/**
 * Pure core of `pnpm replay:dlq` (scripts/replay-dlq.ts): everything that decides
 * what to push, with no wrangler, D1, R2 or queue access, so it can be unit-tested.
 *
 * The DLQ tombstone (`ops_events.event_type = 'dlq.dead_letter'`) keeps only an
 * allow-listed summary of the dead inbound message (see summarizeDeadLetter in
 * src/cloudflare/dlq-consumer.ts): mailbox id, R2 key, sha256, size, recipient
 * *domain*. The recipient, sender and headers were deliberately not kept, so they
 * are rebuilt here from the raw MIME that is still in R2.
 */
import PostalMime from "postal-mime";
import type { InboundEmailQueueMessage } from "../../src/cloudflare/types";
import { inboundEmailQueueMessageSchema } from "../../src/cloudflare/types";
import { randomTraceId } from "../../src/lib/crypto";
import { normalizeMessageId, readHeader, readReferences } from "../../src/lib/email-metadata";
import { inboundIdempotencyKey } from "../../src/lib/idempotency";

/** Mirrors MAX_QUEUE_BYTES in src/cloudflare/email-handler.ts (not exported). */
export const MAX_QUEUE_BYTES = 128 * 1024;

export type InboundDlqSummary = {
	kind: "inbound";
	eventType: string;
	schemaVersion?: number | string;
	traceId?: string;
	mailboxId: string;
	rawR2Key: string;
	rawSha256: string;
	rawSize?: number;
	recipientDomain?: string;
};

export type MailboxAddresses = {
	mailboxId: string;
	primaryAddress: string;
	/** Active alias addresses pointing at the mailbox. */
	aliases: string[];
};

export type RawObjectMetadata = {
	mailboxId?: string;
	messageId?: string;
	rawSha256?: string;
	receivedAt?: string;
};

/** Parses a tombstone's payload_json; null unless it is an inbound summary with what a replay needs. */
export function parseInboundDlqSummary(payloadJson: string): InboundDlqSummary | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payloadJson);
	} catch {
		return null;
	}
	const summary = (parsed as { summary?: Record<string, unknown> } | null)?.summary;
	if (summary?.kind !== "inbound") return null;
	const { mailboxId, rawR2Key, rawSha256 } = summary;
	if (
		typeof mailboxId !== "string" ||
		typeof rawR2Key !== "string" ||
		typeof rawSha256 !== "string" ||
		!mailboxId ||
		!rawR2Key ||
		!rawSha256
	) {
		return null;
	}
	return {
		kind: "inbound",
		eventType: String(summary.eventType ?? "email.received.v1"),
		schemaVersion:
			typeof summary.schemaVersion === "number" || typeof summary.schemaVersion === "string"
				? summary.schemaVersion
				: undefined,
		traceId: typeof summary.traceId === "string" ? summary.traceId : undefined,
		mailboxId,
		rawR2Key,
		rawSha256,
		rawSize: typeof summary.rawSize === "number" ? summary.rawSize : undefined,
		recipientDomain:
			typeof summary.recipientDomain === "string"
				? summary.recipientDomain.toLowerCase()
				: undefined,
	};
}

/** The raw header block as a `Headers`, so the email handler's own readers apply unchanged. */
export async function mimeHeaders(rawBytes: Uint8Array): Promise<Headers> {
	const email = await new PostalMime().parse(rawBytes);
	const headers = new Headers();
	for (const { key, value } of email.headers) {
		try {
			headers.append(key, value);
		} catch {
			// A header name/value Headers rejects cannot have been read by the handler either.
		}
	}
	return headers;
}

/** Bare, lowercased addresses in a header value (`"A" <a@x>, b@y` → [a@x, b@y]). */
export function addressesIn(value: string | null): string[] {
	if (!value) return [];
	const found = value.match(/[^\s<>",;()]+@[^\s<>",;()]+/g) ?? [];
	return found.map((address) => address.toLowerCase());
}

/**
 * Where the mail was delivered to. Envelope-like headers come first (Delivered-To,
 * X-Original-To, Envelope-To), then To/Cc as a last resort. The first candidate that
 * is the mailbox's primary address or one of its aliases wins; when it has to fall
 * back to the primary address it says so.
 */
export function resolveRecipient(
	headers: Headers,
	mailbox: MailboxAddresses,
	recipientDomain: string | undefined,
): { recipient: string; note: string | null } {
	const own = new Set([mailbox.primaryAddress.toLowerCase(), ...mailbox.aliases.map(lowerCase)]);
	const candidates = ["delivered-to", "x-original-to", "envelope-to", "to", "cc"].flatMap((name) =>
		addressesIn(readHeader(headers, name)),
	);
	const domainOk = (address: string) =>
		!recipientDomain || address.split("@")[1] === recipientDomain.toLowerCase();
	const match = candidates.find((address) => own.has(address) && domainOk(address));
	if (match) return { recipient: match, note: null };
	return {
		recipient: mailbox.primaryAddress.toLowerCase(),
		note: "recipient not found in Delivered-To/X-Original-To/To; used the mailbox primary address",
	};
}

function lowerCase(value: string): string {
	return value.toLowerCase();
}

/** Return-Path (the envelope sender, what handleEmail uses as `message.from`) else From. */
export function resolveSender(headers: Headers): string | null {
	const returnPath = addressesIn(readHeader(headers, "return-path"))[0];
	if (returnPath) return returnPath;
	return addressesIn(readHeader(headers, "from"))[0] ?? null;
}

export type RebuildInput = {
	summary: InboundDlqSummary;
	metadata: RawObjectMetadata;
	rawBytes: Uint8Array;
	mailbox: MailboxAddresses;
	now?: Date;
};

export type RebuildResult = {
	payload: InboundEmailQueueMessage;
	notes: string[];
};

/**
 * Rebuilds the InboundEmailQueueMessage handleEmail would have produced, validated
 * against the production schema. Throws if the result is not a payload the
 * consumer would accept, or exceeds the queue size limit.
 */
export async function rebuildInboundPayload(input: RebuildInput): Promise<RebuildResult> {
	const { summary, metadata, rawBytes, mailbox } = input;
	const now = input.now ?? new Date();
	const notes: string[] = [];
	const headers = await mimeHeaders(rawBytes);

	const receivedAt = metadata.receivedAt?.trim() || receivedAtFromKey(summary.rawR2Key);
	if (!receivedAt) {
		throw new Error("no receivedAt in R2 customMetadata or in the raw key");
	}

	// customMetadata.messageId is what the original idempotency key was computed from;
	// the MIME header is the fallback (the handler wrote one from the other).
	const metaMessageId = normalizeMessageId(metadata.messageId ?? null);
	const headerMessageId = normalizeMessageId(readHeader(headers, "message-id"));
	if (metaMessageId && headerMessageId && metaMessageId !== headerMessageId) {
		notes.push(`Message-ID differs (metadata ${metaMessageId}, MIME ${headerMessageId})`);
	}
	const messageId = metaMessageId ?? headerMessageId;

	const { recipient, note } = resolveRecipient(headers, mailbox, summary.recipientDomain);
	if (note) notes.push(note);
	const domain = summary.recipientDomain ?? recipient.split("@")[1] ?? "";

	const sender = resolveSender(headers);
	if (!sender) notes.push("no Return-Path or From address; sender set to unknown@invalid");

	const payload = inboundEmailQueueMessageSchema.parse({
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: randomTraceId(),
		enqueuedAt: now.toISOString(),
		receivedAt,
		mailboxId: summary.mailboxId,
		domain,
		recipient,
		sender: sender ?? "unknown@invalid",
		rawR2Key: summary.rawR2Key,
		rawSha256: summary.rawSha256,
		rawSize: rawBytes.byteLength,
		messageId,
		headers: {
			subject: readHeader(headers, "subject"),
			date: readHeader(headers, "date"),
			inReplyTo: normalizeMessageId(readHeader(headers, "in-reply-to")),
			references: readReferences(headers),
		},
		routing: { ruleId: null, action: "store", matchedAlias: recipient },
		idempotencyKey: inboundIdempotencyKey({
			mailboxId: summary.mailboxId,
			messageId,
			rawSha256: summary.rawSha256,
		}),
	}) satisfies InboundEmailQueueMessage;

	const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
	if (bytes > MAX_QUEUE_BYTES) {
		throw new Error(`queue payload would be ${bytes} bytes, over the ${MAX_QUEUE_BYTES} limit`);
	}
	return { payload, notes };
}

/** raw keys embed the receivedAt epoch ms as `<prefix>/<epoch>-<sha>`; see rawEmailR2Key. */
export function receivedAtFromKey(rawR2Key: string): string | null {
	const epoch = Number(rawR2Key.split("/").pop()?.split("-")[0]);
	return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
}

export type SkipFacts = {
	/** R2 head/get found the object. */
	objectFound: boolean;
	/** sha256 of the downloaded bytes, when found. */
	actualSha256?: string;
	/** ingest_events.status for the rebuilt idempotency key, if a row exists. */
	ingestStatus?: string | null;
	/** message_index already holds this raw_sha256 for the mailbox. */
	indexedBySha: boolean;
};

/** The reason a replay must not be pushed, or null when it should be. Order = most fundamental first. */
export function skipReason(summary: InboundDlqSummary, facts: SkipFacts): string | null {
	if (!facts.objectFound) return `R2 object missing (${summary.rawR2Key})`;
	if (facts.actualSha256 !== undefined && facts.actualSha256 !== summary.rawSha256) {
		return `sha256 mismatch: tombstone ${summary.rawSha256}, R2 object ${facts.actualSha256}`;
	}
	if (facts.ingestStatus === "processed") return "already processed (ingest_events)";
	if (facts.indexedBySha) return "already in message_index (same raw_sha256)";
	return null;
}
