import { classifyEmailEvent, normalizeEmailSendingEvent, safeEventMetadata } from "./email-events";
import { insertOpsEvent, upsertSuppressionProjection } from "../db/d1";
import { mailboxStub } from "../lib/mailbox-stub";

type ResolvedEventTarget = {
	mailboxId: string;
	requestId: string | null;
	correlation: "provider_id" | "envelope";
};

/**
 * Resolves the mailbox DO for a delivery event by looking up the transactional
 * request via D1 using provider_message_id. If the D1 projection is absent,
 * we retry — the event may have raced the projection write.
 *
 * A provider id we have never seen is not necessarily a stranger: an ambiguous
 * send never learns the id of a message that may well have gone out, so its
 * events arrive unattributable by design. Cloudflare mints the id itself and
 * refuses a sender-chosen `Message-ID`, so there is nothing we could have
 * stamped on the message to recognise it by. The envelope fallback narrows to
 * the requests whose outcome we admit we do not know, and only to route: the DO
 * repeats the narrowing against its own rows and has the final say.
 */
async function resolveMailboxIdFromEvent(
	env: Env,
	event: { provider_message_id: string; to: string; from: string; timestamp: string },
): Promise<ResolvedEventTarget | { ambiguous: true } | null> {
	try {
		const {
			lookupTransactionalRequestByProviderMessageId,
			lookupUnresolvedTransactionalRequestsByEnvelope,
		} = await import("../db/d1");
		const row = await lookupTransactionalRequestByProviderMessageId(
			env.INDEX_DB,
			event.provider_message_id,
		);
		if (row) {
			// Validate sender and recipient match the event
			if (row.sender.toLowerCase() !== event.from.toLowerCase()) {
				return null;
			}
			if (row.to_addr.toLowerCase() !== event.to.toLowerCase()) {
				return null;
			}
			return {
				mailboxId: row.mailbox_id,
				requestId: row.request_id,
				correlation: "provider_id",
			};
		}

		const { envelopeCorrelationWindow } = await import("../do/mailbox-suppressions");
		const window = envelopeCorrelationWindow(event.timestamp);
		if (!window) return null;
		const candidates = await lookupUnresolvedTransactionalRequestsByEnvelope(env.INDEX_DB, {
			sender: event.from.trim().toLowerCase(),
			to: event.to.trim().toLowerCase(),
			notBefore: window.notBefore,
			notAfter: window.notAfter,
		});
		if (candidates.length === 0) return null;
		// Two ambiguous sends to the same recipient in the same window: nothing
		// distinguishes them, and retrying will not change that. Say so rather than
		// attributing the event to a coin flip.
		if (candidates.length > 1) return { ambiguous: true };
		return {
			mailboxId: candidates[0]!.mailbox_id,
			requestId: candidates[0]!.request_id,
			correlation: "envelope",
		};
	} catch {
		return null;
	}
}

/**
 * Ops events describe events, not recipients. The domain is what an operator
 * needs to see a pattern ("everything to this provider is bouncing"); the local
 * part is the personal data and never belongs in a log row.
 */
function recipientDomain(address: string): string {
	const at = address.lastIndexOf("@");
	return at === -1 ? "unknown" : address.slice(at + 1).toLowerCase();
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
			const target = await resolveMailboxIdFromEvent(env, event);
			if (target && "ambiguous" in target) {
				// Unresolvable rather than not-yet-resolvable: retrying cannot break the
				// tie, so this rides its retries out to the DLQ, where an operator can
				// see it. Guessing which ambiguous send it belongs to would be worse
				// than leaving both unresolved.
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "email_events.correlation_ambiguous",
					severity: "warning",
					subject: event.provider_message_id,
					payload_json: JSON.stringify({
						event_id: event.event_id,
						event_type: event.event_type,
						to_domain: recipientDomain(event.to),
						attempts: message.attempts,
					}),
				});
				message.retry({ delaySeconds: 30 });
				continue;
			}
			const resolved = target;
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
						to_domain: recipientDomain(event.to),
						attempts: message.attempts,
					}),
				});
				message.retry({ delaySeconds: 30 });
				continue;
			}

			// Forward to the mailbox DO for processing
			const stub = mailboxStub(env, resolved.mailboxId);
			const response = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					event: safeEventMetadata(event),
					eventType: event.event_type,
					// A routing hint only — the DO re-derives the attribution itself and
					// refuses this id if its own storage names a different request.
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
							to_domain: recipientDomain(event.to),
							attempts: message.attempts,
						}),
					});
					message.retry({ delaySeconds: 30 });
					continue;
				}
				// 409 is the DO rejecting the correlation the projection proposed —
				// either the tie it sees is ambiguous or D1 named a different request.
				// The DO is authoritative; do not argue with it.
				if (response.status === 409) {
					await insertOpsEvent(env.INDEX_DB, {
						id: crypto.randomUUID(),
						event_type: "email_events.correlation_rejected",
						severity: "warning",
						subject: event.provider_message_id,
						payload_json: JSON.stringify({
							event_id: event.event_id,
							event_type: event.event_type,
							to_domain: recipientDomain(event.to),
							attempts: message.attempts,
						}),
					});
					message.retry({ delaySeconds: 30 });
					continue;
				}
				throw new Error(`DO delivery-event failed: ${response.status} ${body}`);
			}
			const doResult = (await response.json()) as {
				requestId?: string;
				resolvedStatus?: "sent" | "failed";
			};
			// The DO chose the request; trust its answer over the routing hint.
			const settledRequestId = doResult.requestId ?? resolved.requestId;
			if (settledRequestId) {
				const {
					updateTransactionalRequestDeliveryProjection,
					updateTransactionalRequestResolutionProjection,
				} = await import("../db/d1");
				if (doResult.resolvedStatus) {
					// An ambiguous send just became answerable. Project the settled status
					// before the delivery status so the row is never briefly self-contradictory.
					await updateTransactionalRequestResolutionProjection(
						env.INDEX_DB,
						settledRequestId,
						doResult.resolvedStatus,
						event.provider_message_id,
					);
					// Worth an ops event on its own: a request the API previously had to
					// answer "unknown" for now has an answer, and an operator watching a
					// backlog of ambiguous sends wants to see it drain.
					await insertOpsEvent(env.INDEX_DB, {
						id: crypto.randomUUID(),
						event_type: "transactional.unknown_resolved",
						severity: "info",
						subject: resolved.mailboxId,
						payload_json: JSON.stringify({
							requestId: settledRequestId,
							resolvedStatus: doResult.resolvedStatus,
							deliveryStatus: classification.deliveryStatus,
							correlation: resolved.correlation,
							to_domain: recipientDomain(event.to),
						}),
					}).catch(() => {});
				}
				await updateTransactionalRequestDeliveryProjection(
					env.INDEX_DB,
					settledRequestId,
					classification.deliveryStatus,
					event.timestamp,
				);
			}
			if (settledRequestId && classification.suppress) {
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
