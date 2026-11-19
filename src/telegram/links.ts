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

/** How many cards one conversation action restates; older ones are long scrolled past. */
const THREAD_CARDS_LIMIT = 8;

/**
 * Every card of a conversation in this chat, newest first, one row per Telegram
 * message. For the actions that apply to the whole thread (archive, mark read):
 * each card of it has to stop offering a decision that was just made.
 */
export async function listCardsForThread(
	db: D1Database,
	input: { chatId: string; mailboxId: string; threadId: string },
): Promise<TelegramLinkRow[]> {
	const result = await db
		.prepare(
			`SELECT * FROM telegram_links
       WHERE chat_id = ? AND mailbox_id = ? AND thread_id = ?
       ORDER BY created_at DESC LIMIT ?`,
		)
		.bind(input.chatId, input.mailboxId, input.threadId, THREAD_CARDS_LIMIT * 2)
		.all<TelegramLinkRow>();
	const seen = new Set<number>();
	const cards: TelegramLinkRow[] = [];
	for (const row of result.results ?? []) {
		if (seen.has(row.message_id)) continue;
		seen.add(row.message_id);
		cards.push(row);
		if (cards.length >= THREAD_CARDS_LIMIT) break;
	}
	return cards;
}

/**
 * Has a newer message of this card's conversation been carded in this chat?
 *
 * Computed, not stored: "newer" is a fact about message_index (arrival time),
 * and a card posted later for an *older* message -- a search hit, a digest item
 * -- must not supersede the real newest one. Asked at draw time, so every
 * restatement of an old card keeps saying it is old.
 */
export async function isCardSuperseded(
	db: D1Database,
	input: { chatId: string; mailboxId: string; threadId: string; messageLocalId: string },
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS hit FROM telegram_links l
       JOIN message_index m
         ON m.mailbox_id = l.mailbox_id AND m.message_local_id = l.message_local_id
       WHERE l.chat_id = ? AND l.mailbox_id = ? AND l.thread_id = ? AND l.message_local_id <> ?
         AND m.received_at > (
           SELECT received_at FROM message_index WHERE mailbox_id = ? AND message_local_id = ?
         )
       LIMIT 1`,
		)
		.bind(
			input.chatId,
			input.mailboxId,
			input.threadId,
			input.messageLocalId,
			input.mailboxId,
			input.messageLocalId,
		)
		.first<{ hit: number }>();
	return row !== null;
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
