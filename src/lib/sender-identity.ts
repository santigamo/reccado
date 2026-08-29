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

/**
 * The mailbox address a reply should claim to come from, given the recipients of
 * the mail it answers.
 *
 * A catch-all route funnels every alias of a domain into one mailbox, so mail to
 * shop@ is stored in the mailbox whose primary_address is hello@. Answering as
 * hello@ both confuses the person who wrote to shop@ and hands them the canonical
 * address they were never given. "Ours" is decided by domain — the mailbox's own
 * domain plus anything the operator verified in MAIL_SENDING_DOMAINS — because the
 * DO cannot enumerate aliases of a catch-all. Returns null when no recipient is
 * ours (a fresh conversation, or a reply to our own outbound mail), and the caller
 * then keeps primary_address rather than inventing a sender.
 */
export function resolveDeliveredAlias(
	env: SenderEnv,
	recipients: Array<string | null | undefined>,
	primaryAddress: string | null | undefined,
): string | null {
	const ownDomains = new Set(parseSendingDomains(env.MAIL_SENDING_DOMAINS));
	const primary = primaryAddress?.trim().toLowerCase() || null;
	const primaryDomain = primary ? domainFromAddress(primary) : null;
	if (primaryDomain) ownDomains.add(primaryDomain);
	if (ownDomains.size === 0) return null;
	for (const raw of recipients) {
		const address = raw?.trim().toLowerCase();
		if (!address?.includes("@")) continue;
		const domain = domainFromAddress(address);
		if (domain && ownDomains.has(domain)) return address;
	}
	return null;
}

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
