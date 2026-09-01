/**
 * Whether a sending domain's feedback channel is answering, decided from our own
 * send history rather than from anything the provider tells us about its config.
 *
 * Reccado learns delivery outcomes from Cloudflare event subscriptions, and a
 * sending domain with no subscription produces no events for anything. Three
 * features read the absence of an event as evidence about the message —
 * `delivery_status` staying null, an `unknown` never resolving, a suppression
 * never arriving — and absence is only evidence where presence was possible. So
 * the missing fact is *feedback liveness per sending domain*, and this is it.
 *
 * This detector deliberately duplicates nothing the config-plane check in
 * `pnpm doctor --cloud` does. That one cross-references two live provider lists
 * and needs Cloudflare auth; this one needs no token at all and catches what a
 * config check structurally cannot see: a subscription pointed at the other
 * environment's queue, a queue whose consumer is broken, a deploy that never
 * shipped the consumer, or a provider-side fault. The config check answers "is
 * it wired"; this answers "does it actually arrive", and only the second one is
 * about reality.
 *
 * The classifier is pure so both callers can use it: the D1-backed status in
 * `/api/health`, and the mailbox DO answering a transactional status query from
 * its own authoritative rows.
 */

import { readSenderFeedbackObservations } from "../db/d1";

/**
 * How old a dispatch must be before its missing event means something. Delivered
 * events arrive within seconds and deferrals within hours, so a day is generous
 * on purpose: the cost of calling a healthy channel dead is an operator who
 * learns to ignore this field, and that costs more than a day of latency.
 */
export const FEEDBACK_MATURITY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back the send log is read. Two reasons, and the second is the real one:
 * `/api/health` is polled, and an unbounded `GROUP BY` over a table that grows
 * with every send would turn a liveness probe into a full scan. Bounding it also
 * sharpens the claim — liveness is a property of the channel *now*, and a domain
 * whose last send was months ago has no current evidence either way, which is
 * what dropping out of the report says.
 */
export const FEEDBACK_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** What our own send log says about one sending domain. */
export type SenderFeedbackObservation = {
	domain: string;
	/**
	 * Provider-acknowledged transmissions only. A `rejected` or `pending` request
	 * never reached the provider and a `duplicate` sent nothing, so their silence
	 * says nothing about the channel; an `unknown` is excluded for the sharper
	 * reason that its own ambiguity is what this signal is meant to interpret —
	 * using it as evidence would make the measurement circular.
	 */
	dispatched: number;
	/** Of those, how many ever had a lifecycle event stamped on them. */
	observed: number;
	lastEventAt: string | null;
	lastDispatchAt: string | null;
	/** Dispatches old enough that an event should have arrived, and none did. */
	silentMatureDispatches: number;
	/** The most recent of those, which is what dates the silence. */
	lastSilentMatureAt: string | null;
};

export type FeedbackLivenessState =
	/** Events are arriving for this domain. */
	| "live"
	/** Too early, or too few sends, to tell. Not a fault — a gap in knowledge. */
	| "unobserved"
	/** Mature sends exist and no event has ever arrived: the channel never worked. */
	| "never_observed"
	/** Events used to arrive and stopped while sending continued. */
	| "went_dark";

/** The instant before which a dispatch is old enough to be judged. */
export function feedbackMaturityCutoff(now: Date | number = Date.now()): string {
	const ms = typeof now === "number" ? now : now.getTime();
	return new Date(ms - FEEDBACK_MATURITY_MS).toISOString();
}

/** The instant after which a dispatch still counts as current evidence. */
export function feedbackLookbackFloor(now: Date | number = Date.now()): string {
	const ms = typeof now === "number" ? now : now.getTime();
	return new Date(ms - FEEDBACK_LOOKBACK_MS).toISOString();
}

/**
 * The two failure shapes are separated because they have different fixes: a
 * domain that never had a subscription needs one created, while one that stopped
 * needs someone to find out what changed. Collapsing them into a boolean would
 * throw away the half of the answer that says where to look.
 *
 * `went_dark` fires on a single silent mature dispatch after the last event, not
 * on a run of them. One lost event is indistinguishable from a channel that just
 * died, and the two mistakes are not symmetric: a false alarm costs a glance at
 * the subscription list, while a false "live" is exactly the misreading this
 * whole mechanism exists to prevent. The counts ride along so the operator can
 * see how thin the sample is.
 */
export function classifyFeedbackLiveness(
	observation: SenderFeedbackObservation,
): FeedbackLivenessState {
	if (observation.dispatched === 0) return "unobserved";
	if (observation.observed === 0) {
		return observation.silentMatureDispatches > 0 ? "never_observed" : "unobserved";
	}
	if (observation.silentMatureDispatches === 0) return "live";
	// Silence only counts against the channel if it happened *after* the last
	// event we did receive; an older gap is a blip the channel already recovered
	// from, and reporting it forever would make the signal permanently red.
	const lastEventAt = observation.lastEventAt ?? "";
	const lastSilentAt = observation.lastSilentMatureAt ?? "";
	return lastSilentAt > lastEventAt ? "went_dark" : "live";
}

/** One sentence an operator or an API caller can act on. */
export function describeFeedbackLiveness(observation: SenderFeedbackObservation): string | null {
	const state = classifyFeedbackLiveness(observation);
	switch (state) {
		case "live":
			return null;
		case "unobserved":
			return (
				`No delivery event has been observed for ${observation.domain} yet, and no send from it ` +
				`is older than ${FEEDBACK_MATURITY_MS / 3_600_000}h — too early to tell a dead feedback ` +
				"channel from a young one."
			);
		case "never_observed":
			return (
				`${observation.domain} has never produced a delivery event: ${observation.silentMatureDispatches} ` +
				`send(s) older than ${FEEDBACK_MATURITY_MS / 3_600_000}h and not one event. A null ` +
				"delivery_status on this domain describes the channel, not the message — most likely no " +
				"Email Sending event subscription binds it to the events queue."
			);
		case "went_dark":
			return (
				`${observation.domain} stopped producing delivery events after ${observation.lastEventAt}: ` +
				`${observation.silentMatureDispatches} later send(s) have gone unanswered. The subscription, ` +
				"its destination queue, or the consumer changed."
			);
	}
}

export type SendingFeedbackDomainStatus = SenderFeedbackObservation & {
	state: FeedbackLivenessState;
	reason: string | null;
};

export type SendingFeedbackStatus = {
	/**
	 * no_sends: nothing has been dispatched, so there is nothing to observe.
	 * observing: sends exist but none are mature enough to judge.
	 * live: at least one domain is answering and none is dark.
	 * dark: at least one domain's feedback channel is not answering.
	 */
	mode: "no_sends" | "observing" | "live" | "dark";
	ok: boolean;
	reason: string | null;
	/** Sending domains whose feedback channel is not answering, by name. */
	dark: string[];
	domains: SendingFeedbackDomainStatus[];
	maturityHours: number;
};

/** Rolls per-domain verdicts into the one shape `/api/health` publishes. */
export function summarizeSendingFeedback(
	observations: SenderFeedbackObservation[],
): SendingFeedbackStatus {
	const domains: SendingFeedbackDomainStatus[] = observations.map((observation) => ({
		...observation,
		state: classifyFeedbackLiveness(observation),
		reason: describeFeedbackLiveness(observation),
	}));
	const dark = domains
		.filter((domain) => domain.state === "never_observed" || domain.state === "went_dark")
		.map((domain) => domain.domain);
	const maturityHours = FEEDBACK_MATURITY_MS / 3_600_000;

	if (domains.length === 0) {
		return {
			mode: "no_sends",
			ok: true,
			reason: "No transactional send has been dispatched yet, so no feedback channel is in use.",
			dark: [],
			domains,
			maturityHours,
		};
	}
	if (dark.length > 0) {
		return {
			mode: "dark",
			ok: false,
			reason: domains
				.filter((domain) => dark.includes(domain.domain))
				.map((domain) => domain.reason)
				.join(" "),
			dark,
			domains,
			maturityHours,
		};
	}
	// A mix of live and not-yet-judgeable domains is healthy: the second kind is
	// an absence of evidence, and reporting it as a fault would be the same error
	// this module exists to correct, pointed the other way.
	const anyLive = domains.some((domain) => domain.state === "live");
	return {
		mode: anyLive ? "live" : "observing",
		ok: true,
		reason: anyLive
			? null
			: `Sends exist but none is older than ${maturityHours}h, so feedback liveness is not yet decidable.`,
		dark: [],
		domains,
		maturityHours,
	};
}

/**
 * The whole picture, read from D1 and nothing else.
 *
 * Deliberately not a call out to Cloudflare, for the reason `src/telegram/status.ts`
 * already gives: `/api/health` is what a monitor polls to decide whether this
 * worker is alive, and making that answer depend on a third party's latency
 * would turn a provider blip into a degraded Reccado. What we know about the
 * feedback channel is already written down here — every event that arrived
 * stamped a row. Reading the note is the point.
 */
export async function getSendingFeedbackStatus(
	db: D1Database,
	now: Date | number = Date.now(),
): Promise<SendingFeedbackStatus> {
	const rows = await readSenderFeedbackObservations(
		db,
		feedbackMaturityCutoff(now),
		feedbackLookbackFloor(now),
	);
	return summarizeSendingFeedback(
		rows.map((row) => ({
			domain: row.domain,
			dispatched: Number(row.dispatched ?? 0),
			observed: Number(row.observed ?? 0),
			lastEventAt: row.last_event_at,
			lastDispatchAt: row.last_dispatch_at,
			silentMatureDispatches: Number(row.silent_mature ?? 0),
			lastSilentMatureAt: row.last_silent_mature_at,
		})),
	);
}
