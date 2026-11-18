/**
 * Files attached to a draft, as the mailbox Durable Object keeps them: metadata
 * only. The bytes live in R2 — an upload under a draft-scoped key
 * (lib/r2-keys.ts draftAttachmentR2Key), a forwarded file by reference to the
 * original message's own attachment object — and are read back only at
 * confirm-send time, from the frozen send intent.
 *
 * Lifecycle of the R2 objects, by path:
 *  - removed from the draft: an uploaded object is deleted at once; a forwarded
 *    reference never is (the original message still owns it).
 *  - sent: the sent copy's `attachments` rows take the same objects over (an
 *    upload keeps its drafts/ key; a forwarded file keeps pointing at the
 *    original's), and the draft rows go. Nothing is copied, nothing orphaned.
 *  - discarded: kept for DRAFT_ATTACHMENT_PURGE_DELAY_MS so "Undo" (restore)
 *    brings the draft back whole; a mailbox job then deletes the uploads of a
 *    draft that is still discarded.
 *  - original deleted forever (do/mailbox-purge.ts): a forwarded reference
 *    keeps the original's object alive; when the draft then drops it, the
 *    object goes too, since nothing else points at it.
 */
import {
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENT_COUNT,
	MAX_TOTAL_ATTACHMENT_BYTES,
	normalizeAttachmentType,
	sanitizeAttachmentName,
} from "../lib/attachment-limits";
import type { SnapshotAttachment } from "../lib/outbound-attachments";
import { isR2KeyReferenced } from "./mailbox-purge";

type SqlStorage = DurableObjectState["storage"]["sql"];

/** How long a discarded draft keeps its uploads, for Undo. */
export const DRAFT_ATTACHMENT_PURGE_DELAY_MS = 24 * 60 * 60 * 1000;
export const PURGE_DRAFT_ATTACHMENTS_JOB = "purge_draft_attachments";

/** v13. A new table, so additive for every mailbox; created by the version gate. */
export function createDraftAttachmentsTable(sql: SqlStorage): void {
	sql.exec(`CREATE TABLE IF NOT EXISTS draft_attachments (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  -- 'upload': the draft owns the R2 object. 'message': a reference to another
  -- message's attachment object (forward), never deleted from here.
  source TEXT NOT NULL CHECK (source IN ('upload', 'message')),
  source_attachment_id TEXT,
  created_at TEXT NOT NULL
)`);
	sql.exec(
		"CREATE INDEX IF NOT EXISTS idx_draft_attachments_draft ON draft_attachments(draft_id, position)",
	);
}

type Row = {
	id: string;
	draft_id: string;
	position: number;
	filename: string;
	content_type: string;
	size: number;
	sha256: string;
	r2_key: string;
	source: "upload" | "message";
	source_attachment_id: string | null;
	created_at: string;
};

/** What the web sees of a draft attachment (no R2 key). */
export type DraftAttachmentDto = {
	id: string;
	filename: string;
	content_type: string;
	size: number;
	sha256: string;
	source: "upload" | "message";
	/** Forward: the original message's attachment this one refers to. */
	source_attachment_id: string | null;
	created_at: string;
};

function toDto(row: Row): DraftAttachmentDto {
	return {
		id: row.id,
		filename: row.filename,
		content_type: row.content_type,
		size: row.size,
		sha256: row.sha256,
		source: row.source,
		source_attachment_id: row.source_attachment_id,
		created_at: row.created_at,
	};
}

function rows(sql: SqlStorage, draftId: string): Row[] {
	return sql
		.exec<Row>(
			"SELECT * FROM draft_attachments WHERE draft_id = ? ORDER BY position ASC, created_at ASC",
			draftId,
		)
		.toArray();
}

export function listDraftAttachments(sql: SqlStorage, draftId: string): DraftAttachmentDto[] {
	return rows(sql, draftId).map(toDto);
}

/** draft id -> number of attachments, for the drafts list. */
export function draftAttachmentCounts(sql: SqlStorage): Map<string, number> {
	const counts = new Map<string, number>();
	for (const row of sql
		.exec<{ draft_id: string; n: number }>(
			"SELECT draft_id, COUNT(*) AS n FROM draft_attachments GROUP BY draft_id",
		)
		.toArray()) {
		counts.set(row.draft_id, Number(row.n));
	}
	return counts;
}

/** The attachments part of a send snapshot (see SnapshotAttachment for why this shape). */
export function snapshotAttachments(sql: SqlStorage, draftId: string): SnapshotAttachment[] {
	return rows(sql, draftId).map((row) => ({
		id: row.id,
		filename: row.filename,
		contentType: row.content_type,
		size: Number(row.size),
		sha256: row.sha256,
		r2Key: row.r2_key,
	}));
}

export function getDraftAttachmentRow(
	sql: SqlStorage,
	draftId: string,
	attachmentId: string,
): { r2_key: string; filename: string; content_type: string } | null {
	return (
		sql
			.exec<{ r2_key: string; filename: string; content_type: string }>(
				"SELECT r2_key, filename, content_type FROM draft_attachments WHERE draft_id = ? AND id = ?",
				draftId,
				attachmentId,
			)
			.toArray()[0] ?? null
	);
}

export type AttachmentEditError = {
	error:
		| "draft_not_editable"
		| "agent_draft_attachments"
		| "send_in_progress"
		| "too_many_attachments"
		| "attachment_too_large"
		| "attachments_too_large"
		| "attachment_not_found"
		| "message_not_found";
	currentStatus?: string | null;
};

/**
 * May the owner change this draft's files right now? Only an open draft
 * (draft / pending_confirmation), not mid-send, and not a draft that is still the
 * agent's: its approval page shows the frozen text, not files, so an attachment
 * added from the web would ride along on an approval that never showed it. The
 * owner saves the draft first (the web PATCH takes it over, origin 'web'); from
 * then on it is an owner draft and takes files like any other.
 */
function editable(sql: SqlStorage, draftId: string): AttachmentEditError | null {
	const draft = sql
		.exec<{ status: string; origin: string }>(
			"SELECT status, origin FROM outbound_drafts WHERE id = ?",
			draftId,
		)
		.toArray()[0];
	if (!draft) throw new Error("draft not found");
	if (draft.origin === "mcp") return { error: "agent_draft_attachments" };
	if (draft.status !== "draft" && draft.status !== "pending_confirmation")
		return { error: "draft_not_editable", currentStatus: draft.status };
	if (
		sql.exec("SELECT key FROM mailbox_meta WHERE key = ?", `draft_sending:${draftId}`).toArray()
			.length
	)
		return { error: "send_in_progress" };
	return null;
}

/**
 * A change to the files is a change to the payload: an armed intent stops being
 * sendable exactly as when the body is edited (updateDraft does the same), and
 * confirm-send refuses it until request-send freezes the new set.
 */
function touch(sql: SqlStorage, draftId: string): void {
	const now = new Date().toISOString();
	const status = sql
		.exec<{ status: string }>("SELECT status FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0]?.status;
	if (status === "pending_confirmation") {
		sql.exec(
			"UPDATE mailbox_meta SET value = 'stale', updated_at = ? WHERE key = ?",
			now,
			`intent_stale:${draftId}`,
		);
	}
	sql.exec("UPDATE outbound_drafts SET updated_at = ? WHERE id = ?", now, draftId);
}

function budget(sql: SqlStorage, draftId: string): { count: number; total: number; next: number } {
	const row = sql
		.exec<{ n: number; total: number | null; last: number | null }>(
			"SELECT COUNT(*) AS n, SUM(size) AS total, MAX(position) AS last FROM draft_attachments WHERE draft_id = ?",
			draftId,
		)
		.toArray()[0];
	return {
		count: Number(row?.n ?? 0),
		total: Number(row?.total ?? 0),
		next: Number(row?.last ?? -1) + 1,
	};
}

function fits(
	current: { count: number; total: number },
	size: number,
): AttachmentEditError["error"] | null {
	if (size > MAX_ATTACHMENT_BYTES) return "attachment_too_large";
	if (current.count + 1 > MAX_ATTACHMENT_COUNT) return "too_many_attachments";
	if (current.total + size > MAX_TOTAL_ATTACHMENT_BYTES) return "attachments_too_large";
	return null;
}

/**
 * Records a file the worker has already written to R2. On an error the caller
 * deletes that object again — the row is the only thing that would have kept it.
 */
export function addUploadedAttachment(
	sql: SqlStorage,
	draftId: string,
	input: {
		id: string;
		filename: string;
		contentType: string;
		size: number;
		sha256: string;
		r2Key: string;
	},
): { attachment: DraftAttachmentDto } | AttachmentEditError {
	const blocked = editable(sql, draftId);
	if (blocked) return blocked;
	const current = budget(sql, draftId);
	const over = fits(current, input.size);
	if (over) return { error: over };
	const row: Row = {
		id: input.id,
		draft_id: draftId,
		position: current.next,
		filename: sanitizeAttachmentName(input.filename),
		content_type: normalizeAttachmentType(input.contentType),
		size: input.size,
		sha256: input.sha256,
		r2_key: input.r2Key,
		source: "upload",
		source_attachment_id: null,
		created_at: new Date().toISOString(),
	};
	insertRow(sql, row);
	touch(sql, draftId);
	return { attachment: toDto(row) };
}

function insertRow(sql: SqlStorage, row: Row): void {
	sql.exec(
		`INSERT INTO draft_attachments
       (id, draft_id, position, filename, content_type, size, sha256, r2_key, source, source_attachment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.id,
		row.draft_id,
		row.position,
		row.filename,
		row.content_type,
		row.size,
		row.sha256,
		row.r2_key,
		row.source,
		row.source_attachment_id,
		row.created_at,
	);
}

export type SkippedAttachment = { id: string; filename: string; reason: string };

/**
 * Forward: the original message's files, attached by reference to the R2
 * objects it already has — no bytes move. Inline (cid:) images are included as
 * ordinary files. Files that would break a limit are skipped and reported, in
 * order, rather than failing the whole forward; one already on the draft is not
 * added twice.
 */
export function addMessageAttachments(
	sql: SqlStorage,
	draftId: string,
	messageId: string,
	attachmentIds?: readonly string[],
): { added: DraftAttachmentDto[]; skipped: SkippedAttachment[] } | AttachmentEditError {
	const blocked = editable(sql, draftId);
	if (blocked) return blocked;
	const exists = sql.exec("SELECT 1 FROM messages WHERE id = ?", messageId).toArray().length;
	if (!exists) return { error: "message_not_found" };
	const source = sql
		.exec<{
			id: string;
			filename: string | null;
			content_type: string | null;
			size: number;
			sha256: string;
			r2_key: string;
		}>(
			"SELECT id, filename, content_type, size, sha256, r2_key FROM attachments WHERE message_id = ? ORDER BY rowid ASC",
			messageId,
		)
		.toArray()
		.filter((a) => !attachmentIds || attachmentIds.includes(a.id));
	const already = new Set(
		sql
			.exec<{ source_attachment_id: string }>(
				"SELECT source_attachment_id FROM draft_attachments WHERE draft_id = ? AND source_attachment_id IS NOT NULL",
				draftId,
			)
			.toArray()
			.map((r) => r.source_attachment_id),
	);
	const added: DraftAttachmentDto[] = [];
	const skipped: SkippedAttachment[] = [];
	const current = budget(sql, draftId);
	const now = new Date().toISOString();
	for (const attachment of source) {
		const filename = sanitizeAttachmentName(attachment.filename);
		if (already.has(attachment.id)) continue;
		const size = Number(attachment.size);
		const over = fits(current, size);
		if (over) {
			skipped.push({ id: attachment.id, filename, reason: over });
			continue;
		}
		const row: Row = {
			id: crypto.randomUUID(),
			draft_id: draftId,
			position: current.next,
			filename,
			content_type: normalizeAttachmentType(attachment.content_type),
			size,
			sha256: attachment.sha256,
			r2_key: attachment.r2_key,
			source: "message",
			source_attachment_id: attachment.id,
			created_at: now,
		};
		insertRow(sql, row);
		current.count += 1;
		current.total += size;
		current.next += 1;
		added.push(toDto(row));
	}
	if (added.length > 0) touch(sql, draftId);
	return { added, skipped };
}

/** Removes one file; answers the R2 key to delete when the draft owned it. */
export function removeDraftAttachment(
	sql: SqlStorage,
	draftId: string,
	attachmentId: string,
): { removed: string; deleteR2Key: string | null } | AttachmentEditError {
	const blocked = editable(sql, draftId);
	if (blocked) return blocked;
	const row = sql
		.exec<Row>(
			"SELECT * FROM draft_attachments WHERE draft_id = ? AND id = ?",
			draftId,
			attachmentId,
		)
		.toArray()[0];
	if (!row) return { error: "attachment_not_found" };
	sql.exec("DELETE FROM draft_attachments WHERE id = ?", attachmentId);
	touch(sql, draftId);
	// A forwarded file belongs to its original message — unless that message was
	// deleted forever meanwhile and this draft was the last thing pointing at it.
	const owned = row.source === "upload" || !isR2KeyReferenced(sql, row.r2_key);
	return { removed: attachmentId, deleteR2Key: owned ? row.r2_key : null };
}

/**
 * Inside the send transaction: the sent copy lists exactly the files that went
 * out (the frozen snapshot), pointing at the same R2 objects, and the draft
 * rows are dropped — ownership moves to the message, nothing is left behind.
 */
export function transferDraftAttachmentsToMessage(
	sql: SqlStorage,
	draftId: string,
	messageLocalId: string,
	sent: readonly SnapshotAttachment[],
	now: string,
): void {
	for (const attachment of sent) {
		sql.exec(
			`INSERT INTO attachments
         (id, message_id, filename, content_type, disposition, content_id, size, sha256, r2_key, created_at)
         VALUES (?, ?, ?, ?, 'attachment', NULL, ?, ?, ?, ?)`,
			crypto.randomUUID(),
			messageLocalId,
			attachment.filename,
			attachment.contentType,
			attachment.size,
			attachment.sha256,
			attachment.r2Key,
			now,
		);
	}
	sql.exec("DELETE FROM draft_attachments WHERE draft_id = ?", draftId);
}

/** Discard: queue the uploads' deletion after the Undo window (only if there are any). */
export function scheduleDraftAttachmentPurge(sql: SqlStorage, draftId: string): string | null {
	// Any file at all: a forwarded one is normally left alone by the job, but not
	// when its original was deleted forever in the meantime.
	const files = sql
		.exec("SELECT 1 FROM draft_attachments WHERE draft_id = ? LIMIT 1", draftId)
		.toArray().length;
	if (!files) return null;
	const now = new Date();
	const runAt = new Date(now.getTime() + DRAFT_ATTACHMENT_PURGE_DELAY_MS).toISOString();
	sql.exec(
		`INSERT INTO jobs (id, type, payload_json, status, attempts, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`,
		crypto.randomUUID(),
		PURGE_DRAFT_ATTACHMENTS_JOB,
		JSON.stringify({ draftId }),
		runAt,
		now.toISOString(),
		now.toISOString(),
	);
	return runAt;
}

/**
 * The purge job: a draft that is still discarded loses its rows, and the caller
 * deletes the returned upload keys. A restored (or sent) draft is left alone.
 */
export function purgeDiscardedDraftAttachments(sql: SqlStorage, draftId: string): string[] {
	const status = sql
		.exec<{ status: string }>("SELECT status FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0]?.status;
	if (status !== undefined && status !== "cancelled") return [];
	const rows = sql
		.exec<{ r2_key: string; source: string }>(
			"SELECT r2_key, source FROM draft_attachments WHERE draft_id = ?",
			draftId,
		)
		.toArray();
	sql.exec("DELETE FROM draft_attachments WHERE draft_id = ?", draftId);
	// Uploads are the draft's own. A forwarded file goes only when nothing else
	// points at it any more (its original was deleted forever).
	return [
		...new Set(
			rows
				.filter((r) => r.source === "upload" || !isR2KeyReferenced(sql, r.r2_key))
				.map((r) => r.r2_key),
		),
	];
}
