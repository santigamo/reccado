import { insertOpsEvent } from "../db/d1";

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
					body: serializeBody(message.body),
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
 * Pre-serialized as a string so the enclosing `JSON.stringify` cannot throw on
 * the body. A message reaches a DLQ precisely when its payload is strange —
 * cyclic, a raw value, something the producer never meant to send — and this
 * tombstone is the last copy of that evidence, so a serialization failure must
 * degrade the record, never suppress it.
 */
function serializeBody(body: unknown): string {
	try {
		return JSON.stringify(body) ?? String(body);
	} catch {
		return String(body);
	}
}
