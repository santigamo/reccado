import { domainFromAddress } from "./email-headers";
import { isValidSenderName } from "./transactional-keys";

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
	/**
	 * Display phrase for the From header, or null for a bare address.
	 *
	 * Carried on the identity rather than derived at the send site because the
	 * name belongs to the MAILBOX, not to whichever address the fallback logic
	 * below happens to pick. When a mailbox on an unverified domain relays through
	 * MAIL_FROM_ADDRESS, "Foo Support <noreply@relay>" with Reply-To back to the
	 * mailbox is still the honest rendering: the human it names is the one who
	 * will read the reply.
	 */
	fromName: string | null;
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
	displayName?: string | null,
): SenderIdentity {
	const fallback = env.MAIL_FROM_ADDRESS?.trim() || DEFAULT_FROM_ADDRESS;
	const mailbox = mailboxAddress?.trim().toLowerCase() || null;
	// A name that cannot go in a header is dropped rather than thrown on: this
	// runs on the send path, and refusing to deliver mail because a mailbox has an
	// odd display name would be a far worse failure than sending it bare.
	const name = normalizeDisplayName(displayName);
	if (!mailbox) {
		return { from: fallback, fromName: name, replyTo: null };
	}
	if (mailbox === fallback.toLowerCase()) {
		return { from: fallback, fromName: name, replyTo: null };
	}
	const domain = domainFromAddress(mailbox);
	const verified = parseSendingDomains(env.MAIL_SENDING_DOMAINS);
	if (domain && verified.includes(domain)) {
		return { from: mailbox, fromName: name, replyTo: null };
	}
	return { from: fallback, fromName: name, replyTo: mailbox };
}

/**
 * A display name safe for a From header, or null.
 *
 * Same rule as the transactional path (`isValidSenderName`), including its
 * provisional ASCII-only restriction — see that function for why non-ASCII is
 * held back and what would lift it. Applied here too because
 * `mailboxes.display_name` is free text an operator typed and this is the last
 * point before it reaches a mail header.
 *
 * Unlike the transactional path this DROPS an unusable name instead of throwing.
 * That path is a configuration action with an operator watching a form; this one
 * runs on the send path, where refusing to deliver a reply because a mailbox has
 * an accent in its name would be a far worse failure than sending it bare.
 */
function normalizeDisplayName(value: string | null | undefined): string | null {
	if (value == null) return null;
	const trimmed = value.trim();
	return isValidSenderName(trimmed) ? trimmed : null;
}
