/**
 * Read-only views of the operator's Cloudflare account for the settings UI.
 *
 * Two questions the D1 control plane cannot answer by itself:
 *   - which active zones exist in the account that Reccado has not registered yet
 *     (the "Add domain" zone picker), and
 *   - for a registered domain, what Cloudflare actually has: sending subdomains,
 *     the DMARC record on each, whether Email Routing is on, and whether each of
 *     our addresses is delivered to a Worker by a routing rule or the catch-all.
 *
 * Nothing here writes to Cloudflare. Every read degrades independently: a token
 * that can read zones but not Email Routing still yields the zone list, and the
 * missing piece comes back as `{ ok: false, reason }` rather than as a guess.
 * "Routed" is only ever reported from a rule we read; absence of evidence is
 * `unknown`, never `routed`.
 */
import type { AuthContext } from "../../api/auth";
import { getDomainByName, listAliases, listDomains, listMailboxes } from "../../db/d1";
import { readDmarcRecord } from "../dns-gate";
import { getSendingFeedbackStatus } from "../feedback-liveness";
import { fetchWithTimeout, isAbortTimeoutError } from "../runtime-config";
import { assertAdminAccess } from "./access";
import { AdminError } from "./errors";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 5_000;
/** 4 × 50 zones. An account with more than that gets the typed-domain fallback for the rest. */
const MAX_ZONE_PAGES = 4;

export type ReadFailureReason = "token_missing" | "permission" | "timeout" | "error";

export type ReadFailure = { ok: false; reason: ReadFailureReason; message: string };

class CloudflareReadError extends Error {
	constructor(
		readonly reason: ReadFailureReason,
		message: string,
	) {
		super(message);
		this.name = "CloudflareReadError";
	}
}

type Envelope<T> = {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	result?: T;
	result_info?: { page?: number; total_pages?: number };
};

async function cfGet<T>(token: string, path: string): Promise<Envelope<T>> {
	let response: Response;
	try {
		response = await fetchWithTimeout(`${CLOUDFLARE_API}${path}`, {
			headers: { Authorization: `Bearer ${token}` },
			timeoutMs: TIMEOUT_MS,
		});
	} catch (error) {
		throw new CloudflareReadError(
			isAbortTimeoutError(error) ? "timeout" : "error",
			isAbortTimeoutError(error)
				? "The Cloudflare API did not answer in time."
				: "The Cloudflare API request failed.",
		);
	}
	let body: Envelope<T> = {};
	try {
		body = (await response.json()) as Envelope<T>;
	} catch {
		// Non-JSON: the status decides below.
	}
	// 9109 = "Unauthorized to access requested resource"; 10000 = authentication error.
	if (
		response.status === 401 ||
		response.status === 403 ||
		body.errors?.some((e) => e.code === 9109 || e.code === 10000)
	) {
		throw new CloudflareReadError(
			"permission",
			"The Cloudflare token is not allowed to read this.",
		);
	}
	if (!response.ok || body.success !== true) {
		const detail = body.errors
			?.map((e) => `${e.code ?? "?"}: ${e.message ?? "unknown"}`)
			.join("; ");
		throw new CloudflareReadError(
			"error",
			`Cloudflare answered HTTP ${response.status}${detail ? ` (${detail})` : ""}.`,
		);
	}
	return body;
}

function failure(error: unknown): ReadFailure {
	if (error instanceof CloudflareReadError)
		return { ok: false, reason: error.reason, message: error.message };
	return {
		ok: false,
		reason: "error",
		message: error instanceof Error ? error.message : "Unknown error.",
	};
}

const TOKEN_MISSING: ReadFailure = {
	ok: false,
	reason: "token_missing",
	message: "CLOUDFLARE_API_TOKEN is not set on this Worker.",
};

function tokenOf(env: Env): string | null {
	return env.CLOUDFLARE_API_TOKEN?.trim() || null;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export type ZoneListing =
	| {
			ok: true;
			/** Active zones in the account that are not registered in Reccado yet. */
			zones: Array<{ id: string; name: string }>;
			/** Every active zone the token can see, including registered ones. */
			total: number;
			/** How many of those are already registered. */
			registered: number;
			/** True when the account has more zones than were read. */
			truncated: boolean;
	  }
	| ReadFailure;

export async function listAvailableZones(env: Env, actor: AuthContext): Promise<ZoneListing> {
	assertAdminAccess(env, actor, "");
	const token = tokenOf(env);
	if (!token) return TOKEN_MISSING;
	const all: Array<{ id: string; name: string }> = [];
	let truncated = false;
	try {
		for (let page = 1; page <= MAX_ZONE_PAGES; page += 1) {
			const body = await cfGet<Array<{ id?: string; name?: string; status?: string }>>(
				token,
				`/zones?status=active&per_page=50&page=${page}`,
			);
			for (const zone of body.result ?? []) {
				if (zone.id && zone.name && (zone.status ?? "active") === "active")
					all.push({ id: zone.id, name: zone.name.toLowerCase() });
			}
			const totalPages = body.result_info?.total_pages ?? 1;
			if (page >= totalPages) break;
			if (page === MAX_ZONE_PAGES) truncated = true;
		}
	} catch (error) {
		return failure(error);
	}
	const registeredNames = new Set(
		(await listDomains(env.INDEX_DB)).map((d) => d.domain.toLowerCase()),
	);
	const zones = all
		.filter((z) => !registeredNames.has(z.name))
		.sort((a, b) => a.name.localeCompare(b.name));
	return { ok: true, zones, total: all.length, registered: all.length - zones.length, truncated };
}

// ---------------------------------------------------------------------------
// Domain overview
// ---------------------------------------------------------------------------

type RoutingRule = {
	enabled?: boolean;
	matchers?: Array<{ type?: string; field?: string; value?: string }>;
	actions?: Array<{ type?: string; value?: string[] }>;
};

export type AddressRouting =
	/** An enabled rule (literal or catch-all) delivers this address to a Worker. */
	| { address: string; state: "routed"; via: "rule" | "catch_all"; workers: string[] }
	/** An enabled rule exists for the address but forwards or drops it instead. */
	| { address: string; state: "elsewhere"; via: "rule" | "catch_all"; action: string }
	/** Routing was read and nothing delivers this address anywhere. */
	| { address: string; state: "not_routed" }
	/** Routing could not be read. Never shown as routed. */
	| { address: string; state: "unknown" };

export type DmarcReading = {
	sendingDomain: string;
	/** `none` | `quarantine` | `reject`, or null when no DMARC record exists at that name. */
	policy: string | null;
	record: string | null;
};

export type DomainOverview = {
	domain: string;
	sending: { ok: true; subdomains: string[] } | ReadFailure;
	dmarc: { ok: true; records: DmarcReading[] } | ReadFailure;
	inbound: { ok: true; enabled: boolean } | ReadFailure;
	/**
	 * `addresses`: every active mailbox/alias address on the domain. `catchAll`:
	 * what happens to any other address (`*@domain`) — i.e. to a mailbox created
	 * after this read — so the UI can say whether a new address would be routed.
	 */
	routing:
		| { ok: true; enabled: boolean; addresses: AddressRouting[]; catchAll: AddressRouting }
		| (ReadFailure & { addresses: AddressRouting[]; catchAll: AddressRouting });
	/** Feedback liveness for sending domains in this zone, from our own send log (no token needed). */
	feedback: Array<{
		domain: string;
		state: "live" | "unobserved" | "never_observed" | "went_dark";
		lastEventAt: string | null;
		reason: string | null;
	}>;
};

function workerActions(rule: RoutingRule): string[] {
	return (rule.actions ?? [])
		.filter((a) => a.type === "worker")
		.flatMap((a) => a.value ?? [])
		.filter(Boolean);
}

function firstAction(rule: RoutingRule): string {
	return rule.actions?.[0]?.type ?? "unknown";
}

/**
 * Pure: given the rules Cloudflare returned, classify each address. A literal
 * `to` rule wins over the catch-all, exactly as Email Routing evaluates them.
 */
export function classifyAddressRouting(
	addresses: string[],
	rules: RoutingRule[],
	catchAll: RoutingRule | null,
): AddressRouting[] {
	return addresses.map((raw) => {
		const address = raw.toLowerCase();
		const literal = rules.find(
			(rule) =>
				rule.enabled !== false &&
				(rule.matchers ?? []).some(
					(m) =>
						m.type === "literal" &&
						(m.field ?? "to") === "to" &&
						(m.value ?? "").toLowerCase() === address,
				),
		);
		if (literal) {
			const workers = workerActions(literal);
			return workers.length > 0
				? { address, state: "routed", via: "rule", workers }
				: { address, state: "elsewhere", via: "rule", action: firstAction(literal) };
		}
		if (catchAll && catchAll.enabled === true) {
			const workers = workerActions(catchAll);
			if (workers.length > 0) return { address, state: "routed", via: "catch_all", workers };
			const action = firstAction(catchAll);
			if (action !== "drop") return { address, state: "elsewhere", via: "catch_all", action };
		}
		return { address, state: "not_routed" };
	});
}

/** Pulls `p=` out of a DMARC TXT record. */
export function dmarcPolicyOf(record: string): string | null {
	const match = record.replace(/^"|"$/g, "").match(/(?:^|;)\s*p\s*=\s*([a-z]+)/i);
	return match?.[1]?.toLowerCase() ?? null;
}

async function readAll<T>(token: string, path: string): Promise<T[]> {
	const out: T[] = [];
	for (let page = 1; page <= 4; page += 1) {
		const sep = path.includes("?") ? "&" : "?";
		const body = await cfGet<T[]>(token, `${path}${sep}per_page=50&page=${page}`);
		out.push(...(body.result ?? []));
		if (page >= (body.result_info?.total_pages ?? 1)) break;
	}
	return out;
}

export async function domainOverview(
	env: Env,
	actor: AuthContext,
	input: { domain: string },
): Promise<DomainOverview> {
	assertAdminAccess(env, actor, "");
	const name = input.domain.trim().toLowerCase();
	const domain = await getDomainByName(env.INDEX_DB, name);
	if (!domain) throw new AdminError("Domain not found", "domain_not_found", 404, false);

	const [mailboxes, aliases, feedbackStatus] = await Promise.all([
		listMailboxes(env.INDEX_DB),
		listAliases(env.INDEX_DB),
		getSendingFeedbackStatus(env.INDEX_DB).catch(() => null),
	]);
	const addressSet = new Set<string>();
	for (const m of mailboxes)
		if (m.status === "active" && m.primary_address.toLowerCase().endsWith(`@${name}`))
			addressSet.add(m.primary_address.toLowerCase());
	for (const a of aliases)
		if (a.status === "active" && a.alias_address.toLowerCase().endsWith(`@${name}`))
			addressSet.add(a.alias_address.toLowerCase());
	const addresses = [...addressSet].sort();
	const catchAllAddress = `*@${name}`;

	const feedback = (feedbackStatus?.domains ?? [])
		.filter((d) => d.domain === name || d.domain.endsWith(`.${name}`))
		.map((d) => ({
			domain: d.domain,
			state: d.state,
			lastEventAt: d.lastEventAt,
			reason: d.reason ?? null,
		}));

	const token = tokenOf(env);
	if (!token) {
		return {
			domain: name,
			sending: TOKEN_MISSING,
			dmarc: TOKEN_MISSING,
			inbound: TOKEN_MISSING,
			routing: {
				...TOKEN_MISSING,
				addresses: addresses.map((address) => ({ address, state: "unknown" as const })),
				catchAll: { address: catchAllAddress, state: "unknown" },
			},
			feedback,
		};
	}
	const zoneId = encodeURIComponent(domain.zone_id);

	const sendingRead = readAll<{ name?: string }>(token, `/zones/${zoneId}/email/sending/subdomains`)
		.then((rows) => ({
			ok: true as const,
			subdomains: rows.map((r) => (r.name ?? "").toLowerCase()).filter(Boolean),
		}))
		.catch(failure);

	const routingStatusRead = cfGet<{ enabled?: boolean }>(token, `/zones/${zoneId}/email/routing`)
		.then((body) => ({ ok: true as const, enabled: body.result?.enabled === true }))
		.catch(failure);

	const rulesRead = Promise.all([
		readAll<RoutingRule>(token, `/zones/${zoneId}/email/routing/rules`),
		cfGet<RoutingRule>(token, `/zones/${zoneId}/email/routing/rules/catch_all`).then(
			(body) => body.result ?? null,
		),
	])
		.then(([rules, catchAll]) => ({ ok: true as const, rules, catchAll }))
		.catch(failure);

	const [sending, inbound, rules] = await Promise.all([sendingRead, routingStatusRead, rulesRead]);

	let dmarc: DomainOverview["dmarc"];
	if (!sending.ok) {
		dmarc = sending;
	} else {
		try {
			const records = await Promise.all(
				sending.subdomains.map(async (sendingDomain): Promise<DmarcReading> => {
					// DNS is only ever addressed through the gate, reads included.
					const record = await readDmarcRecord(env, env.INDEX_DB, sendingDomain);
					return { sendingDomain, record, policy: record ? dmarcPolicyOf(record) : null };
				}),
			);
			dmarc = { ok: true, records };
		} catch (error) {
			dmarc = failure(error);
		}
	}

	let routing: DomainOverview["routing"];
	const unknownCatchAll: AddressRouting = { address: catchAllAddress, state: "unknown" };
	if (!inbound.ok) {
		routing = {
			...inbound,
			addresses: addresses.map((address) => ({ address, state: "unknown" as const })),
			catchAll: unknownCatchAll,
		};
	} else if (!inbound.enabled) {
		// Routing is off for the zone: nothing reaches any Worker, whatever rules say.
		routing = {
			ok: true,
			enabled: false,
			addresses: addresses.map((address) => ({ address, state: "not_routed" as const })),
			catchAll: { address: catchAllAddress, state: "not_routed" },
		};
	} else if (!rules.ok) {
		routing = {
			...rules,
			addresses: addresses.map((address) => ({ address, state: "unknown" as const })),
			catchAll: unknownCatchAll,
		};
	} else {
		routing = {
			ok: true,
			enabled: true,
			addresses: classifyAddressRouting(addresses, rules.rules, rules.catchAll),
			// Only the catch-all applies to an address no literal rule names.
			catchAll: classifyAddressRouting([catchAllAddress], [], rules.catchAll)[0]!,
		};
	}

	return { domain: name, sending, dmarc, inbound, routing, feedback };
}
