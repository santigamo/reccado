/**
 * Mailbox operations the web inbox needs beyond one message at a time: bulk
 * folder moves and read state (with what each message was before, so the
 * client can undo exactly), restoring a discarded draft, and the lazy header
 * backfill that gives older rows their sender name and Reply-To.
 *
 * Every write goes through the same per-message rules as the single-message
 * action route (applyMessageAction), so a bulk move never treats your own
 * replies differently from a one-by-one move.
 */
import { sanitizeDisplayName } from "../lib/display-name";
import { headerBlock, parseHeaderFields } from "../lib/mime";

export const BULK_ACTIONS = [
	"mark_read",
	"mark_unread",
	"archive",
	"trash",
	"restore_inbox",
] as const;
export type BulkAction = (typeof BULK_ACTIONS)[number];

/** Upper bounds for one request: a page of conversations, and their messages. */
export const MAX_BULK_THREADS = 100;
export const MAX_BULK_MESSAGES = 1000;

/**
 * Which messages of a conversation an action by thread id may touch: the ones
 * the folder it was taken from shows. A normal folder (Inbox, Archive, Sent)
 * never touches what is in the Trash, the Trash only touches what is in it,
 * and All mail (which lists trashed messages too) touches everything.
 */
export const THREAD_SCOPES = ["live", "trash", "all"] as const;
export type ThreadScope = (typeof THREAD_SCOPES)[number];

export type BulkTarget =
	/** Whole conversations, limited to `scope` ("live" when absent). */
	| { threadIds: string[]; scope?: ThreadScope }
	| { messageIds: string[] }
	/**
	 * Every unread message of a folder ("Mark all as read"), with the same
	 * visibility rules as the thread list: a folder holds the conversations with
	 * a message in that state, and shows their messages outside the trash (Trash
	 * shows the trashed ones). `state` null is All mail.
	 */
	| {
			folder: {
				state: "inbox" | "archive" | "trash" | "sent" | null;
				reports?: "only" | "exclude";
			};
	  };

/** A message the action changed, as it was before. */
export type BulkChange = {
	id: string;
	thread_id: string;
	state: string;
	is_read: number;
};

type Row = BulkChange & { direction: string };

function placeholders(n: number): string {
	return Array.from({ length: n }, () => "?").join(",");
}

function reportsClause(alias: string, reports: "only" | "exclude" | undefined): string {
	if (reports === "exclude") return ` AND ${alias}.automated_kind IS NULL`;
	if (reports === "only") return ` AND ${alias}.automated_kind IS NOT NULL`;
	return "";
}

/** The state a move leaves a message in (your own replies stay in Sent). */
export function stateAfter(action: BulkAction, row: { state: string; direction: string }): string {
	if (action === "trash") return "trash";
	if (action === "archive") return row.direction === "outbound" ? "sent" : "archive";
	if (action === "restore_inbox") return row.direction === "outbound" ? "sent" : "inbox";
	return row.state;
}

function changes(action: BulkAction, row: Row): boolean {
	if (action === "mark_read") return row.is_read === 0;
	if (action === "mark_unread") return row.is_read === 1;
	return stateAfter(action, row) !== row.state;
}

/** SQL condition on `m` for the messages a thread scope reaches. */
export function scopeClause(scope: ThreadScope | undefined): string {
	if (scope === "all") return "";
	if (scope === "trash") return " AND m.state = 'trash'";
	return " AND m.state != 'trash'";
}

function targetRows(sql: SqlStorage, target: BulkTarget): Row[] {
	const columns = "m.id, m.thread_id, m.state, m.is_read, m.direction";
	if ("threadIds" in target) {
		const ids = [...new Set(target.threadIds)].slice(0, MAX_BULK_THREADS);
		if (ids.length === 0) return [];
		return sql
			.exec<Row>(
				`SELECT ${columns} FROM messages m
          WHERE m.thread_id IN (${placeholders(ids.length)})${scopeClause(target.scope)}`,
				...ids,
			)
			.toArray();
	}
	if ("messageIds" in target) {
		const ids = [...new Set(target.messageIds)].slice(0, MAX_BULK_MESSAGES);
		if (ids.length === 0) return [];
		return sql
			.exec<Row>(
				`SELECT ${columns} FROM messages m WHERE m.id IN (${placeholders(ids.length)})`,
				...ids,
			)
			.toArray();
	}
	const { state, reports } = target.folder;
	const visible = state === "trash" ? "m.state = 'trash'" : state ? "m.state != 'trash'" : "1 = 1";
	const inFolder = state
		? ` AND m.thread_id IN (SELECT f.thread_id FROM messages f WHERE f.state = ?${reportsClause("f", reports)})`
		: "";
	return sql
		.exec<Row>(
			`SELECT ${columns} FROM messages m
        WHERE m.is_read = 0 AND ${visible}${reportsClause("m", reports)}${inFolder}`,
			...(state ? [state] : []),
		)
		.toArray();
}

/**
 * Apply one action to many messages at once and say what each changed message
 * was before. `apply` is the single-message action (applyMessageAction), so the
 * rules are the same as one by one. Messages the action would not change are
 * left alone and not reported, so an undo restores exactly what moved.
 */
export function applyBulkAction(
	sql: SqlStorage,
	transactionSync: (fn: () => void) => void,
	apply: (messageId: string, action: BulkAction) => void,
	action: BulkAction,
	target: BulkTarget,
): { action: BulkAction; changed: BulkChange[] } {
	const rows = targetRows(sql, target).filter((row) => changes(action, row));
	transactionSync(() => {
		for (const row of rows) apply(row.id, action);
	});
	return {
		action,
		changed: rows.map(({ id, thread_id, state, is_read }) => ({
			id,
			thread_id,
			state,
			is_read: Number(is_read),
		})),
	};
}

/**
 * Bring back a draft you discarded ("Undo" after Discard). Only your own: an
 * agent's draft (origin 'mcp') stays discarded, since reviving it would revive
 * whatever approval was attached to it.
 */
export function restoreDraft(
	sql: SqlStorage,
	draftId: string | undefined,
): { id: string; status: "draft" } | { error: "draft_not_restorable" } {
	if (!draftId) return { error: "draft_not_restorable" };
	const result = sql.exec(
		`UPDATE outbound_drafts SET status = 'draft', updated_at = ?
      WHERE id = ? AND status = 'cancelled' AND origin != 'mcp'`,
		new Date().toISOString(),
		draftId,
	);
	return result.rowsWritten ? { id: draftId, status: "draft" } : { error: "draft_not_restorable" };
}

/** How much of a raw message is read to find its headers. */
export const HEADER_READ_BYTES = 64 * 1024;
/** Messages backfilled per opened thread, newest first. */
export const HEADER_BACKFILL_LIMIT = 20;

/**
 * Sender names and Reply-To for mail stored before they were kept, from the raw
 * headers already in R2: only the inbound messages of THIS thread still
 * missing them (reply_to_json IS NULL), newest first, at most
 * HEADER_BACKFILL_LIMIT, reading only the first HEADER_READ_BYTES of each. Each
 * row is written once — reply_to_json becomes '[]' when there is none — so a
 * thread pays this on its first open only. A stored name is never replaced, and
 * the name goes through the same sanitiser as at ingest. An R2 error leaves the
 * row for a later open; a missing object marks it done.
 */
export async function backfillHeaderFields(
	sql: SqlStorage,
	r2: Pick<R2Bucket, "get">,
	threadId: string,
): Promise<number> {
	const rows = sql
		.exec<{ id: string; from_addr: string; raw_r2_key: string }>(
			`SELECT id, from_addr, raw_r2_key FROM messages
        WHERE thread_id = ? AND direction = 'inbound' AND reply_to_json IS NULL
        ORDER BY received_at DESC LIMIT ?`,
			threadId,
			HEADER_BACKFILL_LIMIT,
		)
		.toArray();
	if (rows.length === 0) return 0;
	const found = await Promise.all(
		rows.map(async (row) => {
			let head: Uint8Array;
			try {
				const object = await r2.get(row.raw_r2_key, {
					range: { offset: 0, length: HEADER_READ_BYTES },
				});
				if (!object) return { row, name: null, replyTo: [] as string[] };
				head = headerBlock(new Uint8Array(await object.arrayBuffer()));
			} catch {
				// Transient storage error: try again on a later open.
				return null;
			}
			try {
				const fields = await parseHeaderFields(head);
				// The name belongs to the stored sender; a header that names someone
				// else (or nobody) gives no name.
				const sameSender =
					!fields.fromAddress || fields.fromAddress === row.from_addr.trim().toLowerCase();
				const name = sameSender ? sanitizeDisplayName(fields.fromName, row.from_addr) : null;
				return { row, name, replyTo: fields.replyTo };
			} catch {
				// Unparseable headers will not parse next time either: mark it done.
				return { row, name: null, replyTo: [] as string[] };
			}
		}),
	);
	let written = 0;
	for (const result of found) {
		if (!result) continue;
		sql.exec(
			`UPDATE messages SET from_name = COALESCE(from_name, ?), reply_to_json = ?
        WHERE id = ? AND reply_to_json IS NULL`,
			result.name,
			JSON.stringify(result.replyTo),
			result.row.id,
		);
		written++;
	}
	return written;
}
