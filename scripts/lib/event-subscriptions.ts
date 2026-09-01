/**
 * Cloudflare Email Sending event subscriptions, as data.
 *
 * A sending domain only produces delivery/bounce/complaint events if an event
 * subscription binds it to the queue this worker consumes. Nothing in Reccado
 * used to know that, so three features read the *absence* of events as evidence
 * — and absence is only evidence where presence was possible. This module is the
 * shared vocabulary for the two scripts that can see the provider's config
 * plane: `setup:sending` (which creates the subscription) and `doctor --cloud`
 * (which cross-checks live lists against each other).
 *
 * Everything here is pure. The wrangler subprocesses live in the callers, which
 * is what lets the verdict logic be unit-tested without a Cloudflare account —
 * and the verdict logic is the part with the interesting failure modes.
 */

/**
 * The six event types a sending domain must publish for Reccado's delivery
 * tracking and suppression mirror to be whole. A subscription with only
 * `message.delivered` selected passes any existence check while bounces and
 * complaints stay dark, which is why the event set is checked and not just the
 * subscription's presence.
 */
export const EMAIL_SENDING_EVENT_TYPES = [
	"message.delivered",
	"message.deferred",
	"message.bounced",
	"message.rejected",
	"message.complained",
	"message.failed",
] as const;

/** The wrangler version that first exposed `--source email.sending`. */
export const MIN_WRANGLER_FOR_EMAIL_SENDING = "4.127.1";

export type EventSubscription = {
	id: string;
	name: string;
	enabled: boolean;
	source: { type: string; domain?: string; zone_id?: string };
	destination: { type: string; queue_id?: string };
	events: string[];
};

export type SendingDomain = { zone: string; name: string; enabled: boolean };

export type AccountQueue = { id: string; name: string; consumers: number };

export type FeedbackSubscriptionVerdict =
	/** All six event types reach the expected queue. */
	| { state: "live"; subscriptionIds: string[] }
	/** No `email.sending` subscription names this domain at all. */
	| { state: "absent" }
	/** One exists but is switched off, so it publishes nothing. */
	| { state: "disabled"; subscriptionIds: string[] }
	/** One exists and is enabled, but delivers somewhere else. */
	| { state: "wrong_queue"; subscriptionIds: string[]; queueIds: string[] }
	/** Reaches us, but does not carry every event type we act on. */
	| { state: "partial_events"; subscriptionIds: string[]; missingEvents: string[] };

/**
 * Decides whether a sending domain's feedback channel actually reaches us.
 *
 * Three separate ways to be dark, deliberately not collapsed into a boolean: a
 * missing subscription, one pointed at another queue (the live environment here
 * is `reccado-dev`, so a dev/prod mix-up is one wrong dropdown away), and one
 * missing event types. They need different fixes, so they get different names.
 *
 * Coverage is the union across every usable subscription rather than the best
 * single one: two subscriptions splitting the six event types between them is a
 * legitimate configuration, and calling that broken would be a false alarm the
 * operator learns to ignore.
 */
export function evaluateFeedbackSubscription(opts: {
	sendingDomain: string;
	expectedQueueId: string;
	subscriptions: EventSubscription[];
}): FeedbackSubscriptionVerdict {
	const domain = opts.sendingDomain.trim().toLowerCase();
	const candidates = opts.subscriptions.filter(
		(sub) => sub.source?.type === "email.sending" && sub.source?.domain?.toLowerCase() === domain,
	);
	if (candidates.length === 0) return { state: "absent" };

	const ids = candidates.map((sub) => sub.id);
	const enabled = candidates.filter((sub) => sub.enabled);
	if (enabled.length === 0) return { state: "disabled", subscriptionIds: ids };

	const usable = enabled.filter((sub) => sub.destination?.queue_id === opts.expectedQueueId);
	if (usable.length === 0) {
		return {
			state: "wrong_queue",
			subscriptionIds: enabled.map((sub) => sub.id),
			queueIds: [
				...new Set(enabled.map((sub) => sub.destination?.queue_id ?? "unknown").filter(Boolean)),
			],
		};
	}

	const covered = new Set(usable.flatMap((sub) => sub.events ?? []));
	const missingEvents = EMAIL_SENDING_EVENT_TYPES.filter((type) => !covered.has(type));
	const usableIds = usable.map((sub) => sub.id);
	if (missingEvents.length > 0) {
		return { state: "partial_events", subscriptionIds: usableIds, missingEvents };
	}
	return { state: "live", subscriptionIds: usableIds };
}

/** One line an operator can read, for every verdict including the good one. */
export function describeFeedbackVerdict(
	sendingDomain: string,
	queueName: string,
	verdict: FeedbackSubscriptionVerdict,
): string {
	switch (verdict.state) {
		case "live":
			return `${sendingDomain} publishes all ${EMAIL_SENDING_EVENT_TYPES.length} lifecycle events to ${queueName}.`;
		case "absent":
			return `${sendingDomain} has no Email Sending event subscription on ${queueName} — every send from it stays delivery_status=null forever.`;
		case "disabled":
			return `${sendingDomain}'s event subscription on ${queueName} is disabled, so it publishes nothing.`;
		case "wrong_queue":
			return `${sendingDomain}'s event subscription delivers to queue ${verdict.queueIds.join(", ")}, not ${queueName} — its events never reach this worker.`;
		case "partial_events":
			return `${sendingDomain}'s event subscription on ${queueName} omits ${verdict.missingEvents.join(", ")} — those outcomes stay invisible (suppression included).`;
	}
}

/**
 * `queues subscription list --json`. Returns null rather than throwing when the
 * output is not the JSON array we expect (an older wrangler prints a table and
 * rejects `--json` outright), so the caller can say "unresolved" instead of
 * crashing on a CLI shape it does not control.
 */
export function parseSubscriptionListJson(raw: string): EventSubscription[] | null {
	const start = raw.indexOf("[");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(raw.slice(start)) as unknown;
		if (!Array.isArray(parsed)) return null;
		return parsed.map((entry) => {
			const row = entry as Record<string, unknown>;
			const source = (row.source ?? {}) as Record<string, unknown>;
			const destination = (row.destination ?? {}) as Record<string, unknown>;
			return {
				id: String(row.id ?? ""),
				name: String(row.name ?? ""),
				enabled: row.enabled !== false,
				source: {
					type: String(source.type ?? ""),
					domain: typeof source.domain === "string" ? source.domain : undefined,
					zone_id: typeof source.zone_id === "string" ? source.zone_id : undefined,
				},
				destination: {
					type: String(destination.type ?? ""),
					queue_id: typeof destination.queue_id === "string" ? destination.queue_id : undefined,
				},
				events: Array.isArray(row.events) ? row.events.map(String) : [],
			};
		});
	} catch {
		return null;
	}
}

/**
 * `wrangler email sending list`, which has no `--json` mode on any released
 * version (`--json` errors with "Unknown argument: json"), so its box-drawn
 * table is the only surface: │ zone │ name │ enabled │ tag │.
 *
 * Same scraping tradeoff `parseWranglerDnsGetOutput` already accepts in
 * `setup-sending.ts`: unrecognisable rows are skipped, never guessed at.
 */
export function parseSendingDomainsTable(raw: string): SendingDomain[] {
	const rows: SendingDomain[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("│")) continue;
		const cells = line
			.split("│")
			.slice(1, -1)
			.map((cell) => cell.trim());
		const [zone, name, enabled] = cells;
		if (cells.length < 3 || !zone || !name || zone === "zone") continue;
		rows.push({ zone, name: name.toLowerCase(), enabled: enabled?.toLowerCase() === "yes" });
	}
	return rows;
}

/**
 * `wrangler queues list`'s table: │ id │ name │ created_on │ modified_on │ producers │ consumers │.
 *
 * The id column is what makes this more than a name lookup: a subscription's
 * destination is a queue *id*, so resolving "is this pointed at our queue" needs
 * the mapping this table is the only source of.
 */
export function parseQueueListTable(raw: string): AccountQueue[] {
	const rows: AccountQueue[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("│")) continue;
		const cells = line
			.split("│")
			.slice(1, -1)
			.map((cell) => cell.trim());
		const id = cells[0];
		const name = cells[1];
		if (cells.length < 6 || !name || name === "name") continue;
		rows.push({ id: id ?? "", name, consumers: Number.parseInt(cells[5] ?? "", 10) || 0 });
	}
	return rows;
}

/** Whether a `queues subscription create --help` dump offers `email.sending`. */
export function helpAdvertisesEmailSendingSource(help: string): boolean {
	return /"email\.sending"/.test(help);
}
