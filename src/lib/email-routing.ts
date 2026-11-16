/**
 * Cloudflare Email Routing rules, as one implementation shared by the CLI
 * (`pnpm setup:routing`) and the Worker (`POST /api/cloudflare/domains/:domain/routing`).
 *
 * Two things live here:
 *
 *   - a minimal REST client for the four Email Routing calls both sides make
 *     (zone lookup, settings, rules, catch-all), with Cloudflare's errors
 *     classified so a caller can tell "the token may not do this" from "the API
 *     failed";
 *   - the decision about one address: is it already delivered to this Worker,
 *     is it someone else's (a rule or catch-all that sends it elsewhere), or is
 *     it free for a new literal `to:<address> -> worker` rule.
 *
 * The decision is deliberately conservative. A rule is only ever CREATED here,
 * for exactly the address asked about; nothing in this module updates or
 * deletes a literal rule, and the address planner never touches the catch-all.
 * Anything that already sends the address somewhere else is reported, not
 * overridden. (`setup:routing --catch-all` keeps its own documented behaviour of
 * pointing the zone's catch-all at the Worker; that path is CLI-only.)
 *
 * Pure apart from `fetch`: no node:*, no Worker bindings, so both runtimes load it.
 */

export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

export type ApiMessage = { code?: number; message?: string };

type Envelope<T> = {
	success?: boolean;
	errors?: ApiMessage[];
	messages?: ApiMessage[];
	result?: T;
	result_info?: { page?: number; total_pages?: number };
};

export type RoutingMatcher = { type?: string; field?: string; value?: string };
export type RoutingAction = { type?: string; value?: string[] };

export type EmailRoutingRule = {
	id?: string;
	tag?: string;
	name?: string;
	enabled?: boolean;
	priority?: number;
	matchers?: RoutingMatcher[];
	actions?: RoutingAction[];
	source?: string;
};

export type ZoneResult = {
	id?: string;
	name?: string;
	account?: { id?: string; name?: string };
};

export type EmailRoutingFailureReason = "permission" | "timeout" | "error";

/** Thrown by the client. `message` is Cloudflare's own error text, formatted as the CLI always printed it. */
export class EmailRoutingApiError extends Error {
	constructor(
		readonly reason: EmailRoutingFailureReason,
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "EmailRoutingApiError";
	}
}

/** `message [code]; message [code]` — the format `setup:routing` has always printed. */
export function formatApiErrors(payload: {
	errors?: ApiMessage[];
	messages?: ApiMessage[];
}): string {
	const items = [...(payload.errors ?? []), ...(payload.messages ?? [])]
		.map((item) => {
			const code = item.code ? ` [${item.code}]` : "";
			return `${item.message ?? "unknown Cloudflare API error"}${code}`;
		})
		.filter(Boolean);
	return items.length > 0 ? items.join("; ") : "unknown Cloudflare API error";
}

/** Cloudflare codes that mean "this token may not do that": 9109 unauthorized, 10000 authentication error. */
const PERMISSION_CODES = new Set([9109, 10000]);

/** Rules are read whole before any decision; past this many pages we refuse rather than decide blind. */
const MAX_RULE_PAGES = 10;
const RULES_PER_PAGE = 50;

export type EmailRoutingApi = ReturnType<typeof createEmailRoutingApi>;

export function createEmailRoutingApi(
	token: string,
	opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
) {
	const doFetch =
		opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

	async function request<T>(
		method: "GET" | "POST" | "PUT",
		path: string,
		body?: unknown,
	): Promise<Envelope<T> & { result: T }> {
		let response: Response;
		try {
			response = await doFetch(`${CLOUDFLARE_API}${path}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
			});
		} catch (error) {
			const timedOut =
				error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
			throw new EmailRoutingApiError(
				timedOut ? "timeout" : "error",
				timedOut
					? "The Cloudflare API did not answer in time."
					: `The Cloudflare API request failed: ${error instanceof Error ? error.message : String(error)}`,
				0,
			);
		}
		let payload: Envelope<T> = {};
		try {
			payload = (await response.json()) as Envelope<T>;
		} catch {
			// Non-JSON: the status decides below.
		}
		const permission =
			response.status === 401 ||
			response.status === 403 ||
			(payload.errors ?? []).some((e) => e.code !== undefined && PERMISSION_CODES.has(e.code));
		if (permission) {
			throw new EmailRoutingApiError("permission", formatApiErrors(payload), response.status);
		}
		if (!response.ok || payload.success !== true || payload.result === undefined) {
			throw new EmailRoutingApiError("error", formatApiErrors(payload), response.status);
		}
		return payload as Envelope<T> & { result: T };
	}

	return {
		/** Active zones named exactly `name` (the CLI's lookup; the Worker uses its registry instead). */
		async findZones(name: string): Promise<ZoneResult[]> {
			const zones = await request<ZoneResult[]>(
				"GET",
				`/zones?name=${encodeURIComponent(name)}&status=active&match=all`,
			);
			return zones.result.filter((zone) => zone.name?.toLowerCase() === name.toLowerCase());
		},
		/** Whether Email Routing is on for the zone. Needs Zone Settings Read. */
		async getSettings(zoneId: string): Promise<{ enabled: boolean; status: string | null }> {
			const body = await request<{ enabled?: boolean; status?: string }>(
				"GET",
				`/zones/${encodeURIComponent(zoneId)}/email/routing`,
			);
			return { enabled: body.result.enabled === true, status: body.result.status ?? null };
		},
		/** Every routing rule on the zone. Refuses (throws) rather than return a partial list. */
		async listRules(zoneId: string): Promise<EmailRoutingRule[]> {
			const out: EmailRoutingRule[] = [];
			for (let page = 1; ; page += 1) {
				const body = await request<EmailRoutingRule[]>(
					"GET",
					`/zones/${encodeURIComponent(zoneId)}/email/routing/rules?per_page=${RULES_PER_PAGE}&page=${page}`,
				);
				out.push(...body.result);
				const totalPages = body.result_info?.total_pages ?? 1;
				if (page >= totalPages) return out;
				if (page >= MAX_RULE_PAGES) {
					throw new EmailRoutingApiError(
						"error",
						`The zone has more than ${MAX_RULE_PAGES * RULES_PER_PAGE} routing rules; not deciding on a partial read.`,
						200,
					);
				}
			}
		},
		async getCatchAll(zoneId: string): Promise<EmailRoutingRule> {
			return (
				await request<EmailRoutingRule>(
					"GET",
					`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`,
				)
			).result;
		},
		async putCatchAll(zoneId: string, rule: CatchAllRuleBody): Promise<EmailRoutingRule> {
			return (
				await request<EmailRoutingRule>(
					"PUT",
					`/zones/${encodeURIComponent(zoneId)}/email/routing/rules/catch_all`,
					rule,
				)
			).result;
		},
		/** Creates one rule. Never called with anything but `literalWorkerRuleBody`. */
		async createRule(zoneId: string, rule: LiteralRuleBody): Promise<EmailRoutingRule> {
			return (
				await request<EmailRoutingRule>(
					"POST",
					`/zones/${encodeURIComponent(zoneId)}/email/routing/rules`,
					rule,
				)
			).result;
		},
	};
}

// ---------------------------------------------------------------------------
// Rule shapes
// ---------------------------------------------------------------------------

export type CatchAllRuleBody = {
	enabled: true;
	name: string;
	matchers: [{ type: "all" }];
	actions: [{ type: "worker"; value: [string] }];
};

/** The catch-all `setup:routing --catch-all` writes. Key order matters: the CLI prints it. */
export function catchAllRuleBody(worker: string): CatchAllRuleBody {
	return {
		enabled: true,
		name: `Catch-all -> ${worker}`,
		matchers: [{ type: "all" }],
		actions: [{ type: "worker", value: [worker] }],
	};
}

export type LiteralRuleBody = {
	enabled: true;
	name: string;
	matchers: [{ type: "literal"; field: "to"; value: string }];
	actions: [{ type: "worker"; value: [string] }];
};

/** A literal `to:<address> -> worker` rule, named like the ones `pnpm onboard` creates. */
export function literalWorkerRuleBody(address: string, worker: string): LiteralRuleBody {
	const value = address.trim().toLowerCase();
	const local = value.split("@")[0] ?? value;
	return {
		enabled: true,
		name: `${local} -> ${worker}`,
		matchers: [{ type: "literal", field: "to", value }],
		actions: [{ type: "worker", value: [worker] }],
	};
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export function actionsTargetWorker(actions: RoutingAction[] | undefined, worker: string): boolean {
	return (actions ?? []).some(
		(action) => action.type === "worker" && (action.value ?? []).includes(worker),
	);
}

function matchersAreCatchAll(matchers: RoutingMatcher[] | undefined): boolean {
	return (matchers ?? []).some((matcher) => matcher.type === "all");
}

/** The CLI's "catch-all already routes to this Worker" check, unchanged. */
export function catchAllRoutesToWorker(
	rule: EmailRoutingRule | null | undefined,
	worker: string,
): boolean {
	return (
		rule?.enabled === true &&
		matchersAreCatchAll(rule.matchers) &&
		actionsTargetWorker(rule.actions, worker)
	);
}

function ruleMatchesAddress(rule: EmailRoutingRule, address: string): boolean {
	return (rule.matchers ?? []).some(
		(m) =>
			m.type === "literal" &&
			(m.field ?? "to") === "to" &&
			(m.value ?? "").trim().toLowerCase() === address,
	);
}

/** "forward to a@b.c", "Worker other-worker", "drop" — for a human reading a refusal. */
export function describeActions(actions: RoutingAction[] | undefined): string {
	const parts = (actions ?? []).map((a) => {
		const values = (a.value ?? []).join(", ");
		if (a.type === "worker") return values ? `Worker ${values}` : "a Worker";
		if (a.type === "forward") return values ? `forward to ${values}` : "forward";
		return a.type ?? "unknown";
	});
	return parts.length > 0 ? parts.join(" + ") : "no action";
}

export type ConflictingRule = {
	via: "rule" | "catch_all";
	id: string | null;
	name: string | null;
	enabled: boolean;
	action: string;
};

export type AddressRoutePlan =
	| { action: "already"; via: "rule" | "catch_all"; ruleId: string | null }
	| { action: "conflict"; rule: ConflictingRule }
	| { action: "create"; body: LiteralRuleBody };

/**
 * Pure: what to do so mail to `address` reaches `worker`, given every rule on
 * the zone and its catch-all. Email Routing evaluates a literal rule before the
 * catch-all, and so does this.
 *
 *   - an enabled literal rule for the address that delivers to this Worker → already;
 *   - any other literal rule for the address (another target, or disabled) → conflict;
 *   - no literal rule, enabled catch-all to this Worker → already (via catch-all);
 *   - no literal rule, enabled catch-all that forwards or goes to another Worker → conflict;
 *   - otherwise (no catch-all, disabled, or `drop`) → create a literal rule.
 */
export function planAddressRoute(opts: {
	address: string;
	worker: string;
	rules: EmailRoutingRule[];
	catchAll: EmailRoutingRule | null;
}): AddressRoutePlan {
	const address = opts.address.trim().toLowerCase();
	const literal = opts.rules.filter((rule) => ruleMatchesAddress(rule, address));
	if (literal.length > 0) {
		const enabled = literal.filter((rule) => rule.enabled !== false);
		const mine = enabled.find((rule) => actionsTargetWorker(rule.actions, opts.worker));
		const other =
			enabled.find((rule) => !actionsTargetWorker(rule.actions, opts.worker)) ??
			(enabled.length === 0 ? literal[0] : undefined);
		if (mine && !other) return { action: "already", via: "rule", ruleId: mine.id ?? null };
		const blocking = other ?? literal[0]!;
		return {
			action: "conflict",
			rule: {
				via: "rule",
				id: blocking.id ?? null,
				name: blocking.name || null,
				enabled: blocking.enabled !== false,
				action: describeActions(blocking.actions),
			},
		};
	}
	const catchAll = opts.catchAll;
	if (catchAll && catchAll.enabled === true) {
		if (actionsTargetWorker(catchAll.actions, opts.worker))
			return { action: "already", via: "catch_all", ruleId: catchAll.id ?? catchAll.tag ?? null };
		const types = (catchAll.actions ?? []).map((a) => a.type);
		const drops = types.length === 0 || types.every((type) => type === "drop");
		if (!drops)
			return {
				action: "conflict",
				rule: {
					via: "catch_all",
					id: catchAll.id ?? catchAll.tag ?? null,
					name: catchAll.name || null,
					enabled: true,
					action: describeActions(catchAll.actions),
				},
			};
	}
	return { action: "create", body: literalWorkerRuleBody(address, opts.worker) };
}

export type AddressRouteOutcome =
	| { status: "routing_disabled" }
	| { status: "already"; via: "rule" | "catch_all"; ruleId: string | null }
	| { status: "conflict"; rule: ConflictingRule }
	| { status: "created"; ruleId: string | null; rule: LiteralRuleBody };

/**
 * Reads the zone, decides, and creates at most one rule. Never updates or
 * deletes anything. Throws `EmailRoutingApiError` for API/permission failures.
 */
export async function ensureAddressRoute(
	api: EmailRoutingApi,
	opts: { zoneId: string; address: string; worker: string },
): Promise<AddressRouteOutcome> {
	const settings = await api.getSettings(opts.zoneId);
	if (!settings.enabled) return { status: "routing_disabled" };
	const [rules, catchAll] = await Promise.all([
		api.listRules(opts.zoneId),
		api.getCatchAll(opts.zoneId),
	]);
	const plan = planAddressRoute({ address: opts.address, worker: opts.worker, rules, catchAll });
	if (plan.action === "already") return { status: "already", via: plan.via, ruleId: plan.ruleId };
	if (plan.action === "conflict") return { status: "conflict", rule: plan.rule };
	const created = await api.createRule(opts.zoneId, plan.body);
	return { status: "created", ruleId: created.id ?? created.tag ?? null, rule: plan.body };
}
