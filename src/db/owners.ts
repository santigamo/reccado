/**
 * Who owns this deployment, as one record with two facets.
 *
 * The web/MCP perimeter asks "is this email the operator?" and the Telegram
 * bridge asks "is this user id the operator?". Those were two allowlists in two
 * files answering one question, which is how they drift. Here they are two rows
 * of the same table, and both surfaces read the same answer.
 *
 * Nothing in this module decides trust: it stores declarations a human made and
 * reads them back. The only writer that is not a human hand is
 * consumePairingCode, and it acts on a code a human minted and a human typed.
 */

import { base32urlEncode } from "../lib/crypto";

const nowIso = () => new Date().toISOString();

export type OwnerIdentityKind = "email" | "telegram";

export type OwnerRegistry = {
	/** Lowercased owner emails: the web and MCP perimeter. */
	emails: string[];
	/** Telegram user ids, as strings, exactly as updates carry them. */
	telegramUserIds: string[];
};

const EMPTY_REGISTRY: OwnerRegistry = { emails: [], telegramUserIds: [] };

let warnedRegistryUnreadable = false;

/**
 * Reads the registry, and treats an unreadable one as empty rather than throwing.
 *
 * This is on the authentication path of every /api request, so the failure modes
 * have to be chosen deliberately. An empty registry DENIES (see isOwner in
 * api/auth.ts), so degrading to empty is degrading closed -- and it is the only
 * behaviour that keeps a deployment usable in the two cases that actually happen:
 * a worker shipped before migration 0012 ran, and a D1 blip. In both, the
 * bootstrap variable is still unioned in by the callers, so an operator who set
 * one is never locked out by a database that is merely late.
 */
export async function readOwnerRegistry(db: D1Database | undefined): Promise<OwnerRegistry> {
	if (!db) return EMPTY_REGISTRY;
	try {
		const result = await db
			.prepare(`SELECT kind, identity FROM owner_identities`)
			.all<{ kind: OwnerIdentityKind; identity: string }>();
		const emails: string[] = [];
		const telegramUserIds: string[] = [];
		for (const row of result.results ?? []) {
			if (row.kind === "email") emails.push(row.identity.trim().toLowerCase());
			else if (row.kind === "telegram") telegramUserIds.push(row.identity.trim());
		}
		return { emails, telegramUserIds };
	} catch (error) {
		if (!warnedRegistryUnreadable) {
			warnedRegistryUnreadable = true;
			console.warn("owners.registry_unreadable", {
				error: error instanceof Error ? error.message : String(error),
				hint: "Falling back to the bootstrap variables. Apply migrations/d1/0012_owner_registry.sql.",
			});
		}
		return EMPTY_REGISTRY;
	}
}

/** Normalised the way each surface presents the identity it observes. */
export function canonicalOwnerIdentity(kind: OwnerIdentityKind, identity: string): string {
	return kind === "email" ? identity.trim().toLowerCase() : identity.trim();
}

/**
 * Records an owner. Returns false when the identity was already one, so the
 * caller can tell "linked" from "linked again" without a second round trip.
 */
export async function linkOwnerIdentity(
	db: D1Database,
	input: { kind: OwnerIdentityKind; identity: string; label?: string | null; linkedVia: string },
): Promise<boolean> {
	const identity = canonicalOwnerIdentity(input.kind, input.identity);
	const result = await db
		.prepare(
			`INSERT INTO owner_identities (kind, identity, label, linked_at, linked_via)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, identity) DO NOTHING`,
		)
		.bind(input.kind, identity, input.label ?? null, nowIso(), input.linkedVia)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export type PairingCode = { code: string; expiresAt: string };

/**
 * 80 bits from the CSPRNG, base32 -- short enough to retype from a terminal into
 * Telegram, long enough that guessing it is not an attack. Not derived from
 * anything: a code that can be recomputed is a code that outlives its own expiry.
 */
function newPairingCode(): string {
	return base32urlEncode(crypto.getRandomValues(new Uint8Array(10)));
}

/** The live code, if one is outstanding. Null when none is, or when D1 is unreadable. */
export async function getOpenPairingCode(db: D1Database): Promise<PairingCode | null> {
	const row = await db
		.prepare(
			`SELECT code, expires_at FROM owner_pairing_codes
       WHERE consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(nowIso())
		.first<{ code: string; expires_at: string }>();
	return row ? { code: row.code, expiresAt: row.expires_at } : null;
}

/**
 * Mints a code if none is outstanding, and returns whichever one is now live.
 *
 * Never more than one at a time: two live codes are two standing authorities to
 * become the operator, and the second buys nothing the first did not already.
 */
export async function ensurePairingCode(
	db: D1Database,
	input: { ttlMs: number; issuedBy: string },
): Promise<{ pairing: PairingCode; minted: boolean }> {
	const existing = await getOpenPairingCode(db);
	if (existing) return { pairing: existing, minted: false };
	const pairing: PairingCode = {
		code: newPairingCode(),
		expiresAt: new Date(Date.now() + input.ttlMs).toISOString(),
	};
	await db
		.prepare(
			`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by)
       VALUES (?, ?, ?, ?)`,
		)
		.bind(pairing.code, nowIso(), pairing.expiresAt, input.issuedBy)
		.run();
	return { pairing, minted: true };
}

export type PairingClaim = "linked" | "already_owner" | "expired" | "used" | "unknown";

/**
 * Spends a pairing code, at most once, ever.
 *
 * The UPDATE carries the whole precondition -- unconsumed and unexpired -- so two
 * updates racing for the same code produce exactly one winner and D1 says which:
 * a check-then-write would let a retried Telegram update, or two people holding
 * the same code, both become owners.
 */
export async function consumePairingCode(
	db: D1Database,
	input: { code: string; kind: OwnerIdentityKind; identity: string },
): Promise<PairingClaim> {
	const code = input.code.trim();
	if (!code) return "unknown";
	const now = nowIso();
	const claimed = await db
		.prepare(
			`UPDATE owner_pairing_codes SET consumed_at = ?, consumed_by = ?
       WHERE code = ? AND consumed_at IS NULL AND expires_at > ?`,
		)
		.bind(now, canonicalOwnerIdentity(input.kind, input.identity), code, now)
		.run();
	if ((claimed.meta?.changes ?? 0) === 0) {
		const row = await db
			.prepare(`SELECT consumed_at, expires_at FROM owner_pairing_codes WHERE code = ?`)
			.bind(code)
			.first<{ consumed_at: string | null; expires_at: string }>();
		if (!row) return "unknown";
		return row.consumed_at ? "used" : "expired";
	}
	const linked = await linkOwnerIdentity(db, {
		kind: input.kind,
		identity: input.identity,
		linkedVia: "pairing_code",
	});
	// The code is spent either way. An operator who pairs an account that was
	// already an owner burned a code and changed nothing, which is the honest
	// answer to give them.
	if (!linked) return "already_owner";
	// One owner is all bootstrap needed. Leaving codes live after that would keep
	// a standing invitation open for no reason anyone asked for.
	await db.prepare(`DELETE FROM owner_pairing_codes WHERE consumed_at IS NULL`).run();
	return "linked";
}

/** Housekeeping: codes that can never be spent again are just clutter. */
export async function deleteSpentPairingCodes(db: D1Database): Promise<void> {
	await db
		.prepare(`DELETE FROM owner_pairing_codes WHERE consumed_at IS NOT NULL OR expires_at <= ?`)
		.bind(nowIso())
		.run();
}
