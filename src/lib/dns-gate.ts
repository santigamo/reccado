import { fetchWithTimeout } from "#/lib/runtime-config";

/**
 * The only door in this codebase through which a DNS record may be written.
 *
 * Reccado provisions sending domains without a human pasting anything, which
 * means the Worker holds a Cloudflare token that can edit DNS. That token is a
 * blunt instrument: it can rewrite the MX of a zone, point the apex somewhere
 * else, or take over third-party account recovery that happens to live on the
 * same domain. Those zones are shared with things that have nothing to do with
 * email, so "the token can edit the zone" is a much larger authority than "the
 * product needs to publish a DMARC policy".
 *
 * This module closes that gap in code rather than in the token, because
 * Cloudflare's permission model has no record-level scope to close it with. The
 * attenuation is structural, not advisory:
 *
 *   - The exported function takes an INTENT (which sending domain, which
 *     policy), never a record. There is no parameter through which a caller can
 *     name a record, choose a type, or supply content.
 *   - The zone is resolved from the `domains` registry in D1, never accepted
 *     from the caller. A caller who wants to write into a zone must first have
 *     that domain registered by an operator.
 *   - The record type is the string literal "TXT", written once, below.
 *   - The record name is composed here as `_dmarc.<sending domain>`, then
 *     re-checked against the zone it landed in.
 *
 * What this DOES NOT protect against, stated plainly so nobody mistakes it for
 * more than it is: if the Worker's environment leaks, the attacker has the token
 * and this file is irrelevant to them. The gate bounds what OUR OWN code can do
 * — a future endpoint, a bug, a careless refactor — not what a thief can do.
 * Keeping the blast radius small still matters (the token is scoped to Reccado's
 * zones only), but it is a different control from this one.
 *
 * A source-level guard in tests/unit/dns-gate.test.ts fails the build if any
 * other file in src/ talks to the Cloudflare DNS API directly. Without it this
 * whole design decays the first time someone is in a hurry.
 */

/** Records this module writes carry this comment, so they are identifiable in the dashboard. */
const RECORD_COMMENT = "Reccado managed DMARC (dns-gate)";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

const API_TIMEOUT_MS = 10_000;

export type DmarcPolicy = "none" | "quarantine" | "reject";
export type DmarcAlignment = "relaxed" | "strict";

export interface DnsGateEnv {
	CLOUDFLARE_API_TOKEN?: string;
}

export interface DmarcIntent {
	/** The domain mail is sent from, e.g. `notify.eccos.chat`. Not the zone. */
	sendingDomain: string;
	policy: DmarcPolicy;
	/** Relaxed unless the domain has been observed to align. */
	alignment?: DmarcAlignment;
	/** Where aggregate reports go. Without it the ramp is blind. */
	rua?: string;
}

export type DmarcOutcome =
	| { status: "unchanged"; name: string; content: string }
	| { status: "created"; name: string; content: string }
	| { status: "updated"; name: string; content: string; previous: string };

/** Thrown for every refusal, so callers can distinguish a refusal from a network failure. */
export class DnsGateRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DnsGateRefusal";
	}
}

interface CloudflareEnvelope<T> {
	success: boolean;
	errors?: Array<{ code: number; message: string }>;
	result: T;
}

interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
}

interface RegisteredDomain {
	domain: string;
	zone_id: string;
	status: string;
}

/**
 * DMARC policy string.
 *
 * Exported because `scripts/setup-sending.ts` must produce byte-identical
 * content: if the CLI and the Worker disagree by so much as a space, each run
 * sees the other's record as different and rewrites it, and the domain flaps
 * between two policies forever.
 */
export function buildDmarcValue(
	policy: DmarcPolicy,
	alignment: DmarcAlignment = "relaxed",
	rua?: string,
): string {
	const alignmentMode = alignment === "strict" ? "s" : "r";
	const tags = ["v=DMARC1", `p=${policy}`, `adkim=${alignmentMode}`, `aspf=${alignmentMode}`];
	// `pct` is meaningless in monitor mode: p=none never applies an action to any share of mail.
	if (policy !== "none") {
		tags.push("pct=100");
	}
	if (rua) {
		tags.push(`rua=mailto:${rua}`);
	}
	return tags.join("; ");
}

/**
 * TXT content as the record means it, not as the API spells it.
 *
 * Cloudflare returns provider-provisioned TXT records with their quotes inside
 * `content` ("v=DMARC1; p=reject") while API-created ones come back bare.
 * Comparing raw strings therefore fails to recognise an existing record as the
 * same one — and for DMARC the consequence is not a cosmetic duplicate: two
 * DMARC records at one name mean RFC 7489 treats the policy as ABSENT, so a
 * domain that looks configured is in fact unprotected.
 */
export function normalizeTxtContent(content: string): string {
	// A multi-string TXT ("part one" "part two") concatenates on the wire.
	return content.trim().replace(/"\s*"/g, "").replace(/^"/, "").replace(/"$/, "").trim();
}

/** Lowercased, trailing dot removed — the form DNS comparisons are safe in. */
function canonicalizeHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.$/, "");
}

function assertHostShape(host: string): void {
	// Deliberately strict. A host that reaches the composition step with a slash,
	// a space or a query character could otherwise be smuggled into the request
	// path and address a different Cloudflare resource entirely.
	if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host)) {
		throw new DnsGateRefusal(`dns-gate: refusing to act on a malformed domain "${host}".`);
	}
}

/**
 * The registered domain whose zone contains `sendingDomain`.
 *
 * Longest suffix wins, so registering both `example.com` and `mail.example.com`
 * resolves a send from `notify.mail.example.com` to the more specific zone.
 * A domain nobody registered has no zone here, and that is the point: the
 * registry is the list of zones this token is permitted to touch.
 */
async function resolveRegisteredZone(
	db: D1Database,
	sendingDomain: string,
): Promise<RegisteredDomain> {
	const rows = await db
		.prepare("SELECT domain, zone_id, status FROM domains")
		.all<RegisteredDomain>();
	const candidates = (rows.results ?? [])
		.map((row) => ({ ...row, domain: canonicalizeHost(row.domain) }))
		.filter(
			(row) => sendingDomain === row.domain || sendingDomain.endsWith(`.${row.domain}`),
		)
		.sort((a, b) => b.domain.length - a.domain.length);

	const match = candidates[0];
	if (!match) {
		throw new DnsGateRefusal(
			`dns-gate: refusing to write DNS for "${sendingDomain}" because no registered domain in the ` +
				"`domains` table contains it. Register the zone first — the registry is what bounds " +
				"which zones this token may touch.",
		);
	}
	if (match.status === "disabled") {
		throw new DnsGateRefusal(
			`dns-gate: refusing to write DNS for "${sendingDomain}" because its registered domain ` +
				`"${match.domain}" is disabled.`,
		);
	}
	if (!match.zone_id.trim()) {
		throw new DnsGateRefusal(
			`dns-gate: registered domain "${match.domain}" has no zone_id, so there is nothing to write to.`,
		);
	}
	return match;
}

async function cloudflareRequest<T>(
	token: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<T> {
	const response = await fetchWithTimeout(`${CLOUDFLARE_API}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		timeoutMs: API_TIMEOUT_MS,
	});
	const json = (await response.json()) as CloudflareEnvelope<T>;
	if (!response.ok || !json.success) {
		const details = json.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
		// The token is in the request headers, never in the path or body, so echoing
		// method+path here cannot leak it.
		throw new Error(`Cloudflare API ${method} ${path} failed${details ? ` (${details})` : ""}.`);
	}
	return json.result;
}

/**
 * Publish (or correct) the DMARC policy for one sending domain.
 *
 * Idempotent, and an upsert rather than a create on purpose: enabling Cloudflare
 * Email Sending auto-provisions its own `p=reject` DMARC record, so the first
 * run of the ramp always finds a record it has to replace rather than a clean
 * slate. Ramping straight to `reject` on a domain nobody has observed is exactly
 * how legitimate mail disappears silently, which is why the ramp exists at all.
 */
export async function ensureDmarcRecord(
	env: DnsGateEnv,
	db: D1Database,
	intent: DmarcIntent,
): Promise<DmarcOutcome> {
	const token = env.CLOUDFLARE_API_TOKEN?.trim();
	if (!token) {
		throw new DnsGateRefusal(
			"dns-gate: CLOUDFLARE_API_TOKEN is not set, so DNS cannot be written.",
		);
	}

	const sendingDomain = canonicalizeHost(intent.sendingDomain);
	assertHostShape(sendingDomain);

	const zone = await resolveRegisteredZone(db, sendingDomain);

	// ---- The name is composed here and nowhere else. -------------------------
	const name = `_dmarc.${sendingDomain}`;

	// ...and then re-checked, because the value of a structural constraint is that
	// it still holds after someone edits the line above without reading this far.
	if (name === zone.domain) {
		throw new DnsGateRefusal(
			`dns-gate: refusing to write the zone apex "${zone.domain}". This gate only ever writes ` +
				"_dmarc records; reaching the apex means the composition above is wrong.",
		);
	}
	if (!name.startsWith("_dmarc.")) {
		throw new DnsGateRefusal(`dns-gate: refusing to write "${name}", which is not a _dmarc record.`);
	}
	if (name !== `_dmarc.${zone.domain}` && !name.endsWith(`.${zone.domain}`)) {
		throw new DnsGateRefusal(
			`dns-gate: refusing to write "${name}", which is outside the registered zone "${zone.domain}".`,
		);
	}

	const desired = buildDmarcValue(intent.policy, intent.alignment ?? "relaxed", intent.rua);

	const existing = await cloudflareRequest<DnsRecord[]>(
		token,
		"GET",
		`/zones/${zone.zone_id}/dns_records?type=TXT&name=${encodeURIComponent(name)}&per_page=100`,
	);

	// Only records that are themselves DMARC policies are ours to touch. Anything
	// else that happens to sit at this name is left alone: this gate never deletes
	// a record whose meaning it does not understand.
	let managed = existing.filter((record) =>
		normalizeTxtContent(record.content).toLowerCase().startsWith("v=dmarc1"),
	);

	if (managed.length > 1) {
		// Collapse rather than refuse. Two DMARC records at one name is not a state
		// worth preserving — it is the failure mode where the domain reads as having
		// no policy at all — and Cloudflare creates the second one itself.
		for (const record of managed.slice(1)) {
			await cloudflareRequest(token, "DELETE", `/zones/${zone.zone_id}/dns_records/${record.id}`);
		}
		managed = managed.slice(0, 1);
	}

	const current = managed[0];
	if (current) {
		if (normalizeTxtContent(current.content) === normalizeTxtContent(desired)) {
			return { status: "unchanged", name, content: desired };
		}
		await cloudflareRequest(token, "PATCH", `/zones/${zone.zone_id}/dns_records/${current.id}`, {
			type: "TXT",
			name,
			content: desired,
			ttl: 1,
			comment: RECORD_COMMENT,
		});
		return {
			status: "updated",
			name,
			content: desired,
			previous: normalizeTxtContent(current.content),
		};
	}

	await cloudflareRequest(token, "POST", `/zones/${zone.zone_id}/dns_records`, {
		type: "TXT",
		name,
		content: desired,
		ttl: 1,
		comment: RECORD_COMMENT,
	});
	return { status: "created", name, content: desired };
}
