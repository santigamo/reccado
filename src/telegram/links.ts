/**
 * telegram_links, read backwards: which card announced this email.
 *
 * db/d1.ts already answers the forward question ("what is this Telegram message
 * about?"), which is all a reply needed. Reconciling state the other way — an
 * email archived on the web whose card still says pending — needs the inverse,
 * and it lives here for the same reason telegram-topics.ts does: it is bridge
 * state, read by nothing outside src/telegram, and losing the whole table costs
 * stale cards rather than mail.
 *
 * Both lookups are scoped to one chat and take the newest row. A message can own
 * more than one card — a redelivered notification posts a second one — and the
 * newest is the one the operator is looking at.
 */

import type { TelegramLinkRow } from "../db/d1";

export async function findCardForMessage(
	db: D1Database,
	input: { chatId: string; mailboxId: string; messageLocalId: string },
): Promise<TelegramLinkRow | null> {
	return db
		.prepare(
			`SELECT * FROM telegram_links
       WHERE chat_id = ? AND mailbox_id = ? AND message_local_id = ?
       ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(input.chatId, input.mailboxId, input.messageLocalId)
		.first<TelegramLinkRow>();
}

/**
 * The newest card of a conversation, for the events that know the thread and not
 * the message: a reply confirmed on the web answers a thread, and the card worth
 * marking "respondido" is the last one the operator saw — not every card the
 * thread ever produced, which would spend one edit per message on a chat that
 * accepts about one per second.
 */
export async function findCardForThread(
	db: D1Database,
	input: { chatId: string; mailboxId: string; threadId: string },
): Promise<TelegramLinkRow | null> {
	return db
		.prepare(
			`SELECT * FROM telegram_links
       WHERE chat_id = ? AND mailbox_id = ? AND thread_id = ?
       ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(input.chatId, input.mailboxId, input.threadId)
		.first<TelegramLinkRow>();
}
