import { base32urlEncode } from "./crypto";

export function canonicalPrimaryAddress(email: string): string {
	const trimmed = email.trim().toLowerCase();
	const at = trimmed.indexOf("@");
	if (at <= 0) {
		throw new Error(`Invalid email address: ${email}`);
	}
	const localPart = trimmed.slice(0, at).trim();
	const domain = trimmed.slice(at + 1).trim();
	if (!localPart || !domain) {
		throw new Error(`Invalid email address: ${email}`);
	}
	return `${localPart}@${domain}`;
}

/**
 * Opaque, random mailbox id. Ids used to be HMAC-derived from the address so a provisioning
 * run could recompute them offline, which made one write-only secret part of the identity of
 * every mailbox — rotate it and every id changed. Nothing at runtime ever derived: ingest
 * resolves the mailbox by D1 lookup. So D1 is the only source of truth and the id carries no
 * address material. Format is unchanged (`mbx_` + 26 base32url chars) so pre-existing rows,
 * R2 keys and DO names stay valid: 16 random bytes encode to exactly 26 base32 chars.
 */
export function generateMailboxId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return `mbx_${base32urlEncode(bytes).slice(0, 26)}`;
}

/**
 * The id this address already has, or a fresh one for a first insert. UNIQUE(primary_address)
 * — not a shared secret — is what makes re-provisioning the same address idempotent, so callers
 * that want "create if missing" must pair this with an `ON CONFLICT(primary_address) DO NOTHING`
 * insert (see `insertMailbox`) rather than assuming the id is free.
 */
export async function mailboxIdFromPrimaryAddress(
	env: Pick<Env, "INDEX_DB">,
	primaryAddress: string,
): Promise<string> {
	const canonical = canonicalPrimaryAddress(primaryAddress);
	const existing = await env.INDEX_DB.prepare(
		"SELECT mailbox_id FROM mailboxes WHERE primary_address = ?",
	)
		.bind(canonical)
		.first<{ mailbox_id: string }>();
	return existing?.mailbox_id ?? generateMailboxId();
}
