import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import type { InboundEmailQueueMessage, MailboxIngestResult } from "../cloudflare/types";
import { sha256Hex } from "../lib/crypto";
import { buildReferences, messageIdHeader, referencesHeader } from "../lib/email-headers";
import { normalizeMessageId } from "../lib/email-metadata";
import { normalizeSubject } from "../lib/mime";
import {
	resolveDeliveredAlias,
	resolveSenderIdentity,
	type SenderEnv,
	type SenderIdentity,
} from "../lib/sender-identity";
import { AmbiguousSendError } from "../lib/errors";
import { ingestInboundEmail, recordRealtimeEvent, searchMessages } from "./mailbox-ingest";
import {
	createRealtimeBroadcaster,
	handleWebSocketMessage,
	sendHello,
	type WebSocketAttachment,
} from "./mailbox-realtime";
import { MAILBOX_SCHEMA_SQL } from "./mailbox-schema";

type SqlStorage = DurableObjectState["storage"]["sql"];

// Target schema_migrations version. Bump this (and the migration logic in the
// constructor) when a future legacy-schema migration needs to run again.
const MAILBOX_SCHEMA_VERSION = 4;

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
// (sender, subject, snippet, time, attachment/unread affordances) without a
// second round-trip per thread. `latest_*` describe the representative message
// of the thread — overall newest for the unfiltered ("All mail") view, or the
// newest message *in the requested folder* when a state filter is applied, so a
// Sent/Archive/Trash row previews the right message.
const THREAD_LIST_COLUMNS = `
  t.id, t.subject_norm, t.last_message_at, t.message_count, t.unread_count,
  t.created_at, t.updated_at,
  lm.subject AS latest_subject,
  lm.from_addr AS latest_from,
  lm.snippet AS latest_snippet,
  lm.received_at AS latest_received_at,
  lm.has_attachments AS latest_has_attachments,
  lm.is_read AS latest_is_read,
  lm.direction AS latest_direction,
  lm.state AS latest_state`;

function listThreads(sql: SqlStorage, limit: number, state?: ThreadListState) {
	if (state) {
		// The JOIN's correlated subquery only resolves for threads that actually
		// have a message in this state, so it doubles as the folder filter — a
		// thread with no message in `state` is dropped. Order by the folder
		// message's time so the folder view sorts by folder activity.
		return sql
			.exec(
				`SELECT ${THREAD_LIST_COLUMNS}
          FROM threads t
          JOIN messages lm ON lm.id = (
            SELECT m.id FROM messages m
            WHERE m.thread_id = t.id AND m.state = ?
            ORDER BY m.received_at DESC LIMIT 1
          )
          ORDER BY lm.received_at DESC
          LIMIT ?`,
				state,
				limit,
			)
			.toArray();
	}
	return sql
		.exec(
			`SELECT ${THREAD_LIST_COLUMNS}
        FROM threads t
        JOIN messages lm ON lm.id = (
          SELECT m.id FROM messages m WHERE m.thread_id = t.id ORDER BY m.received_at DESC LIMIT 1
        )
        ORDER BY t.last_message_at DESC
        LIMIT ?`,
			limit,
		)
		.toArray();
}

function getThread(sql: SqlStorage, threadId: string | undefined) {
	if (!threadId) return null;
	const thread = sql.exec("SELECT * FROM threads WHERE id = ?", threadId).toArray()[0];
	const messages = sql
		.exec("SELECT * FROM messages WHERE thread_id = ? ORDER BY received_at ASC", threadId)
		.toArray();
	return { thread, messages };
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

function applyMessageAction(sql: SqlStorage, messageId: string | undefined, action: string) {
	if (!messageId) throw new Error("messageId required");
	const now = new Date().toISOString();
	if (action === "mark_read") {
		sql.exec("UPDATE messages SET is_read = 1, updated_at = ? WHERE id = ?", now, messageId);
	} else if (action === "mark_unread") {
		sql.exec("UPDATE messages SET is_read = 0, updated_at = ? WHERE id = ?", now, messageId);
	} else if (action === "archive") {
		sql.exec("UPDATE messages SET state = 'archive', updated_at = ? WHERE id = ?", now, messageId);
	} else if (action === "trash") {
		sql.exec("UPDATE messages SET state = 'trash', updated_at = ? WHERE id = ?", now, messageId);
	} else if (action === "restore_inbox") {
		sql.exec("UPDATE messages SET state = 'inbox', updated_at = ? WHERE id = ?", now, messageId);
	}
	return { ok: true, messageId, action };
}

function listDrafts(sql: SqlStorage) {
	return sql.exec("SELECT * FROM outbound_drafts ORDER BY updated_at DESC").toArray();
}

function getDraft(sql: SqlStorage, draftId: string | undefined) {
	if (!draftId) throw new Error("draftId required");
	const draft = sql.exec("SELECT * FROM outbound_drafts WHERE id = ?", draftId).toArray()[0];
	if (!draft) throw new Error("draft not found");
	return draft;
}

function createDraft(sql: SqlStorage, body: Record<string, unknown>) {
	const idempotencyKey = (body.idempotencyKey as string | undefined) ?? null;
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
				return { id: existing.id, status: "draft", duplicate: true };
			}
			// Unexpected: zero rows written but no existing draft. Treat as internal error.
			throw new Error("draft_idempotency_conflict_unresolved");
		}
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
	return { id, status: "draft" };
}

function updateDraft(sql: SqlStorage, draftId: string | undefined, body: Record<string, unknown>) {
	if (!draftId) throw new Error("draftId required");
	const now = new Date().toISOString();
	const existing = sql.exec("SELECT * FROM outbound_drafts WHERE id = ?", draftId).toArray()[0];
	if (!existing) throw new Error("draft not found");
	sql.exec(
		`UPDATE outbound_drafts SET
         to_json = ?, cc_json = ?, bcc_json = ?, subject = ?, body_text = ?, body_html = ?, updated_at = ?
       WHERE id = ?`,
		JSON.stringify(body.to ?? JSON.parse(String(existing.to_json))),
		JSON.stringify(body.cc ?? JSON.parse(String(existing.cc_json))),
		JSON.stringify(body.bcc ?? JSON.parse(String(existing.bcc_json))),
		body.subject ?? existing.subject,
		body.bodyText ?? existing.body_text,
		body.bodyHtml ?? existing.body_html,
		now,
		draftId,
	);
	return { id: draftId, status: "draft" };
}

function requestSendDraft(sql: SqlStorage, draftId: string | undefined) {
	if (!draftId) throw new Error("draftId required");
	const now = new Date().toISOString();
	// Only a draft can be armed for sending. Guarding on the current status matters
	// now that a retried Telegram update can re-enter this path: an unguarded UPDATE
	// would move an already-sent draft back to pending_confirmation and offer a
	// second Send button for mail that has gone out.
	sql.exec(
		`UPDATE outbound_drafts SET status = 'pending_confirmation', updated_at = ?
     WHERE id = ? AND status IN ('draft', 'pending_confirmation')`,
		now,
		draftId,
	);
	const row = sql
		.exec<{ status: string }>("SELECT status FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!row) throw new Error("draft not found");
	return { id: draftId, status: row.status };
}

type ConfirmSendDraftContext = {
	sql: SqlStorage;
	transactionSync: (fn: () => void) => void;
	email: Env["EMAIL"];
	fromAddress: string;
	replyToAddress: string | null;
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

function parseAddressList(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
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
): SenderIdentity {
	const alias = draftId ? resolveDraftAlias(env, sql, draftId, primaryAddress) : null;
	return resolveSenderIdentity(env, alias ?? primaryAddress);
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
): Promise<Record<string, unknown>> {
	if (!draftId) throw new Error("draftId required");
	const draft = ctx.sql
		.exec<{
			thread_id: string | null;
			to_json: string;
			cc_json: string;
			bcc_json: string;
			subject: string;
			body_text: string | null;
			body_html: string | null;
			status: string;
			parent_message_id?: string | null;
		}>("SELECT * FROM outbound_drafts WHERE id = ?", draftId)
		.toArray()[0];
	if (!draft) throw new Error("draft not found");

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

	const fromAddress = ctx.fromAddress;
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
	const parent = findThreadParent(ctx.sql, draft.thread_id, draft.parent_message_id ?? null);
	// Normalize on read rather than trusting whoever wrote the row: stored ids are
	// meant to be bare, and a stray "<...>" here would emit In-Reply-To: <<id>>,
	// which threads nowhere. normalizeMessageId is idempotent, so this is free.
	const inReplyTo = normalizeMessageId(parent?.rfc_message_id ?? null);
	const references = parent
		? buildReferences(
				(JSON.parse(parent.references_json) as string[])
					.map((reference) => normalizeMessageId(reference))
					.filter((reference): reference is string => Boolean(reference)),
				inReplyTo,
			)
		: [];
	const outboundHeaders: Record<string, string> = {};
	if (inReplyTo) {
		outboundHeaders["In-Reply-To"] = messageIdHeader(inReplyTo);
		outboundHeaders.References = referencesHeader(references);
	}

	let providerMessageId: string | null = null;
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

		const providerResult = await ctx.email.send({
			from: fromAddress,
			to,
			cc: cc.length ? cc : undefined,
			bcc: bcc.length ? bcc : undefined,
			replyTo: ctx.replyToAddress ?? undefined,
			subject: draft.subject,
			text: draft.body_text ?? undefined,
			html: draft.body_html ?? undefined,
			...(Object.keys(outboundHeaders).length > 0 ? { headers: outboundHeaders } : {}),
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
			}),
		),
	);
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
           last_message_at = excluded.last_message_at,
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
          from_addr, to_json, cc_json, bcc_json, subject, snippet,
          received_at, raw_r2_key, raw_sha256, raw_size, parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'outbound', 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'parsed', 0, 1, ?, ?)`,
			messageLocalId,
			sentKey,
			threadId,
			rfcMessageId,
			inReplyTo,
			JSON.stringify(references),
			fromAddress,
			draft.to_json,
			draft.cc_json,
			draft.bcc_json,
			draft.subject,
			(draft.body_text ?? draft.subject).slice(0, 200),
			now,
			rawR2Key,
			rawSha256,
			now,
			now,
		);
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
		snippet: (draft.body_text ?? draft.subject).slice(0, 200),
		receivedAt: now,
		rawR2Key,
		rawSha256,
	};
}

function cancelDraft(sql: SqlStorage, draftId: string | undefined) {
	if (!draftId) throw new Error("draftId required");
	const now = new Date().toISOString();
	sql.exec(
		"UPDATE outbound_drafts SET status = 'cancelled', updated_at = ? WHERE id = ?",
		now,
		draftId,
	);
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
			return Response.json({ results: searchMessages(this.ctx.storage.sql, q, limit) });
		}
		if (url.pathname === "/threads" && request.method === "GET") {
			const stateParam = url.searchParams.get("state");
			const state = isThreadListState(stateParam) ? stateParam : undefined;
			return Response.json({
				threads: this.listThreads(Number(url.searchParams.get("limit") ?? "25"), state),
			});
		}
		if (url.pathname.startsWith("/threads/") && request.method === "GET") {
			const threadId = url.pathname.split("/")[2];
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
			return Response.json(this.updateDraft(draftId, body as Record<string, unknown>));
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/request-send$/) && request.method === "POST") {
			const draftId = url.pathname.split("/")[2];
			return Response.json(this.requestSendDraft(draftId));
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/confirm-send$/) && request.method === "POST") {
			const draftId = url.pathname.split("/")[2];
			const body = (await request.json()) as {
				idempotencyKey: string;
				mailboxAddress?: string | null;
			};
			const result = await this.confirmSendDraft(draftId, body.idempotencyKey, body.mailboxAddress);
			// Ambiguous provider outcomes are business-level, not transport-level errors.
			// Return 200 so the caller's confirmDraftSend reaches the "ambiguous" branch
			// and records D1 status as "unknown" (not "failed"). Any other "error" property
			// (e.g. draft-not-found, too-many-recipients) remains an HTTP error.
			const isAmbiguous = result.error === "ambiguous";
			const status =
				"error" in result && !isAmbiguous
					? result.error === "too_many_recipients"
						? 400
						: 500
					: 200;
			return Response.json(result, { status });
		}
		if (url.pathname.match(/^\/drafts\/[^/]+\/cancel$/) && request.method === "POST") {
			const draftId = url.pathname.split("/")[2];
			return Response.json(this.cancelDraft(draftId));
		}
		if (url.pathname === "/export-index" && request.method === "GET") {
			return Response.json({ messages: this.exportMessageIndex() });
		}
		if (url.pathname === "/alarm" && request.method === "POST") {
			await this.runPendingJobs();
			return Response.json({ ok: true });
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
					scopes: body.scopes as import("../lib/transactional-keys").KeyScope[],
					templateAllowlist: body.templateAllowlist as string[] | null | undefined,
					recipientPolicy: body.recipientPolicy as string | null | undefined,
					quotaMax: body.quotaMax != null ? Number(body.quotaMax) : null,
					expiresAt: body.expiresAt as string | null | undefined,
				});
				return Response.json(result, { status: 201 });
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				const status = msg === "invalid_scopes" ? 400 : 500;
				return Response.json({ error: msg }, { status });
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
						created_at: string;
						updated_at: string;
					}>(
						"SELECT request_id, key_id, status, to_addr, template_id, sender, provider_message_id, error_code, delivery_status, delivery_event_at, created_at, updated_at FROM transactional_requests WHERE request_id = ?",
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

			const status =
				result.status === "rejected"
					? result.error === "missing_authorization"
						? 401
						: result.error === "idempotency_key_required"
							? 400
							: 403
					: result.status === "idempotency_conflict"
						? 409
						: 200;

			return Response.json(result, { status });
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
			const authHeader = request.headers.get("Authorization");
			if (!authHeader?.startsWith("Bearer ")) {
				return Response.json({ error: "missing_authorization" }, { status: 401 });
			}
			const rawKey = authHeader.slice("Bearer ".length).trim();
			if (!rawKey) {
				return Response.json({ error: "missing_authorization" }, { status: 401 });
			}
			const { parseApiKey } = await import("../lib/transactional-keys");
			const parsed = parseApiKey(rawKey);
			if (!parsed) {
				return Response.json({ error: "invalid_api_key" }, { status: 403 });
			}
			const { getTransactionalRequestStatus, getApiKeyRecord } = await import(
				"./transactional-send-ops"
			);
			const record = getApiKeyRecord(this.ctx.storage.sql, parsed.keyId);
			if (!record) {
				return Response.json({ error: "invalid_api_key" }, { status: 403 });
			}
			if (record.status === "revoked") {
				return Response.json({ error: "key_revoked" }, { status: 403 });
			}
			if (!record.scopes.includes("transactional:status")) {
				return Response.json({ error: "insufficient_scope" }, { status: 403 });
			}
			const statusRecord = getTransactionalRequestStatus(
				this.ctx.storage.sql,
				requestId,
				parsed.keyId,
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
				if (!body.id || !body.subject) {
					return Response.json({ error: "id_and_subject_required" }, { status: 400 });
				}
				if (body.id.includes("..") || body.id.includes("/") || body.id.includes("\\")) {
					return Response.json({ error: "invalid_template_id" }, { status: 400 });
				}
				if (body.subject.includes("\r") || body.subject.includes("\n")) {
					return Response.json({ error: "subject_contains_newline" }, { status: 400 });
				}
				if (body.body_text && body.body_text.length > 100_000) {
					return Response.json({ error: "body_text_too_long" }, { status: 400 });
				}
				if (body.body_html && body.body_html.length > 100_000) {
					return Response.json({ error: "body_html_too_long" }, { status: 400 });
				}
				const { createTemplate } = await import("./transactional-send-ops");
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

	// Reserved, currently unused: fires only if something calls storage.setAlarm(),
	// which today only happens from inside runPendingJobs() itself (see its comment).
	async alarm(): Promise<void> {
		await this.runPendingJobs();
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

	private listThreads(limit: number, state?: ThreadListState) {
		return listThreads(this.ctx.storage.sql, limit, state);
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

	private requestSendDraft(draftId: string | undefined) {
		return requestSendDraft(this.ctx.storage.sql, draftId);
	}

	/**
	 * The mailbox's own address, which decides the From/Reply-To of a reply. The DO
	 * has no view of the D1 control plane, so the caller supplies it and we cache it
	 * in mailbox_meta — later sends (a Telegram confirm, a retry) then work even when
	 * the caller didn't pass it.
	 */
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
	): Promise<Record<string, unknown>> {
		const identity = resolveReplyIdentity(
			this.env,
			this.ctx.storage.sql,
			draftId,
			this.resolveMailboxAddress(mailboxAddress),
		);
		return confirmSendDraft(
			{
				sql: this.ctx.storage.sql,
				transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
				email: this.env.EMAIL,
				fromAddress: identity.from,
				replyToAddress: identity.replyTo,
			},
			draftId,
			idempotencyKey,
		);
	}

	private cancelDraft(draftId: string | undefined) {
		return cancelDraft(this.ctx.storage.sql, draftId);
	}

	private exportMessageIndex() {
		return exportMessageIndex(this.ctx.storage.sql);
	}

	// Reserved, currently unused: the `jobs` table (see the comment on its CREATE
	// TABLE in mailbox-schema-content.ts) has no writers yet, so this always finds
	// zero pending jobs. Kept wired up (and gated by DO alarm) for the planned
	// mailbox-local job-queue milestone in docs/IMPLEMENTATION.md.
	private async runPendingJobs(): Promise<void> {
		const now = new Date().toISOString();
		const jobs = this.ctx.storage.sql
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
			this.ctx.storage.sql.exec(
				"UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?",
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
			await this.ctx.storage.setAlarm(new Date(next.next_run_at).getTime());
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
	 * 5. If no match found via provider_message_id, falls back to requestId lookup.
	 * 6. Unmatched events return 404 (triggers queue retry/DLQ).
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
		const { handleDeliveryEvent: processDeliveryEvent } = await import("./mailbox-suppressions");
		const parsed = emailSendingEventSchema.safeParse(body.event);
		if (!parsed.success) {
			return Response.json({ error: "invalid_event_schema" }, { status: 400 });
		}
		const event = parsed.data;
		const requestId = typeof body.requestId === "string" ? body.requestId : null;
		const processEvent = (resolvedRequestId: string): Response => {
			const classification = classifyEmailEvent(event);
			processDeliveryEvent(this.ctx.storage.sql, event, classification, resolvedRequestId);
			return Response.json({
				ok: true,
				deliveryStatus: classification.deliveryStatus,
				suppressed: classification.suppress,
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
			// If we have a requestId from D1, try that too
			if (requestId) {
				const rowByRequestId = this.ctx.storage.sql
					.exec<{
						request_id: string;
						to_addr: string;
						sender: string;
					}>(
						"SELECT request_id, to_addr, sender FROM transactional_requests WHERE request_id = ?",
						requestId,
					)
					.toArray()[0];
				if (
					rowByRequestId &&
					rowByRequestId.sender.toLowerCase() === event.from.toLowerCase() &&
					rowByRequestId.to_addr.toLowerCase() === event.to.toLowerCase()
				) {
					return processEvent(rowByRequestId.request_id);
				}
			}
			// Unknown event — return 404 (triggers queue retry/DLQ)
			return Response.json({ error: "request_not_found" }, { status: 404 });
		}

		// Validate sender and recipient match
		if (requestRow.sender.toLowerCase() !== event.from.toLowerCase()) {
			return Response.json({ error: "sender_mismatch" }, { status: 404 });
		}
		if (requestRow.to_addr.toLowerCase() !== event.to.toLowerCase()) {
			return Response.json({ error: "recipient_mismatch" }, { status: 404 });
		}

		return processEvent(requestRow.request_id);
	}
}
