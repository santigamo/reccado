import { domainFromAddress } from "./email-headers";

/**
 * Which address outbound mail actually goes out as.
 *
 * The honest constraint: Cloudflare Email Sending only signs mail for domains you
 * have verified, so Reccado cannot just put the mailbox's own address in `From`
 * and hope — an unverified sender domain fails DMARC at the receiver. So the
 * operator declares the verified sending domains in MAIL_SENDING_DOMAINS, and:
 *
 *  - mailbox domain is verified  -> From: the mailbox address itself (best case,
 *    the reply comes from the address the human wrote to)
 *  - otherwise                   -> From: MAIL_FROM_ADDRESS, plus Reply-To set to
 *    the mailbox address, so the conversation still comes back to the right place
 *
 * With MAIL_SENDING_DOMAINS unset the behavior is the previous one (single global
 * From) plus the Reply-To, which is strictly better than losing the reply address.
 */
export type SenderIdentity = {
	from: string;
	replyTo: string | null;
};

export const DEFAULT_FROM_ADDRESS = "noreply@mail.example.com";

export function parseSendingDomains(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter(Boolean);
}

/**
 * Structurally typed rather than `Pick<Env, …>`: `wrangler types` emits
 * MAIL_FROM_ADDRESS as the *literal* value from wrangler.jsonc, which would force
 * every caller (and every test) to pass that exact string.
 */
export type SenderEnv = {
	MAIL_FROM_ADDRESS?: string;
	MAIL_SENDING_DOMAINS?: string;
};

export function resolveSenderIdentity(
	env: SenderEnv,
	mailboxAddress: string | null | undefined,
): SenderIdentity {
	const fallback = env.MAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS;
	const mailbox = mailboxAddress?.trim().toLowerCase() || null;
	if (!mailbox) {
		return { from: fallback, replyTo: null };
	}
	if (mailbox === fallback.toLowerCase()) {
		return { from: fallback, replyTo: null };
	}
	const domain = domainFromAddress(mailbox);
	const verified = parseSendingDomains(env.MAIL_SENDING_DOMAINS);
	if (domain && verified.includes(domain)) {
		return { from: mailbox, replyTo: null };
	}
	return { from: fallback, replyTo: mailbox };
}
