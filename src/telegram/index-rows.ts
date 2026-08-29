/**
 * message_index, as the bridge reads it.
 *
 * Every surface that draws a card — a new arrival, a search hit, an item expanded
 * out of a digest, a card restated after a button — needs the same four facts
 * about an email, and they were already written to D1 by the ingest consumer
 * before any of those surfaces existed. Reading them from one place keeps a
 * retrieved card byte-identical to the one that arrived on its own, which is the
 * whole premise of "everything the bot shows is operable".
 *
 * Its own module rather than a corner of cards.ts because noise.ts (digests) and
 * commands.ts (/inbox, /buscar) need it too, and cards.ts already imports both
 * directions of the card lifecycle — a shared read helper living there would make
 * the import graph a circle.
 */

export type MailIndexRow = {
	mailbox_id: string;
	message_local_id: string;
	thread_id: string;
	subject: string | null;
	from_addr: string;
	to_json: string | null;
	snippet: string | null;
	has_attachments: number;
	received_at: string;
	state: string;
};

const COLUMNS = `mailbox_id, message_local_id, thread_id, subject, from_addr, to_json,
                 snippet, has_attachments, received_at, state`;

export async function getMailIndexRow(
	db: D1Database,
	mailboxId: string,
	messageLocalId: string,
): Promise<MailIndexRow | null> {
	return db
		.prepare(`SELECT ${COLUMNS} FROM message_index WHERE mailbox_id = ? AND message_local_id = ?`)
		.bind(mailboxId, messageLocalId)
		.first<MailIndexRow>();
}

/** Bounded so an accidental fan-out cannot build a statement D1 will refuse. */
const MAX_IN_LIST = 60;

/**
 * The rows for a set of ids, newest first.
 *
 * One statement per mailbox rather than one per id: search and digests both
 * arrive holding a list, and a lookup per item would spend dozens of round trips
 * to render a single screen.
 */
export async function listMailIndexRows(
	db: D1Database,
	mailboxId: string,
	messageLocalIds: string[],
): Promise<MailIndexRow[]> {
	const ids = messageLocalIds.slice(0, MAX_IN_LIST);
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT ${COLUMNS} FROM message_index
       WHERE mailbox_id = ? AND message_local_id IN (${placeholders})
       ORDER BY received_at DESC`,
		)
		.bind(mailboxId, ...ids)
		.all<MailIndexRow>();
	return result.results ?? [];
}

/**
 * The newest inbound message of each of these threads.
 *
 * A card is about a message, but the Durable Object answers "what is still in the
 * inbox" in threads — so /inbox asks the DO which conversations are open and then
 * asks here which email to show for each. `state = 'inbox'` filters out the
 * replies we sent, which share the thread and would otherwise be the newest row.
 */
export async function listNewestInboxRowsForThreads(
	db: D1Database,
	mailboxId: string,
	threadIds: string[],
): Promise<MailIndexRow[]> {
	const ids = threadIds.slice(0, MAX_IN_LIST);
	if (ids.length === 0) return [];
	const placeholders = ids.map(() => "?").join(", ");
	const result = await db
		.prepare(
			`SELECT ${COLUMNS} FROM message_index
       WHERE mailbox_id = ? AND state = 'inbox' AND thread_id IN (${placeholders})
       ORDER BY received_at DESC`,
		)
		.bind(mailboxId, ...ids)
		.all<MailIndexRow>();
	const newestPerThread = new Map<string, MailIndexRow>();
	for (const row of result.results ?? []) {
		if (!newestPerThread.has(row.thread_id)) {
			newestPerThread.set(row.thread_id, row);
		}
	}
	return [...newestPerThread.values()];
}

/**
 * Has this address ever written here before?
 *
 * Asked of the whole index rather than one mailbox: the badge means "nobody at
 * this deployment has heard from this person", which is the fact worth printing
 * on an address that receives cold mail. Excluding the message being announced is
 * what makes it answerable at all — ingest has already written its row by the
 * time the notification is delivered.
 */
export async function isFirstContact(
	db: D1Database,
	input: { fromAddr: string; messageLocalId: string },
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS hit FROM message_index
       WHERE from_addr = ? COLLATE NOCASE AND message_local_id <> ? LIMIT 1`,
		)
		.bind(input.fromAddr, input.messageLocalId)
		.first<{ hit: number }>();
	return row === null;
}
