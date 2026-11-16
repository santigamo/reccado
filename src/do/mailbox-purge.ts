/**
 * Permanent deletion: "Delete forever" on conversations in the Trash, and
 * "Empty trash". The one irreversible operation of the mail client, so it is
 * built to be boring:
 *
 *  - Only messages whose state is `trash` are ever deleted, and that is
 *    re-checked at the moment of deletion (a message restored while a large
 *    "Empty trash" is still running stays).
 *  - An operation first queues the message ids (`purge_queue`), then deletes in
 *    bounded batches (PURGE_BATCH_MESSAGES): the first batch inside the request,
 *    the rest from the DO alarm, so no request or transaction grows with the
 *    size of the Trash.
 *  - Each batch removes the mailbox rows in ONE synchronous transaction —
 *    message, attachments, headers, labels, search rows, thread bookkeeping,
 *    the sent draft's content — and in that same transaction records a
 *    `purge_message_objects` job holding the R2 keys and the ids whose D1 rows
 *    must go. The UI reads the DO, so it never sees a half-deleted message; the
 *    job (jobs table + alarm, like the draft upload purge) retries the R2 and D1
 *    deletes until they succeed.
 *  - An R2 object is only ever deleted when no surviving row points at it:
 *    another message (a sent copy keeps a draft upload's key, a forward keeps
 *    the original's attachment key), a draft's file, or a duplicate delivery
 *    that reused a raw key. Checked in the batch transaction and again right
 *    before the R2 call.
 *  - The ingest ledger keeps its row (marked `error_code = 'purged'`), so a
 *    re-delivered copy of a deleted email is answered "duplicate" and does not
 *    come back (mailbox-ingest.ts).
 *
 * D1 is a projection; the job deletes the rows keyed by the deleted messages
 * (message_index, telegram_links, telegram_retained). One ops event is written
 * per operation when it finishes, with counts only.
 */

type SqlStorage = DurableObjectState["storage"]["sql"];

export const PURGE_OBJECTS_JOB = "purge_message_objects";
/** Messages deleted per batch (one transaction, one cleanup job). */
export const PURGE_BATCH_MESSAGES = 250;
/** Upper bounds for one request's explicit targets (same as the bulk actions). */
export const MAX_PURGE_THREADS = 100;
export const MAX_PURGE_MESSAGES = 1000;
/** R2 delete() takes at most 1000 keys per call. */
const R2_DELETE_CHUNK = 1000;
/** D1 allows 100 bound parameters per statement; one is the mailbox id. */
const D1_ID_CHUNK = 90;
/** Same idea for the DO's own IN lists built from request ids. */
const SQL_ID_CHUNK = 90;
/** Finished operations are kept this long, for status polling and debugging. */
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type PurgeTarget =
	| { threadIds: string[] }
	| { messageIds: string[] }
	/** Every message in the Trash, with the same reports filter as the folder. */
	| { emptyTrash: { reports?: "exclude" | "only" } };

export type PurgeScope = "threads" | "messages" | "empty_trash";

export type PurgeOperationStatus = {
	operationId: string;
	scope: PurgeScope;
	status: "running" | "done";
	/** Messages queued when the operation started. */
	requested: number;
	/** Messages deleted so far. */
	deleted: number;
	/** Conversations that lost messages / disappeared entirely. */
	conversations: number;
	conversationsRemoved: number;
	/** Messages still queued. */
	remaining: number;
};

export type PurgeObjectsPayload = {
	mailboxId: string;
	messageIds: string[];
	keys: string[];
	r2Done?: boolean;
};

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

function placeholders(n: number): string {
	return Array.from({ length: n }, () => "?").join(",");
}

/**
 * v14. New tables plus the indexes that make the reference checks and the
 * attachment deletes index lookups instead of scans. Additive for every mailbox.
 */
export function createPurgeTables(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS purge_operations (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('threads', 'messages', 'empty_trash')),
  requested_messages INTEGER NOT NULL DEFAULT 0,
  deleted_messages INTEGER NOT NULL DEFAULT 0,
  touched_threads INTEGER NOT NULL DEFAULT 0,
  removed_threads INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'done')),
  -- 1 once its ops event reached D1.
  reported INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
)`);
	// The messages an operation will delete. batch_id/thread_id are only set
	// inside the transaction that deletes them, and the rows go in that same
	// transaction, so a crash never leaves a half-claimed batch behind.
	sql.exec(`CREATE TABLE IF NOT EXISTS purge_queue (
  message_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  batch_id TEXT,
  thread_id TEXT,
  created_at TEXT NOT NULL
)`);
	createPurgeThreadsTable(sql);
	sql.exec("CREATE INDEX IF NOT EXISTS idx_purge_queue_operation ON purge_queue(operation_id)");
	sql.exec("CREATE INDEX IF NOT EXISTS idx_purge_queue_batch ON purge_queue(batch_id)");
	// R2 keys a batch may delete, checked against every surviving reference.
	sql.exec(`CREATE TABLE IF NOT EXISTS purge_candidates (
  batch_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  PRIMARY KEY (batch_id, r2_key)
)`);
	sql.exec("CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id)");
	sql.exec("CREATE INDEX IF NOT EXISTS idx_attachments_r2_key ON attachments(r2_key)");
	sql.exec("CREATE INDEX IF NOT EXISTS idx_messages_raw_r2_key ON messages(raw_r2_key)");
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_messages_body_html_r2_key
       ON messages(body_html_r2_key) WHERE body_html_r2_key IS NOT NULL`,
	);
	sql.exec("CREATE INDEX IF NOT EXISTS idx_draft_attachments_r2_key ON draft_attachments(r2_key)");
}

/**
 * v15. The conversations an operation has touched so far, once each, so its
 * tallies count a conversation whose trashed messages span several batches
 * once (and say whether it is gone). Rows live only while the operation runs.
 */
export function createPurgeThreadsTable(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS purge_operation_threads (
  operation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (operation_id, thread_id)
)`);
}

/** Does any surviving message, attachment or draft file point at this R2 object? */
export function isR2KeyReferenced(sql: SqlStorage, key: string): boolean {
	return (
		sql
			.exec(
				`SELECT 1 FROM messages WHERE raw_r2_key = ?
         UNION ALL SELECT 1 FROM messages WHERE body_html_r2_key = ?
         UNION ALL SELECT 1 FROM attachments WHERE r2_key = ?
         UNION ALL SELECT 1 FROM draft_attachments WHERE r2_key = ?
         LIMIT 1`,
				key,
				key,
				key,
				key,
			)
			.toArray().length > 0
	);
}

/** A sent copy's raw key is a marker (`sent/<draftId>`), not an R2 object. */
const SENT_MARKER_PREFIX = "sent/";

function reportsClause(reports: "exclude" | "only" | undefined): string {
	if (reports === "exclude") return " AND automated_kind IS NULL";
	if (reports === "only") return " AND automated_kind IS NOT NULL";
	return "";
}

/**
 * Queue an operation. Explicit message ids must all be in the Trash (or already
 * gone: a retry of a finished delete is not an error). Conversations take only
 * their trashed messages; one with messages but none trashed is refused.
 */
export function startPurge(
	sql: SqlStorage,
	mailboxId: string,
	target: PurgeTarget,
): { operationId: string; requested: number } | { error: "not_in_trash"; ids: string[] } {
	const now = new Date().toISOString();
	const operationId = crypto.randomUUID();
	let scope: PurgeScope;
	const enqueue = (selectSql: string, ...params: SqlStorageValue[]) => {
		sql.exec(
			`INSERT OR IGNORE INTO purge_queue (message_id, operation_id, created_at)
       ${selectSql}`,
			...params,
		);
	};

	if ("messageIds" in target) {
		scope = "messages";
		const ids = [...new Set(target.messageIds)].slice(0, MAX_PURGE_MESSAGES);
		const notTrash: string[] = [];
		for (const part of chunk(ids, SQL_ID_CHUNK)) {
			for (const row of sql
				.exec<{ id: string }>(
					`SELECT id FROM messages WHERE id IN (${placeholders(part.length)}) AND state != 'trash'`,
					...part,
				)
				.toArray())
				notTrash.push(row.id);
		}
		if (notTrash.length > 0) return { error: "not_in_trash", ids: notTrash };
		for (const part of chunk(ids, SQL_ID_CHUNK)) {
			enqueue(
				`SELECT id, ?, ? FROM messages WHERE id IN (${placeholders(part.length)}) AND state = 'trash'`,
				operationId,
				now,
				...part,
			);
		}
	} else if ("threadIds" in target) {
		scope = "threads";
		const ids = [...new Set(target.threadIds)].slice(0, MAX_PURGE_THREADS);
		const trashed = new Set<string>();
		const present = new Set<string>();
		for (const part of chunk(ids, SQL_ID_CHUNK)) {
			for (const row of sql
				.exec<{ thread_id: string; trashed: number }>(
					`SELECT thread_id, MAX(state = 'trash') AS trashed FROM messages
            WHERE thread_id IN (${placeholders(part.length)}) GROUP BY thread_id`,
					...part,
				)
				.toArray()) {
				present.add(row.thread_id);
				if (row.trashed) trashed.add(row.thread_id);
			}
		}
		const refused = [...present].filter((id) => !trashed.has(id));
		if (refused.length > 0) return { error: "not_in_trash", ids: refused };
		for (const part of chunk(ids, SQL_ID_CHUNK)) {
			enqueue(
				`SELECT id, ?, ? FROM messages
          WHERE thread_id IN (${placeholders(part.length)}) AND state = 'trash'`,
				operationId,
				now,
				...part,
			);
		}
	} else {
		scope = "empty_trash";
		enqueue(
			`SELECT id, ?, ? FROM messages WHERE state = 'trash'${reportsClause(target.emptyTrash.reports)}`,
			operationId,
			now,
		);
	}

	// rowsWritten counts index writes too, so ask the queue itself.
	const requested = sql
		.exec<{ n: number }>(
			"SELECT COUNT(*) AS n FROM purge_queue WHERE operation_id = ?",
			operationId,
		)
		.one().n;
	// Nothing to delete (an empty Trash, a retry of a finished delete): done now.
	sql.exec(
		`INSERT INTO purge_operations
       (id, mailbox_id, scope, requested_messages, status, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		operationId,
		mailboxId,
		scope,
		requested,
		requested > 0 ? "running" : "done",
		now,
		now,
		requested > 0 ? null : now,
	);
	return { operationId, requested };
}

export function hasQueuedPurge(sql: SqlStorage): boolean {
	return sql.exec("SELECT 1 FROM purge_queue LIMIT 1").toArray().length > 0;
}

export type PurgeBatchResult = {
	/** The cleanup job this batch queued (R2 objects and D1 rows), if any. */
	jobId: string | null;
	deleted: number;
	/** Conversations that lost messages in this batch. */
	threadIds: string[];
	mailboxIds: string[];
};

/**
 * Delete the next batch of queued messages, in one transaction, and record the
 * job that removes their R2 objects and D1 rows. Queued messages that are no
 * longer in the Trash (restored meanwhile) or no longer exist are dropped from
 * the queue untouched.
 */
export function runPurgeBatch(
	sql: SqlStorage,
	transactionSync: (fn: () => void) => void,
	limit = PURGE_BATCH_MESSAGES,
): PurgeBatchResult {
	const batchId = crypto.randomUUID();
	const now = new Date().toISOString();
	const result: PurgeBatchResult = { jobId: null, deleted: 0, threadIds: [], mailboxIds: [] };
	const inBatch = "SELECT message_id FROM purge_queue WHERE batch_id = ?";

	transactionSync(() => {
		sql.exec(
			`UPDATE purge_queue SET batch_id = ?
        WHERE message_id IN (
          SELECT message_id FROM purge_queue WHERE batch_id IS NULL
           ORDER BY created_at ASC, rowid ASC LIMIT ?)`,
			batchId,
			limit,
		);
		// Restored (or already deleted) since it was queued: not ours to delete.
		sql.exec(
			`DELETE FROM purge_queue WHERE batch_id = ?
        AND message_id NOT IN (SELECT id FROM messages WHERE state = 'trash')`,
			batchId,
		);
		sql.exec(
			`UPDATE purge_queue
          SET thread_id = (SELECT thread_id FROM messages WHERE id = purge_queue.message_id)
        WHERE batch_id = ?`,
			batchId,
		);
		const messageIds = sql
			.exec<{ message_id: string }>(inBatch, batchId)
			.toArray()
			.map((r) => r.message_id);

		if (messageIds.length > 0) {
			// R2 objects these rows own, before the rows go.
			sql.exec(
				`INSERT OR IGNORE INTO purge_candidates (batch_id, r2_key)
           SELECT ?, raw_r2_key FROM messages
            WHERE id IN (${inBatch}) AND raw_r2_key NOT LIKE '${SENT_MARKER_PREFIX}%'
           UNION SELECT ?, body_html_r2_key FROM messages
            WHERE id IN (${inBatch}) AND body_html_r2_key IS NOT NULL
           UNION SELECT ?, r2_key FROM attachments WHERE message_id IN (${inBatch})`,
				batchId,
				batchId,
				batchId,
				batchId,
				batchId,
				batchId,
			);

			// The ingest ledger keeps the key (so a re-delivery stays a duplicate),
			// and says why the message it names is gone.
			sql.exec(
				`UPDATE ingest_events SET error_code = 'purged', error_message = NULL, updated_at = ?
          WHERE idempotency_key IN (SELECT idempotency_key FROM messages WHERE id IN (${inBatch}))`,
				now,
				batchId,
			);

			// A sent copy came from a draft that still holds what was sent, and a
			// frozen intent with the same: emptied, so "forever" means forever. The
			// row and the send markers stay — they are what stops a replayed
			// confirm-send from sending it again.
			const draftOf = `substr(raw_r2_key, ${SENT_MARKER_PREFIX.length + 1})`;
			const sentOnly = `WHERE id IN (${inBatch}) AND raw_r2_key LIKE '${SENT_MARKER_PREFIX}%'`;
			const sentDrafts = `SELECT ${draftOf} FROM messages ${sentOnly}`;
			sql.exec(
				`DELETE FROM mailbox_meta WHERE key IN (
           SELECT 'send_intent:' || ${draftOf} FROM messages ${sentOnly}
           UNION SELECT 'intent_stale:' || ${draftOf} FROM messages ${sentOnly})`,
				batchId,
				batchId,
			);
			sql.exec(
				`UPDATE outbound_drafts
            SET subject = '', body_text = NULL, body_html = NULL,
                to_json = '[]', cc_json = '[]', bcc_json = '[]', updated_at = ?
          WHERE status = 'sent' AND id IN (${sentDrafts})`,
				now,
				batchId,
			);

			// Live-update history keeps its sequence numbers but forgets what the
			// message was about.
			sql.exec(
				`UPDATE realtime_events
            SET payload_json = json_remove(payload_json, '$.subject', '$.from')
          WHERE json_extract(payload_json, '$.messageId') IN (${inBatch})`,
				batchId,
			);

			sql.exec(`DELETE FROM attachments WHERE message_id IN (${inBatch})`, batchId);
			sql.exec(`DELETE FROM message_headers WHERE message_id IN (${inBatch})`, batchId);
			sql.exec(`DELETE FROM message_labels WHERE message_id IN (${inBatch})`, batchId);
			sql.exec(`DELETE FROM message_fts WHERE message_id IN (${inBatch})`, batchId);
			sql.exec(`DELETE FROM messages WHERE id IN (${inBatch})`, batchId);

			// Conversations that keep messages stay consistent; empty ones go.
			const touched = "SELECT DISTINCT thread_id FROM purge_queue WHERE batch_id = ?";
			sql.exec(
				`UPDATE threads SET
            message_count = (SELECT COUNT(*) FROM messages m WHERE m.thread_id = threads.id),
            unread_count = (SELECT COUNT(*) FROM messages m WHERE m.thread_id = threads.id AND m.is_read = 0),
            last_message_at = COALESCE(
              (SELECT MAX(received_at) FROM messages m WHERE m.thread_id = threads.id), last_message_at),
            updated_at = ?
          WHERE id IN (${touched})`,
				now,
				batchId,
			);
			sql.exec(
				`DELETE FROM threads WHERE id IN (${touched})
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id)`,
				batchId,
			);

			// Per-operation tallies. Conversations are counted once per operation,
			// however many batches their messages took.
			sql.exec(
				`INSERT OR IGNORE INTO purge_operation_threads (operation_id, thread_id)
           SELECT DISTINCT operation_id, thread_id FROM purge_queue
            WHERE batch_id = ? AND thread_id IS NOT NULL`,
				batchId,
			);
			sql.exec(
				`UPDATE purge_operation_threads SET removed = 1
          WHERE removed = 0
            AND thread_id IN (SELECT thread_id FROM purge_queue WHERE batch_id = ?)
            AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.id = purge_operation_threads.thread_id)`,
				batchId,
			);
			for (const row of sql
				.exec<{ operation_id: string; messages: number }>(
					`SELECT operation_id, COUNT(*) AS messages FROM purge_queue
            WHERE batch_id = ? GROUP BY operation_id`,
					batchId,
				)
				.toArray()) {
				sql.exec(
					`UPDATE purge_operations SET deleted_messages = deleted_messages + ?,
              touched_threads = (SELECT COUNT(*) FROM purge_operation_threads p
                                  WHERE p.operation_id = purge_operations.id),
              removed_threads = (SELECT COALESCE(SUM(removed), 0) FROM purge_operation_threads p
                                  WHERE p.operation_id = purge_operations.id),
              updated_at = ?
            WHERE id = ?`,
					row.messages,
					now,
					row.operation_id,
				);
			}

			// Only objects nothing left in this mailbox points at.
			const keys = sql
				.exec<{ r2_key: string }>(
					`SELECT r2_key FROM purge_candidates c WHERE c.batch_id = ?
              AND NOT EXISTS (SELECT 1 FROM messages WHERE raw_r2_key = c.r2_key)
              AND NOT EXISTS (SELECT 1 FROM messages WHERE body_html_r2_key = c.r2_key)
              AND NOT EXISTS (SELECT 1 FROM attachments WHERE r2_key = c.r2_key)
              AND NOT EXISTS (SELECT 1 FROM draft_attachments WHERE r2_key = c.r2_key)`,
					batchId,
				)
				.toArray()
				.map((r) => r.r2_key);
			sql.exec("DELETE FROM purge_candidates WHERE batch_id = ?", batchId);

			const mailboxIds = sql
				.exec<{ mailbox_id: string }>(
					`SELECT DISTINCT o.mailbox_id FROM purge_queue q
             JOIN purge_operations o ON o.id = q.operation_id WHERE q.batch_id = ?`,
					batchId,
				)
				.toArray()
				.map((r) => r.mailbox_id);
			result.threadIds = sql
				.exec<{ thread_id: string }>(touched, batchId)
				.toArray()
				.map((r) => r.thread_id);
			result.mailboxIds = mailboxIds;
			result.deleted = messageIds.length;

			// One mailbox per DO, so one payload; written with the deletes so a
			// crash after this commit still knows what is left to remove.
			const jobId = crypto.randomUUID();
			const payload: PurgeObjectsPayload = {
				mailboxId: mailboxIds[0] ?? "",
				messageIds,
				keys,
			};
			sql.exec(
				`INSERT INTO jobs (id, type, payload_json, status, attempts, next_run_at, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
				jobId,
				PURGE_OBJECTS_JOB,
				JSON.stringify(payload),
				now,
				now,
				now,
			);
			result.jobId = jobId;
			sql.exec("DELETE FROM purge_queue WHERE batch_id = ?", batchId);
		}

		// Operations with nothing left queued are finished; their tallies are final.
		sql.exec(
			`UPDATE purge_operations SET status = 'done', finished_at = ?, updated_at = ?
        WHERE status = 'running'
          AND NOT EXISTS (SELECT 1 FROM purge_queue q WHERE q.operation_id = purge_operations.id)`,
			now,
			now,
		);
		sql.exec(
			`DELETE FROM purge_operation_threads WHERE operation_id IN (
         SELECT id FROM purge_operations WHERE status = 'done')`,
		);
	});
	return result;
}

/**
 * The cleanup job of one batch: R2 objects first (re-checked: nothing may have
 * started pointing at them), then the D1 rows keyed by the deleted messages.
 * Throws on any failure so the job runner retries it; progress is saved on the
 * job so a retry does not repeat what already succeeded.
 */
export async function runPurgeObjectsJob(
	ctx: {
		sql: SqlStorage;
		r2: Pick<R2Bucket, "delete">;
		db: D1Database;
		saveProgress: (payload: PurgeObjectsPayload) => void;
	},
	payload: PurgeObjectsPayload,
): Promise<void> {
	if (!payload.r2Done) {
		const keys = payload.keys.filter((key) => !isR2KeyReferenced(ctx.sql, key));
		for (const part of chunk(keys, R2_DELETE_CHUNK)) {
			if (part.length > 0) await ctx.r2.delete(part);
		}
		payload = { ...payload, keys: [], r2Done: true };
		ctx.saveProgress(payload);
	}
	if (payload.messageIds.length === 0 || !payload.mailboxId) return;
	for (const part of chunk(payload.messageIds, D1_ID_CHUNK)) {
		const list = placeholders(part.length);
		for (const statement of [
			`DELETE FROM message_index WHERE mailbox_id = ? AND message_local_id IN (${list})`,
			`DELETE FROM telegram_links WHERE mailbox_id = ? AND message_local_id IN (${list})`,
			`DELETE FROM telegram_retained WHERE mailbox_id = ? AND message_local_id IN (${list})`,
		]) {
			try {
				await ctx.db
					.prepare(statement)
					.bind(payload.mailboxId, ...part)
					.run();
			} catch (error) {
				// A deployment without the Telegram bridge tables has nothing to clean.
				const message = error instanceof Error ? error.message : String(error);
				if (/no such table/i.test(message)) continue;
				throw error;
			}
		}
	}
}

export function getPurgeOperation(
	sql: SqlStorage,
	operationId: string | undefined,
): PurgeOperationStatus | null {
	if (!operationId) return null;
	const row = sql
		.exec<{
			id: string;
			scope: PurgeScope;
			status: "running" | "done";
			requested_messages: number;
			deleted_messages: number;
			touched_threads: number;
			removed_threads: number;
		}>("SELECT * FROM purge_operations WHERE id = ?", operationId)
		.toArray()[0];
	if (!row) return null;
	const remaining =
		sql
			.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM purge_queue WHERE operation_id = ?",
				operationId,
			)
			.toArray()[0]?.n ?? 0;
	return {
		operationId: row.id,
		scope: row.scope,
		status: row.status,
		requested: row.requested_messages,
		deleted: row.deleted_messages,
		conversations: row.touched_threads,
		conversationsRemoved: row.removed_threads,
		remaining,
	};
}

/** Finished operations whose ops event has not been written yet. */
export function unreportedPurges(sql: SqlStorage): Array<{
	id: string;
	mailbox_id: string;
	scope: PurgeScope;
	deleted_messages: number;
	touched_threads: number;
	removed_threads: number;
}> {
	return sql
		.exec<{
			id: string;
			mailbox_id: string;
			scope: PurgeScope;
			deleted_messages: number;
			touched_threads: number;
			removed_threads: number;
		}>(
			`SELECT id, mailbox_id, scope, deleted_messages, touched_threads, removed_threads
         FROM purge_operations WHERE status = 'done' AND reported = 0
        ORDER BY created_at ASC LIMIT 20`,
		)
		.toArray();
}

export function markPurgeReported(sql: SqlStorage, operationId: string): void {
	sql.exec("UPDATE purge_operations SET reported = 1 WHERE id = ?", operationId);
	sql.exec(
		"DELETE FROM purge_operations WHERE status = 'done' AND reported = 1 AND finished_at < ?",
		new Date(Date.now() - OPERATION_RETENTION_MS).toISOString(),
	);
}
