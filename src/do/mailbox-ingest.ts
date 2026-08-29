import type { InboundEmailQueueMessage, MailboxIngestResult } from "../cloudflare/types";
import { sha256Hex } from "../lib/crypto";
import { domainFromAddress } from "../lib/email-headers";
import { normalizeMessageId } from "../lib/email-metadata";
import { normalizeSubject, parseMimeBytes, snippetFromText } from "../lib/mime";
import { attachmentR2Key, bodyHtmlR2Key, sanitizeFilename } from "../lib/r2-keys";

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

/**
 * How far back the subject-only fallback may reach, measured against the
 * candidate thread's last_message_at. Subject equality is weak evidence: on a
 * catch-all address "Hola", "Test" and "Factura" recur forever from unrelated
 * strangers, and without a bound a mail can be welded onto a thread that went
 * quiet months ago (production had a July mail and an August mail sharing a
 * thread on the strength of the subject "test"). 30 days is roughly the point
 * past which a repeated subject is more likely a new conversation than a
 * continuation of a silent one.
 */
const SUBJECT_FALLBACK_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Same-subject threads inspected before giving up. More than a handful in the
 * window means the subject is generic, which is exactly when merging is wrong. */
const SUBJECT_FALLBACK_CANDIDATES = 5;

/** Messages read per candidate thread to build its participant set. */
const PARTICIPANT_SCAN_LIMIT = 50;

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
 * The domains that belong to this mailbox. Derived from the address the mail was
 * actually routed to (under a catch-all that is always one of ours) plus the
 * cached primary address, because the DO has no view of the D1 control plane.
 */
function mailboxOwnDomains(sql: SqlStorage, deliveredTo: string): Set<string> {
	const domains = new Set<string>();
	const delivered = domainFromAddress(deliveredTo.trim().toLowerCase());
	if (delivered) domains.add(delivered);
	const primary = sql
		.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = 'primary_address'")
		.toArray()[0]?.value;
	const primaryDomain = primary ? domainFromAddress(primary.trim().toLowerCase()) : null;
	if (primaryDomain) domains.add(primaryDomain);
	return domains;
}

/**
 * "Participants" for the subject fallback = the *counterparties* of a message:
 * its sender plus its To/Cc, minus every address in the mailbox's own domains.
 *
 * Dropping our own addresses is the whole point. With a catch-all they sit on
 * both sides of every message (as recipient inbound, as sender outbound), so a
 * naive intersection would be non-empty for any two messages and the check would
 * wave through exactly the merges it exists to stop. What remains — the humans on
 * the other end — is what actually distinguishes two conversations that happen to
 * share a subject, and it is one cheap indexed read per candidate thread.
 */
function counterparties(ownDomains: Set<string>, addresses: string[]): Set<string> {
	const result = new Set<string>();
	for (const raw of addresses) {
		const address = raw?.trim().toLowerCase();
		if (!address?.includes("@")) continue;
		const domain = domainFromAddress(address);
		if (domain && ownDomains.has(domain)) continue;
		result.add(address);
	}
	return result;
}

/**
 * Subject-based threading, for the many clients that reply without References.
 * Only accepted when the candidate thread is both recent (window) and demonstrably
 * about the same people (shared counterparty). Failing either, the caller mints a
 * new thread, which is the safe direction: a split conversation is a nuisance, a
 * merged one leaks one stranger's mail into another's thread.
 */
function findThreadBySubject(
	sql: SqlStorage,
	input: {
		subjectNorm: string;
		fromAddr: string;
		recipients: string[];
		deliveredTo: string;
		receivedAt: string;
	},
): string | null {
	const ownDomains = mailboxOwnDomains(sql, input.deliveredTo);
	const incoming = counterparties(ownDomains, [input.fromAddr, ...input.recipients]);
	// Nothing but our own addresses on the message: no way to tell conversations
	// apart, so don't guess.
	if (incoming.size === 0) return null;

	const receivedAtMs = Date.parse(input.receivedAt);
	const anchor = Number.isNaN(receivedAtMs) ? Date.now() : receivedAtMs;
	// Timestamps are stored as ISO-8601 UTC, so lexicographic order is chronological
	// order and the window is a plain string comparison SQLite can index.
	const cutoff = new Date(anchor - SUBJECT_FALLBACK_WINDOW_MS).toISOString();

	const candidates = sql
		.exec<{ id: string }>(
			`SELECT id FROM threads WHERE subject_norm = ? AND last_message_at >= ?
       ORDER BY last_message_at DESC LIMIT ?`,
			input.subjectNorm,
			cutoff,
			SUBJECT_FALLBACK_CANDIDATES,
		)
		.toArray();

	for (const candidate of candidates) {
		const rows = sql
			.exec<{ from_addr: string; to_json: string; cc_json: string }>(
				`SELECT from_addr, to_json, cc_json FROM messages WHERE thread_id = ?
         ORDER BY received_at DESC LIMIT ?`,
				candidate.id,
				PARTICIPANT_SCAN_LIMIT,
			)
			.toArray();
		for (const row of rows) {
			const known = counterparties(ownDomains, [
				row.from_addr,
				...parseAddressList(row.to_json),
				...parseAddressList(row.cc_json),
			]);
			for (const address of known) {
				if (incoming.has(address)) return candidate.id;
			}
		}
	}
	return null;
}

/**
 * Exported for tests: which thread an inbound mail joins is the decision that
 * makes an inbox readable, and it is worth pinning both halves of it — the
 * header match that is authoritative, and the subject fallback that is a guess.
 */
export function resolveThreadId(
	sql: SqlStorage,
	input: {
		inReplyTo: string | null;
		references: string[];
		subjectNorm: string | null;
		fromAddr: string;
		recipients: string[];
		deliveredTo: string;
		receivedAt: string;
	},
): string {
	const candidates = [input.inReplyTo, ...input.references]
		.map((value) => normalizeMessageId(value))
		.filter((value): value is string => Boolean(value));

	for (const rfcId of candidates) {
		// COLLATE NOCASE rather than lower() on both sides: msg-ids are US-ASCII, which
		// is precisely what NOCASE folds, and it can use idx_messages_rfc_message_id_nocase
		// (a lower() expression is unindexable here). Case-insensitivity is what keeps
		// threading working across the change that stopped lowercasing stored ids —
		// rows written by earlier versions hold the folded form.
		const row = sql
			.exec<{ thread_id: string }>(
				"SELECT thread_id FROM messages WHERE rfc_message_id = ? COLLATE NOCASE LIMIT 1",
				rfcId,
			)
			.toArray()[0];
		if (row) return row.thread_id;
	}

	if (input.subjectNorm) {
		const matched = findThreadBySubject(sql, {
			subjectNorm: input.subjectNorm,
			fromAddr: input.fromAddr,
			recipients: input.recipients,
			deliveredTo: input.deliveredTo,
			receivedAt: input.receivedAt,
		});
		if (matched) return matched;
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
	const row = sql
		.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM realtime_events")
		.toArray()[0];
	return row?.seq ?? 1;
}

// The DO SQLite driver doesn't expose a typed error code for constraint violations;
// it surfaces as a generic Error whose message mentions "UNIQUE"/"constraint". We
// detect that specifically so a concurrent duplicate insert (same idempotency_key)
// resolves to a clean duplicate/conflict result instead of throwing a spurious 500.
function isUniqueConstraintViolation(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /unique/i.test(message) && /constraint/i.test(message);
}

// Re-reads the row that won the race so we can answer with the same shape the
// upfront idempotency pre-check would have returned, had it observed the winner.
function resolveConcurrentIdempotencyConflict(
	sql: SqlStorage,
	message: InboundEmailQueueMessage,
): MailboxIngestResult {
	const winner = sql
		.exec<{
			message_local_id: string | null;
			raw_sha256: string;
		}>(
			"SELECT message_local_id, raw_sha256 FROM ingest_events WHERE idempotency_key = ?",
			message.idempotencyKey,
		)
		.toArray()[0];

	if (!winner) {
		// Constraint violation implies a concurrent writer holds this idempotency_key,
		// but we couldn't find its row (e.g. a messages.idempotency_key collision from
		// a different code path). Surface a conflict rather than silently swallowing it.
		return {
			status: "conflict",
			mailboxId: message.mailboxId,
			messageCount: messageCount(sql),
			idempotencyKey: message.idempotencyKey,
			messageLocalId: "",
			rawR2Key: message.rawR2Key,
			errorCode: "message_id_conflict",
		};
	}

	if (winner.raw_sha256 && winner.raw_sha256 !== message.rawSha256) {
		return {
			status: "conflict",
			mailboxId: message.mailboxId,
			messageCount: messageCount(sql),
			idempotencyKey: message.idempotencyKey,
			messageLocalId: "",
			rawR2Key: message.rawR2Key,
			errorCode: "message_id_conflict",
		};
	}

	return {
		status: "duplicate",
		mailboxId: message.mailboxId,
		messageCount: messageCount(sql),
		idempotencyKey: message.idempotencyKey,
		messageLocalId: winner.message_local_id ?? "",
		rawR2Key: message.rawR2Key,
	};
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
		}>(
			"SELECT message_local_id, raw_sha256, status FROM ingest_events WHERE idempotency_key = ?",
			message.idempotencyKey,
		)
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
	// Kept as arrays, not JSON: thread resolution needs the addresses themselves.
	let toAddresses: string[] = [message.recipient];
	let ccAddresses: string[] = [];
	let inReplyTo: string | null = message.headers.inReplyTo;
	let referencesJson = JSON.stringify(message.headers.references);
	const attachments: Array<{
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
		toAddresses = parsed.to.length ? parsed.to : [message.recipient];
		ccAddresses = parsed.cc;
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
		const toJson = JSON.stringify(toAddresses);
		const ccJson = JSON.stringify(ccAddresses);
		const subjectNorm = normalizeSubject(subject);
		const threadId = resolveThreadId(ctx.sql, {
			inReplyTo,
			references: JSON.parse(referencesJson) as string[],
			subjectNorm,
			fromAddr,
			recipients: [...toAddresses, ...ccAddresses],
			deliveredTo: message.recipient,
			receivedAt: message.receivedAt,
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
		if (isUniqueConstraintViolation(error)) {
			// A concurrent invocation (for the same idempotency_key) won the race and
			// committed first. Resolve to the same duplicate/conflict shape the upfront
			// pre-check would have returned instead of re-inserting or throwing.
			return resolveConcurrentIdempotencyConflict(ctx.sql, message);
		}

		parseStatus = "failed";
		const now = nowIso();
		const toJson = JSON.stringify(toAddresses);
		const messageLocalId = crypto.randomUUID();
		const threadId = crypto.randomUUID();
		const snippet = snippetFromText(null, null);

		try {
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
		} catch (insertError) {
			if (isUniqueConstraintViolation(insertError)) {
				// Same race, but discovered while persisting the parse-failure fallback
				// row: a concurrent invocation already committed under this idempotency_key.
				return resolveConcurrentIdempotencyConflict(ctx.sql, message);
			}
			throw insertError;
		}

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
	return (
		sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM messages").toArray()[0]?.count ?? 0
	);
}

export function searchMessages(
	sql: SqlStorage,
	query: string,
	limit: number,
): Array<{ message_id: string }> {
	const escaped = query.replace(/"/g, '""');
	return sql
		.exec<{ message_id: string }>(
			`SELECT message_id FROM message_fts WHERE message_fts MATCH ? ORDER BY rank LIMIT ?`,
			`"${escaped}"`,
			limit,
		)
		.toArray();
}
