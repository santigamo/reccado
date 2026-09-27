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
	/**
	 * The name the operator chose for this topic, or null for "whatever the
	 * mailbox is called" (display_name, else the address). See
	 * migrations/d1/0020_telegram_topic_name.sql.
	 */
	topic_name: string | null;
	created_at: string;
};

/** The whole mapping row, for callers that need the stored name as well as the id. */
export async function getTelegramTopicMapping(
	db: D1Database,
	chatId: string,
	mailboxId: string,
): Promise<TelegramTopicRow | null> {
	return db
		.prepare(
			"SELECT chat_id, mailbox_id, topic_id, topic_name, created_at FROM telegram_topics WHERE chat_id = ? AND mailbox_id = ?",
		)
		.bind(chatId, mailboxId)
		.first<TelegramTopicRow>();
}

/**
 * Every mapping, in every chat.
 *
 * Rows for chats other than the bound one are kept on purpose: a rebind back to
 * a previous chat finds its topics where it left them (the key includes the
 * chat, so they never collide with the new chat's).
 */
export async function listTelegramTopics(db: D1Database): Promise<TelegramTopicRow[]> {
	const result = await db
		.prepare(
			"SELECT chat_id, mailbox_id, topic_id, topic_name, created_at FROM telegram_topics ORDER BY chat_id, created_at",
		)
		.all<TelegramTopicRow>();
	return result.results ?? [];
}

/**
 * Writes a mapping unconditionally -- the operator's explicit override.
 *
 * Unlike claimTelegramTopic this is last-write-wins, which is correct only
 * because it is reachable solely from the authenticated operator route: an
 * operator replacing a mapping has decided which topic the mailbox belongs in,
 * and a concurrent notification that auto-created one loses to that decision.
 */
export async function upsertTelegramTopic(
	db: D1Database,
	input: { chatId: string; mailboxId: string; topicId: number; topicName: string | null },
): Promise<TelegramTopicRow> {
	const createdAt = nowIso();
	await db
		.prepare(
			`INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, topic_name, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, mailbox_id) DO UPDATE SET
         topic_id = excluded.topic_id,
         topic_name = excluded.topic_name,
         created_at = excluded.created_at`,
		)
		.bind(input.chatId, input.mailboxId, input.topicId, input.topicName, createdAt)
		.run();
	return {
		chat_id: input.chatId,
		mailbox_id: input.mailboxId,
		topic_id: input.topicId,
		topic_name: input.topicName,
		created_at: createdAt,
	};
}

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
	input: { chatId: string; mailboxId: string; topicId: number; topicName?: string | null },
): Promise<number> {
	await db
		.prepare(
			`INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, topic_name, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, mailbox_id) DO NOTHING`,
		)
		.bind(input.chatId, input.mailboxId, input.topicId, input.topicName ?? null, nowIso())
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
