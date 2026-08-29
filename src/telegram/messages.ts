/**
 * The mailbox Durable Object, as the bridge needs it.
 *
 * Shared by the reply path (which needs the parent to quote) and the triage
 * buttons (which need to act on the message the card announced), so both agree on
 * what "the DO said no" looks like instead of each inventing its own check.
 */

/** What the DO stores about one file that travelled with an email. */
export type MailboxAttachment = {
	id: string;
	filename: string | null;
	content_type: string | null;
	size: number;
	r2_key: string;
};

export type MailboxMessage = {
	id: string;
	subject: string | null;
	from_addr: string;
	date_header: string | null;
	received_at: string;
	body_text: string | null;
	/** Always present in the DO's answer; empty for mail that carried none. */
	attachments?: MailboxAttachment[];
};

/** Exactly the verbs the DO implements; anything else is a typo, not a feature. */
export type MailboxMessageAction =
	| "mark_read"
	| "mark_unread"
	| "archive"
	| "trash"
	| "restore_inbox";

export async function fetchMailboxMessage(
	env: Env,
	mailboxId: string,
	messageLocalId: string,
): Promise<MailboxMessage | null> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const response = await stub.fetch(`https://mailbox-do/messages/${messageLocalId}`);
	if (!response.ok) {
		return null;
	}
	// The DO answers 200 with a hollow object for an unknown id, so presence of the
	// sender — the one field a reply cannot be built without — is the real check.
	const payload = (await response.json()) as { message?: Partial<MailboxMessage> };
	return payload.message?.from_addr ? (payload.message as MailboxMessage) : null;
}

/**
 * The attachment list, or nothing.
 *
 * Best effort by design: this is called while composing a notification card, and
 * a Durable Object that is slow or unreachable must cost the card its filenames,
 * never the card itself. The caller falls back to the plain "con adjuntos" line.
 */
export async function fetchMailboxAttachments(
	env: Env,
	mailboxId: string,
	messageLocalId: string,
): Promise<MailboxAttachment[] | null> {
	try {
		const message = await fetchMailboxMessage(env, mailboxId, messageLocalId);
		return message?.attachments ?? null;
	} catch (error) {
		console.warn("telegram.attachments_unavailable", {
			mailboxId,
			messageLocalId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Applies one triage verb, and says whether the DO accepted it.
 *
 * Deliberately not routed through /api: that perimeter authenticates a browser
 * carrying a Cloudflare Access JWT, which a Telegram update never has. The
 * operator check that stands in for it happens before this is called.
 */
export async function applyMailboxMessageAction(
	env: Env,
	input: { mailboxId: string; messageLocalId: string; action: MailboxMessageAction },
): Promise<boolean> {
	const stub = env.MAILBOX_DO.getByName(input.mailboxId);
	const response = await stub.fetch(`https://mailbox-do/messages/${input.messageLocalId}/actions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: input.action }),
	});
	return response.ok;
}
