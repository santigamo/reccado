import { classifyEmailEvent, normalizeEmailSendingEvent, safeEventMetadata } from "./email-events";
import { insertOpsEvent, upsertSuppressionProjection } from "../db/d1";

/**
 * Resolves the mailbox DO for a delivery event by looking up the transactional
 * request via D1 using provider_message_id. If the D1 projection is absent,
 * we retry — the event may have raced the projection write.
 */
async function resolveMailboxIdFromEvent(
	env: Env,
	event: { provider_message_id: string; to: string; from: string },
): Promise<{ mailboxId: string; requestId: string | null } | null> {
	try {
		const { lookupTransactionalRequestByProviderMessageId } = await import("../db/d1");
		const row = await lookupTransactionalRequestByProviderMessageId(
			env.INDEX_DB,
			event.provider_message_id,
		);
		if (!row) {
			return null;
		}
		// Validate sender and recipient match the event
		if (row.sender.toLowerCase() !== event.from.toLowerCase()) {
			return null;
		}
		if (row.to_addr.toLowerCase() !== event.to.toLowerCase()) {
			return null;
		}
		return { mailboxId: row.mailbox_id, requestId: row.request_id };
	} catch {
		return null;
	}
}

export async function handleEmailEventsQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		try {
			const normalized = normalizeEmailSendingEvent(message.body);
			if (!normalized) {
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "email_events.poison_schema",
					severity: "error",
					subject: message.id,
					payload_json: JSON.stringify({
						attempts: message.attempts,
						body: safeForLog(message.body),
					}),
				});
				// The queue's configured max_retries controls DLQ placement.
				message.retry({ delaySeconds: 30 });
				continue;
			}
			const event = normalized;
			const classification = classifyEmailEvent(event);

			// Resolve mailbox via D1 projection
			const resolved = await resolveMailboxIdFromEvent(env, event);
			if (!resolved) {
				// D1 projection absent — event may have raced the write. Retry.
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "email_events.unresolved",
					severity: "warning",
					subject: event.provider_message_id,
					payload_json: JSON.stringify({
						event_id: event.event_id,
						event_type: event.event_type,
						to: event.to,
						attempts: message.attempts,
					}),
				});
				message.retry({ delaySeconds: 30 });
				continue;
			}

			// Forward to the mailbox DO for processing
			const stub = env.MAILBOX_DO.getByName(resolved.mailboxId);
			const response = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					event: safeEventMetadata(event),
					eventType: event.event_type,
					requestId: resolved.requestId,
				}),
			});

			if (!response.ok) {
				const body = await response.text();
				// 404/not_found means the DO couldn't validate the event — retry.
				if (response.status === 404) {
					await insertOpsEvent(env.INDEX_DB, {
						id: crypto.randomUUID(),
						event_type: "email_events.not_found",
						severity: "warning",
						subject: event.provider_message_id,
						payload_json: JSON.stringify({
							event_id: event.event_id,
							event_type: event.event_type,
							to: event.to,
							attempts: message.attempts,
						}),
					});
					message.retry({ delaySeconds: 30 });
					continue;
				}
				throw new Error(`DO delivery-event failed: ${response.status} ${body}`);
			}
			await response.arrayBuffer();
			if (resolved.requestId) {
				const { updateTransactionalRequestDeliveryProjection } = await import("../db/d1");
				await updateTransactionalRequestDeliveryProjection(
					env.INDEX_DB,
					resolved.requestId,
					classification.deliveryStatus,
					event.timestamp,
				);
			}
			if (resolved.requestId && classification.suppress) {
				const reason =
					event.event_type === "cf.email.sending.message.complained" ? "complaint" : "hard_bounce";
				const now = new Date().toISOString();
				// Mirrors the DO's own policy so the projection does not read as permanent
				// while the authoritative list expires it.
				const { suppressionExpiryFor } = await import("../do/mailbox-suppressions");
				await upsertSuppressionProjection(env.INDEX_DB, {
					email: event.to,
					mailbox_id: resolved.mailboxId,
					reason,
					source_event_id: event.event_id,
					created_at: now,
					updated_at: now,
					expires_at: suppressionExpiryFor(reason),
				});
			}

			message.ack();
		} catch (error) {
			console.error("email_events.failed", {
				messageId: message.id,
				attempts: message.attempts,
				error: error instanceof Error ? error.message : String(error),
			});
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "email_events.failed",
				severity: "error",
				subject: message.id,
				payload_json: JSON.stringify({ attempts: message.attempts }),
			});
			message.retry({ delaySeconds: 2 });
		}
	}
}

/**
 * Sanitizes an unknown value for logging — never logs subject, reason, smtp_response, body.
 */
function safeForLog(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		return { raw: String(value).slice(0, 200) };
	}
	const obj = value as Record<string, unknown>;
	return {
		type: typeof obj.type === "string" ? obj.type : undefined,
		...(obj.payload && typeof obj.payload === "object"
			? { eventId: (obj.payload as Record<string, unknown>).eventId }
			: {}),
	};
}
