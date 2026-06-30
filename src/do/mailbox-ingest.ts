import type { InboundEmailQueueMessage, MailboxIngestResult } from "../cloudflare/types";
import { sha256Hex } from "../lib/crypto";
import { normalizeMessageId } from "../lib/email-metadata";
import { attachmentR2Key, bodyHtmlR2Key, sanitizeFilename } from "../lib/r2-keys";
import { normalizeSubject, parseMimeBytes, snippetFromText } from "../lib/mime";

type SqlStorage = DurableObjectState["storage"]["sql"];

export type IngestContext = {
	sql: SqlStorage;
	r2: R2Bucket;
	mailboxId: string;
	transactionSync: (fn: () => void) => void;
};

function nowIso(): string {
	return new Date().toISOString();
}

function resolveThreadId(
	sql: SqlStorage,
	input: {
		inReplyTo: string | null;
		references: string[];
		subjectNorm: string | null;
	},
): string {
	const candidates = [input.inReplyTo, ...input.references]
		.map((value) => normalizeMessageId(value))
		.filter((value): value is string => Boolean(value));

	for (const rfcId of candidates) {
		const row = sql
			.exec<{ thread_id: string }>("SELECT thread_id FROM messages WHERE rfc_message_id = ? LIMIT 1", rfcId)
			.toArray()[0];
		if (row) return row.thread_id;
	}

	if (input.subjectNorm) {
		const row = sql
			.exec<{ id: string }>(
				"SELECT id FROM threads WHERE subject_norm = ? ORDER BY last_message_at DESC LIMIT 1",
				input.subjectNorm,
			)
			.toArray()[0];
		if (row) return row.id;
	}

	return crypto.randomUUID();
}

function bumpContact(sql: SqlStorage, email: string, now: string): void {
	sql.exec(
		`INSERT INTO contacts (email, name, last_seen_at, message_count, updated_at)
     VALUES (?, NULL, ?, 1, ?)
     ON CONFLICT(email) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       message_count = message_count + 1,
       updated_at = excluded.updated_at`,
		email,
		now,
		now,
	);
}

function nextRealtimeSeq(sql: SqlStorage): number {
	const row = sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM realtime_events").toArray()[0];
	return row?.seq ?? 1;
}

export function recordRealtimeEvent(
	sql: SqlStorage,
	eventType: string,
	payload: Record<string, unknown>,
): number {
	const seq = nextRealtimeSeq(sql);
	const now = nowIso();
	sql.exec(
		"INSERT INTO realtime_events (event_type, payload_json, created_at) VALUES (?, ?, ?)",
		eventType,
		JSON.stringify(payload),
		now,
	);
	return seq;
}

export async function ingestInboundEmail(
	ctx: IngestContext,
	message: InboundEmailQueueMessage,
): Promise<MailboxIngestResult> {
	const existing = ctx.sql
		.exec<{
			message_local_id: string | null;
			raw_sha256: string;
			status: string;
		}>("SELECT message_local_id, raw_sha256, status FROM ingest_events WHERE idempotency_key = ?", message.idempotencyKey)
		.toArray()[0];

	if (existing?.raw_sha256 && existing.raw_sha256 !== message.rawSha256) {
		return {
			status: "conflict",
			mailboxId: message.mailboxId,
			messageCount: messageCount(ctx.sql),
			idempotencyKey: message.idempotencyKey,
			messageLocalId: "",
			rawR2Key: message.rawR2Key,
			errorCode: "message_id_conflict",
		};
	}

	if (existing?.message_local_id) {
		return {
			status: "duplicate",
			mailboxId: message.mailboxId,
			messageCount: messageCount(ctx.sql),
			idempotencyKey: message.idempotencyKey,
			messageLocalId: existing.message_local_id,
			rawR2Key: message.rawR2Key,
		};
	}

	const rawObject = await ctx.r2.get(message.rawR2Key);
	if (!rawObject) {
		throw new Error(`raw MIME missing: ${message.rawR2Key}`);
	}
	const rawBytes = new Uint8Array(await rawObject.arrayBuffer());

	let parseStatus: "parsed" | "failed" = "parsed";
	let bodyText: string | null = null;
	let bodyHtmlR2KeyValue: string | null = null;
	let subject = message.headers.subject;
	let fromAddr = message.sender;
	let toJson = JSON.stringify([message.recipient]);
	let ccJson = "[]";
	let inReplyTo: string | null = message.headers.inReplyTo;
	let referencesJson = JSON.stringify(message.headers.references);
	let attachments: Array<{
		id: string;
		filename: string | null;
		contentType: string;
		disposition: string | null;
		contentId: string | null;
		size: number;
		sha256: string;
		r2Key: string;
	}> = [];

	try {
		const parsed = await parseMimeBytes(rawBytes);
		subject = parsed.subject ?? subject;
		fromAddr = parsed.from || fromAddr;
		toJson = JSON.stringify(parsed.to.length ? parsed.to : [message.recipient]);
		ccJson = JSON.stringify(parsed.cc);
		inReplyTo = normalizeMessageId(parsed.inReplyTo) ?? inReplyTo;
		referencesJson = JSON.stringify(
			parsed.references.map((ref) => normalizeMessageId(ref)).filter(Boolean),
		);
		bodyText = parsed.text;
		const messageLocalId = crypto.randomUUID();
		if (parsed.html) {
			bodyHtmlR2KeyValue = bodyHtmlR2Key({ mailboxId: ctx.mailboxId, messageLocalId });
			await ctx.r2.put(bodyHtmlR2KeyValue, parsed.html, {
				httpMetadata: { contentType: "text/html; charset=utf-8" },
			});
		}

		for (const attachment of parsed.attachments) {
			const sha256 = await sha256Hex(attachment.content);
			const safeFilename = sanitizeFilename(attachment.filename);
			const r2Key = attachmentR2Key({
				mailboxId: ctx.mailboxId,
				messageLocalId,
				attachmentSha256: sha256,
				safeFilename,
			});
			await ctx.r2.put(r2Key, attachment.content, {
				httpMetadata: { contentType: attachment.mimeType },
			});
			attachments.push({
				id: crypto.randomUUID(),
				filename: attachment.filename,
				contentType: attachment.mimeType,
				disposition: attachment.disposition,
				contentId: attachment.contentId,
				size: attachment.content.byteLength,
				sha256,
				r2Key,
			});
		}

		const now = nowIso();
		const subjectNorm = normalizeSubject(subject);
		const threadId = resolveThreadId(ctx.sql, {
			inReplyTo,
			references: JSON.parse(referencesJson) as string[],
			subjectNorm,
		});
		const snippet = snippetFromText(bodyText, parsed.html);

		ctx.transactionSync(() => {
			ctx.sql.exec(
				`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           last_message_at = excluded.last_message_at,
           message_count = message_count + 1,
           unread_count = unread_count + 1,
           updated_at = excluded.updated_at`,
				threadId,
				subjectNorm,
				message.receivedAt,
				now,
				now,
			);

			ctx.sql.exec(
				`INSERT INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
          from_addr, to_json, cc_json, bcc_json, subject, snippet, date_header, received_at, raw_r2_key,
          raw_sha256, raw_size, body_text, body_html_r2_key, parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'inbound', 'inbox', ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', ?, 0, ?, ?)`,
				messageLocalId,
				message.idempotencyKey,
				threadId,
				message.messageId,
				inReplyTo,
				referencesJson,
				fromAddr,
				toJson,
				ccJson,
				subject,
				snippet,
				message.headers.date,
				message.receivedAt,
				message.rawR2Key,
				message.rawSha256,
				message.rawSize,
				bodyText,
				bodyHtmlR2KeyValue,
				attachments.length > 0 ? 1 : 0,
				now,
				now,
			);

			for (const attachment of attachments) {
				ctx.sql.exec(
					`INSERT INTO attachments
           (id, message_id, filename, content_type, disposition, content_id, size, sha256, r2_key, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					attachment.id,
					messageLocalId,
					attachment.filename,
					attachment.contentType,
					attachment.disposition,
					attachment.contentId,
					attachment.size,
					attachment.sha256,
					attachment.r2Key,
					now,
				);
			}

			ctx.sql.exec(
				`INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text)
         VALUES (?, ?, ?, ?, ?, ?)`,
				messageLocalId,
				subject ?? "",
				fromAddr,
				toJson,
				snippet,
				bodyText ?? "",
			);

			ctx.sql.exec(
				`INSERT INTO ingest_events
         (idempotency_key, raw_r2_key, raw_sha256, status, message_local_id, error_code, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'processed', ?, NULL, NULL, ?, ?)`,
				message.idempotencyKey,
				message.rawR2Key,
				message.rawSha256,
				messageLocalId,
				now,
				now,
			);

			bumpContact(ctx.sql, fromAddr, now);
		});

		const seq = recordRealtimeEvent(ctx.sql, "message.created", {
			messageId: messageLocalId,
			threadId,
			subject,
			from: fromAddr,
			receivedAt: message.receivedAt,
		});

		return {
			status: "inserted",
			mailboxId: message.mailboxId,
			messageCount: messageCount(ctx.sql),
			idempotencyKey: message.idempotencyKey,
			messageLocalId,
			rawR2Key: message.rawR2Key,
			threadId,
			subject,
			snippet,
			fromAddr,
			toJson,
			receivedAt: message.receivedAt,
			hasAttachments: attachments.length > 0,
			rfcMessageId: message.messageId,
			parseStatus,
			realtimeSeq: seq,
		};
	} catch (error) {
		parseStatus = "failed";
		const now = nowIso();
		const messageLocalId = crypto.randomUUID();
		const threadId = crypto.randomUUID();
		const snippet = snippetFromText(null, null);

		ctx.transactionSync(() => {
			ctx.sql.exec(
				`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, NULL, ?, 1, 1, ?, ?)`,
				threadId,
				message.receivedAt,
				now,
				now,
			);
			ctx.sql.exec(
				`INSERT INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
          from_addr, to_json, cc_json, bcc_json, subject, snippet, date_header, received_at, raw_r2_key,
          raw_sha256, raw_size, body_text, body_html_r2_key, parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'inbound', 'inbox', ?, ?, '[]', '[]', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'failed', 0, 0, ?, ?)`,
				messageLocalId,
				message.idempotencyKey,
				threadId,
				message.messageId,
				inReplyTo,
				referencesJson,
				fromAddr,
				toJson,
				subject,
				snippet,
				message.headers.date,
				message.receivedAt,
				message.rawR2Key,
				message.rawSha256,
				message.rawSize,
				now,
				now,
			);
			ctx.sql.exec(
				`INSERT INTO ingest_events
         (idempotency_key, raw_r2_key, raw_sha256, status, message_local_id, error_code, error_message, created_at, updated_at)
         VALUES (?, ?, ?, 'processed', ?, 'parse_failed', ?, ?, ?)`,
				message.idempotencyKey,
				message.rawR2Key,
				message.rawSha256,
				messageLocalId,
				error instanceof Error ? error.message : String(error),
				now,
				now,
			);
		});

		return {
			status: "inserted",
			mailboxId: message.mailboxId,
			messageCount: messageCount(ctx.sql),
			idempotencyKey: message.idempotencyKey,
			messageLocalId,
			rawR2Key: message.rawR2Key,
			threadId,
			subject,
			snippet,
			fromAddr,
			toJson,
			receivedAt: message.receivedAt,
			hasAttachments: false,
			rfcMessageId: message.messageId,
			parseStatus,
		};
	}
}

export function messageCount(sql: SqlStorage): number {
	return sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").toArray()[0]?.count ?? 0;
}

export function searchMessages(sql: SqlStorage, query: string, limit: number): Array<{ message_id: string }> {
	const escaped = query.replace(/"/g, '""');
	return sql
		.exec<{ message_id: string }>(
			`SELECT message_id FROM message_fts WHERE message_fts MATCH ? ORDER BY rank LIMIT ?`,
			`"${escaped}"`,
			limit,
		)
		.toArray();
}
