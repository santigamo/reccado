import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { InboundEmailQueueMessage, MailboxIngestResult } from "../cloudflare/types";
import {
	approvalProofSecret,
	type McpApprovalProof,
	verifyMcpApprovalProof,
} from "../lib/approvals";
import { classifyAutomatedMail } from "../lib/automated-mail";
import { sha256Hex } from "../lib/crypto";
import { sanitizeDisplayName } from "../lib/display-name";
import { buildReferences, messageIdHeader, referencesHeader } from "../lib/email-headers";
import { normalizeMessageId } from "../lib/email-metadata";
import { AmbiguousSendError } from "../lib/errors";
import { normalizeSubject, snippetFromText } from "../lib/mime";
import {
	AttachmentUnavailableError,
	type LoadedAttachment,
	loadSnapshotAttachments,
	providerAttachments,
} from "../lib/outbound-attachments";
import { stripQuotedText } from "../lib/quoted-text";
import { bodyHtmlR2Key } from "../lib/r2-keys";
import {
	resolveDeliveredAlias,
	resolveSenderIdentity,
	type SenderEnv,
	type SenderIdentity,
} from "../lib/sender-identity";
import {
	buildParticipants,
	type ParticipantSource,
	type ThreadParticipant,
} from "../lib/thread-summary";
import { httpStatusForTransactionalResult } from "../lib/transactional-send";
import {
	addMessageAttachments,
	addUploadedAttachment,
	createDraftAttachmentsTable,
	draftAttachmentCounts,
	getDraftAttachmentRow,
	listDraftAttachments,
	PURGE_DRAFT_ATTACHMENTS_JOB,
	purgeDiscardedDraftAttachments,
	removeDraftAttachment,
	scheduleDraftAttachmentPurge,
	snapshotAttachments,
	transferDraftAttachmentsToMessage,
} from "./mailbox-draft-attachments";
import { ingestInboundEmail, recordRealtimeEvent, searchMessages } from "./mailbox-ingest";
import {
	createPurgeTables,
	getPurgeOperation,
	hasQueuedPurge,
	markPurgeReported,
	PURGE_OBJECTS_JOB,
	type PurgeObjectsPayload,
	type PurgeTarget,
	runPurgeBatch,
	runPurgeObjectsJob,
	startPurge,
	unreportedPurges,
} from "./mailbox-purge";
import {
	createRealtimeBroadcaster,
	handleWebSocketMessage,
	sendHello,
	type WebSocketAttachment,
} from "./mailbox-realtime";
import { MAILBOX_SCHEMA_SQL } from "./mailbox-schema";
import {
	applyBulkAction,
	type BulkAction,
	type BulkTarget,
	backfillHeaderFields,
	restoreDraft,
} from "./mailbox-web";

type SqlStorage = DurableObjectState["storage"]["sql"];

// Target schema_migrations version. Bump this (and the migration logic in the
// constructor) when a future legacy-schema migration needs to run again.
const MAILBOX_SCHEMA_VERSION = 14;

export type DraftOrigin = "web" | "telegram" | "mcp";

function requestedDraftOrigin(value: unknown): DraftOrigin {
	if (value === undefined) return "web";
	if (value === "web" || value === "telegram" || value === "mcp") return value;
	throw new Error("invalid_draft_origin");
}

// Minimal runtime validation for the /ingest payload. Defined locally (rather than
// imported from src/api/schemas.ts) so this DO doesn't take a dependency on the API
// layer's schema module. Mirrors InboundEmailQueueMessage in ../cloudflare/types.
const inboundEmailQueueMessageSchema = z.object({
	schemaVersion: z.literal(1),
	eventType: z.literal("email.received.v1"),
	traceId: z.string(),
	enqueuedAt: z.string(),
	receivedAt: z.string(),
	mailboxId: z.string(),
	domain: z.string(),
	recipient: z.string(),
	sender: z.string(),
	rawR2Key: z.string(),
	rawSha256: z.string(),
	rawSize: z.number(),
	messageId: z.string().nullable(),
	headers: z.object({
		subject: z.string().nullable(),
		date: z.string().nullable(),
		inReplyTo: z.string().nullable(),
		references: z.array(z.string()),
	}),
	routing: z.object({
		ruleId: z.string().nullable(),
		action: z.enum(["store", "forward", "reject"]),
		matchedAlias: z.string(),
		forwardTo: z.array(z.string()).optional(),
		rejectReason: z.string().optional(),
	}),
	idempotencyKey: z.string(),
});

function extractProviderMessageId(result: unknown): string | null {
	if (!result || typeof result !== "object") return null;
	const record = result as Record<string, unknown>;
	const candidates = [record.messageId, record.id, record.providerMessageId];
	const value = candidates.find((candidate) => typeof candidate === "string");
	return typeof value === "string" ? value : null;
}

/**
 * Classifies a provider error as ambiguous (the provider may have accepted the
 * message before the error surfaced) vs. definitely-not-delivered (the provider
 * explicitly rejected the message). Only known non-delivery signals return false;
 * everything else — network timeout, DNS failure, unknown error code — is
 * ambiguous and must NOT be auto-retried. The DO preserves the sent marker
 * so the same idempotency key cannot retry; the D1 projection records it as
 * "unknown" (not "failed") so human ops reconciliation is required.
 */
function isAmbiguousProviderError(error: unknown): boolean {
	if (!(error instanceof Error)) return true;
	const message = error.message.toLowerCase();
	// Known non-delivery signals — the provider definitely did not accept the message.
	if (
		message.includes("permanent") ||
		message.includes("rejected") ||
		message.includes("invalid") ||
		message.includes("not found") ||
		message.includes("does not exist") ||
		message.includes("address rejected") ||
		message.includes("mailbox unavailable") ||
		message.includes("user unknown") ||
		message.includes("spam blocked") ||
		message.includes("policy rejection")
	) {
		return false;
	}
	// Everything else — timeout, temporary failure, unknown error code — is ambiguous.
	return true;
}

function sentMarkerValue(providerMessageId: string | null): string {
	return JSON.stringify({ status: "sent", providerMessageId });
}

type SendMarkerStatus = "sending" | "sent" | "failed" | "unknown";

function readSendMarker(value: unknown): {
	status: SendMarkerStatus;
	providerMessageId: string | null;
	error?: string;
} {
	if (value === "sending") {
		return { status: "sending", providerMessageId: null };
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as {
				status?: unknown;
				providerMessageId?: unknown;
				error?: unknown;
			};
			if (parsed.status === "unknown") {
				return {
					status: "unknown",
					providerMessageId: null,
					error: typeof parsed.error === "string" ? parsed.error : undefined,
				};
			}
			if (parsed.status === "failed") {
				return {
					status: "failed",
					providerMessageId: null,
					error: typeof parsed.error === "string" ? parsed.error : undefined,
				};
			}
			if (parsed.status === "sent") {
				return {
					status: "sent",
					providerMessageId:
						typeof parsed.providerMessageId === "string" ? parsed.providerMessageId : null,
				};
			}
		} catch {
			// Fall through to treating any unknown persisted marker as a completed send.
		}
	}
	// Legacy "sent" string value or unrecognised JSON — assume the send completed.
	return { status: "sent", providerMessageId: null };
}

// --- Pure DO query/command logic -----------------------------------------
// These mirror the IngestContext pattern in mailbox-ingest.ts: plain functions
// taking an explicit `sql` (and, for confirmSendDraft, an explicit context
// object) instead of closing over `this`. That makes them testable without a
// real DurableObjectState. The class methods below are thin wrappers that
// just supply the DO-bound dependencies. Behavior is unchanged from before
// this extraction.

// States a thread row can be filtered/represented by. `draft` lives in the
// separate outbound_drafts table, so it is never a valid message-list filter.
const THREAD_LIST_STATES = ["inbox", "archive", "trash", "sent"] as const;
export type ThreadListState = (typeof THREAD_LIST_STATES)[number];

export function isThreadListState(value: string | null | undefined): value is ThreadListState {
	return value != null && (THREAD_LIST_STATES as readonly string[]).includes(value);
}

// Columns the Gmail-style thread list needs: enough to render a full row
// (participants, subject, snippet, time, attachment/unread affordances) without
// a second round-trip per thread. `latest_*` describe the representative message
// of the conversation: its newest message among the ones the folder shows (every
// message but trashed ones, or only trashed ones in Trash), so a reply you just
// sent is what the Inbox row previews, and what it is sorted by.
const THREAD_LIST_COLUMNS = `
  t.id, t.subject_norm, t.last_message_at,
  t.created_at, t.updated_at,
  lm.subject AS latest_subject,
  lm.from_addr AS latest_from,
  lm.from_name AS latest_from_name,
  lm.to_json AS latest_to_json,
  lm.recipient_names_json AS latest_recipient_names_json,
  lm.snippet AS latest_snippet,
  lm.received_at AS latest_received_at,
  lm.has_attachments AS latest_has_attachments,
  lm.is_read AS latest_is_read,
  lm.direction AS latest_direction,
  lm.state AS latest_state`;

/**
 * Which messages of a conversation a folder shows. Gmail's model: a conversation
 * is in a folder when any of its messages is, and it is then shown — and sorted —
 * by its newest message outside the trash. Trash shows the trashed messages only.
 * "All mail" (no state) shows everything.
 */
function visibleClause(
	alias: string,
	state: ThreadListState | undefined,
	reports?: ReportsFilter,
): string {
	const folder =
		state === "trash" ? `${alias}.state = 'trash'` : state ? `${alias}.state != 'trash'` : "1 = 1";
	return `${folder}${reportsClause(alias, reports)}`;
}

/**
 * Automated mail (DMARC aggregate reports, src/lib/automated-mail.ts) in a list
 * or a search. Absent: everything, as MCP has always seen it. `exclude`: the
 * web's normal folders, where a report is neither listed nor counted, and a
 * conversation made only of reports disappears while a person's conversation
 * that happens to hold one stays. `only`: the web's "DMARC reports" view.
 */
export type ReportsFilter = "exclude" | "only";

export function parseReportsFilter(value: string | null | undefined): ReportsFilter | undefined {
	return value === "exclude" || value === "only" ? value : undefined;
}

function reportsClause(alias: string, reports: ReportsFilter | undefined): string {
	if (reports === "exclude") return ` AND ${alias}.automated_kind IS NULL`;
	if (reports === "only") return ` AND ${alias}.automated_kind IS NOT NULL`;
	return "";
}

/** Where a page of the thread list ends: its last row's sort key. */
export type ThreadListCursor = { receivedAt: string; id: string };

/** `<latest_received_at>|<thread id>`, as the client sends back from the last row. */
export function parseThreadListCursor(
	value: string | null | undefined,
): ThreadListCursor | undefined {
	if (!value) return undefined;
	const at = value.lastIndexOf("|");
	if (at <= 0 || at === value.length - 1) return undefined;
	return { receivedAt: value.slice(0, at), id: value.slice(at + 1) };
}

export type ThreadListRow = Record<string, unknown> & {
	id: string;
	message_count: number;
	unread_count: number;
	participants: ThreadParticipant[];
};

/**
 * Exported for tests. Newest activity first in every folder: the order key is the
 * representative message's received_at (ISO-8601 UTC everywhere, so string order
 * is time order), with the thread id as a tie-breaker so the order is total and a
 * merged multi-mailbox list stays stable across refreshes. Within a thread, ties
 * on received_at (same-millisecond writes) fall back to insertion order.
 */
export function listThreads(
	sql: SqlStorage,
	limit: number,
	state?: ThreadListState,
	unread?: boolean,
	reports?: ReportsFilter,
	before?: ThreadListCursor,
): ThreadListRow[] {
	const visible = (alias: string) => visibleClause(alias, state, reports);
	const folderFilter = state
		? `WHERE EXISTS (SELECT 1 FROM messages f WHERE f.thread_id = t.id AND f.state = ?${reportsClause("f", reports)})`
		: "";
	const outer: string[] = [];
	if (unread !== undefined) outer.push(unread ? "unread_count > 0" : "unread_count = 0");
	// Keyset paging on the list order: strictly after the last row of the
	// previous page, so a page never repeats or skips a conversation.
	if (before) outer.push("(latest_received_at < ? OR (latest_received_at = ? AND id < ?))");
	const unreadFilter = outer.length ? `WHERE ${outer.join(" AND ")}` : "";
	const rows = sql
		.exec(
			`SELECT * FROM (
         SELECT ${THREAD_LIST_COLUMNS},
           (SELECT COUNT(*) FROM messages c WHERE c.thread_id = t.id AND ${visible("c")}) AS message_count,
           (SELECT COUNT(*) FROM messages u WHERE u.thread_id = t.id AND u.is_read = 0 AND ${visible("u")}) AS unread_count
         FROM threads t
         JOIN messages lm ON lm.id = (
           SELECT m.id FROM messages m WHERE m.thread_id = t.id AND ${visible("m")}
           ORDER BY m.received_at DESC, m.rowid DESC LIMIT 1
         )
         ${folderFilter}
       ) ${unreadFilter}
       ORDER BY latest_received_at DESC, id DESC
       LIMIT ?`,
			...(state ? [state] : []),
			...(before ? [before.receivedAt, before.receivedAt, before.id] : []),
			limit,
		)
		.toArray() as Array<Record<string, SqlStorageValue>>;
	if (rows.length === 0) return [];

	// Participants for the whole page in one indexed read, oldest message first.
	const ids = rows.map((r) => String(r.id));
	const senders = sql
		.exec<{ thread_id: string } & ParticipantSource>(
			`SELECT m.thread_id, m.direction, m.from_addr, m.from_name, m.is_read
         FROM messages m
        WHERE m.thread_id IN (${ids.map(() => "?").join(",")}) AND ${visible("m")}
        ORDER BY m.received_at ASC, m.rowid ASC`,
			...ids,
		)
		.toArray();
	const byThread = new Map<string, ParticipantSource[]>();
	for (const row of senders) {
		const list = byThread.get(row.thread_id) ?? [];
		list.push(row);
		byThread.set(row.thread_id, list);
	}
	return rows.map((row) => ({
		...row,
		id: String(row.id),
		message_count: Number(row.message_count ?? 0),
		unread_count: Number(row.unread_count ?? 0),
		participants: buildParticipants(byThread.get(String(row.id)) ?? []),
	}));
}

export type FolderCounts = {
	/** Conversations with at least one message in this folder (the list's rows). */
	threads: number;
	/** Of those, conversations with at least one unread message in this folder. */
	unread: number;
	/** Messages in this folder. */
	messages: number;
};

export type MailboxCounts = Record<ThreadListState | "all", FolderCounts> & {
	/** Open drafts: still editable or awaiting confirmation. */
	drafts: number;
	/**
	 * Automated reports (every state), kept out of every other figure here. Read
	 * on arrival, so `unread` is normally 0; the web shows no badge for it.
	 */
	reports: FolderCounts;
};

/**
 * Real per-folder totals for the web UI, from the mailbox's own tables. One
 * statement answered entirely from idx_messages_web_counts (state, thread_id,
 * is_read, …) WHERE automated_kind IS NULL, so it reads that partial index, never
 * the message rows, and automated reports never reach a folder figure; the
 * "all" branch scans the same index. The reports' own figure comes from
 * idx_messages_reports. Unread is counted from messages.is_read, which every
 * action maintains — threads.unread_count only ever goes up and is not used here.
 */
export function folderCounts(sql: SqlStorage): MailboxCounts {
	const empty = (): FolderCounts => ({ threads: 0, unread: 0, messages: 0 });
	const counts: MailboxCounts = {
		inbox: empty(),
		sent: empty(),
		archive: empty(),
		trash: empty(),
		all: empty(),
		drafts: 0,
		reports: empty(),
	};
	const rows = sql
		.exec<{ folder: string; threads: number; unread: number; messages: number }>(
			`SELECT state AS folder, COUNT(DISTINCT thread_id) AS threads,
              COUNT(DISTINCT CASE WHEN is_read = 0 THEN thread_id END) AS unread,
              COUNT(*) AS messages
         FROM messages WHERE automated_kind IS NULL GROUP BY state
       UNION ALL
       SELECT 'all', COUNT(DISTINCT thread_id),
              COUNT(DISTINCT CASE WHEN is_read = 0 THEN thread_id END),
              COUNT(*)
         FROM messages WHERE automated_kind IS NULL
       UNION ALL
       SELECT 'reports', COUNT(DISTINCT thread_id),
              COUNT(DISTINCT CASE WHEN is_read = 0 THEN thread_id END),
              COUNT(*)
         FROM messages WHERE automated_kind IS NOT NULL`,
		)
		.toArray();
	for (const row of rows) {
		if (row.folder === "all" || row.folder === "reports" || isThreadListState(row.folder)) {
			counts[row.folder] = { threads: row.threads, unread: row.unread, messages: row.messages };
		}
	}
	counts.drafts =
		sql
			.exec<{ n: number }>(
				"SELECT COUNT(*) AS n FROM outbound_drafts WHERE status IN ('draft', 'pending_confirmation')",
			)
			.toArray()[0]?.n ?? 0;
	return counts;
}

/**
 * The indexes behind the web counts and the reports view. Partial, so the
 * reports index holds only reports. Each carries automated_kind as its last
 * column although its WHERE already fixes it: SQLite only treats an index as
 * covering when every column the query names is in it. Created by the v11 migration, not
 * MAILBOX_SCHEMA_SQL, which runs before any migration on every cold start and
 * would fail on a mailbox that does not have the column yet.
 */
export function createAutomatedMailIndexes(sql: SqlStorage): void {
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_messages_web_counts
       ON messages(state, thread_id, is_read, automated_kind) WHERE automated_kind IS NULL`,
	);
	sql.exec(
		`CREATE INDEX IF NOT EXISTS idx_messages_reports
       ON messages(thread_id, id, is_read, automated_kind) WHERE automated_kind IS NOT NULL`,
	);
}

/**
 * Classifies the mail a mailbox already holds, from what is stored: subject,
 * sender, In-Reply-To/References and attachment file names and types. No R2
 * read. Only parsed inbound mail is a candidate (a parse failure is never
 * classified), and only rows with an attachment or "report" in the subject are
 * looked at. A report found is marked read too, like one arriving now. Returns
 * how many rows it classified. Safe to run again: it only touches NULL rows.
 */
export function backfillAutomatedKind(sql: SqlStorage): number {
	const candidates = `m.direction = 'inbound' AND m.parse_status = 'parsed'
     AND m.automated_kind IS NULL AND (m.has_attachments = 1 OR m.subject LIKE '%report%')`;
	const rows = sql
		.exec<{
			id: string;
			from_addr: string;
			subject: string | null;
			in_reply_to: string | null;
			references_json: string | null;
		}>(
			`SELECT m.id, m.from_addr, m.subject, m.in_reply_to, m.references_json
         FROM messages m WHERE ${candidates}`,
		)
		.toArray();
	if (rows.length === 0) return 0;
	const files = new Map<string, Array<{ filename: string | null; contentType: string | null }>>();
	for (const a of sql
		.exec<{ message_id: string; filename: string | null; content_type: string | null }>(
			`SELECT a.message_id, a.filename, a.content_type
         FROM attachments a JOIN messages m ON m.id = a.message_id WHERE ${candidates}`,
		)
		.toArray()) {
		const list = files.get(a.message_id) ?? [];
		list.push({ filename: a.filename, contentType: a.content_type });
		files.set(a.message_id, list);
	}
	const now = new Date().toISOString();
	let classified = 0;
	for (const row of rows) {
		let references: string[] = [];
		try {
			const parsed = JSON.parse(row.references_json ?? "[]") as unknown;
			if (Array.isArray(parsed)) references = parsed.map(String);
		} catch {
			// Unreadable references: treat as none; In-Reply-To and the subject still gate.
		}
		const kind = classifyAutomatedMail({
			from: row.from_addr,
			subject: row.subject,
			inReplyTo: row.in_reply_to,
			references,
			attachments: files.get(row.id) ?? [],
		});
		if (!kind) continue;
		sql.exec(
			"UPDATE messages SET automated_kind = ?, is_read = 1, updated_at = ? WHERE id = ?",
			kind,
			now,
			row.id,
		);
		classified++;
	}
	return classified;
}

function getThread(sql: SqlStorage, threadId: string | undefined) {
	if (!threadId) return null;
	const thread = sql.exec("SELECT * FROM threads WHERE id = ?", threadId).toArray()[0];
	const messages = sql
		.exec("SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC", threadId)
		.toArray();
	const attachments = sql
		.exec(
			"SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.thread_id = ?",
			threadId,
		)
		.toArray();
	return {
		thread,
		messages: messages.map((message) => ({
			...message,
			attachments: attachments.filter((a) => a.message_id === message.id),
		})),
	};
}

function getMessage(sql: SqlStorage, messageId: string | undefined) {
	if (!messageId) return null;
	const message = sql.exec("SELECT * FROM messages WHERE id = ?", messageId).toArray()[0];
	const attachments = sql
		.exec("SELECT * FROM attachments WHERE message_id = ?", messageId)
		.toArray();
	return { ...message, attachments };
}

function getRawMessageR2Key(sql: SqlStorage, messageId: string | undefined): string | null {
	if (!messageId) return null;
	const row = sql
		.exec<{ raw_r2_key: string }>("SELECT raw_r2_key FROM messages WHERE id = ?", messageId)
		.toArray()[0];
	return row?.raw_r2_key ?? null;
}

function getBodyHtmlR2Key(sql: SqlStorage, messageId: string | undefined): string | null {
	if (!messageId) return null;
	const row = sql
		.exec<{ body_html_r2_key: string | null }>(
			"SELECT body_html_r2_key FROM messages WHERE id = ?",
			messageId,
		)
		.toArray()[0];
	return row?.body_html_r2_key ?? null;
}

export function applyMessageAction(sql: SqlStorage, messageId: string | undefined, action: string) {
	if (!messageId) throw new Error("messageId required");
	const now = new Date().toISOString();
	if (action === "mark_read") {
		sql.exec("UPDATE messages SET is_read = 1, updated_at = ? WHERE id = ?", now, messageId);
	} else if (action === "mark_unread") {
		sql.exec("UPDATE messages SET is_read = 0, updated_at = ? WHERE id = ?", now, messageId);
	} else if (action === "archive" || action === "restore_inbox") {
		// Folder moves act on a conversation, and a conversation holds your own
		// replies too. Those are never "in the inbox" or "archived": they stay in
		// Sent, so archiving a thread doesn't empty Sent and restoring it doesn't
		// drop your replies into the Inbox as if someone had written them.
		sql.exec(
			`UPDATE messages SET state = CASE WHEN direction = 'outbound' THEN 'sent' ELSE ? END,
         updated_at = ? WHERE id = ?`,
			action === "archive" ? "archive" : "inbox",
			now,
			messageId,
		);
	} else if (action === "trash") {
		sql.exec("UPDATE messages SET state = 'trash', updated_at = ? WHERE id = ?", now, messageId);
	}
	return { ok: true, messageId, action };
}

function listDrafts(sql: SqlStorage) {
	// The count is what a list row needs (the paperclip); the files come with the draft.
	const counts = draftAttachmentCounts(sql);
	return sql
		.exec("SELECT * FROM outbound_drafts ORDER BY updated_at DESC")
		.toArray()
		.map((draft) => ({ ...draft, attachment_count: counts.get(String(draft.id)) ?? 0 }));
}

function getDraft(sql: SqlStorage, draftId: string | undefined) {
	if (!draftId) throw new Error("draftId required");
	const draft = sql.exec("SELECT * FROM outbound_drafts WHERE id = ?", draftId).toArray()[0];
	if (!draft) throw new Error("draft not found");
	return { ...draft, attachments: listDraftAttachments(sql, draftId) };
}

function createDraft(sql: SqlStorage, body: Record<string, unknown>) {
	const idempotencyKey = (body.idempotencyKey as string | undefined) ?? null;
	const origin = requestedDraftOrigin(body.origin);
	const now = new Date().toISOString();

	// Idempotent insert: if an idempotencyKey is provided and a draft with that
	// key already exists, INSERT OR IGNORE skips the insert and we return the
	// existing draft. The partial unique index (WHERE idempotency_key IS NOT NULL)
	// ensures NULL keys don't dedup.
	if (idempotencyKey) {
		const id = crypto.randomUUID();
		const result = sql.exec(
			`INSERT OR IGNORE INTO outbound_drafts
       (id, thread_id, parent_message_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
			id,
			(body.threadId as string | null) ?? null,
			(body.parentMessageId as string | null) ?? null,
			JSON.stringify(body.to ?? []),
			JSON.stringify(body.cc ?? []),
			JSON.stringify(body.bcc ?? []),
			body.subject,
			body.bodyText ?? null,
			body.bodyHtml ?? null,
			(body.createdBy as string | undefined) ?? "user",
			now,
			now,
			idempotencyKey,
		);
		if (result.rowsWritten === 0) {
			// Duplicate — fetch and return the existing draft.
			const existing = sql
				.exec<{ id: string }>(
					"SELECT id FROM outbound_drafts WHERE idempotency_key = ?",
					idempotencyKey,
				)
				.toArray()[0];
			if (existing) {
				if (origin === "mcp")
					sql.exec("UPDATE outbound_drafts SET origin = 'mcp' WHERE id = ?", existing.id);
				return { id: existing.id, status: "draft", duplicate: true };
			}
			// Unexpected: zero rows written but no existing draft. Treat as internal error.
			throw new Error("draft_idempotency_conflict_unresolved");
		}
		sql.exec("UPDATE outbound_drafts SET origin = ? WHERE id = ?", origin, id);
		return { id, status: "draft", duplicate: false };
	}

	const id = crypto.randomUUID();
	sql.exec(
		`INSERT INTO outbound_drafts
       (id, thread_id, parent_message_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
		id,
		(body.threadId as string | null) ?? null,
		(body.parentMessageId as string | null) ?? null,
		JSON.stringify(body.to ?? []),
		JSON.stringify(body.cc ?? []),
		JSON.stringify(body.bcc ?? []),
		body.subject,
		body.bodyText ?? null,
		body.bodyHtml ?? null,
		(body.createdBy as string | undefined) ?? "user",
		now,
		now,
	);
	sql.exec("UPDATE outbound_drafts SET origin = ? WHERE id = ?", origin, id);
	return { id, status: "draft" };
}

function updateDraft(sql: SqlStorage, draftId: string | undefined, body: Record<string, unknown>) {
	if (!draftId) throw new Error("draftId required");
	const origin = requestedDraftOrigin(body.origin);
	const now = new Date().toISOString();
	const allowed =
		Array.isArray(body.allowedStatuses) && body.allowedStatuses.every((s) => typeof s === "string")
			? (body.allowedStatuses as string[])
			: undefined;
	const existing = sql.exec("SELECT * FROM outbound_drafts WHERE id = ?", draftId).toArray()[0];
	if (allowed && (!existing || !allowed.includes(String(existing.status))))
		return { error: "draft_not_editable", currentStatus: existing?.status ?? null };
	if (!existing) throw new Error("draft not found");
	if (origin === "mcp") sql.exec("UPDATE outbound_drafts SET origin = 'mcp' WHERE id = ?", draftId);
	const changed =
		JSON.stringify(body.to ?? JSON.parse(String(existing.to_json))) !== existing.to_json ||
		JSON.stringify(body.cc ?? JSON.parse(String(existing.cc_json))) !== existing.cc_json ||
		JSON.stringify(body.bcc ?? JSON.parse(String(existing.bcc_json))) !== existing.bcc_json ||
		(body.subject ?? existing.subject) !== existing.subject ||
		(body.bodyText ?? existing.body_text) !== existing.body_text ||
		(body.bodyHtml ?? existing.body_html) !== existing.body_html;
	if (changed && existing.status === "pending_confirmation") {
		sql.exec(
			"UPDATE mailbox_meta SET value = 'stale', updated_at = ? WHERE key = ?",
			now,
			`intent_stale:${draftId}`,
		);
	}
	const updated = sql.exec(
		`UPDATE outbound_drafts SET
         to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_text = ?, body_html = ?, updated_at = ?
       WHERE id = ?${allowed ? ` AND status IN (${allowed.map(() => "?").join(",") || "NULL"})` : ""}`,
		JSON.stringify(body.to ?? JSON.parse(String(existing.to_json))),
		JSON.stringify(body.cc ?? JSON.parse(String(existing.cc_json))),
		JSON.stringify(body.bcc ?? JSON.parse(String(existing.bcc_json))),
		body.subject ?? existing.subject,
		body.bodyText ?? existing.body_text,
		body.bodyHtml ?? existing.body_html,
		now,
		draftId,
		...(allowed ?? []),
	);
	if (allowed && !updated.rowsWritten)
		return { error: "draft_not_editable", currentStatus: existing.status };
	return { id: draftId, status: "draft" };
}

export async function requestSendDraft(
	sql: SqlStorage,
	draftId: string | undefined,
	identity: SenderIdentity,
	replaceStale = false,
) {
	if (!draftId) throw new Error("draftId required");
	const now = new Date().toISOString();
	const row = sql
		.exec<{ status: string }>("SELECT status FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!row) throw new Error("draft not found");
	const key = `send_intent:${draftId}`;
	const existing = sql
		.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = ?", key)
		.toArray()[0];
	const staleState = sql
		.exec<{ value: string }>(
			"SELECT value FROM mailbox_meta WHERE key = ?",
			`intent_stale:${draftId}`,
		)
		.toArray()[0];
	const replacing = replaceStale && staleState?.value === "stale";
	if (row.status === "pending_confirmation" && existing && !replacing) {
		const intent = JSON.parse(existing.value) as { payload_hash: string };
		return { id: draftId, status: row.status, payload_hash: intent.payload_hash };
	}
	if (row.status !== "draft" && row.status !== "pending_confirmation")
		return { id: draftId, status: row.status };
	const snapshot = buildSendSnapshot(sql, draftId, identity);
	const serialized = JSON.stringify(snapshot);
	const payload_hash = await sha256Hex(new TextEncoder().encode(serialized));
	// No await between the recheck and writes: another request or edit cannot slip in.
	const current = sql
		.exec<{ status: string }>("SELECT status FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!current) throw new Error("draft not found");
	const raced = sql
		.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = ?", key)
		.toArray()[0];
	if (raced && (!replacing || raced.value !== existing?.value))
		return {
			id: draftId,
			status: current.status,
			payload_hash: (JSON.parse(raced.value) as { payload_hash: string }).payload_hash,
		};
	if (
		(current.status !== "draft" && current.status !== "pending_confirmation") ||
		JSON.stringify(buildSendSnapshot(sql, draftId, identity)) !== serialized
	) {
		return { id: draftId, status: current.status, error: "intent_stale" };
	}
	if (
		sql.exec("SELECT key FROM mailbox_meta WHERE key = ?", `draft_sending:${draftId}`).toArray()
			.length
	)
		return { id: draftId, status: current.status, error: "send_in_progress" };
	sql.exec(
		"INSERT OR REPLACE INTO mailbox_meta (key, value, updated_at) VALUES (?, ?, ?)",
		key,
		JSON.stringify({ snapshot, payload_hash }),
		now,
	);
	sql.exec(
		"INSERT OR REPLACE INTO mailbox_meta (key, value, updated_at) VALUES (?, 'active', ?)",
		`intent_stale:${draftId}`,
		now,
	);
	sql.exec(
		"UPDATE outbound_drafts SET status = 'pending_confirmation', updated_at = ? WHERE id = ?",
		now,
		draftId,
	);
	return { id: draftId, status: "pending_confirmation", payload_hash };
}

type ConfirmSendDraftContext = {
	sql: SqlStorage;
	transactionSync: (fn: () => void) => void;
	email: Env["EMAIL"];
	/** Display phrase for the From header, or null to send the bare address. */
	fromName?: string | null;
	fromAddress: string;
	replyToAddress: string | null;
	/**
	 * Where the sent copy's HTML body is stored, and under which mailbox. Both are
	 * needed to write it, and both are optional so a caller that only cares about
	 * the send itself (most tests) can leave them out: the sent copy then keeps its
	 * text body and skips the HTML rendering.
	 */
	r2?: Pick<R2Bucket, "put"> & Partial<Pick<R2Bucket, "get">>;
	mailboxId?: string;
	/** Present only when the worker has verified a consumed passkey approval. */
	approvalProofSecret?: string | null;
};

type ParentMessageRow = {
	rfc_message_id: string | null;
	references_json: string;
	to_json: string;
	cc_json: string;
};

const PARENT_COLUMNS = "rfc_message_id, references_json, to_json, cc_json";

/**
 * The message a reply actually answers — which decides both its In-Reply-To and,
 * under catch-all routing, the address it goes out as.
 *
 * A reply is to one message, not to a thread, so the draft's parent_message_id
 * wins when it is known: answering an old mail in a long thread has to point at
 * that mail. Drafts composed from a thread rather than a message (and drafts
 * created before the column existed) fall back to the previous heuristic — the
 * newest message in the thread carrying a Message-ID, which is the last inbound
 * mail, or our own last send when we are following up on ourselves. The same
 * fallback covers a named parent that never got a Message-ID: threading against
 * a sibling beats emitting no reply headers at all.
 */
function findThreadParent(
	sql: SqlStorage,
	threadId: string | null,
	parentMessageId: string | null,
): ParentMessageRow | null {
	if (parentMessageId) {
		const row = sql
			.exec<ParentMessageRow>(
				`SELECT ${PARENT_COLUMNS} FROM messages WHERE id = ? LIMIT 1`,
				parentMessageId,
			)
			.toArray()[0];
		if (row?.rfc_message_id) return row;
		// No Message-ID and no thread to fall back through: the row is still the right
		// source for the alias, it just cannot carry reply headers.
		if (row && !threadId) return row;
	}
	if (!threadId) return null;
	return (
		sql
			.exec<ParentMessageRow>(
				`SELECT ${PARENT_COLUMNS} FROM messages
         WHERE thread_id = ? AND rfc_message_id IS NOT NULL
         ORDER BY received_at DESC LIMIT 1`,
				threadId,
			)
			.toArray()[0] ?? null
	);
}

type SendDraft = {
	thread_id: string | null;
	parent_message_id: string | null;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	subject: string;
	body_text: string | null;
	body_html: string | null;
	status: string;
};

function buildSendSnapshot(sql: SqlStorage, draftId: string, identity: SenderIdentity) {
	const draft = sql
		.exec<SendDraft>("SELECT * FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!draft) throw new Error("draft not found");
	const parent = findThreadParent(sql, draft.thread_id, draft.parent_message_id ?? null);
	const inReplyTo = normalizeMessageId(parent?.rfc_message_id ?? null);
	const references = parent
		? buildReferences(
				(JSON.parse(parent.references_json) as string[])
					.map(normalizeMessageId)
					.filter((v): v is string => Boolean(v)),
				inReplyTo,
			)
		: [];
	return {
		identity: { from: identity.from, fromName: identity.fromName, replyTo: identity.replyTo },
		threadId: draft.thread_id,
		parentMessageId: draft.parent_message_id ?? null,
		to: JSON.parse(draft.to_json) as string[],
		cc: JSON.parse(draft.cc_json) as string[],
		bcc: JSON.parse(draft.bcc_json) as string[],
		subject: draft.subject,
		text: draft.body_text,
		html: draft.body_html,
		inReplyTo,
		references,
		// [] for a draft without files: the same JSON (and so the same payload_hash)
		// every intent froze before attachments existed.
		attachments: snapshotAttachments(sql, draftId),
	};
}

function parseAddressList(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
}

/** Addresses this mailbox has already exchanged mail with, for the approval warning. */
function seenAddresses(sql: SqlStorage): string[] {
	const rows = sql
		.exec<{ from_addr: string; to_json: string; cc_json: string }>(
			"SELECT from_addr, to_json, cc_json FROM messages",
		)
		.toArray();
	const seen = new Set<string>();
	for (const row of rows) {
		if (row.from_addr) seen.add(row.from_addr.trim().toLowerCase());
		for (const address of [...parseAddressList(row.to_json), ...parseAddressList(row.cc_json)]) {
			seen.add(address.trim().toLowerCase());
		}
	}
	return [...seen];
}

/**
 * From/Reply-To for a draft. Exported for tests: with a catch-all route this is
 * the difference between answering as shop@ and quietly outing the mailbox's
 * canonical hello@ to someone who never wrote to it.
 *
 * The alias is read off the message being answered (its To/Cc), never invented:
 * when none of the parent's recipients belongs to us — a brand-new conversation,
 * or a reply to our own outbound mail — this falls back to primary_address, which
 * is the pre-existing behavior.
 */
export function resolveReplyIdentity(
	env: SenderEnv,
	sql: SqlStorage,
	draftId: string | undefined,
	primaryAddress: string | null,
	displayName?: string | null,
): SenderIdentity {
	const alias = draftId ? resolveDraftAlias(env, sql, draftId, primaryAddress) : null;
	return resolveSenderIdentity(env, alias ?? primaryAddress, displayName);
}

function resolveDraftAlias(
	env: SenderEnv,
	sql: SqlStorage,
	draftId: string,
	primaryAddress: string | null,
): string | null {
	const draft = sql
		.exec<{ thread_id: string | null; parent_message_id: string | null }>(
			"SELECT thread_id, parent_message_id FROM outbound_drafts WHERE id = ?",
			draftId,
		)
		.toArray()[0];
	if (!draft) return null;
	const parent = findThreadParent(sql, draft.thread_id, draft.parent_message_id ?? null);
	if (!parent) return null;
	return resolveDeliveredAlias(
		env,
		[...parseAddressList(parent.to_json), ...parseAddressList(parent.cc_json)],
		primaryAddress,
	);
}

/**
 * Exported for tests: the threading behavior (which thread a reply joins, which
 * headers go on the wire) is the part worth pinning down, and the explicit ctx
 * makes it checkable with a fake email sender instead of a real provider.
 */
export async function confirmSendDraft(
	ctx: ConfirmSendDraftContext,
	draftId: string | undefined,
	idempotencyKey: string,
	expectedPayloadHash?: string,
	approvalProof?: McpApprovalProof | null,
): Promise<Record<string, unknown>> {
	if (!draftId) throw new Error("draftId required");
	let draft = ctx.sql
		.exec<SendDraft>("SELECT * FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!draft) throw new Error("draft not found");
	const origin = ctx.sql
		.exec<{ origin: string }>("SELECT origin FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0]?.origin;
	if (origin === "mcp") {
		const secret = ctx.approvalProofSecret;
		const proofOk =
			Boolean(secret) &&
			Boolean(approvalProof) &&
			Boolean(ctx.mailboxId) &&
			expectedPayloadHash !== undefined &&
			approvalProof?.payloadHash === expectedPayloadHash &&
			(await verifyMcpApprovalProof(secret as string, {
				intentId: approvalProof?.intentId ?? "",
				payloadHash: approvalProof?.payloadHash ?? "",
				exp: approvalProof?.exp ?? 0,
				sig: approvalProof?.sig ?? "",
				mailboxId: ctx.mailboxId ?? "",
				draftId,
			}));
		if (!proofOk) {
			return { id: draftId, status: draft.status, sent: false, error: "approval_required" };
		}
	}

	const sentMarker = ctx.sql
		.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = ?", idempotencyKey)
		.toArray()[0];
	if (sentMarker) {
		const marker = readSendMarker(sentMarker.value);
		if (marker.status === "failed") {
			return {
				id: draftId,
				status: "failed",
				sent: false,
				duplicate: true,
				error: "ambiguous",
				reason: marker.error ?? "ambiguous",
			};
		}
		if (marker.status === "unknown") {
			return {
				id: draftId,
				status: "unknown",
				sent: false,
				duplicate: true,
				error: "ambiguous",
				reason: marker.error ?? "unknown",
			};
		}
		return {
			id: draftId,
			status: marker.status,
			sent: false,
			duplicate: true,
			providerMessageId: marker.providerMessageId,
			reason: marker.status === "sending" ? "send_in_progress" : undefined,
		};
	}
	if (draft.status !== "pending_confirmation") {
		return { id: draftId, status: draft.status, sent: false, reason: "not_pending_confirmation" };
	}
	const stored = ctx.sql
		.exec<{ value: string }>(
			"SELECT value FROM mailbox_meta WHERE key = ?",
			`send_intent:${draftId}`,
		)
		.toArray()[0];
	const stale = () => ({
		id: draftId,
		status: "pending_confirmation",
		sent: false,
		error: "intent_stale",
	});
	if (!stored) return stale();
	let intent: { snapshot: ReturnType<typeof buildSendSnapshot>; payload_hash: string };
	try {
		intent = JSON.parse(stored.value) as typeof intent;
	} catch {
		return stale();
	}
	if (expectedPayloadHash !== undefined && expectedPayloadHash !== intent.payload_hash)
		return stale();
	const serialized = JSON.stringify(intent.snapshot);
	if (
		!serialized ||
		(await sha256Hex(new TextEncoder().encode(serialized))) !== intent.payload_hash
	)
		return stale();
	const staleMarker = ctx.sql
		.exec<{ value: string }>(
			"SELECT value FROM mailbox_meta WHERE key = ?",
			`intent_stale:${draftId}`,
		)
		.toArray()[0];
	const current = ctx.sql
		.exec<SendDraft>("SELECT * FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!current || current.status !== "pending_confirmation")
		return { id: draftId, status: current?.status ?? "missing", sent: false, duplicate: true };
	try {
		if (
			staleMarker?.value !== "active" ||
			JSON.stringify(buildSendSnapshot(ctx.sql, draftId, intent.snapshot.identity)) !== serialized
		)
			return stale();
	} catch {
		return stale();
	}
	const snapshot = intent.snapshot;
	// All subsequent wire and sent-copy fields come from the frozen intent.
	draft = {
		...draft,
		thread_id: snapshot.threadId,
		parent_message_id: snapshot.parentMessageId,
		to_json: JSON.stringify(snapshot.to),
		cc_json: JSON.stringify(snapshot.cc),
		bcc_json: JSON.stringify(snapshot.bcc),
		subject: snapshot.subject,
		body_text: snapshot.text,
		body_html: snapshot.html,
	};

	const to = JSON.parse(draft.to_json) as string[];
	const cc = JSON.parse(draft.cc_json) as string[];
	const bcc = JSON.parse(draft.bcc_json) as string[];
	const totalRecipients = to.length + cc.length + bcc.length;
	if (totalRecipients > 50) {
		return {
			id: draftId,
			status: draft.status,
			sent: false,
			error: "too_many_recipients",
			recipientCount: totalRecipients,
		};
	}

	const fromAddress = snapshot.identity.from;
	const now = new Date().toISOString();
	const sentKey = idempotencyKey;
	try {
		ctx.sql.exec(
			"INSERT INTO mailbox_meta (key, value, updated_at) VALUES (?, 'sending', ?)",
			sentKey,
			now,
		);
	} catch {
		return { id: draftId, status: "sending", sent: false, duplicate: true };
	}

	// Threading, the part that makes a reply read as a reply in the recipient's
	// client. In-Reply-To and References are on Cloudflare Email Service's custom
	// header allowlist ("critical for email threading in all clients"); Message-ID
	// is NOT — it is platform-controlled and generated by Cloudflare, and sending
	// our own would be rejected as a restricted header. So we set the two we may
	// set and take the sent id back from the provider below.
	const threadId = draft.thread_id ?? crypto.randomUUID();
	const inReplyTo = snapshot.inReplyTo;
	const references = snapshot.references;
	const outboundHeaders: Record<string, string> = {};
	if (inReplyTo) {
		outboundHeaders["In-Reply-To"] = messageIdHeader(inReplyTo);
		outboundHeaders.References = referencesHeader(references);
	}

	let providerMessageId: string | null = null;
	let loadedAttachments: LoadedAttachment[] = [];
	try {
		// Atomic per-draft send gate: only one idempotency key per draft may
		// proceed to EMAIL.send. A different attempt key targeting the same draft
		// will fail this INSERT (PRIMARY KEY conflict on mailbox_meta) and return
		// a duplicate response without calling the provider.
		try {
			ctx.sql.exec(
				"INSERT INTO mailbox_meta (key, value, updated_at) VALUES (?, ?, ?)",
				`draft_sending:${draftId}`,
				idempotencyKey,
				new Date().toISOString(),
			);
		} catch {
			// Another attempt key already claimed the per-draft gate. Clean up our
			// sentKey marker (left at 'sending') so the reconciliation sweep doesn't
			// find a stale row.
			ctx.sql.exec("DELETE FROM mailbox_meta WHERE key = ?", sentKey);
			return {
				id: draftId,
				status: "sent",
				sent: false,
				duplicate: true,
				reason: "already_sending",
			};
		}

		// The frozen files, read back now and checked against their frozen sha256:
		// what leaves is exactly what was confirmed. Nothing has been sent yet, so a
		// missing or changed object releases both gates and fails cleanly — a retry
		// with the same key may go again once the draft is fixed.
		if (snapshot.attachments.length > 0) {
			try {
				if (!ctx.r2?.get) throw new AttachmentUnavailableError("attachment_missing");
				loadedAttachments = await loadSnapshotAttachments(
					ctx.r2 as Pick<R2Bucket, "get">,
					snapshot.attachments,
				);
			} catch (error) {
				ctx.sql.exec("DELETE FROM mailbox_meta WHERE key = ?", sentKey);
				ctx.sql.exec("DELETE FROM mailbox_meta WHERE key = ?", `draft_sending:${draftId}`);
				if (error instanceof AttachmentUnavailableError) {
					return {
						id: draftId,
						status: draft.status,
						sent: false,
						error: error.reason,
						attachmentId: error.attachmentId ?? null,
					};
				}
				throw error;
			}
		}

		const providerResult = await ctx.email.send({
			// Bare address when the mailbox has no display name — identical to the
			// behaviour before names existed, so no mailbox changes how it renders
			// unless someone gave it a name.
			from: snapshot.identity.fromName
				? { name: snapshot.identity.fromName, email: fromAddress }
				: fromAddress,
			to,
			cc: cc.length ? cc : undefined,
			bcc: bcc.length ? bcc : undefined,
			replyTo: snapshot.identity.replyTo ?? undefined,
			subject: draft.subject,
			text: draft.body_text ?? undefined,
			// "" is a draft whose rich body was emptied: a text-only send.
			html: draft.body_html || undefined,
			...(Object.keys(outboundHeaders).length > 0 ? { headers: outboundHeaders } : {}),
			...(loadedAttachments.length > 0
				? { attachments: providerAttachments(loadedAttachments) }
				: {}),
		});
		providerMessageId = extractProviderMessageId(providerResult);
	} catch (error) {
		// The provider threw but may have accepted the message. The per-draft
		// gate stays in place so no other attempt key retries. Update the sent
		// marker to "failed" (the caller's outbound-send.ts maps this to D1
		// status "unknown", never "failed") — idempotent retries of the same
		// key see "failed" and return "ambiguous", stopping automatic replay.
		if (error instanceof AmbiguousSendError || isAmbiguousProviderError(error)) {
			const errorMsg = error instanceof Error ? error.message : "send_failed";
			ctx.sql.exec(
				"UPDATE mailbox_meta SET value = ?, updated_at = ? WHERE key = ?",
				JSON.stringify({ status: "unknown", error: errorMsg }),
				new Date().toISOString(),
				sentKey,
			);
			return {
				id: draftId,
				status: "failed",
				sent: false,
				error: "ambiguous",
				reason: errorMsg,
			};
		}
		ctx.sql.exec("DELETE FROM mailbox_meta WHERE key = ?", sentKey);
		ctx.sql.exec("DELETE FROM mailbox_meta WHERE key = ?", `draft_sending:${draftId}`);
		throw error;
	}

	// The provider's id IS the Message-ID it put on the wire, so store that and only
	// that: a locally invented id would never match the In-Reply-To of the eventual
	// answer, and resolveThreadId would fork the thread anyway. Null when the
	// provider returns nothing — that reply then falls back to subject matching.
	const rfcMessageId = normalizeMessageId(providerMessageId);

	const messageLocalId = crypto.randomUUID();
	const rawR2Key = `sent/${draftId}`;
	// The viewer renders body_html_r2_key first and body_text second, so the sent
	// copy has to carry the same bodies the recipient got. HTML goes to R2 under
	// the key an inbound message would use (it is served by the same sandboxed
	// /html route). The mail has already left by now, so a failed R2 write must not
	// turn a delivered send into an error: the copy keeps its text body instead.
	let bodyHtmlR2KeyValue: string | null = null;
	if (draft.body_html && ctx.r2 && ctx.mailboxId) {
		const htmlKey = bodyHtmlR2Key({ mailboxId: ctx.mailboxId, messageLocalId });
		try {
			await ctx.r2.put(htmlKey, draft.body_html, {
				httpMetadata: { contentType: "text/html; charset=utf-8" },
			});
			bodyHtmlR2KeyValue = htmlKey;
		} catch (error) {
			console.error("mailbox.sent_html_store_failed", {
				draftId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	const rawSha256 = await sha256Hex(
		new TextEncoder().encode(
			JSON.stringify({
				draftId,
				idempotencyKey,
				to,
				cc,
				bcc,
				subject: draft.subject,
				text: draft.body_text ?? null,
				html: draft.body_html ?? null,
				// Only when there are files, so a send without any keeps its old value.
				...(snapshot.attachments.length > 0
					? { attachments: snapshot.attachments.map((a) => a.sha256) }
					: {}),
			}),
		),
	);
	// Free the bytes before the bookkeeping; the sent copy keeps only the metadata.
	loadedAttachments = [];
	const hasAttachments = snapshot.attachments.length > 0;
	// The list row previews the reply itself, not the quoted conversation under it.
	const sentSnippet =
		snippetFromText(stripQuotedText(draft.body_text ?? ""), null) ||
		snippetFromText(draft.body_text, draft.body_html) ||
		draft.subject.slice(0, 200);
	ctx.transactionSync(() => {
		ctx.sql.exec(
			"UPDATE mailbox_meta SET value = ?, updated_at = ? WHERE key = ?",
			sentMarkerValue(providerMessageId),
			now,
			sentKey,
		);
		ctx.sql.exec(
			"UPDATE outbound_drafts SET status = 'sent', updated_at = ? WHERE id = ?",
			now,
			draftId,
		);
		// Per-draft send gate cleanup: no longer needed once the send committed.
		ctx.sql.exec("DELETE FROM mailbox_meta WHERE key = ?", `draft_sending:${draftId}`);
		// Replying into an existing thread must not try to re-create its row: the
		// draft carries the thread it belongs to, so this is an upsert that bumps
		// the counters the thread list renders from.
		ctx.sql.exec(
			`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_message_at = MAX(last_message_at, excluded.last_message_at),
           message_count = message_count + 1,
           updated_at = excluded.updated_at`,
			threadId,
			normalizeSubject(draft.subject),
			now,
			now,
			now,
		);
		ctx.sql.exec(
			`INSERT INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
          from_addr, from_name, to_json, cc_json, bcc_json, subject, snippet,
          received_at, raw_r2_key, raw_sha256, raw_size, body_text, body_html_r2_key,
          parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'parsed', ?, 1, ?, ?)`,
			messageLocalId,
			sentKey,
			threadId,
			rfcMessageId,
			inReplyTo,
			JSON.stringify(references),
			fromAddress,
			// The phrase the From header actually carried, through the same sanitiser.
			sanitizeDisplayName(snapshot.identity.fromName, fromAddress),
			draft.to_json,
			draft.cc_json,
			draft.bcc_json,
			draft.subject,
			sentSnippet,
			now,
			rawR2Key,
			rawSha256,
			draft.body_text,
			bodyHtmlR2KeyValue,
			hasAttachments ? 1 : 0,
			now,
			now,
		);
		// The sent copy lists the files like any received message (same table,
		// same download route), on the very objects that were sent.
		transferDraftAttachmentsToMessage(ctx.sql, draftId, messageLocalId, snapshot.attachments, now);
	});

	recordRealtimeEvent(ctx.sql, "message.created", {
		messageId: messageLocalId,
		threadId,
		direction: "outbound",
	});

	return {
		id: draftId,
		status: "sent",
		sent: true,
		messageLocalId,
		threadId,
		idempotencyKey,
		providerMessageId,
		rfcMessageId,
		subject: draft.subject,
		fromAddr: fromAddress,
		toJson: draft.to_json,
		snippet: sentSnippet,
		receivedAt: now,
		rawR2Key,
		rawSha256,
		hasAttachments,
	};
}

function cancelDraft(sql: SqlStorage, draftId: string | undefined, allowed?: string[]) {
	if (!draftId) throw new Error("draftId required");
	const now = new Date().toISOString();
	const updated = sql.exec(
		`UPDATE outbound_drafts SET status = 'cancelled', updated_at = ? WHERE id = ?${allowed ? ` AND status IN (${allowed.map(() => "?").join(",") || "NULL"})` : ""}`,
		now,
		draftId,
		...(allowed ?? []),
	);
	if (allowed && !updated.rowsWritten) {
		const current = sql
			.exec<{ status: string }>("SELECT status FROM outbound_drafts WHERE id = ?", draftId)
			.toArray()[0];
		return { error: "draft_not_editable", currentStatus: current?.status ?? null };
	}
	return { id: draftId, status: "cancelled" };
}

function exportMessageIndex(sql: SqlStorage) {
	return sql
		.exec(
			`SELECT id AS message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
              received_at, has_attachments, state, raw_r2_key, raw_sha256
         FROM messages ORDER BY received_at ASC`,
		)
		.toArray();
}

function debugState(sql: SqlStorage) {
	const messages = sql
		.exec(
			`SELECT id, idempotency_key, raw_r2_key, raw_sha256, subject, thread_id, parse_status, state
         FROM messages ORDER BY created_at ASC`,
		)
		.toArray();
	return { messageCount: messages.length, messages };
}

export class MailboxDurableObject extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// The legacy PRAGMA/ALTER migration scan below is only needed once per DO
		// (it rebuilds/backfills pre-thread_id-era tables). Re-running it on every
		// cold start is wasted work — gate it behind the persisted schema version.
		const currentVersion = this.getAppliedSchemaVersion();
		if (currentVersion < 1) {
			// Must run before MAILBOX_SCHEMA_SQL: it renames a pre-existing legacy
			// "messages" table out of the way so the CREATE TABLE IF NOT EXISTS below
			// can create the current schema instead of leaving the legacy table in place.
			this.renameLegacyMessagesBeforeSchema();
		}
		this.ctx.storage.sql.exec(MAILBOX_SCHEMA_SQL);
		if (currentVersion < 1) {
			try {
				this.rebuildLegacyMessagesTable();
				this.migrateLegacySchema();
			} catch (error) {
				console.error("mailbox.schema_migration_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		// v2: add idempotency_key to outbound_drafts for MCP draft dedup.
		if (currentVersion < 2) {
			this.migrateDraftIdempotency();
		}
		// v3: add delivery_status/delivery_event_at to transactional_requests
		// (the new tables recipient_suppressions and transactional_delivery_events
		// are handled by CREATE TABLE IF NOT EXISTS in MAILBOX_SCHEMA_SQL).
		if (currentVersion < 3) {
			this.migrateDeliveryEventColumns();
		}
		// v4: add parent_message_id to outbound_drafts so a reply can point at the
		// message it answers instead of the newest one in the thread.
		if (currentVersion < 4) {
			this.migrateDraftParentMessage();
		}
		// v5: add resolved_via to transactional_requests so a status reached by
		// correlating a delivery event stays distinguishable from one the provider
		// acknowledged directly. The supporting indexes are created by
		// MAILBOX_SCHEMA_SQL's CREATE INDEX IF NOT EXISTS.
		if (currentVersion < 5) {
			this.migrateResolvedViaColumn();
		}
		// v6: From display names. `api_keys.sender_name` holds the phrase, and
		// `api_key_events` needs its CHECK widened to admit the audit row that
		// records a change to it — a constraint SQLite cannot ALTER, hence a
		// rebuild. Both are new gates rather than additions to an older one:
		// every mailbox in production is already past v5, so a migration hidden
		// behind an earlier version would never run for the mailboxes that need it.
		if (currentVersion < 6) {
			this.migrateApiKeySenderName();
			this.migrateApiKeyEventTypes();
		}
		// v7: sent copies were written without body_text, so the viewer showed
		// "(no text content)" for every message the mailbox ever sent. New sends store
		// the body; this fills in the ones already there, from the draft each came from.
		if (currentVersion < 7) {
			this.backfillSentBodyText();
		}
		if (currentVersion < 8) {
			const columns = this.columnNames("messages");
			this.addColumnIfMissing("messages", columns, "sensitive_kind", "TEXT");
			this.addColumnIfMissing(
				"messages",
				columns,
				"sensitive_classified",
				"INTEGER NOT NULL DEFAULT 0",
			);
		}
		if (currentVersion < 9) {
			const columns = this.columnNames("outbound_drafts");
			this.addColumnIfMissing("outbound_drafts", columns, "origin", "TEXT NOT NULL DEFAULT 'web'");
		}
		// v10: sender/recipient display names (nullable, no backfill: a row without
		// one renders the address-derived name it always did), and the covering
		// index the per-folder counts are answered from.
		if (currentVersion < 10) {
			const columns = this.columnNames("messages");
			this.addColumnIfMissing("messages", columns, "from_name", "TEXT");
			this.addColumnIfMissing("messages", columns, "recipient_names_json", "TEXT");
			this.ctx.storage.sql.exec(
				"CREATE INDEX IF NOT EXISTS idx_messages_folder_counts ON messages(state, thread_id, is_read)",
			);
		}
		// v11: automated mail (DMARC aggregate reports) the web keeps out of its
		// folders and counts. An additive nullable column, the two partial indexes
		// the web counts and the reports view are answered from, and a backfill of
		// the mail already stored, classified from its stored subject, headers and
		// attachment metadata (no R2 read).
		if (currentVersion < 11) {
			const columns = this.columnNames("messages");
			this.addColumnIfMissing("messages", columns, "automated_kind", "TEXT");
			createAutomatedMailIndexes(this.ctx.storage.sql);
			try {
				backfillAutomatedKind(this.ctx.storage.sql);
			} catch (error) {
				// A failed backfill only leaves old reports visible; it must not stop
				// the mailbox from booting.
				console.error("mailbox.automated_backfill_failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		// v12: Reply-To, kept so Reply answers where the sender asked. Nullable and
		// not backfilled here: a NULL row is filled from its raw headers in R2 the
		// first time its thread is opened (backfillHeaderFields, bounded per open).
		if (currentVersion < 12) {
			const columns = this.columnNames("messages");
			this.addColumnIfMissing("messages", columns, "reply_to_json", "TEXT");
		}
		// v13: files attached to drafts (metadata only; the bytes are in R2). A new
		// table, so purely additive; see do/mailbox-draft-attachments.ts.
		if (currentVersion < 13) {
			createDraftAttachmentsTable(this.ctx.storage.sql);
		}
		// v14: permanent deletion ("Delete forever", "Empty trash"): its queue and
		// operation tables, and the indexes its R2 reference checks are answered
		// from. Additive; see do/mailbox-purge.ts.
		if (currentVersion < 14) {
			createPurgeTables(this.ctx.storage.sql);
		}
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
			MAILBOX_SCHEMA_VERSION,
			new Date().toISOString(),
		);
	}

	private getAppliedSchemaVersion(): number {
		if (!this.tableExists("schema_migrations")) return 0;
		const row = this.ctx.storage.sql
			.exec<{ max_version: number }>(
				"SELECT COALESCE(MAX(version), 0) AS max_version FROM schema_migrations",
			)
			.toArray()[0];
		return row?.max_version ?? 0;
	}

	private migrateDraftIdempotency(): void {
		// Guard ALTER TABLE against partial-failure reruns: check if the column
		// already exists before adding it (avoids duplicate-column error).
		const columns = this.columnNames("outbound_drafts");
		if (!columns.has("idempotency_key")) {
			this.ctx.storage.sql.exec("ALTER TABLE outbound_drafts ADD COLUMN idempotency_key TEXT");
		}
		// CREATE UNIQUE INDEX IF NOT EXISTS is inherently idempotent.
		this.ctx.storage.sql.exec(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_idempotency
       ON outbound_drafts(idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
		);
	}

	private migrateDraftParentMessage(): void {
		const columns = this.columnNames("outbound_drafts");
		if (!columns.has("parent_message_id")) {
			this.ctx.storage.sql.exec("ALTER TABLE outbound_drafts ADD COLUMN parent_message_id TEXT");
		}
	}

	/**
	 * Adds `api_keys.sender_name` to mailboxes provisioned before display names
	 * existed. Nullable with no backfill, deliberately: null means "send the bare
	 * address", which is exactly what those keys did yesterday, so the migration
	 * cannot change the From header of a key already in use.
	 */
	private migrateApiKeySenderName(): void {
		const columns = this.columnNames("api_keys");
		if (!columns.has("sender_name")) {
			this.ctx.storage.sql.exec("ALTER TABLE api_keys ADD COLUMN sender_name TEXT");
		}
	}

	/**
	 * Widens `api_key_events.event_type` to admit 'sender_name_updated' and 'template_allowlist_updated'.
	 *
	 * A CHECK constraint cannot be altered in SQLite, so a mailbox provisioned
	 * before this event type existed would reject the audit row — and because the
	 * insert happens in the same call as the update, the whole rename would fail
	 * with a constraint error rather than silently skipping the audit. Hence a
	 * table rebuild rather than an ALTER.
	 *
	 * Detection reads the stored DDL rather than tracking a version number: the
	 * constraint text is the fact we care about, so asking the table directly
	 * cannot drift from reality the way a counter can.
	 */
	private migrateApiKeyEventTypes(): void {
		const ddl = this.ctx.storage.sql
			.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_events'")
			.toArray()[0] as { sql?: string } | undefined;
		if (!ddl?.sql || ddl.sql.includes("template_allowlist_updated")) return;

		this.ctx.storage.sql.exec("ALTER TABLE api_key_events RENAME TO api_key_events_old");
		this.ctx.storage.sql.exec(`CREATE TABLE api_key_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('created', 'revoked', 'rotated', 'sender_name_updated', 'template_allowlist_updated')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
)`);
		this.ctx.storage.sql.exec(
			"INSERT INTO api_key_events SELECT id, key_id, event_type, metadata_json, created_at FROM api_key_events_old",
		);
		this.ctx.storage.sql.exec("DROP TABLE api_key_events_old");
		this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_ake_key ON api_key_events(key_id)");
	}

	/**
	 * Gives every sent copy that has no body the text of the draft it was sent from.
	 *
	 * The link is `raw_r2_key`: a sent copy has no raw MIME in R2, so the send path
	 * stores the pseudo key `sent/<draftId>` there. Only outbound rows with a NULL
	 * body are touched, which is what makes a second run a no-op and keeps inbound
	 * mail out of reach. A draft edited after it was sent (its `updated_at` moves
	 * past the moment the copy was created) is skipped, because its text is no
	 * longer what went out. Text only: the HTML body would need an R2 write, which
	 * a constructor cannot await, and the text is what the viewer falls back to.
	 */
	private backfillSentBodyText(): void {
		this.ctx.storage.sql.exec(
			`UPDATE messages
       SET body_text = (
         SELECT d.body_text FROM outbound_drafts d
         WHERE d.id = substr(messages.raw_r2_key, 6)
       )
       WHERE direction = 'outbound'
         AND body_text IS NULL
         AND substr(raw_r2_key, 1, 5) = 'sent/'
         AND EXISTS (
           SELECT 1 FROM outbound_drafts d
           WHERE d.id = substr(messages.raw_r2_key, 6)
             AND d.body_text IS NOT NULL
             AND d.updated_at <= messages.created_at
         )`,
		);
	}

	private migrateResolvedViaColumn(): void {
		const columns = this.columnNames("transactional_requests");
		if (!columns.has("resolved_via")) {
			this.ctx.storage.sql.exec("ALTER TABLE transactional_requests ADD COLUMN resolved_via TEXT");
		}
	}

	private migrateDeliveryEventColumns(): void {
		const columns = this.columnNames("transactional_requests");
		if (!columns.has("delivery_status")) {
			this.ctx.storage.sql.exec(
				"ALTER TABLE transactional_requests ADD COLUMN delivery_status TEXT",
			);
		}
		if (!columns.has("delivery_event_at")) {
			this.ctx.storage.sql.exec(
				"ALTER TABLE transactional_requests ADD COLUMN delivery_event_at TEXT",
			);
		}
	}

	async fetch(request: Request): Promise<Response> {
		try {
			return await this.route(request);
		} catch (error) {
			// Map thrown handler errors to proper HTTP statuses so a missing draft/thread/message
			// surfaces as 404/400 to the API layer instead of a generic 500.
			const message = error instanceof Error ? error.message : String(error);
			const status = /not found/i.test(message) ? 404 : /required/i.test(message) ? 400 : 500;
			return Response.json({ error: message }, { status });
		}
	}

	private async route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/ws" && request.headers.get("Upgrade") === "websocket") {
			return this.handleWebSocketUpgrade(request);
		}
		if (url.pathname === "/ingest" && request.method === "POST") {
			let json: unknown;
			try {
				json = await request.json();
			} catch {
				return Response.json({ error: "invalid_json" }, { status: 400 });
			}
			const parsed = inboundEmailQueueMessageSchema.safeParse(json);
			if (!parsed.success) {
				return Response.json(
					{ error: "invalid_payload", issues: parsed.error.issues },
					{ status: 400 },
				);
			}
			const result = await this.ingestEmail(parsed.data);
			return Response.json(result);
		}
		if (url.pathname === "/search" && request.method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			const limit = Number(url.searchParams.get("limit") ?? "25");
			return Response.json({
				results: searchMessages(this.ctx.storage.sql, q, limit, {
					includeSensitive: url.searchParams.get("sensitive") === "1",
					reports: parseReportsFilter(url.searchParams.get("reports")),
				}),
			});
		}
		if (url.pathname === "/threads" && request.method === "GET") {
			const stateParam = url.searchParams.get("state");
			const state = isThreadListState(stateParam) ? stateParam : undefined;
			return Response.json({
				threads: this.listThreads(
					Number(url.searchParams.get("limit") ?? "25"),
					state,
					url.searchParams.has("unread") ? url.searchParams.get("unread") === "true" : undefined,
					parseReportsFilter(url.searchParams.get("reports")),
					parseThreadListCursor(url.searchParams.get("before")),
				),
			});
		}
		if (url.pathname === "/counts" && request.method === "GET") {
			return Response.json({ counts: folderCounts(this.ctx.storage.sql) });
		}
		if (url.pathname.startsWith("/threads/") && request.method === "GET") {
			const threadId = url.pathname.split("/")[2];
			// Older rows get their sender name and Reply-To from their own raw
			// headers, once, the first time their conversation is opened.
			if (threadId) {
				try {
					await backfillHeaderFields(this.ctx.storage.sql, this.env.MAIL_OBJECTS, threadId);
				} catch (error) {
					console.error("mailbox.header_backfill_failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			// getThread already returns { thread, messages }; return it flat so the
			// client reads data.messages / data.thread directly (not data.thread.messages).
			return Response.json(this.getThread(threadId));
		}
		if (url.pathname.startsWith("/messages/") && request.method === "GET") {
			const messageId = url.pathname.split("/")[2];
			if (url.pathname.endsWith("/raw")) {
				return this.getRawMessage(messageId);
			}
			if (url.pathname.endsWith("/html")) {
				return this.getBodyHtml(messageId);
			}
			return Response.json({ message: this.getMessage(messageId) });
		}
		if (
			url.pathname.startsWith("/messages/") &&
			url.pathname.endsWith("/actions") &&
			request.method === "POST"
		) {
			const messageId = url.pathname.split("/")[2];
			const body = (await request.json()) as { action: string };
			return Response.json(this.applyMessageAction(messageId, body.action));
		}
		if (url.pathname === "/bulk-actions" && request.method === "POST") {
			const body = (await request.json()) as { action: BulkAction; target: BulkTarget };
			const sql = this.ctx.storage.sql;
			return Response.json(
				applyBulkAction(
					sql,
					(fn) => this.ctx.storage.transactionSync(fn),
					(messageId, action) => applyMessageAction(sql, messageId, action),
					body.action,
					body.target,
				),
			);
		}
		const attachmentResponse = await this.draftAttachmentRoute(request, url);
		if (attachmentResponse) return attachmentResponse;
		if (url.pathname.match(/^\/drafts\/[^/]+\/restore$/) && request.method === "POST") {
			const result = restoreDraft(this.ctx.storage.sql, url.pathname.split("/")[2]);
			return Response.json(result, { status: "error" in result ? 409 : 200 });
		}
		if (url.pathname === "/drafts" && request.method === "GET") {
			return Response.json({ drafts: this.listDrafts() });
		}
		if (url.pathname.match(/^\/drafts\/[^/]+$/) && request.method === "GET") {
			const draftId = url.pathname.split("/")[2];
			return Response.json({ draft: this.getDraft(draftId) });
		}
		if (url.pathname === "/drafts" && request.method === "POST") {
			const body = await request.json();
			return Response.json(this.createDraft(body as Record<string, unknown>), { status: 201 });
		}
		if (url.pathname.match(/^\/drafts\/[^/]+$/) && request.method === "PATCH") {
			const draftId = url.pathname.split("/")[2];
			const body = await request.json();
			const result = this.updateDraft(draftId, body as Record<string, unknown>);
			return Response.json(result, { status: "error" in result ? 409 : 200 });
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/request-send$/) && request.method === "POST") {
			const draftId = url.pathname.split("/")[2];
			const body = request.headers.get("content-type")?.includes("application/json")
				? ((await request.json()) as {
						mailboxAddress?: string | null;
						displayName?: string | null;
						replaceStale?: boolean;
					})
				: {};
			return Response.json(
				await this.requestSendDraft(
					draftId,
					body.mailboxAddress,
					body.displayName,
					body.replaceStale,
				),
			);
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/send-intent$/) && request.method === "GET") {
			const draftId = url.pathname.split("/")[2];
			const row = this.ctx.storage.sql
				.exec<{ value: string }>(
					"SELECT value FROM mailbox_meta WHERE key = ?",
					`send_intent:${draftId}`,
				)
				.toArray()[0];
			if (!row) return Response.json({ error: "intent_not_found" }, { status: 404 });
			const stale = this.ctx.storage.sql
				.exec<{ value: string }>(
					"SELECT value FROM mailbox_meta WHERE key = ?",
					`intent_stale:${draftId}`,
				)
				.toArray()[0];
			return Response.json({
				...(JSON.parse(row.value) as object),
				stale: stale?.value === "stale",
				seenAddresses: seenAddresses(this.ctx.storage.sql),
			});
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/confirm-send$/) && request.method === "POST") {
			const draftId = url.pathname.split("/")[2];
			const body = (await request.json()) as {
				idempotencyKey: string;
				mailboxAddress?: string | null;
				displayName?: string | null;
				expectedPayloadHash?: string;
				approvalProof?: McpApprovalProof | null;
			};
			const result = await this.confirmSendDraft(
				draftId,
				body.idempotencyKey,
				body.mailboxAddress,
				body.displayName,
				body.expectedPayloadHash,
				body.approvalProof,
			);
			// Ambiguous provider outcomes are business-level, not transport-level errors.
			// Return 200 so the caller's confirmDraftSend reaches the "ambiguous" branch
			// and records D1 status as "unknown" (not "failed"). Any other "error" property
			// (e.g. draft-not-found, too-many-recipients) remains an HTTP error.
			const isAmbiguous = result.error === "ambiguous";
			const status =
				"error" in result && !isAmbiguous
					? result.error === "intent_stale" ||
						result.error === "approval_required" ||
						result.error === "attachment_missing" ||
						result.error === "attachment_changed"
						? 409
						: result.error === "attachments_too_large"
							? 413
							: result.error === "too_many_recipients"
								? 400
								: 500
					: 200;
			return Response.json(result, { status });
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/cancel$/) && request.method === "POST") {
			const draftId = url.pathname.split("/")[2];
			const body = request.headers.get("content-type")?.includes("application/json")
				? ((await request.json()) as { allowedStatuses?: unknown })
				: {};
			const allowed =
				Array.isArray(body.allowedStatuses) &&
				body.allowedStatuses.every((s) => typeof s === "string")
					? (body.allowedStatuses as string[])
					: undefined;
			const result = await this.cancelDraft(draftId, allowed);
			return Response.json(result, { status: "error" in result ? 409 : 200 });
		}
		if (url.pathname === "/export-index" && request.method === "GET") {
			return Response.json({ messages: this.exportMessageIndex() });
		}
		if (url.pathname === "/alarm" && request.method === "POST") {
			await this.alarm();
			return Response.json({ ok: true });
		}
		if (url.pathname === "/purge" && request.method === "POST") {
			const body = (await request.json()) as { mailboxId: string; target: PurgeTarget };
			return this.purge(body.mailboxId, body.target);
		}
		if (url.pathname.startsWith("/purge/") && request.method === "GET") {
			const operation = getPurgeOperation(this.ctx.storage.sql, url.pathname.split("/")[2]);
			if (!operation) return Response.json({ error: "operation_not_found" }, { status: 404 });
			return Response.json(operation);
		}
		// --- Transactional API key routes ---
		if (url.pathname === "/transactional/api-keys" && request.method === "POST") {
			const pepper = this.env.TRANSACTIONAL_API_KEY_PEPPER;
			if (!pepper) {
				return Response.json({ error: "transactional_api_not_configured" }, { status: 503 });
			}
			const mailboxId = this.ctx.id.name ?? "unknown";
			try {
				const body = (await request.json()) as Record<string, unknown>;
				const { createApiKey } = await import("./transactional-key-ops");
				const result = await createApiKey(this.ctx.storage.sql, pepper, mailboxId, {
					environment: body.environment as "test" | "live",
					sender: body.sender as string,
					senderName: body.senderName as string | null | undefined,
					scopes: body.scopes as import("../lib/transactional-keys").KeyScope[],
					templateAllowlist: body.templateAllowlist as string[] | null | undefined,
					recipientPolicy: body.recipientPolicy as string | null | undefined,
					quotaMax: body.quotaMax != null ? Number(body.quotaMax) : null,
					expiresAt: body.expiresAt as string | null | undefined,
				});
				return Response.json(result, { status: 201 });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				// invalid_sender_name is a value that cannot go in a header — the
				// caller's mistake, like a bad scope, not a server fault.
				const status = msg === "invalid_scopes" || msg === "invalid_sender_name" ? 400 : 500;
				return Response.json({ error: msg }, { status });
			}
		}
		if (url.pathname.match(/^\/transactional\/api-keys\/[^/]+$/) && request.method === "PATCH") {
			const keyId = url.pathname.split("/")[3];
			if (!keyId) {
				return Response.json({ error: "key_not_found" }, { status: 404 });
			}
			const body = (await request.json()) as { senderName?: unknown };
			const { updateApiKeySenderName } = await import("./transactional-key-ops");
			try {
				const result = updateApiKeySenderName(
					this.ctx.storage.sql,
					keyId,
					(body.senderName ?? null) as string | null,
				);
				if (!result) {
					return Response.json({ error: "key_not_found" }, { status: 404 });
				}
				return Response.json({ key: result });
			} catch (error) {
				const code = error instanceof Error ? error.message : "update_failed";
				// key_not_active is the caller pointing at a revoked key; the sender-name
				// codes are a value that cannot go in a header. Both are the caller's
				// mistake, neither is a server fault.
				const status = code === "key_not_active" || code === "invalid_sender_name" ? 400 : 500;
				return Response.json({ error: code }, { status });
			}
		}
		if (
			url.pathname.match(/^\/transactional\/api-keys\/[^/]+\/templates$/) &&
			request.method === "PUT"
		) {
			const keyId = url.pathname.split("/")[3];
			if (!keyId) return Response.json({ error: "key_not_found" }, { status: 404 });
			const body = (await request.json()) as { templateAllowlist?: unknown };
			if (!Array.isArray(body.templateAllowlist)) {
				return Response.json({ error: "invalid_template_allowlist" }, { status: 400 });
			}
			const { updateApiKeyTemplateAllowlist } = await import("./transactional-key-ops");
			try {
				const result = updateApiKeyTemplateAllowlist(
					this.ctx.storage.sql,
					keyId,
					body.templateAllowlist as string[],
				);
				if (!result) return Response.json({ error: "key_not_found" }, { status: 404 });
				return Response.json({ key: result });
			} catch (error) {
				const code = error instanceof Error ? error.message : "update_failed";
				const status =
					code === "key_not_active" ||
					code === "invalid_template_allowlist" ||
					code === "send_scope_requires_template_allowlist"
						? 400
						: 500;
				return Response.json({ error: code }, { status });
			}
		}
		if (url.pathname === "/transactional/api-keys" && request.method === "GET") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const { listApiKeys } = await import("./transactional-key-ops");
			const keys = listApiKeys(this.ctx.storage.sql, mailboxId);
			return Response.json({ keys });
		}
		if (
			url.pathname.match(/^\/transactional\/api-keys\/[^/]+\/revoke$/) &&
			request.method === "POST"
		) {
			const keyId = url.pathname.split("/")[3];
			if (!keyId) return Response.json({ error: "key_id_required" }, { status: 400 });
			const { revokeApiKey } = await import("./transactional-key-ops");
			const result = revokeApiKey(this.ctx.storage.sql, keyId);
			if (!result) return Response.json({ error: "key_not_found" }, { status: 404 });
			return Response.json({ key: result });
		}
		if (
			url.pathname.match(/^\/transactional\/api-keys\/[^/]+\/rotate$/) &&
			request.method === "POST"
		) {
			const pepper = this.env.TRANSACTIONAL_API_KEY_PEPPER;
			if (!pepper) {
				return Response.json({ error: "transactional_api_not_configured" }, { status: 503 });
			}
			const keyId = url.pathname.split("/")[3];
			if (!keyId) return Response.json({ error: "key_id_required" }, { status: 400 });
			const mailboxId = this.ctx.id.name ?? "unknown";
			try {
				const { rotateApiKey } = await import("./transactional-key-ops");
				const result = await rotateApiKey(this.ctx.storage.sql, pepper, mailboxId, keyId, (fn) =>
					this.ctx.storage.transactionSync(fn),
				);
				if (!result) return Response.json({ error: "key_not_found" }, { status: 404 });
				return Response.json(result);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				const status = msg === "key_not_active" ? 400 : 500;
				return Response.json({ error: msg }, { status });
			}
		}
		if (url.pathname === "/transactional/api-keys/export-projections" && request.method === "GET") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const { exportApiKeyProjections } = await import("./transactional-key-ops");
			return Response.json({
				projections: exportApiKeyProjections(this.ctx.storage.sql, mailboxId),
			});
		}

		// --- Transactional send route ---
		if (url.pathname === "/transactional/send" && request.method === "POST") {
			const pepper = this.env.TRANSACTIONAL_API_KEY_PEPPER;
			if (!pepper) {
				return Response.json({ error: "transactional_api_not_configured" }, { status: 503 });
			}
			const mailboxId = this.ctx.id.name ?? "unknown";
			const authHeader = request.headers.get("Authorization");
			const idempotencyKeyHeader = request.headers.get("Idempotency-Key");
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json({ error: "invalid_json" }, { status: 400 });
			}
			const identity = resolveSenderIdentity(this.env, this.resolveMailboxAddress(null));
			const { handleTransactionalSend, fireTransactionalOpsEvent, makeTransactionalRequestLogRow } =
				await import("./transactional-send-ops");
			const { insertOpsEvent, upsertTransactionalRequestLog } = await import("../db/d1");
			const result = await handleTransactionalSend(
				{
					sql: this.ctx.storage.sql,
					transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
					email: this.env.EMAIL,
					fromAddress: identity.from,
				},
				pepper,
				{
					mailboxId,
					authHeader,
					idempotencyKeyHeader,
					body,
				},
			);

			// Fire-and-forget: write ops event to D1 (best-effort, never blocks response).
			// Only logs categories/ids/status/mailbox/keyId — never Authorization, key,
			// variables, body, or raw provider errors.
			const opsEvent = fireTransactionalOpsEvent(mailboxId, result.keyId ?? "", result);
			// Silent catch — D1 unavailability must not break the HTTP response.
			this.ctx.waitUntil(
				insertOpsEvent(this.env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: opsEvent.event_type,
					severity: opsEvent.severity,
					subject: opsEvent.subject,
					payload_json: opsEvent.payload_json,
				}).catch(() => {}),
			);

			// Fire-and-forget: write D1 projection for sent/permanent/unknown outcomes
			if (
				result.requestId &&
				(result.status === "sent" ||
					result.status === "permanent_failure" ||
					result.status === "unknown")
			) {
				const dbRow = this.ctx.storage.sql
					.exec<{
						request_id: string;
						key_id: string;
						status: string;
						to_addr: string;
						template_id: string | null;
						sender: string;
						provider_message_id: string | null;
						error_code: string | null;
						delivery_status: string | null;
						delivery_event_at: string | null;
						resolved_via: string | null;
						created_at: string;
						updated_at: string;
					}>(
						// resolved_via is selected because this block also runs on an
						// idempotent replay: a request already settled from a delivery event
						// must not have that provenance erased by re-projecting the row.
						"SELECT request_id, key_id, status, to_addr, template_id, sender, provider_message_id, error_code, delivery_status, delivery_event_at, resolved_via, created_at, updated_at FROM transactional_requests WHERE request_id = ?",
						result.requestId,
					)
					.toArray()[0];
				if (dbRow) {
					const logRow = makeTransactionalRequestLogRow(mailboxId, dbRow);
					this.ctx.waitUntil(
						upsertTransactionalRequestLog(this.env.INDEX_DB, logRow).catch(() => {}),
					);
				}
			}

			return Response.json(result, { status: httpStatusForTransactionalResult(result) });
		}

		// --- Transactional reconcile-stale route (admin-only, never public API-key) ---
		if (url.pathname === "/transactional/reconcile-stale" && request.method === "POST") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const { reconcileStaleTransactionalRequests } = await import("./transactional-send-ops");
			// Default stale threshold: 30 minutes — pending/sending requests older than this
			// are assumed to be crashed/interrupted DO sagas rather than work still in flight.
			const olderThanIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();
			const result = reconcileStaleTransactionalRequests(this.ctx.storage.sql, olderThanIso);
			return Response.json({ mailboxId, ...result });
		}

		// --- Transactional status route ---
		if (url.pathname.match(/^\/transactional\/requests\/[^/]+$/) && request.method === "GET") {
			const requestId = url.pathname.split("/")[3];
			if (!requestId) return Response.json({ error: "request_id_required" }, { status: 400 });
			const pepper = this.env.TRANSACTIONAL_API_KEY_PEPPER;
			if (!pepper) {
				return Response.json({ error: "transactional_api_not_configured" }, { status: 503 });
			}
			const { getTransactionalRequestStatus, authenticateTransactionalKey } = await import(
				"./transactional-send-ops"
			);
			// Same authentication as the send path — secret, mailbox binding, status,
			// expiry, scope — so a published key id alone reads nothing.
			const auth = await authenticateTransactionalKey(this.ctx.storage.sql, pepper, {
				mailboxId: this.ctx.id.name ?? "unknown",
				authHeader: request.headers.get("Authorization"),
				requiredScopes: ["transactional:status"],
			});
			if (!auth.ok) {
				return Response.json(
					{ error: auth.error },
					{ status: httpStatusForTransactionalResult({ status: "rejected", error: auth.error }) },
				);
			}
			// Scoped to the authenticated key: another key's request is a 404.
			const statusRecord = getTransactionalRequestStatus(
				this.ctx.storage.sql,
				requestId,
				auth.keyId,
			);
			if (!statusRecord) {
				return Response.json({ error: "not_found" }, { status: 404 });
			}
			return Response.json({ requestId, ...statusRecord });
		}

		// --- Template CRUD routes ---
		if (url.pathname === "/transactional/templates" && request.method === "POST") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			try {
				const body = (await request.json()) as {
					id: string;
					subject: string;
					body_text?: string | null;
					body_html?: string | null;
				};
				const { createTemplate, templateInputProblem } = await import("./transactional-send-ops");
				const problem = templateInputProblem(body);
				if (problem) return Response.json({ error: problem }, { status: 400 });
				createTemplate(this.ctx.storage.sql, mailboxId, {
					id: body.id!,
					subject: body.subject!,
					body_text: body.body_text ?? null,
					body_html: body.body_html ?? null,
				});
				return Response.json({ ok: true, id: body.id }, { status: 201 });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				// UNIQUE constraint violation on id
				if (msg.includes("UNIQUE")) {
					return Response.json({ error: "template_id_already_exists" }, { status: 409 });
				}
				return Response.json({ error: msg }, { status: 500 });
			}
		}
		// Revise a template without changing its id. Templates were write-once, so
		// correcting a typo or adding an HTML part meant minting a new id -- and the
		// id is what the caller hard-codes, so a revision was a coordinated deploy
		// across two codebases for a wording change.
		if (url.pathname.match(/^\/transactional\/templates\/[^/]+$/) && request.method === "PUT") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const templateId = url.pathname.split("/")[3];
			if (!templateId) return Response.json({ error: "template_id_required" }, { status: 400 });
			try {
				const body = (await request.json()) as {
					subject: string;
					body_text?: string | null;
					body_html?: string | null;
				};
				if (!body.subject) {
					return Response.json({ error: "subject_required" }, { status: 400 });
				}
				if (body.subject.includes("\r") || body.subject.includes("\n")) {
					return Response.json({ error: "subject_contains_newline" }, { status: 400 });
				}
				const { updateTemplate } = await import("./transactional-send-ops");
				const updated = updateTemplate(this.ctx.storage.sql, mailboxId, templateId, body);
				if (!updated) return Response.json({ error: "template_not_found" }, { status: 404 });
				return Response.json({ ok: true, id: templateId });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return Response.json({ error: msg }, { status: 400 });
			}
		}
		// Idempotent sync of a caller-owned template list; see `syncTemplates` for
		// the per-id semantics and why archived ids are reported, not revived.
		if (url.pathname === "/transactional/templates" && request.method === "PUT") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const { syncTemplates, TemplateSyncError } = await import("./transactional-send-ops");
			let body: {
				templates: import("./transactional-send-ops").TemplateInput[];
				archiveMissing?: boolean;
			};
			try {
				body = (await request.json()) as typeof body;
			} catch {
				return Response.json({ error: "invalid_json" }, { status: 400 });
			}
			try {
				const results = syncTemplates(
					this.ctx.storage.sql,
					(fn) => this.ctx.storage.transactionSync(fn),
					mailboxId,
					body ?? { templates: [] },
				);
				const summary = { created: 0, updated: 0, unchanged: 0, archived: 0 };
				for (const result of results) summary[result.outcome] += 1;
				return Response.json({ ok: true, results, summary });
			} catch (error) {
				if (error instanceof TemplateSyncError) {
					return Response.json(
						{ error: error.code, index: error.index, id: error.templateId },
						{ status: 400 },
					);
				}
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes("UNIQUE")) {
					return Response.json({ error: "template_id_already_exists" }, { status: 409 });
				}
				return Response.json({ error: msg }, { status: 500 });
			}
		}
		if (url.pathname === "/transactional/templates" && request.method === "GET") {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const { listTemplates } = await import("./transactional-send-ops");
			return Response.json({ templates: listTemplates(this.ctx.storage.sql, mailboxId) });
		}
		if (
			url.pathname.match(/^\/transactional\/templates\/[^/]+\/archive$/) &&
			request.method === "POST"
		) {
			const mailboxId = this.ctx.id.name ?? "unknown";
			const templateId = url.pathname.split("/")[3];
			const { archiveTemplate } = await import("./transactional-send-ops");
			const archived = templateId
				? archiveTemplate(this.ctx.storage.sql, mailboxId, templateId)
				: false;
			if (!archived) return Response.json({ error: "template_not_found" }, { status: 404 });
			return Response.json({ ok: true });
		}
		if (url.pathname === "/debug" && request.method === "GET") {
			return Response.json(this.debugState());
		}
		if (url.pathname === "/debug/schema" && request.method === "GET") {
			try {
				return Response.json({
					messages: this.ctx.storage.sql.exec("PRAGMA table_info(messages)").toArray(),
					ingestEvents: this.ctx.storage.sql.exec("PRAGMA table_info(ingest_events)").toArray(),
				});
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 500 },
				);
			}
		}

		// --- Email Sending delivery event route (internal, no public API) ---
		if (url.pathname === "/transactional/delivery-event" && request.method === "POST") {
			return this.handleDeliveryEvent(request);
		}
		if (url.pathname === "/outbound/delivery-event" && request.method === "POST") {
			return this.handleOutboundDeliveryEvent(request);
		}

		// --- Suppression admin routes (internal, Access-protected via API layer) ---
		if (url.pathname === "/transactional/suppressions" && request.method === "GET") {
			const { listSuppressions } = await import("./mailbox-suppressions");
			return Response.json({ suppressions: listSuppressions(this.ctx.storage.sql) });
		}
		if (url.pathname === "/transactional/suppressions" && request.method === "DELETE") {
			try {
				const body = (await request.json()) as {
					email: string;
					allowProviderRemoval?: boolean;
				};
				const { removeSuppression } = await import("./mailbox-suppressions");
				const removed = removeSuppression(
					this.ctx.storage.sql,
					body.email,
					body.allowProviderRemoval ?? false,
				);
				return Response.json({ removed });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				return Response.json({ error: msg }, { status: 400 });
			}
		}
		return new Response("Not found", { status: 404 });
	}

	private async handleWebSocketUpgrade(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const mailboxId = url.searchParams.get("mailboxId");
		if (!mailboxId) {
			return new Response("mailboxId required", { status: 400 });
		}

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment({ mailboxId } satisfies WebSocketAttachment);

		const connectionCount = this.ctx.getWebSockets().length;
		sendHello(server, mailboxId, connectionCount);
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		const attachment = ws.deserializeAttachment() as WebSocketAttachment | undefined;
		const mailboxId = attachment?.mailboxId ?? "unknown";
		await handleWebSocketMessage(ws, message, mailboxId, this.ctx.getWebSockets().length);
	}

	async webSocketClose(): Promise<void> {}

	async webSocketError(): Promise<void> {}

	private columnNames(table: string): Set<string> {
		return new Set(
			this.ctx.storage.sql
				.exec<{ name: string }>(`PRAGMA table_info(${table})`)
				.toArray()
				.map((column) => column.name),
		);
	}

	private tableExists(table: string): boolean {
		return Boolean(
			this.ctx.storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
					table,
				)
				.toArray()[0],
		);
	}

	private renameLegacyMessagesBeforeSchema(): void {
		if (!this.tableExists("messages") || this.tableExists("messages_legacy_v0")) return;
		const columns = this.columnNames("messages");
		if (columns.size > 0 && !columns.has("thread_id")) {
			this.ctx.storage.sql.exec("ALTER TABLE messages RENAME TO messages_legacy_v0");
		}
	}

	private addColumnIfMissing(
		table: string,
		columns: Set<string>,
		name: string,
		definition: string,
	): void {
		if (columns.has(name)) return;
		this.ctx.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
		columns.add(name);
	}

	private rebuildLegacyMessagesTable(): void {
		if (!this.tableExists("messages_legacy_v0")) return;
		const now = new Date().toISOString();
		const rows = this.ctx.storage.sql.exec("SELECT * FROM messages_legacy_v0").toArray() as Array<
			Record<string, unknown>
		>;

		for (const row of rows) {
			const id = String(row.id ?? crypto.randomUUID());
			const threadId = String(row.thread_id ?? id);
			const idempotencyKey = String(row.idempotency_key ?? `legacy:${id}`);
			const subject = typeof row.subject === "string" ? row.subject : null;
			const rawR2Key = String(row.raw_r2_key ?? "");
			const rawSha256 = String(row.raw_sha256 ?? "");
			const createdAt = String(row.created_at ?? now);
			const updatedAt = String(row.updated_at ?? createdAt);
			const receivedAt = String(row.received_at ?? createdAt);
			const isRead = Number(row.is_read ?? 0);

			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, ?, ?)`,
				threadId,
				subject?.toLowerCase() ?? null,
				receivedAt,
				isRead ? 0 : 1,
				createdAt,
				updatedAt,
			);
			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
          from_addr, to_json, cc_json, bcc_json, subject, snippet, date_header, received_at, raw_r2_key,
          raw_sha256, raw_size, body_text, body_html_r2_key, parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, '[]', ?, ?, ?, ?, '[]', '[]', ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
				id,
				idempotencyKey,
				threadId,
				typeof row.rfc_message_id === "string" ? row.rfc_message_id : null,
				typeof row.direction === "string" ? row.direction : "inbound",
				typeof row.state === "string" ? row.state : "inbox",
				typeof row.from_addr === "string" && row.from_addr ? row.from_addr : "unknown@invalid",
				typeof row.to_json === "string" ? row.to_json : "[]",
				subject,
				typeof row.snippet === "string" ? row.snippet : subject,
				receivedAt,
				rawR2Key,
				rawSha256,
				Number(row.raw_size ?? 0),
				typeof row.parse_status === "string" ? row.parse_status : "parsed",
				Number(row.has_attachments ?? 0),
				isRead,
				createdAt,
				updatedAt,
			);
		}

		this.ctx.storage.sql.exec("DROP TABLE messages_legacy_v0");
	}

	private migrateLegacySchema(): void {
		let messageColumns = this.columnNames("messages");
		let needsMessageRebuild = messageColumns.size > 0 && !messageColumns.has("thread_id");
		try {
			this.ctx.storage.sql.exec("SELECT thread_id FROM messages LIMIT 1").toArray();
		} catch {
			needsMessageRebuild = true;
		}
		if (needsMessageRebuild) {
			this.rebuildLegacyMessagesTable();
			messageColumns = this.columnNames("messages");
		}
		this.addColumnIfMissing("messages", messageColumns, "thread_id", "TEXT NOT NULL DEFAULT ''");
		this.addColumnIfMissing("messages", messageColumns, "rfc_message_id", "TEXT");
		this.addColumnIfMissing("messages", messageColumns, "in_reply_to", "TEXT");
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"references_json",
			"TEXT NOT NULL DEFAULT '[]'",
		);
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"direction",
			"TEXT NOT NULL DEFAULT 'inbound'",
		);
		this.addColumnIfMissing("messages", messageColumns, "state", "TEXT NOT NULL DEFAULT 'inbox'");
		this.addColumnIfMissing("messages", messageColumns, "from_addr", "TEXT NOT NULL DEFAULT ''");
		this.addColumnIfMissing("messages", messageColumns, "to_json", "TEXT NOT NULL DEFAULT '[]'");
		this.addColumnIfMissing("messages", messageColumns, "cc_json", "TEXT NOT NULL DEFAULT '[]'");
		this.addColumnIfMissing("messages", messageColumns, "bcc_json", "TEXT NOT NULL DEFAULT '[]'");
		this.addColumnIfMissing("messages", messageColumns, "snippet", "TEXT");
		this.addColumnIfMissing("messages", messageColumns, "date_header", "TEXT");
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"received_at",
			"TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
		);
		this.addColumnIfMissing("messages", messageColumns, "raw_size", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing("messages", messageColumns, "body_text", "TEXT");
		this.addColumnIfMissing("messages", messageColumns, "body_html_r2_key", "TEXT");
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"parse_status",
			"TEXT NOT NULL DEFAULT 'parsed'",
		);
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"has_attachments",
			"INTEGER NOT NULL DEFAULT 0",
		);
		this.addColumnIfMissing("messages", messageColumns, "is_read", "INTEGER NOT NULL DEFAULT 0");
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"created_at",
			"TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
		);
		this.addColumnIfMissing(
			"messages",
			messageColumns,
			"updated_at",
			"TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
		);

		const ingestColumns = this.columnNames("ingest_events");
		this.addColumnIfMissing(
			"ingest_events",
			ingestColumns,
			"raw_r2_key",
			"TEXT NOT NULL DEFAULT ''",
		);
		this.addColumnIfMissing(
			"ingest_events",
			ingestColumns,
			"raw_sha256",
			"TEXT NOT NULL DEFAULT ''",
		);
		this.addColumnIfMissing(
			"ingest_events",
			ingestColumns,
			"status",
			"TEXT NOT NULL DEFAULT 'processed'",
		);
		this.addColumnIfMissing("ingest_events", ingestColumns, "message_local_id", "TEXT");
		this.addColumnIfMissing("ingest_events", ingestColumns, "error_code", "TEXT");
		this.addColumnIfMissing("ingest_events", ingestColumns, "error_message", "TEXT");
		this.addColumnIfMissing(
			"ingest_events",
			ingestColumns,
			"created_at",
			"TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
		);
		this.addColumnIfMissing(
			"ingest_events",
			ingestColumns,
			"updated_at",
			"TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'",
		);

		const now = new Date().toISOString();
		this.ctx.storage.sql.exec("UPDATE messages SET thread_id = id WHERE thread_id = ''");
		this.ctx.storage.sql.exec(
			"UPDATE messages SET received_at = created_at WHERE received_at = '1970-01-01T00:00:00.000Z'",
		);
		this.ctx.storage.sql.exec(
			"UPDATE messages SET updated_at = ? WHERE updated_at = '1970-01-01T00:00:00.000Z'",
			now,
		);
		this.ctx.storage.sql.exec(
			"UPDATE messages SET created_at = updated_at WHERE created_at = '1970-01-01T00:00:00.000Z'",
		);
		this.ctx.storage.sql.exec(
			`INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
       SELECT thread_id, LOWER(COALESCE(subject, '')), received_at, 1, CASE WHEN is_read = 0 THEN 1 ELSE 0 END, created_at, updated_at
       FROM messages
       WHERE thread_id IS NOT NULL AND thread_id != ''`,
		);
		this.ctx.storage.sql.exec(
			`INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text)
       SELECT id, COALESCE(subject, ''), COALESCE(from_addr, ''), COALESCE(to_json, ''), COALESCE(snippet, ''), COALESCE(body_text, '')
       FROM messages
       WHERE id NOT IN (SELECT message_id FROM message_fts)`,
		);
	}

	// Runs the mailbox's pending jobs (a discarded draft's uploads once its Undo
	// window has passed, the R2/D1 cleanup of permanently deleted messages) and
	// the next batch of a running "Empty trash". Armed by cancelDraft, by
	// runPendingJobs and by advancePurge.
	async alarm(): Promise<void> {
		await this.runPendingJobs();
		await this.advancePurge();
	}

	/**
	 * Start a permanent deletion and run its first batch now; anything left is
	 * continued by the alarm, one bounded batch per run.
	 */
	private async purge(mailboxId: string, target: PurgeTarget): Promise<Response> {
		const started = startPurge(this.ctx.storage.sql, mailboxId, target);
		if ("error" in started) return Response.json(started, { status: 409 });
		await this.advancePurge();
		return Response.json(getPurgeOperation(this.ctx.storage.sql, started.operationId));
	}

	/** One batch of the purge queue, its cleanup job, and the ops events of finished operations. */
	private async advancePurge(): Promise<void> {
		const sql = this.ctx.storage.sql;
		if (hasQueuedPurge(sql)) {
			const batch = runPurgeBatch(sql, (fn) => this.ctx.storage.transactionSync(fn));
			for (const mailboxId of batch.mailboxIds) {
				this.getBroadcaster(mailboxId).broadcast({
					type: "messages.purged",
					payload: { threadIds: batch.threadIds },
				});
			}
			if (batch.jobId) await this.runPendingJobs(batch.jobId);
		}
		await this.reportFinishedPurges();
		if (hasQueuedPurge(sql)) await this.armAlarm(Date.now());
	}

	// One ops event per finished operation: counts and mailbox, nothing about
	// the mail itself. A D1 failure leaves it unreported for the next alarm.
	private async reportFinishedPurges(): Promise<void> {
		const sql = this.ctx.storage.sql;
		const pending = unreportedPurges(sql);
		if (pending.length === 0) return;
		const { insertOpsEvent } = await import("../db/d1");
		for (const op of pending) {
			try {
				await insertOpsEvent(this.env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "mailbox.messages_purged",
					severity: "info",
					subject: op.mailbox_id,
					payload_json: JSON.stringify({
						mailboxId: op.mailbox_id,
						operationId: op.id,
						scope: op.scope,
						messages: op.deleted_messages,
						conversations: op.touched_threads,
						conversationsRemoved: op.removed_threads,
					}),
				});
				markPurgeReported(sql, op.id);
			} catch (error) {
				console.error("mailbox.purge_report_failed", {
					operationId: op.id,
					error: error instanceof Error ? error.message : String(error),
				});
				await this.armAlarm(Date.now() + 5 * 60 * 1000);
				return;
			}
		}
	}

	private getBroadcaster(mailboxId: string) {
		return createRealtimeBroadcaster(
			() => this.ctx.getWebSockets(),
			mailboxId,
			() =>
				this.ctx.storage.sql
					.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM realtime_events")
					.toArray()[0]?.seq ?? 0,
		);
	}

	private async ingestEmail(message: InboundEmailQueueMessage): Promise<MailboxIngestResult> {
		const result = await ingestInboundEmail(
			{
				sql: this.ctx.storage.sql,
				r2: this.env.MAIL_OBJECTS,
				mailboxId: message.mailboxId,
				transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
				authMail: this.env,
			},
			message,
		);

		if (result.status === "inserted" && result.realtimeSeq) {
			this.getBroadcaster(message.mailboxId).broadcast({
				type: "message.created",
				payload: {
					messageId: result.messageLocalId,
					threadId: result.threadId,
					subject: result.subject,
				},
			});
		}

		return result;
	}

	private listThreads(
		limit: number,
		state?: ThreadListState,
		unread?: boolean,
		reports?: ReportsFilter,
		before?: ThreadListCursor,
	) {
		return listThreads(this.ctx.storage.sql, limit, state, unread, reports, before);
	}

	private getThread(threadId: string | undefined) {
		return getThread(this.ctx.storage.sql, threadId);
	}

	private getMessage(messageId: string | undefined) {
		return getMessage(this.ctx.storage.sql, messageId);
	}

	private async getRawMessage(messageId: string | undefined): Promise<Response> {
		const r2Key = getRawMessageR2Key(this.ctx.storage.sql, messageId);
		if (!r2Key) return new Response("Not found", { status: 404 });
		const object = await this.env.MAIL_OBJECTS.get(r2Key);
		if (!object) return new Response("Not found", { status: 404 });
		return new Response(object.body, {
			headers: { "content-type": "message/rfc822" },
		});
	}

	// Streams the stored HTML body. The API layer sandboxes it (strict CSP,
	// iframe sandbox) before it reaches the browser; here we just serve bytes.
	private async getBodyHtml(messageId: string | undefined): Promise<Response> {
		const r2Key = getBodyHtmlR2Key(this.ctx.storage.sql, messageId);
		if (!r2Key) return new Response("Not found", { status: 404 });
		const object = await this.env.MAIL_OBJECTS.get(r2Key);
		if (!object) return new Response("Not found", { status: 404 });
		return new Response(object.body, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	}

	private applyMessageAction(messageId: string | undefined, action: string) {
		return applyMessageAction(this.ctx.storage.sql, messageId, action);
	}

	private listDrafts() {
		return listDrafts(this.ctx.storage.sql);
	}

	private getDraft(draftId: string | undefined) {
		return getDraft(this.ctx.storage.sql, draftId);
	}

	private createDraft(body: Record<string, unknown>) {
		return createDraft(this.ctx.storage.sql, body);
	}

	private updateDraft(draftId: string | undefined, body: Record<string, unknown>) {
		return updateDraft(this.ctx.storage.sql, draftId, body);
	}

	private requestSendDraft(
		draftId: string | undefined,
		mailboxAddress?: string | null,
		displayName?: string | null,
		replaceStale?: boolean,
	) {
		const identity = resolveReplyIdentity(
			this.env,
			this.ctx.storage.sql,
			draftId,
			this.resolveMailboxAddress(mailboxAddress),
			this.resolveMailboxDisplayName(displayName),
		);
		return requestSendDraft(this.ctx.storage.sql, draftId, identity, replaceStale);
	}

	/**
	 * The mailbox's own address, which decides the From/Reply-To of a reply. The DO
	 * has no view of the D1 control plane, so the caller supplies it and we cache it
	 * in mailbox_meta — later sends (a Telegram confirm, a retry) then work even when
	 * the caller didn't pass it.
	 */
	/**
	 * The mailbox's display name, cached in mailbox_meta.
	 *
	 * Same shape as resolveMailboxAddress: the DO has no D1 access, so the value
	 * travels in on requests that know it and is remembered for the ones that do
	 * not. A caller that omits it gets the last one seen rather than nothing,
	 * which keeps Telegram- and MCP-initiated sends named like UI-initiated ones.
	 */
	private resolveMailboxDisplayName(provided: string | null | undefined): string | null {
		const candidate = provided?.trim();
		if (candidate) {
			this.ctx.storage.sql.exec(
				`INSERT INTO mailbox_meta (key, value, updated_at) VALUES ('display_name', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
				candidate,
				new Date().toISOString(),
			);
			return candidate;
		}
		const cached = this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = 'display_name'")
			.toArray()[0];
		return cached?.value ?? null;
	}

	private resolveMailboxAddress(provided: string | null | undefined): string | null {
		const candidate = provided?.trim().toLowerCase();
		if (candidate?.includes("@")) {
			this.ctx.storage.sql.exec(
				`INSERT INTO mailbox_meta (key, value, updated_at) VALUES ('primary_address', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
				candidate,
				new Date().toISOString(),
			);
			return candidate;
		}
		const cached = this.ctx.storage.sql
			.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = 'primary_address'")
			.toArray()[0];
		return cached?.value ?? null;
	}

	private async confirmSendDraft(
		draftId: string | undefined,
		idempotencyKey: string,
		mailboxAddress?: string | null,
		displayName?: string | null,
		expectedPayloadHash?: string,
		approvalProof?: McpApprovalProof | null,
	): Promise<Record<string, unknown>> {
		const identity = resolveReplyIdentity(
			this.env,
			this.ctx.storage.sql,
			draftId,
			this.resolveMailboxAddress(mailboxAddress),
			this.resolveMailboxDisplayName(displayName),
		);
		return confirmSendDraft(
			{
				sql: this.ctx.storage.sql,
				transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
				email: this.env.EMAIL,
				fromAddress: identity.from,
				fromName: identity.fromName,
				replyToAddress: identity.replyTo,
				r2: this.env.MAIL_OBJECTS,
				mailboxId: this.ctx.id.name,
				approvalProofSecret: approvalProofSecret(this.env),
			},
			draftId,
			idempotencyKey,
			expectedPayloadHash,
			approvalProof,
		);
	}

	private async cancelDraft(draftId: string | undefined, allowed?: string[]) {
		const result = cancelDraft(this.ctx.storage.sql, draftId, allowed);
		// Uploaded files outlive a discard for the Undo window, then a job deletes
		// them unless the draft was restored.
		if (!("error" in result) && draftId) {
			const runAt = scheduleDraftAttachmentPurge(this.ctx.storage.sql, draftId);
			if (runAt) await this.armAlarm(new Date(runAt).getTime());
		}
		return result;
	}

	private async armAlarm(at: number): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		// An alarm time already in the past is the one firing right now (or about
		// to): it must not stop the next wake-up from being set.
		if (current === null || current > at || current <= Date.now()) {
			await this.ctx.storage.setAlarm(at);
		}
	}

	private async draftAttachmentRoute(request: Request, url: URL): Promise<Response | null> {
		const match = url.pathname.match(/^\/drafts\/([^/]+)\/attachments(?:\/([^/]+))?$/);
		if (!match) return null;
		const draftId = match[1]!;
		const tail = match[2];
		const sql = this.ctx.storage.sql;
		const statusOf = (error: string) =>
			error === "attachment_not_found" || error === "message_not_found"
				? 404
				: error === "attachment_too_large" ||
						error === "attachments_too_large" ||
						error === "too_many_attachments"
					? 413
					: 409;
		if (!tail && request.method === "GET") {
			getDraft(sql, draftId);
			return Response.json({ attachments: listDraftAttachments(sql, draftId) });
		}
		if (!tail && request.method === "POST") {
			const body = (await request.json()) as {
				id: string;
				filename: string;
				contentType: string;
				size: number;
				sha256: string;
				r2Key: string;
			};
			const result = addUploadedAttachment(sql, draftId, body);
			return Response.json(result, {
				status: "error" in result ? statusOf(result.error) : 201,
			});
		}
		if (tail === "from-message" && request.method === "POST") {
			const body = (await request.json()) as { messageId: string; attachmentIds?: string[] };
			const result = addMessageAttachments(sql, draftId, body.messageId, body.attachmentIds);
			return Response.json(result, {
				status: "error" in result ? statusOf(result.error) : 200,
			});
		}
		if (tail && request.method === "GET") {
			const row = getDraftAttachmentRow(sql, draftId, tail);
			if (!row) return Response.json({ error: "attachment_not_found" }, { status: 404 });
			return Response.json({ attachment: row });
		}
		if (tail && request.method === "DELETE") {
			const result = removeDraftAttachment(sql, draftId, tail);
			if ("error" in result) {
				return Response.json(result, { status: statusOf(result.error) });
			}
			if (result.deleteR2Key) {
				try {
					await this.env.MAIL_OBJECTS.delete(result.deleteR2Key);
				} catch (error) {
					// The row is gone, so the file is off the draft either way; a leftover
					// object under the draft prefix is logged, not surfaced.
					console.error("mailbox.draft_attachment_delete_failed", {
						draftId,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
			return Response.json({ removed: result.removed });
		}
		return null;
	}

	private exportMessageIndex() {
		return exportMessageIndex(this.ctx.storage.sql);
	}

	// Mailbox-local jobs from the `jobs` table: a draft discard
	// (PURGE_DRAFT_ATTACHMENTS_JOB) and the R2/D1 cleanup of permanently deleted
	// messages (PURGE_OBJECTS_JOB). Unknown types are marked done. `onlyJobId`
	// runs that one job now, whatever its next_run_at (a purge batch just queued it).
	private async runPendingJobs(onlyJobId?: string): Promise<void> {
		const now = new Date().toISOString();
		const jobs = onlyJobId
			? this.ctx.storage.sql
					.exec<{ id: string; type: string; payload_json: string }>(
						"SELECT id, type, payload_json FROM jobs WHERE status = 'pending' AND id = ?",
						onlyJobId,
					)
					.toArray()
			: this.ctx.storage.sql
					.exec<{ id: string; type: string; payload_json: string }>(
						"SELECT id, type, payload_json FROM jobs WHERE status = 'pending' AND next_run_at <= ? LIMIT 5",
						now,
					)
					.toArray();
		for (const job of jobs) {
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?",
				now,
				job.id,
			);
			let status: "done" | "pending" | "failed" = "done";
			let nextRunAt = now;
			let lastError: string | null = null;
			try {
				await this.runJob(job.id, job.type, job.payload_json);
			} catch (error) {
				lastError = error instanceof Error ? error.message.slice(0, 200) : String(error);
				const attempts =
					this.ctx.storage.sql
						.exec<{ attempts: number }>("SELECT attempts FROM jobs WHERE id = ?", job.id)
						.toArray()[0]?.attempts ?? 1;
				// A transient R2 error retries hourly, a few times, then stays visible as
				// failed. Deleted mail's leftovers retry sooner and for longer: until they
				// are gone, an object the owner deleted forever still exists.
				const purge = job.type === PURGE_OBJECTS_JOB;
				status = attempts >= (purge ? 24 : 5) ? "failed" : "pending";
				nextRunAt = new Date(Date.now() + (purge ? 5 : 60) * 60 * 1000).toISOString();
				if (purge) {
					console.error("mailbox.purge_cleanup_failed", { jobId: job.id, attempts, status });
				}
			}
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET status = ?, next_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
				status,
				nextRunAt,
				lastError,
				now,
				job.id,
			);
		}
		const next = this.ctx.storage.sql
			.exec<{ next_run_at: string }>(
				"SELECT next_run_at FROM jobs WHERE status = 'pending' ORDER BY next_run_at ASC LIMIT 1",
			)
			.toArray()[0];
		if (next) {
			await this.armAlarm(new Date(next.next_run_at).getTime());
		}
	}

	private async runJob(id: string, type: string, payloadJson: string): Promise<void> {
		if (type === PURGE_OBJECTS_JOB) {
			const sql = this.ctx.storage.sql;
			await runPurgeObjectsJob(
				{
					sql,
					r2: this.env.MAIL_OBJECTS,
					db: this.env.INDEX_DB,
					saveProgress: (payload) =>
						sql.exec("UPDATE jobs SET payload_json = ? WHERE id = ?", JSON.stringify(payload), id),
				},
				JSON.parse(payloadJson) as PurgeObjectsPayload,
			);
			return;
		}
		if (type === PURGE_DRAFT_ATTACHMENTS_JOB) {
			const payload = JSON.parse(payloadJson) as { draftId?: string; keys?: string[] };
			// Rows go first, in one synchronous step with the status check, so a draft
			// restored meanwhile can never lose its files. The keys are kept on the job
			// until R2 confirms the delete, so a retry still knows what to remove.
			const keys =
				payload.keys ??
				(payload.draftId
					? purgeDiscardedDraftAttachments(this.ctx.storage.sql, payload.draftId)
					: []);
			if (keys.length === 0) return;
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET payload_json = ? WHERE id = ?",
				JSON.stringify({ ...payload, keys }),
				id,
			);
			await this.env.MAIL_OBJECTS.delete(keys);
		}
	}

	private debugState() {
		return debugState(this.ctx.storage.sql);
	}

	/**
	 * Handles a delivery event from the Email Sending lifecycle event subscription.
	 *
	 * Validation:
	 * 1. Validates the event schema.
	 * 2. Checks eventId idempotency — if already recorded, returns 200 (already processed).
	 * 3. Finds the canonical DO request by provider_message_id.
	 * 4. Validates sender and recipient match exactly.
	 * 5. If no match found via provider_message_id, correlates on the envelope
	 *    against this DO's own rows (see `correlateEventToUnknownRequest`).
	 * 6. Unmatched events return 404 (triggers queue retry/DLQ).
	 *
	 * The queue consumer may pass a `requestId` it resolved from D1. That is a
	 * routing hint and nothing more: for the envelope path the DO recomputes the
	 * candidate from its own storage and refuses if the hint disagrees, because a
	 * rebuildable projection must never be what decides which request an event
	 * gets attributed to.
	 */
	private async handleDeliveryEvent(request: Request): Promise<Response> {
		let json: unknown;
		try {
			json = await request.json();
		} catch {
			return Response.json({ error: "invalid_json" }, { status: 400 });
		}
		if (typeof json !== "object" || json === null) {
			return Response.json({ error: "invalid_payload" }, { status: 400 });
		}
		const body = json as { event?: unknown; requestId?: unknown };
		const { classifyEmailEvent, emailSendingEventSchema } = await import(
			"../cloudflare/email-events"
		);
		const { handleDeliveryEvent: processDeliveryEvent, correlateEventToUnknownRequest } =
			await import("./mailbox-suppressions");
		const parsed = emailSendingEventSchema.safeParse(body.event);
		if (!parsed.success) {
			return Response.json({ error: "invalid_event_schema" }, { status: 400 });
		}
		const event = parsed.data;
		const requestId = typeof body.requestId === "string" ? body.requestId : null;
		const processEvent = (resolvedRequestId: string, correlation: "provider_id" | "envelope") => {
			const classification = classifyEmailEvent(event);
			const { resolvedStatus } = processDeliveryEvent(
				this.ctx.storage.sql,
				event,
				classification,
				resolvedRequestId,
			);
			return Response.json({
				ok: true,
				deliveryStatus: classification.deliveryStatus,
				suppressed: classification.suppress,
				requestId: resolvedRequestId,
				correlation,
				// Present only when this event settled a previously ambiguous send;
				// the consumer mirrors it into the D1 projection.
				resolvedStatus: resolvedStatus ?? undefined,
				providerMessageId: event.provider_message_id,
			});
		};

		// Idempotency check: if event_id already recorded, return 200 (already processed)
		const existingEvent = this.ctx.storage.sql
			.exec<{ event_id: string }>(
				"SELECT event_id FROM transactional_delivery_events WHERE event_id = ?",
				event.event_id,
			)
			.toArray()[0];
		if (existingEvent) {
			return Response.json({ ok: true, idempotent: true });
		}

		// Validate the event against the stored transactional request.
		// Find the request by provider_message_id.
		const requestRow = this.ctx.storage.sql
			.exec<{
				request_id: string;
				to_addr: string;
				sender: string;
			}>(
				"SELECT request_id, to_addr, sender FROM transactional_requests WHERE provider_message_id = ?",
				event.provider_message_id,
			)
			.toArray()[0];

		if (!requestRow) {
			// The provider id is unrecognised, which is the signature of an event for
			// a send that threw before it could tell us its id. Fall back to the
			// envelope, adjudicated here against this DO's own rows.
			const correlation = correlateEventToUnknownRequest(this.ctx.storage.sql, event);
			if (correlation.outcome === "ambiguous") {
				return Response.json({ error: "correlation_ambiguous" }, { status: 409 });
			}
			if (correlation.outcome === "no_candidate") {
				// Unknown event — return 404 (triggers queue retry/DLQ)
				return Response.json({ error: "request_not_found" }, { status: 404 });
			}
			// A hint that names a different request than our own storage does means
			// the projection is stale or wrong. Refuse instead of siding with it.
			if (requestId && requestId !== correlation.requestId) {
				return Response.json({ error: "correlation_hint_mismatch" }, { status: 409 });
			}
			return processEvent(correlation.requestId, "envelope");
		}

		// Validate sender and recipient match
		if (requestRow.sender.toLowerCase() !== event.from.toLowerCase()) {
			return Response.json({ error: "sender_mismatch" }, { status: 404 });
		}
		if (requestRow.to_addr.toLowerCase() !== event.to.toLowerCase()) {
			return Response.json({ error: "recipient_mismatch" }, { status: 404 });
		}

		return processEvent(requestRow.request_id, "provider_id");
	}

	/**
	 * Handles a delivery event for a human-confirmed mailbox send (request-send ->
	 * confirm-send), which has no transactional request row to settle.
	 *
	 * What it records is deliberately small: the event goes into the same
	 * idempotent delivery-event ledger the transactional path uses (keyed by
	 * `event_id`, with `request_id` NULL), and a hard bounce or complaint adds the
	 * recipient to the suppression mirror exactly as a transactional one would.
	 * Suppression is a fact about the recipient, not about which path sent to them.
	 * The mailbox message row gets no delivery-status column: nothing reads one
	 * today, and the ledger already holds the event per provider id should a
	 * reader ever want it.
	 *
	 * Unmatched events return 404 so the consumer retries, as on the
	 * transactional route.
	 */
	private async handleOutboundDeliveryEvent(request: Request): Promise<Response> {
		let json: unknown;
		try {
			json = await request.json();
		} catch {
			return Response.json({ error: "invalid_json" }, { status: 400 });
		}
		const body = (typeof json === "object" && json !== null ? json : {}) as { event?: unknown };
		const { classifyEmailEvent, emailSendingEventSchema } = await import(
			"../cloudflare/email-events"
		);
		const { handleDeliveryEvent: processDeliveryEvent, findOutboundMessageForEvent } = await import(
			"./mailbox-suppressions"
		);
		const parsed = emailSendingEventSchema.safeParse(body.event);
		if (!parsed.success) {
			return Response.json({ error: "invalid_event_schema" }, { status: 400 });
		}
		const event = parsed.data;

		const existingEvent = this.ctx.storage.sql
			.exec<{ event_id: string }>(
				"SELECT event_id FROM transactional_delivery_events WHERE event_id = ?",
				event.event_id,
			)
			.toArray()[0];
		if (existingEvent) {
			return Response.json({ ok: true, idempotent: true });
		}

		const match = findOutboundMessageForEvent(this.ctx.storage.sql, event);
		if (!match) {
			return Response.json({ error: "outbound_message_not_found" }, { status: 404 });
		}

		const classification = classifyEmailEvent(event);
		processDeliveryEvent(this.ctx.storage.sql, event, classification, null);
		return Response.json({
			ok: true,
			deliveryStatus: classification.deliveryStatus,
			suppressed: classification.suppress,
			messageLocalId: match.messageLocalId,
		});
	}
}
