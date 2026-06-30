import { base32urlEncode, hmacSha256 } from "./crypto";

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

export async function deriveMailboxId(secret: string, primaryAddress: string): Promise<string> {
	const canonical = canonicalPrimaryAddress(primaryAddress);
	const digest = await hmacSha256(secret, canonical);
	return `mbx_${base32urlEncode(digest).slice(0, 26)}`;
}

export async function mailboxIdFromPrimaryAddress(
	env: Pick<Env, "MAILBOX_ID_SECRET">,
	primaryAddress: string,
): Promise<string> {
	const secret = env.MAILBOX_ID_SECRET;
	if (!secret) {
		throw new Error("MAILBOX_ID_SECRET is not configured");
	}
	return deriveMailboxId(secret, primaryAddress);
}
