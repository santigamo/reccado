import { runInDurableObject } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleDeadLetterQueue } from "#/cloudflare/dlq-consumer";
import { handleEmailEventsQueue } from "#/cloudflare/email-events-consumer";
import { confirmSendDraft } from "#/do/mailbox-do";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * Email Sending lifecycle events for mail a person confirmed from a mailbox
 * (request-send -> confirm-send). Those sends live in D1 `outbound_sends`, not in
 * the transactional request log, and until the consumer looked there every one
 * of their events was logged as unresolved four times and dead-lettered.
 */

const env = testEnv as unknown as Env;

// The consumer resolves stubs through mailboxStub, which refuses an undeclared
// jurisdiction; workerd has none, so the test declares "none" explicitly.
const consumerEnv = {
	INDEX_DB: env.INDEX_DB,
	MAILBOX_DO: env.MAILBOX_DO,
	MAILBOX_JURISDICTION: "none",
} as unknown as Env;

const MAILBOX_ADDRESS = "hello@reccado.example";
const RECIPIENT = "cliente@customer.example";

async function applyD1Migrations(db: D1Database): Promise<void> {
	const files = [
		await import("../../migrations/d1/0001_initial.sql?raw"),
		await import("../../migrations/d1/0002_message_index.sql?raw"),
		await import("../../migrations/d1/0003_mailbox_owner.sql?raw"),
		await import("../../migrations/d1/0005_outbound_status_approval.sql?raw"),
		await import("../../migrations/d1/0006_transactional_api_keys.sql?raw"),
		await import("../../migrations/d1/0007_transactional_requests.sql?raw"),
		await import("../../migrations/d1/0008_email_events_suppressions.sql?raw"),
		await import("../../migrations/d1/0015_transactional_resolved_via.sql?raw"),
	];
	for (const file of files) {
		for (const statement of splitSqlStatements(file.default as string)) {
			await db.prepare(statement).run();
		}
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.INDEX_DB);
});

/**
 * Sends a real draft through the DO's confirm-send path with a fake provider,
 * then writes the D1 `outbound_sends` row the way outbound-send.ts does: the
 * provider id verbatim, angle brackets and all.
 */
async function sendFromMailbox(mailboxId: string, providerMessageId: string): Promise<void> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const draftId = crypto.randomUUID();
	const outcome = await runInDurableObject(stub, async (_instance, state) => {
		const now = new Date().toISOString();
		state.storage.sql.exec(
			`INSERT INTO outbound_drafts
       (id, thread_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
       VALUES (?, NULL, ?, '[]', '[]', 'Factura de junio', 'Te la mando.', NULL, 'pending_confirmation', 'owner', ?, ?)`,
			draftId,
			JSON.stringify([RECIPIENT]),
			now,
			now,
		);
		return confirmSendDraft(
			{
				sql: state.storage.sql,
				transactionSync: (fn) => state.storage.transactionSync(fn),
				email: {
					send: async () => ({ messageId: providerMessageId }),
				} as unknown as Env["EMAIL"],
				fromAddress: MAILBOX_ADDRESS,
				replyToAddress: null,
			},
			draftId,
			`attempt-${draftId}`,
		);
	});
	expect(outcome.sent).toBe(true);

	const now = new Date().toISOString();
	await env.INDEX_DB.prepare(
		`INSERT INTO outbound_sends
     (id, mailbox_id, draft_id, idempotency_key, status, provider_message_id, error_code, approval_mode, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'sent', ?, NULL, 'human_confirmed', ?, ?)`,
	)
		.bind(
			crypto.randomUUID(),
			mailboxId,
			draftId,
			`send:v1:${draftId}:attempt-${draftId}`,
			providerMessageId,
			now,
			now,
		)
		.run();
}

/** The official nested format, as the event subscription delivers it. */
function nestedEvent(input: {
	eventId: string;
	type: string;
	messageId: string;
	recipient?: string;
	bounceType?: "hard" | "soft";
}) {
	return {
		type: input.type,
		source: { type: "email.sending", domain: "reccado.example" },
		payload: {
			eventId: input.eventId,
			messageId: input.messageId,
			sender: MAILBOX_ADDRESS,
			recipient: input.recipient ?? RECIPIENT,
			subject: "Factura de junio",
			terminal: true,
			...(input.bounceType ? { bounce: { type: input.bounceType } } : {}),
		},
		metadata: { eventSchemaVersion: 1, eventTimestamp: new Date().toISOString() },
	};
}

function queueMessage(body: unknown, attempts = 1) {
	return { id: crypto.randomUUID(), attempts, body, ack: vi.fn(), retry: vi.fn() };
}

async function consume(message: ReturnType<typeof queueMessage>): Promise<void> {
	await handleEmailEventsQueue(
		{
			queue: "inbox-mcp-email-events-dev",
			messages: [message],
		} as unknown as MessageBatch<unknown>,
		consumerEnv,
		{} as ExecutionContext,
	);
}

async function opsEventTypesFor(subject: string): Promise<string[]> {
	const result = await env.INDEX_DB.prepare(
		"SELECT event_type FROM ops_events WHERE subject = ? ORDER BY created_at",
	)
		.bind(subject)
		.all<{ event_type: string }>();
	return (result.results ?? []).map((row) => row.event_type);
}

describe("delivery events for human-confirmed mailbox sends", () => {
	it("acks a delivered event that matches only outbound_sends and records it in the DO", async () => {
		const mailboxId = "mbx_mailbox_send_delivered";
		// Stored bracketed in D1 (verbatim provider result), carried bare by the event.
		await sendFromMailbox(mailboxId, "<delivered-1@cloudflare.email>");

		const message = queueMessage(
			nestedEvent({
				eventId: "evt-mailbox-delivered-1",
				type: "cf.email.sending.message.delivered",
				messageId: "delivered-1@cloudflare.email",
			}),
		);
		await consume(message);

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		expect(await opsEventTypesFor("delivered-1@cloudflare.email")).not.toContain(
			"email_events.unresolved",
		);

		const stub = env.MAILBOX_DO.getByName(mailboxId);
		const ledger = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.sql
				.exec<{ event_type: string; request_id: string | null }>(
					"SELECT event_type, request_id FROM transactional_delivery_events WHERE event_id = ?",
					"evt-mailbox-delivered-1",
				)
				.toArray(),
		);
		expect(ledger).toEqual([
			{ event_type: "cf.email.sending.message.delivered", request_id: null },
		]);

		// A replay of the same event is idempotent and still acked.
		const replay = queueMessage(message.body, 2);
		await consume(replay);
		expect(replay.ack).toHaveBeenCalledTimes(1);
		expect(replay.retry).not.toHaveBeenCalled();
	});

	it("adds a suppression for a hard bounce on a mailbox send, in the DO and in D1", async () => {
		const mailboxId = "mbx_mailbox_send_bounce";
		await sendFromMailbox(mailboxId, "<bounce-1@cloudflare.email>");

		const message = queueMessage(
			nestedEvent({
				eventId: "evt-mailbox-bounce-1",
				type: "cf.email.sending.message.bounced",
				messageId: "<bounce-1@cloudflare.email>",
				bounceType: "hard",
			}),
		);
		await consume(message);

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();

		const stub = env.MAILBOX_DO.getByName(mailboxId);
		const suppressions = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.sql
				.exec<{ email: string; reason: string; expires_at: string | null }>(
					"SELECT email, reason, expires_at FROM recipient_suppressions",
				)
				.toArray(),
		);
		expect(suppressions).toHaveLength(1);
		expect(suppressions[0]?.email).toBe(RECIPIENT);
		expect(suppressions[0]?.reason).toBe("hard_bounce");
		expect(suppressions[0]?.expires_at).toBeTruthy();

		const projection = await env.INDEX_DB.prepare(
			"SELECT email, mailbox_id, reason, source_event_id FROM recipient_suppressions WHERE email = ? AND mailbox_id = ?",
		)
			.bind(RECIPIENT, mailboxId)
			.first();
		expect(projection).toEqual({
			email: RECIPIENT,
			mailbox_id: mailboxId,
			reason: "hard_bounce",
			source_event_id: "evt-mailbox-bounce-1",
		});
	});

	it("retries when the provider id matches outbound_sends but the recipient does not", async () => {
		const mailboxId = "mbx_mailbox_send_mismatch";
		await sendFromMailbox(mailboxId, "<mismatch-1@cloudflare.email>");

		const message = queueMessage(
			nestedEvent({
				eventId: "evt-mailbox-mismatch-1",
				type: "cf.email.sending.message.bounced",
				messageId: "mismatch-1@cloudflare.email",
				recipient: "someone-else@customer.example",
				bounceType: "hard",
			}),
		);
		await consume(message);

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledTimes(1);
		expect(await opsEventTypesFor("mismatch-1@cloudflare.email")).toContain(
			"email_events.not_found",
		);
		const stub = env.MAILBOX_DO.getByName(mailboxId);
		const suppressions = await runInDurableObject(stub, async (_instance, state) =>
			state.storage.sql.exec("SELECT email FROM recipient_suppressions").toArray(),
		);
		expect(suppressions).toEqual([]);
	});

	it("still retries an event that matches nothing, then dead-letters it without the recipient", async () => {
		const body = nestedEvent({
			eventId: "evt-stranger-1",
			type: "cf.email.sending.message.delivered",
			messageId: "0101018f-stranger",
			recipient: "jane.private@customer.example",
		});
		for (const attempt of [1, 2, 3, 4]) {
			const message = queueMessage(body, attempt);
			await consume(message);
			expect(message.ack).not.toHaveBeenCalled();
			expect(message.retry).toHaveBeenCalledTimes(1);
		}
		expect(await opsEventTypesFor("0101018f-stranger")).toEqual([
			"email_events.unresolved",
			"email_events.unresolved",
			"email_events.unresolved",
			"email_events.unresolved",
		]);

		// Once Cloudflare's retries are spent the message lands on the DLQ.
		const dead = queueMessage(body, 4);
		await handleDeadLetterQueue(
			{
				queue: "inbox-mcp-email-events-dlq-dev",
				messages: [dead],
			} as unknown as MessageBatch<unknown>,
			consumerEnv,
			{} as ExecutionContext,
		);
		expect(dead.ack).toHaveBeenCalledTimes(1);
		const tombstone = await env.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'dlq.dead_letter' AND subject = ?",
		)
			.bind(dead.id)
			.first<{ payload_json: string }>();
		expect(tombstone).not.toBeNull();
		expect(tombstone!.payload_json).not.toContain("jane.private");
		expect(JSON.parse(tombstone!.payload_json).summary).toMatchObject({
			kind: "email_event",
			provider_message_id: "0101018f-stranger",
			to_domain: "customer.example",
		});
	});
});
