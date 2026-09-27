import { insertOpsEvent } from "../db/d1";
import { normalizeEmailSendingEvent } from "./email-events";

/**
 * Terminal consumer shared by every dead-letter queue. It writes a tombstone to
 * `ops_events` and stops there.
 *
 * Never re-enqueues: a DLQ consumer that redelivers resurrects the exact loop
 * the DLQ exists to end. For inbound the raw MIME is still in R2, so nothing
 * irrecoverable is lost — the correct replay is a deliberate admin re-ingest,
 * a human decision, not an automatic one.
 *
 * The queues feeding this have no DLQ of their own, on purpose: a dead letter
 * from a dead-letter queue has nowhere left to go, and pretending otherwise
 * only moves the silence one hop further away.
 *
 * If the ack is lost after the insert lands, Cloudflare redelivers and the
 * tombstone is written twice. Duplicate `ops_events` rows are harmless and
 * deduplicating them would cost a read per dead message; the duplicates are
 * the cheaper outcome.
 */
export async function handleDeadLetterQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "dlq.dead_letter",
				severity: "error",
				subject: message.id,
				payload_json: JSON.stringify({
					queue: batch.queue,
					attempts: message.attempts,
					summary: summarizeDeadLetter(message.body),
				}),
			});
			message.ack();
		} catch (error) {
			console.error("dlq.tombstone_failed", {
				queue: batch.queue,
				messageId: message.id,
				attempts: message.attempts,
				error: error instanceof Error ? error.message : String(error),
			});
			// A death cannot be recorded in a ledger that is down. Retrying keeps the
			// message alive until D1 answers; once the retries are spent it is lost,
			// which is assumed and stated rather than hidden behind another DLQ.
			message.retry();
		}
	}
}

/**
 * What a tombstone may say about the message it records: identifiers and
 * metadata, never people or content.
 *
 * The bodies on these queues are full of both. An Email Sending lifecycle event
 * carries the recipient's address and the rendered subject (which for
 * transactional mail routinely *is* the secret: "Your code is 123456"); an
 * inbound envelope carries sender, recipient and subject; a notification carries
 * the sender, subject and a body snippet. `ops_events` is an operator log, and the
 * rule everywhere else that writes to it (see `recipientDomain` in
 * email-events-consumer.ts) is that ops events describe events, not recipients.
 * A dead-lettered message is no exception.
 *
 * So this is an allow-list per known shape, not a redaction of the body: a field
 * a producer grows tomorrow stays out of the log until someone decides it is
 * safe. What is kept is what an operator needs to find the rest: the provider
 * message id and event id to reconcile against the provider console, the R2 key
 * and hash to re-ingest raw mail, the mailbox/message/thread ids to find the
 * conversation. The data itself stays where it already lives.
 *
 * Never throws. A message reaches a DLQ precisely when its payload is strange
 * (cyclic, a raw value, something the producer never meant to send), and a
 * failure to summarize it must degrade the record, never suppress it.
 */
export function summarizeDeadLetter(body: unknown): Record<string, unknown> {
	try {
		return summarizeKnownShape(body);
	} catch {
		return { kind: "unrecognized", bodyType: describeType(body) };
	}
}

function summarizeKnownShape(body: unknown): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { kind: "unrecognized", bodyType: describeType(body) };
	}
	const record = body as Record<string, unknown>;

	if (record.eventType === "email.received.v1") {
		return {
			kind: "inbound",
			eventType: record.eventType,
			schemaVersion: safeScalar(record.schemaVersion),
			traceId: safeId(record.traceId),
			mailboxId: safeId(record.mailboxId),
			// The R2 key and hash are what a deliberate re-ingest needs. The key is
			// built from the mailbox id, a timestamp and the hash, never an address.
			rawR2Key: safeId(record.rawR2Key),
			rawSha256: safeId(record.rawSha256),
			rawSize: typeof record.rawSize === "number" ? record.rawSize : undefined,
			recipientDomain: safeDomain(record.domain) ?? domainOf(record.recipient),
		};
	}

	if (record.eventType === "mail.notify.v1" || record.eventType === "telegram.card_refresh.v1") {
		const inner = asRecord(
			record.eventType === "mail.notify.v1" ? record.notification : record.refresh,
		);
		return {
			kind: "notify",
			eventType: record.eventType,
			schemaVersion: safeScalar(record.schemaVersion),
			mailboxId: safeId(inner.mailboxId),
			messageLocalId: safeId(inner.messageLocalId),
			threadId: safeId(inner.threadId),
			status: record.eventType === "telegram.card_refresh.v1" ? safeId(inner.status) : undefined,
		};
	}

	const event = normalizeEmailSendingEvent(body);
	if (event) {
		return {
			kind: "email_event",
			event_type: event.event_type,
			event_id: event.event_id,
			provider_message_id: event.provider_message_id,
			to_domain: domainOf(event.to) ?? "unknown",
		};
	}
	if (typeof record.type === "string" && record.type.startsWith("cf.email.")) {
		// An Email Sending event that failed our schema, which may be why it died.
		// Pull the identifiers out by hand; the rest of it is exactly the content
		// this function exists to keep out.
		const payload = asRecord(record.payload);
		return {
			kind: "email_event",
			schema_valid: false,
			event_type: safeId(record.type),
			event_id: safeId(payload.eventId),
			provider_message_id: safeId(payload.messageId),
			to_domain: domainOf(payload.recipient) ?? "unknown",
		};
	}

	// Something no producer here sends. Its key names say what it was meant to be
	// without repeating what it contains.
	return {
		kind: "unrecognized",
		bodyType: "object",
		eventType: safeId(record.eventType) ?? safeId(record.type),
		keys: Object.keys(record)
			.slice(0, 20)
			.map((key) => key.slice(0, 64)),
	};
}

const MAX_ID_LENGTH = 200;

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * An identifier we or the provider minted. One containing `@` is, or embeds, an
 * address, and a tombstone is not where to find out whose.
 */
function safeId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_ID_LENGTH || trimmed.includes("@")) return undefined;
	return trimmed;
}

function safeScalar(value: unknown): number | string | undefined {
	return typeof value === "number" ? value : safeId(value);
}

function safeDomain(value: unknown): string | undefined {
	return safeId(value)?.toLowerCase();
}

/** The domain half of an address; the local part is the personal data. */
function domainOf(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const at = value.lastIndexOf("@");
	if (at === -1) return undefined;
	return safeDomain(value.slice(at + 1).replace(/>.*$/, ""));
}

function describeType(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}
