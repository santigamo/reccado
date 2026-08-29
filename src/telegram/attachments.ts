/**
 * Attachments, one direction only: out of the mailbox and into the chat.
 *
 * The card used to say "📎 con adjuntos" and stop there, which made every email
 * carrying a file a reason to go and open the web UI — the exact trip the bridge
 * exists to save. The DO already knows each file's name, type and R2 key, and the
 * Bot API already takes multipart uploads, so the whole download half is a loop.
 *
 * Uploading is deliberately absent, and not merely unfinished: outbound_drafts
 * has no attachment model at all, so accepting a file in Telegram would mean
 * extending the DO schema, the MIME composer and the preview together. See
 * docs/plans/telegram-roadmap.md.
 */

import type { TelegramLinkRow } from "../db/d1";
import { sendDocument, type TelegramConfig } from "./api";
import { formatByteSize } from "./format";
import { type MailboxAttachment, fetchMailboxMessage } from "./messages";

/**
 * The Bot API refuses uploads above 50 MB, and a refusal arrives as a 400 that
 * looks like every other malformed request. Checking first turns "the bot is
 * broken" into "this one file is too big for Telegram".
 */
const TELEGRAM_MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * Each document is a message against the chat's ~1 per second budget, so a mail
 * with thirty inline images is capped rather than allowed to monopolise the
 * bridge for half a minute.
 */
const MAX_DOCUMENTS_PER_PRESS = 8;

export type AttachmentDelivery = {
	sent: number;
	/** Too large for Telegram, or no longer in R2. */
	skipped: number;
	/** Present when the mail carried more files than one press will send. */
	truncated: number;
};

function safeFilename(attachment: MailboxAttachment, index: number): string {
	const name = attachment.filename?.trim();
	// Path separators would let a filename chosen by a stranger decide where
	// Telegram — or whatever opens the file afterwards — thinks it belongs.
	const cleaned = name?.replace(/[/\\]/g, "_").slice(0, 120);
	return cleaned && cleaned.length > 0 ? cleaned : `adjunto-${index + 1}`;
}

/**
 * Sends every attachment of the email a card announces.
 *
 * Throws only on a transport failure the caller should report: a file missing
 * from R2 or one Telegram will not accept is counted and skipped, because the
 * other three attachments of the same email are still worth having.
 */
export async function deliverAttachments(
	env: Env,
	config: TelegramConfig,
	link: TelegramLinkRow,
): Promise<AttachmentDelivery | null> {
	const message = await fetchMailboxMessage(env, link.mailbox_id, link.message_local_id);
	const attachments = message?.attachments ?? [];
	if (attachments.length === 0) {
		return null;
	}

	const deliverable = attachments.slice(0, MAX_DOCUMENTS_PER_PRESS);
	const delivery: AttachmentDelivery = {
		sent: 0,
		skipped: 0,
		truncated: attachments.length - deliverable.length,
	};

	for (const [index, attachment] of deliverable.entries()) {
		if (attachment.size > TELEGRAM_MAX_DOCUMENT_BYTES) {
			delivery.skipped += 1;
			continue;
		}
		const object = await env.MAIL_OBJECTS.get(attachment.r2_key);
		if (!object) {
			delivery.skipped += 1;
			continue;
		}
		await sendDocument(config, {
			chatId: link.chat_id,
			filename: safeFilename(attachment, index),
			content: await object.arrayBuffer(),
			contentType: attachment.content_type ?? "application/octet-stream",
			caption: `📎 ${formatByteSize(attachment.size)}`,
			messageThreadId: link.topic_id,
			// Under the card rather than loose in the chat: the file and the email it
			// came from stay visibly the same object.
			replyToMessageId: link.message_id,
		});
		delivery.sent += 1;
	}
	return delivery;
}

/** What the operator is told after a press, in one callback answer. */
export function describeDelivery(delivery: AttachmentDelivery): string {
	const parts = [`${delivery.sent} ${delivery.sent === 1 ? "adjunto" : "adjuntos"}`];
	if (delivery.skipped > 0) parts.push(`${delivery.skipped} no disponibles`);
	if (delivery.truncated > 0) parts.push(`${delivery.truncated} sin enviar`);
	return parts.join(" · ");
}
