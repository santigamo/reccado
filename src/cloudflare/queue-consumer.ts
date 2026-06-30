import { insertOpsEvent, upsertIngestEvent, upsertMessageIndex } from "../db/d1";
import type { InboundEmailQueueMessage, MailboxIngestResult } from "./types";
import { inboundEmailQueueMessageSchema } from "./types";

const MAX_RETRIES = 3;

export async function handleInboundQueue(
	batch: MessageBatch<InboundEmailQueueMessage>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			const parseResult = inboundEmailQueueMessageSchema.safeParse(message.body);
			if (!parseResult.success) {
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "queue.poison_schema",
					severity: "error",
					subject: message.id,
					payload_json: JSON.stringify({
						body: message.body,
						attempts: message.attempts,
						issues: parseResult.error.flatten(),
					}),
				});
				message.retry({ delaySeconds: 2 });
				continue;
			}
			const body = parseResult.data;

			const rawObject = await env.MAIL_OBJECTS.head(body.rawR2Key);
			if (!rawObject) {
				throw new Error(`raw MIME object missing: ${body.rawR2Key}`);
			}

			const stub = env.MAILBOX_DO.getByName(body.mailboxId);
			const response = await stub.fetch("https://mailbox-do/ingest", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});

			if (!response.ok) {
				throw new Error(`DO ingest failed: ${response.status} ${await response.text()}`);
			}

			const result = (await response.json()) as MailboxIngestResult;

			if (result.status === "conflict") {
				await upsertIngestEvent(env.INDEX_DB, {
					idempotency_key: body.idempotencyKey,
					mailbox_id: body.mailboxId,
					message_local_id: null,
					raw_r2_key: body.rawR2Key,
					status: "failed",
					error_code: result.errorCode ?? "message_id_conflict",
				});
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "ingest.conflict",
					severity: "warning",
					subject: body.idempotencyKey,
					payload_json: JSON.stringify({ mailboxId: body.mailboxId, rawSha256: body.rawSha256 }),
				});
				message.ack();
				continue;
			}

			if (result.status === "inserted" && result.messageLocalId) {
				await upsertMessageIndex(env.INDEX_DB, {
					mailbox_id: body.mailboxId,
					message_local_id: result.messageLocalId,
					thread_id: result.threadId ?? result.messageLocalId,
					rfc_message_id: result.rfcMessageId ?? body.messageId,
					subject: result.subject ?? body.headers.subject,
					from_addr: result.fromAddr ?? body.sender,
					to_json: result.toJson ?? JSON.stringify([body.recipient]),
					snippet: result.snippet ?? null,
					received_at: result.receivedAt ?? body.receivedAt,
					has_attachments: result.hasAttachments ? 1 : 0,
					labels_json: "[]",
					state: "inbox",
					raw_r2_key: body.rawR2Key,
					raw_sha256: body.rawSha256,
					updated_at: new Date().toISOString(),
				});
				await upsertIngestEvent(env.INDEX_DB, {
					idempotency_key: body.idempotencyKey,
					mailbox_id: body.mailboxId,
					message_local_id: result.messageLocalId,
					raw_r2_key: body.rawR2Key,
					status: "processed",
				});
			} else if (result.status === "duplicate") {
				await upsertIngestEvent(env.INDEX_DB, {
					idempotency_key: body.idempotencyKey,
					mailbox_id: body.mailboxId,
					message_local_id: result.messageLocalId ?? null,
					raw_r2_key: body.rawR2Key,
					status: "processed",
				});
			}

			console.log("email.ingested", {
				messageId: message.id,
				attempts: message.attempts,
				result,
			});
			message.ack();
		} catch (error) {
			console.error("email.ingest_failed", {
				messageId: message.id,
				attempts: message.attempts,
				error: error instanceof Error ? error.message : String(error),
			});
			if (message.attempts >= MAX_RETRIES) {
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "ingest.terminal_failure",
					severity: "error",
					subject: message.id,
					payload_json: JSON.stringify({
						error: error instanceof Error ? error.message : String(error),
						attempts: message.attempts,
					}),
				});
			}
			message.retry({ delaySeconds: 2 });
		}
	}
}
