/**
 * Which Telegram forum topic belongs to which mailbox.
 *
 * Lives beside the bridge rather than in db/d1.ts because it is bridge state, not
 * part of the cross-mailbox mail index: nothing outside src/telegram reads it, and
 * losing the whole table costs one recreated topic per mailbox.
 *
 * See migrations/d1/0010_telegram_topics.sql for why the mapping is per mailbox
 * and not per email thread.
 */

const nowIso = () => new Date().toISOString();

export type TelegramTopicRow = {
	chat_id: string;
	mailbox_id: string;
	topic_id: number;
	created_at: string;
};

export async function getTelegramTopicForMailbox(
	db: D1Database,
	chatId: string,
	mailboxId: string,
): Promise<number | null> {
	const row = await db
		.prepare("SELECT topic_id FROM telegram_topics WHERE chat_id = ? AND mailbox_id = ?")
		.bind(chatId, mailboxId)
		.first<{ topic_id: number }>();
	return row?.topic_id ?? null;
}

/**
 * Records the topic just created for a mailbox, and answers with the one that is
 * actually in force.
 *
 * First write wins, like chat adoption: two emails for the same mailbox can be
 * notified concurrently, and last-write-wins would split one mailbox's cards
 * across two topics forever. The loser's topic is left empty in Telegram -- an
 * unused topic is a far cheaper mistake than a mailbox whose conversation is
 * scattered -- and the caller posts into the winner.
 */
export async function claimTelegramTopic(
	db: D1Database,
	input: { chatId: string; mailboxId: string; topicId: number },
): Promise<number> {
	await db
		.prepare(
			`INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id, mailbox_id) DO NOTHING`,
		)
		.bind(input.chatId, input.mailboxId, input.topicId, nowIso())
		.run();
	// Re-read rather than trusting the insert: on conflict the row that survives is
	// the one the concurrent notification wrote, which is the topic to post into.
	return (await getTelegramTopicForMailbox(db, input.chatId, input.mailboxId)) ?? input.topicId;
}

/**
 * Forgets a mapping whose topic no longer exists in Telegram.
 *
 * The operator deleting a topic is a normal thing to do, and without this the
 * bridge would keep addressing a dead thread id and fail on every future email
 * for that mailbox.
 */
export async function forgetTelegramTopic(
	db: D1Database,
	chatId: string,
	mailboxId: string,
): Promise<void> {
	await db
		.prepare("DELETE FROM telegram_topics WHERE chat_id = ? AND mailbox_id = ?")
		.bind(chatId, mailboxId)
		.run();
}
