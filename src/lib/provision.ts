import { getDomainByName, insertDomain, insertMailbox } from "#/db/d1";
import { type DmarcAlignment, type DmarcPolicy, ensureDmarcRecord } from "#/lib/dns-gate";
import { canonicalPrimaryAddress, generateMailboxId } from "#/lib/mailbox-id";
import { fetchWithTimeout } from "#/lib/runtime-config";

/**
 * Provisioning a sending domain, as one resumable sequence instead of six
 * commands and a checklist.
 *
 * This used to be a runbook: enable Email Sending, wait, enable Email Routing,
 * create an event subscription, then paste a DMARC record into the dashboard by
 * hand. Every one of those steps is an API call, so the runbook was never the
 * real requirement — it was just the shape the work happened to have. The cost
 * of leaving it that way is that the steps drift: a domain ends up verified for
 * sending but with no feedback subscription, so bounces and complaints go
 * nowhere and nothing says so.
 *
 * Two properties matter more than brevity here:
 *
 *   Every step is idempotent. Re-running is the normal way to finish a
 *   half-provisioned domain, not a recovery procedure — so each step asks what
 *   is already true before it writes, and reports `already` rather than
 *   pretending it did the work.
 *
 *   A step that cannot run does not abort the ones that do not depend on it.
 *   The common case is a token that can do four of the five things; failing the
 *   whole run would leave the operator worse off than doing the four. Steps
 *   declare their dependencies, and only dependents are skipped.
 *
 * The result is a list of per-step outcomes, never a boolean. "Did it work?" is
 * the question that hid the drift in the first place.
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const API_TIMEOUT_MS = 15_000;

/** Feedback events Reccado acts on. A subscription missing any of these is partially dark. */
export const FEEDBACK_EVENT_TYPES = [
	"message.delivered",
	"message.deferred",
	"message.bounced",
	"message.rejected",
	"message.complained",
	"message.failed",
] as const;

export type ProvisionStepName =
	| "register_domain"
	| "email_sending"
	| "dmarc"
	| "email_routing"
	| "feedback_subscription"
	| "mailbox";

export type StepOutcome =
	/** Already in the desired state. Nothing was written. */
	| { state: "already"; detail: string }
	/** This run changed something. */
	| { state: "done"; detail: string }
	/** Not attempted because something it depends on did not succeed. */
	| { state: "skipped"; reason: string }
	/**
	 * Reccado cannot do this itself — almost always a token permission. Carries the
	 * exact remedy, because "blocked" without one is just a nicer word for failed.
	 */
	| { state: "blocked"; reason: string; remedy: string }
	| { state: "failed"; error: string };

export interface ProvisionStep {
	name: ProvisionStepName;
	outcome: StepOutcome;
}

export interface ProvisionResult {
	zone: string;
	sendingDomain: string;
	steps: ProvisionStep[];
	/** True only when every attempted step ended in `already` or `done`. */
	complete: boolean;
}

export interface ProvisionOptions {
	/** The zone, e.g. `eccos.chat`. */
	zone: string;
	/** The subdomain mail is sent from, e.g. `notify.eccos.chat`. Must be inside the zone. */
	sendingDomain: string;
	dmarc: { policy: DmarcPolicy; alignment?: DmarcAlignment; rua?: string };
	/** Queue that feedback events are delivered to. Omit to skip the subscription step. */
	feedbackQueueId?: string;
	/** Enable inbound Email Routing for the zone. */
	inbound?: boolean;
	/** Create this mailbox once the domain is registered. */
	mailbox?: { address: string; displayName?: string; ownerEmail?: string };
}

export interface ProvisionEnv {
	CLOUDFLARE_API_TOKEN?: string;
	CLOUDFLARE_ACCOUNT_ID?: string;
}

// ---------------------------------------------------------------------------
// Cloudflare access
// ---------------------------------------------------------------------------

interface ApiResponse<T> {
	success: boolean;
	errors?: Array<{ code: number; message: string }>;
	result: T;
}

/**
 * Raised for a response Cloudflare refused on authority grounds. Separated from a
 * generic failure because the remedy is completely different: a 403 means the
 * token is missing a permission and no amount of retrying will help.
 */
export class PermissionError extends Error {
	constructor(
		message: string,
		readonly permission: string,
	) {
		super(message);
		this.name = "PermissionError";
	}
}

/** The subset of Cloudflare this module touches. Injectable so tests need no network. */
export interface CloudflareClient {
	findZoneId(name: string): Promise<string | null>;
	listSendingSubdomains(zoneId: string): Promise<Array<{ id: string; name: string }>>;
	createSendingSubdomain(zoneId: string, name: string): Promise<void>;
	getRoutingStatus(zoneId: string): Promise<{ enabled: boolean }>;
	enableRouting(zoneId: string): Promise<void>;
	listSubscriptions(accountId: string): Promise<
		Array<{
			id: string;
			enabled: boolean;
			source?: { type?: string; domain?: string };
			destination?: { queue_id?: string };
			events?: string[];
		}>
	>;
	createFeedbackSubscription(opts: {
		accountId: string;
		sendingDomain: string;
		queueId: string;
	}): Promise<void>;
}

export function createCloudflareClient(token: string): CloudflareClient {
	async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetchWithTimeout(`${CLOUDFLARE_API}${path}`, {
			method,
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			timeoutMs: API_TIMEOUT_MS,
		});
		const json = (await response.json()) as ApiResponse<T>;
		if (response.status === 403 || json.errors?.some((error) => error.code === 9109)) {
			throw new PermissionError(
				`Cloudflare refused ${method} ${path} on authority grounds.`,
				path,
			);
		}
		if (!response.ok || !json.success) {
			const details = json.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
			throw new Error(`Cloudflare API ${method} ${path} failed${details ? ` (${details})` : ""}.`);
		}
		return json.result;
	}

	return {
		async findZoneId(name) {
			const zones = await call<Array<{ id: string }>>(
				"GET",
				`/zones?name=${encodeURIComponent(name)}&status=active&per_page=1`,
			);
			return zones[0]?.id ?? null;
		},
		listSendingSubdomains: (zoneId) =>
			call<Array<{ id: string; name: string }>>("GET", `/zones/${zoneId}/email/sending/subdomains`),
		createSendingSubdomain: async (zoneId, name) => {
			await call("POST", `/zones/${zoneId}/email/sending/subdomains`, { name });
		},
		getRoutingStatus: (zoneId) => call<{ enabled: boolean }>("GET", `/zones/${zoneId}/email/routing`),
		enableRouting: async (zoneId) => {
			await call("POST", `/zones/${zoneId}/email/routing/enable`, {});
		},
		listSubscriptions: (accountId) =>
			// biome-ignore lint/suspicious/noExplicitAny: shape is asserted by the interface
			call<any[]>("GET", `/accounts/${accountId}/event_subscriptions/subscriptions`),
		createFeedbackSubscription: async ({ accountId, sendingDomain, queueId }) => {
			await call("POST", `/accounts/${accountId}/event_subscriptions/subscriptions`, {
				name: `reccado-feedback-${sendingDomain}`,
				enabled: true,
				source: { type: "email.sending", domain: sendingDomain },
				destination: { type: "queues.queue", queue_id: queueId },
				events: [...FEEDBACK_EVENT_TYPES],
			});
		},
	};
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function failureOutcome(error: unknown, permissionRemedy: string): StepOutcome {
	if (error instanceof PermissionError) {
		return {
			state: "blocked",
			reason: error.message,
			remedy: permissionRemedy,
		};
	}
	return { state: "failed", error: error instanceof Error ? error.message : String(error) };
}

/**
 * The zone must be in the `domains` table before anything else runs — not as
 * bookkeeping, but because the DNS gate resolves its zone from that table and
 * refuses to write for a domain nobody registered. Registration is the act that
 * grants Reccado authority over a zone.
 */
async function stepRegisterDomain(
	db: D1Database,
	cf: CloudflareClient,
	zone: string,
): Promise<StepOutcome> {
	try {
		const existing = await getDomainByName(db, zone);
		if (existing) {
			return { state: "already", detail: `${zone} is registered (zone ${existing.zone_id}).` };
		}
		const zoneId = await cf.findZoneId(zone);
		if (!zoneId) {
			return {
				state: "blocked",
				reason: `No active Cloudflare zone named ${zone} in this account.`,
				remedy: `Add ${zone} to the Cloudflare account first, or check the token can read zones.`,
			};
		}
		await insertDomain(db, {
			id: `dom_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`,
			domain: zone,
			zone_id: zoneId,
			status: "active",
		});
		return { state: "done", detail: `Registered ${zone} (zone ${zoneId}).` };
	} catch (error) {
		return failureOutcome(error, "The token needs Zone · Zone · Read.");
	}
}

async function stepEmailSending(
	cf: CloudflareClient,
	zoneId: string,
	sendingDomain: string,
): Promise<StepOutcome> {
	try {
		const existing = await cf.listSendingSubdomains(zoneId);
		if (existing.some((entry) => entry.name.toLowerCase() === sendingDomain)) {
			return { state: "already", detail: `${sendingDomain} is already a sending subdomain.` };
		}
		await cf.createSendingSubdomain(zoneId, sendingDomain);
		return {
			state: "done",
			// Worth saying out loud: this call is what puts DKIM, SPF, MX and a
			// default p=reject DMARC into the zone, which is why the DMARC step runs
			// after it rather than before.
			detail: `Enabled Email Sending for ${sendingDomain}; Cloudflare provisioned its DKIM/SPF/MX records.`,
		};
	} catch (error) {
		return failureOutcome(error, "The token needs Zone · Email Sending · Edit.");
	}
}

async function stepDmarc(
	env: ProvisionEnv,
	db: D1Database,
	sendingDomain: string,
	dmarc: ProvisionOptions["dmarc"],
): Promise<StepOutcome> {
	try {
		const outcome = await ensureDmarcRecord(env, db, {
			sendingDomain,
			policy: dmarc.policy,
			alignment: dmarc.alignment,
			rua: dmarc.rua,
		});
		if (outcome.status === "unchanged") {
			return { state: "already", detail: `${outcome.name} already reads "${outcome.content}".` };
		}
		if (outcome.status === "updated") {
			return {
				state: "done",
				detail: `Replaced ${outcome.name} ("${outcome.previous}" -> "${outcome.content}").`,
			};
		}
		return { state: "done", detail: `Published ${outcome.name} as "${outcome.content}".` };
	} catch (error) {
		return failureOutcome(error, "The token needs Zone · DNS · Edit for this zone.");
	}
}

async function stepEmailRouting(cf: CloudflareClient, zoneId: string): Promise<StepOutcome> {
	try {
		const status = await cf.getRoutingStatus(zoneId);
		if (status.enabled) {
			return { state: "already", detail: "Email Routing is enabled for this zone." };
		}
		await cf.enableRouting(zoneId);
		return { state: "done", detail: "Enabled Email Routing for this zone." };
	} catch (error) {
		return failureOutcome(error, "The token needs Zone · Email Routing · Edit.");
	}
}

/**
 * Without this, a domain sends mail and hears nothing back: bounces, complaints
 * and rejections are published as account events, and if nothing subscribes they
 * are simply lost. A domain in that state looks healthy right up until a
 * suppression list should have existed and does not.
 */
async function stepFeedbackSubscription(
	cf: CloudflareClient,
	accountId: string,
	sendingDomain: string,
	queueId: string,
): Promise<StepOutcome> {
	try {
		const subscriptions = await cf.listSubscriptions(accountId);
		const mine = subscriptions.filter(
			(sub) =>
				sub.source?.type === "email.sending" &&
				sub.source?.domain?.toLowerCase() === sendingDomain,
		);
		// Coverage is the union across usable subscriptions: splitting the event
		// types across two of them is a legitimate configuration.
		const usable = mine.filter(
			(sub) => sub.enabled && sub.destination?.queue_id === queueId,
		);
		const covered = new Set(usable.flatMap((sub) => sub.events ?? []));
		const missing = FEEDBACK_EVENT_TYPES.filter((type) => !covered.has(type));
		if (usable.length > 0 && missing.length === 0) {
			return { state: "already", detail: `Feedback for ${sendingDomain} reaches queue ${queueId}.` };
		}
		if (usable.length > 0) {
			// Partial coverage. Adding a second, complete subscription would work, but
			// both would then publish the event types they share and the consumer would
			// see every delivery twice. Widening the existing one is the right fix and
			// it is not this function's to make blindly.
			return {
				state: "blocked",
				reason:
					`${sendingDomain} has a subscription to queue ${queueId} that omits ` +
					`${missing.join(", ")}.`,
				remedy:
					"Add the missing event types to the existing subscription. Creating a second one " +
					"here would double-deliver every event the two have in common.",
			};
		}
		if (mine.length > 0 && usable.length === 0) {
			// Do not quietly add a second subscription next to a misdirected one — the
			// operator needs to know the existing one points somewhere else.
			return {
				state: "blocked",
				reason:
					`${sendingDomain} already has an email.sending subscription that is disabled or ` +
					"delivers to a different queue.",
				remedy: `Fix or delete the existing subscription, then re-run. Expected queue: ${queueId}.`,
			};
		}
		await cf.createFeedbackSubscription({ accountId, sendingDomain, queueId });
		return { state: "done", detail: `Feedback for ${sendingDomain} now reaches queue ${queueId}.` };
	} catch (error) {
		return failureOutcome(
			error,
			"The token needs account-level Event Subscriptions access. This is the one step that is " +
				"not zone-scoped; leave it to `pnpm doctor --cloud` if you would rather not widen the token.",
		);
	}
}

async function stepMailbox(
	db: D1Database,
	mailbox: NonNullable<ProvisionOptions["mailbox"]>,
): Promise<StepOutcome> {
	try {
		const address = canonicalPrimaryAddress(mailbox.address);
		// Existence is checked before the insert rather than inferred from it:
		// insertMailbox is ON CONFLICT(primary_address) DO NOTHING and returns the
		// STORED id either way, so a plain insert cannot tell "created" from "was
		// already there" — and reporting a creation that did not happen is exactly
		// the kind of quiet lie this whole result shape exists to avoid.
		const existing = await db
			.prepare("SELECT mailbox_id FROM mailboxes WHERE primary_address = ?")
			.bind(address)
			.first<{ mailbox_id: string }>();
		if (existing) {
			return { state: "already", detail: `${address} is already mailbox ${existing.mailbox_id}.` };
		}
		const id = await insertMailbox(db, {
			mailbox_id: generateMailboxId(),
			primary_address: address,
			display_name: mailbox.displayName ?? null,
			status: "active",
			// Null is legitimate (an unowned mailbox is reachable over MCP by an
			// operator), but it also hides the mailbox from the owner-scoped lists, so
			// the caller decides rather than this defaulting to something convenient.
			owner_email: mailbox.ownerEmail ?? null,
		});
		return { state: "done", detail: `Created mailbox ${id} for ${address}.` };
	} catch (error) {
		return { state: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function succeeded(outcome: StepOutcome): boolean {
	return outcome.state === "already" || outcome.state === "done";
}

export async function provisionSendingDomain(
	env: ProvisionEnv,
	db: D1Database,
	opts: ProvisionOptions,
	client?: CloudflareClient,
): Promise<ProvisionResult> {
	const zone = opts.zone.trim().toLowerCase();
	const sendingDomain = opts.sendingDomain.trim().toLowerCase();
	const steps: ProvisionStep[] = [];
	const push = (name: ProvisionStepName, outcome: StepOutcome) => {
		steps.push({ name, outcome });
		return outcome;
	};

	if (sendingDomain !== zone && !sendingDomain.endsWith(`.${zone}`)) {
		// Not a step failure: the request itself is incoherent, and running any of it
		// would put records in a zone the caller did not name.
		throw new Error(
			`provision: sending domain "${sendingDomain}" is not inside zone "${zone}".`,
		);
	}

	const token = env.CLOUDFLARE_API_TOKEN?.trim();
	if (!token) {
		const blocked: StepOutcome = {
			state: "blocked",
			reason: "CLOUDFLARE_API_TOKEN is not set.",
			remedy: "Set the CLOUDFLARE_API_TOKEN secret on the Worker.",
		};
		return {
			zone,
			sendingDomain,
			steps: [{ name: "register_domain", outcome: blocked }],
			complete: false,
		};
	}
	const cf = client ?? createCloudflareClient(token);

	// 1. Registration gates everything: the DNS gate reads the zone from here.
	const registered = push("register_domain", await stepRegisterDomain(db, cf, zone));
	const domainRow = succeeded(registered) ? await getDomainByName(db, zone) : null;

	if (!domainRow) {
		const reason = "the zone is not registered, so its Cloudflare zone id is unknown";
		push("email_sending", { state: "skipped", reason });
		push("dmarc", { state: "skipped", reason });
		if (opts.inbound) push("email_routing", { state: "skipped", reason });
		if (opts.feedbackQueueId) push("feedback_subscription", { state: "skipped", reason });
		if (opts.mailbox) push("mailbox", { state: "skipped", reason });
		return { zone, sendingDomain, steps, complete: false };
	}

	// 2. Enabling sending is what makes Cloudflare write DKIM/SPF/MX — and its own
	//    p=reject DMARC, which step 3 then replaces with the ramp.
	const sending = push("email_sending", await stepEmailSending(cf, domainRow.zone_id, sendingDomain));

	// 3. DMARC. Ordered after sending on purpose; running it first would have the
	//    provider overwrite the ramp moments later.
	if (succeeded(sending)) {
		push("dmarc", await stepDmarc(env, db, sendingDomain, opts.dmarc));
	} else {
		push("dmarc", {
			state: "skipped",
			reason: "Email Sending is not enabled, so Cloudflare has not written its records yet",
		});
	}

	// 4. Inbound is independent of sending: a domain can receive without sending.
	if (opts.inbound) {
		push("email_routing", await stepEmailRouting(cf, domainRow.zone_id));
	}

	// 5. Feedback needs the domain to exist as a sending domain first.
	if (opts.feedbackQueueId) {
		const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
		if (!succeeded(sending)) {
			push("feedback_subscription", {
				state: "skipped",
				reason: "there is no sending domain to subscribe to yet",
			});
		} else if (!accountId) {
			push("feedback_subscription", {
				state: "blocked",
				reason: "CLOUDFLARE_ACCOUNT_ID is not set.",
				remedy: "Set CLOUDFLARE_ACCOUNT_ID; event subscriptions are an account-scoped resource.",
			});
		} else {
			push(
				"feedback_subscription",
				await stepFeedbackSubscription(cf, accountId, sendingDomain, opts.feedbackQueueId),
			);
		}
	}

	// 6. The mailbox only needs the domain row, so it runs even if Cloudflare misbehaved.
	if (opts.mailbox) {
		push("mailbox", await stepMailbox(db, opts.mailbox));
	}

	return {
		zone,
		sendingDomain,
		steps,
		complete: steps.every((step) => succeeded(step.outcome)),
	};
}
