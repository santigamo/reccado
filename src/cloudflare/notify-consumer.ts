import { insertOpsEvent } from "../db/d1";
import { TelegramApiError } from "../telegram/api";
import { refreshTelegramCard } from "../telegram/cards";
import { deliverInboundNotification } from "../telegram/notify";
import { type NotifyQueueMessage, notifyQueueMessageSchema } from "./types";

/**
 * Telegram accepts roughly one message per second per chat and answers 429 the
 * moment that is exceeded, so a redelivery two seconds later — the ingest
 * queue's flat delay — mostly earns another 429. Doubling per attempt rides out
 * both a rate-limit burst and a short outage; the cap keeps the last attempts
 * inside the queue's retention window instead of pushing them past it.
 */
const BASE_RETRY_SECONDS = 5;
const MAX_RETRY_SECONDS = 300;

function retryDelaySeconds(attempts: number): number {
	return Math.min(BASE_RETRY_SECONDS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_SECONDS);
}

/**
 * A 4xx from the Bot API describes the request, not the moment: a bot the
 * operator blocked, a chat that no longer exists or a card Telegram considers
 * malformed answer identically on every redelivery, and retrying them only
 * fills the DLQ slower. 429 is the exception — it literally means "later" —
 * and anything that is not a Bot API error (fetch timeout, D1, the runtime)
 * gets the benefit of the doubt, because those are transient by nature.
 */
function isTransientFailure(error: unknown): boolean {
	if (error instanceof TelegramApiError) {
		return error.statusCode === 429 || error.statusCode >= 500;
	}
	return true;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** What the ops trail calls this payload when it fails. */
function subjectOf(body: NotifyQueueMessage): string {
	return body.eventType === "mail.notify.v1"
		? body.notification.messageLocalId
		: (body.refresh.messageLocalId ?? body.refresh.threadId ?? body.refresh.mailboxId);
}

function mailboxOf(body: NotifyQueueMessage): string {
	return body.eventType === "mail.notify.v1" ? body.notification.mailboxId : body.refresh.mailboxId;
}

/**
 * Two shapes, one queue: a card to post, and a card to correct.
 *
 * They share a consumer because they share the constraint — the same chat, the
 * same ~1 message per second, the same 429 backoff. Editing a card from the API
 * request that archived the mail would have spent that budget without any of the
 * pacing, and a queue of its own would just be a second unmetered claim on it.
 */
async function deliver(env: Env, body: NotifyQueueMessage): Promise<string | null> {
	if (body.eventType === "mail.notify.v1") {
		const outcome = await deliverInboundNotification(env, body.notification);
		return outcome.status === "skipped" ? outcome.reason : null;
	}
	const outcome = await refreshTelegramCard(env, body.refresh);
	return outcome.status === "skipped" ? outcome.reason : null;
}

export async function handleNotifyQueue(
	batch: MessageBatch<unknown>,
	env: Env,
	_ctx: ExecutionContext,
): Promise<void> {
	for (const message of batch.messages) {
		const parseResult = notifyQueueMessageSchema.safeParse(message.body);
		if (!parseResult.success) {
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "notify.poison_schema",
				severity: "error",
				subject: message.id,
				payload_json: JSON.stringify({
					attempts: message.attempts,
					issues: parseResult.error.flatten(),
				}),
			});
			// Retried rather than dropped so the DLQ ends up holding the payload:
			// an unreadable notification is a producer bug, and the only copy of
			// the evidence is the message itself.
			message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
			continue;
		}
		const body = parseResult.data;

		try {
			// A skip is a decision about this deployment, identical on every
			// redelivery: no bot token, no adopted chat, or -- for an edit -- a card
			// that no longer exists, or never did. Retrying any of them would burn the
			// queue's budget re-deciding the same thing.
			const skipped = await deliver(env, body);
			if (skipped) {
				console.log("telegram.notify_skipped", {
					messageId: message.id,
					eventType: body.eventType,
					mailboxId: mailboxOf(body),
					reason: skipped,
				});
			}
			message.ack();
		} catch (error) {
			const transient = isTransientFailure(error);
			console.error("telegram.notify_failed", {
				messageId: message.id,
				attempts: message.attempts,
				eventType: body.eventType,
				mailboxId: mailboxOf(body),
				transient,
				error: errorMessage(error),
			});
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: transient ? "telegram.notify_retry" : "telegram.notify_dropped",
				severity: transient ? "warning" : "error",
				subject: subjectOf(body),
				payload_json: JSON.stringify({
					eventType: body.eventType,
					mailboxId: mailboxOf(body),
					attempts: message.attempts,
					error: errorMessage(error),
				}),
			}).catch(() => undefined);
			if (!transient) {
				message.ack();
				continue;
			}
			message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
		}
	}
}
