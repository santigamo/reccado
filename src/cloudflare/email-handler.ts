import type { InboundEmailQueueMessage } from "./types";
import { sha256Hex, randomTraceId } from "../lib/crypto";
import { readHeader, readReferences, normalizeMessageId } from "../lib/email-metadata";
import { inboundIdempotencyKey } from "../lib/idempotency";
import { rawEmailR2Key } from "../lib/r2-keys";
import { resolveRoutingForRecipient, insertOpsEvent } from "../db/d1";
import { seedDevData } from "../db/seed-dev";

const MAX_QUEUE_BYTES = 128 * 1024;

export async function handleEmail(
	message: ForwardableEmailMessage,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	await seedDevData(env.INDEX_DB);

	const rawBytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
	const rawSha256 = await sha256Hex(rawBytes);
	const receivedAt = new Date();
	const recipient = message.to.trim().toLowerCase();
	const sender = message.from.trim().toLowerCase();
	const domain = recipient.split("@")[1] ?? "";

	const routing = await resolveRoutingForRecipient(env.INDEX_DB, recipient);
	if (routing.action === "reject") {
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "inbound.rejected",
			severity: "info",
			subject: recipient,
			payload_json: JSON.stringify({ reason: routing.reason, recipient }),
		});
		message.setReject(routing.reason);
		console.log("email.rejected", { recipient, reason: routing.reason });
		return;
	}

	if (routing.action === "forward") {
		for (const target of routing.forwardTo) {
			await message.forward(target);
		}
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "inbound.forwarded",
			severity: "info",
			subject: recipient,
			payload_json: JSON.stringify({ recipient, forwardTo: routing.forwardTo, ruleId: routing.ruleId }),
		});
		console.log("email.forwarded", { recipient, forwardTo: routing.forwardTo });
		return;
	}

	const mailboxId = routing.mailboxId;
	const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt, rawSha256 });
	const normalizedMessageId = normalizeMessageId(readHeader(message.headers, "message-id"));
	const idempotencyKey = inboundIdempotencyKey({ mailboxId, messageId: normalizedMessageId, rawSha256 });

	await env.MAIL_OBJECTS.put(rawR2Key, rawBytes, {
		customMetadata: {
			mailboxId,
			messageId: normalizedMessageId ?? "",
			rawSha256,
			receivedAt: receivedAt.toISOString(),
			schemaVersion: "1",
		},
		httpMetadata: {
			contentType: "message/rfc822",
		},
	});

	const queueMessage: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: randomTraceId(),
		enqueuedAt: new Date().toISOString(),
		receivedAt: receivedAt.toISOString(),
		mailboxId,
		domain,
		recipient,
		sender,
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId: normalizedMessageId,
		headers: {
			subject: readHeader(message.headers, "subject"),
			date: readHeader(message.headers, "date"),
			inReplyTo: normalizeMessageId(readHeader(message.headers, "in-reply-to")),
			references: readReferences(message.headers),
		},
		routing: {
			ruleId: routing.ruleId,
			action: "store",
			matchedAlias: routing.matchedAlias,
		},
		idempotencyKey,
	};

	const payloadSize = new TextEncoder().encode(JSON.stringify(queueMessage)).byteLength;
	if (payloadSize > MAX_QUEUE_BYTES) {
		throw new Error(`Queue payload too large: ${payloadSize} bytes`);
	}

	console.log("email.received", {
		mailboxId,
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		queuePayloadBytes: payloadSize,
	});

	await env.INBOUND_EMAIL_QUEUE.send(queueMessage, { contentType: "json" });
}
