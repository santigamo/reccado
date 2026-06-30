import { describe, expect, it, vi } from "vitest";
import { handleInboundQueue } from "#/cloudflare/queue-consumer";
import type { InboundEmailQueueMessage, MailboxIngestResult } from "#/cloudflare/types";

type RecordedCall = { sql: string; args: unknown[] };

// A minimal D1Database stand-in that records every prepare(sql).bind(...args)
// call so assertions can inspect exactly what queue-consumer.ts wrote,
// without needing a real D1 binding (mirrors the existing poison-message
// mocking style above, generalized to multiple distinct SQL statements).
function createMockDb(): { prepare: ReturnType<typeof vi.fn>; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const prepare = vi.fn((sql: string) => ({
		bind: (...args: unknown[]) => {
			calls.push({ sql, args });
			return { run: vi.fn().mockResolvedValue(undefined) };
		},
	}));
	return { prepare, calls };
}

function callsFor(calls: RecordedCall[], sqlIncludes: string): RecordedCall[] {
	return calls.filter((call) => call.sql.includes(sqlIncludes));
}

function buildBody(overrides: Partial<InboundEmailQueueMessage> = {}): InboundEmailQueueMessage {
	return {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: "trace-1",
		enqueuedAt: "2026-06-30T00:00:00.000Z",
		receivedAt: "2026-06-30T00:00:00.000Z",
		mailboxId: "mbx_test",
		domain: "example.com",
		recipient: "test@example.com",
		sender: "sender@example.com",
		rawR2Key: "raw/dev/mbx_test/2026/06/30/123-abc.eml",
		rawSha256: "abc123",
		rawSize: 100,
		messageId: "<msg@example.com>",
		headers: { subject: "Hi", date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
		idempotencyKey: "email:v1:mbx_test:message-id:msg@example.com",
		...overrides,
	};
}

function buildMessage(body: InboundEmailQueueMessage, attempts = 1) {
	return {
		id: "msg-1",
		attempts,
		body,
		retry: vi.fn(),
		ack: vi.fn(),
	};
}

function buildEnv(opts: {
	db: { prepare: ReturnType<typeof vi.fn> };
	doFetch: () => Promise<Response> | Response;
}): Env {
	const stub = { fetch: vi.fn(opts.doFetch) };
	return {
		INDEX_DB: { prepare: opts.db.prepare },
		MAIL_OBJECTS: { head: vi.fn().mockResolvedValue({ key: "raw-object-exists" }) },
		MAILBOX_DO: { getByName: vi.fn(() => stub) },
	} as unknown as Env;
}

async function run(message: ReturnType<typeof buildMessage>, env: Env): Promise<void> {
	await handleInboundQueue(
		{ messages: [message] } as unknown as MessageBatch<InboundEmailQueueMessage>,
		env,
		{} as ExecutionContext,
	);
}

describe("queue consumer", () => {
	it("retries invalid schema messages instead of acking poison messages", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const bind = vi.fn(() => ({ run }));
		const prepare = vi.fn(() => ({ bind }));
		const retry = vi.fn();
		const ack = vi.fn();
		const message = {
			id: "poison-1",
			attempts: 3,
			body: { schemaVersion: 999 },
			retry,
			ack,
		};

		await handleInboundQueue(
			{ messages: [message] } as unknown as MessageBatch<InboundEmailQueueMessage>,
			{ INDEX_DB: { prepare } } as unknown as Env,
			{} as ExecutionContext,
		);

		expect(prepare).toHaveBeenCalledWith(
			"INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at)\n       VALUES (?, ?, ?, ?, ?, ?)",
		);
		expect(retry).toHaveBeenCalledWith({ delaySeconds: 2 });
		expect(ack).not.toHaveBeenCalled();
	});

	it("acks and writes message_index + a processed ingest_event on status=inserted", async () => {
		const db = createMockDb();
		const body = buildBody();
		const message = buildMessage(body);
		const result: MailboxIngestResult = {
			status: "inserted",
			mailboxId: body.mailboxId,
			messageCount: 1,
			idempotencyKey: body.idempotencyKey,
			messageLocalId: "msg_local_1",
			rawR2Key: body.rawR2Key,
			threadId: "thread_1",
			subject: "Hi",
			snippet: "hello there",
			fromAddr: body.sender,
			toJson: JSON.stringify([body.recipient]),
			receivedAt: body.receivedAt,
			hasAttachments: true,
			rfcMessageId: "msg@example.com",
		};
		const env = buildEnv({
			db,
			doFetch: () => new Response(JSON.stringify(result), { status: 200 }),
		});

		await run(message, env);

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();

		const messageIndexCalls = callsFor(db.calls, "INSERT INTO message_index");
		expect(messageIndexCalls).toHaveLength(1);
		// bind order: mailbox_id, message_local_id, ..., has_attachments(idx 9), ...
		expect(messageIndexCalls[0]?.args[0]).toBe(body.mailboxId);
		expect(messageIndexCalls[0]?.args[1]).toBe("msg_local_1");
		expect(messageIndexCalls[0]?.args[9]).toBe(1); // hasAttachments true -> 1

		const ingestEventCalls = callsFor(db.calls, "INSERT INTO ingest_events");
		expect(ingestEventCalls).toHaveLength(1);
		// bind order: idempotency_key, mailbox_id, message_local_id, raw_r2_key, status, ...
		expect(ingestEventCalls[0]?.args[4]).toBe("processed");
	});

	it("acks and writes only a processed ingest_event (no message_index write) on status=duplicate", async () => {
		const db = createMockDb();
		const body = buildBody();
		const message = buildMessage(body);
		const result: MailboxIngestResult = {
			status: "duplicate",
			mailboxId: body.mailboxId,
			messageCount: 1,
			idempotencyKey: body.idempotencyKey,
			messageLocalId: "msg_local_existing",
			rawR2Key: body.rawR2Key,
		};
		const env = buildEnv({
			db,
			doFetch: () => new Response(JSON.stringify(result), { status: 200 }),
		});

		await run(message, env);

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		expect(callsFor(db.calls, "INSERT INTO message_index")).toHaveLength(0);
		const ingestEventCalls = callsFor(db.calls, "INSERT INTO ingest_events");
		expect(ingestEventCalls).toHaveLength(1);
		expect(ingestEventCalls[0]?.args[4]).toBe("processed");
	});

	it("acks and writes a failed ingest_event + an ingest.conflict ops_event on status=conflict", async () => {
		const db = createMockDb();
		const body = buildBody();
		const message = buildMessage(body);
		const result: MailboxIngestResult = {
			status: "conflict",
			mailboxId: body.mailboxId,
			messageCount: 1,
			idempotencyKey: body.idempotencyKey,
			messageLocalId: "msg_local_1",
			rawR2Key: body.rawR2Key,
			errorCode: "message_id_conflict",
		};
		const env = buildEnv({
			db,
			doFetch: () => new Response(JSON.stringify(result), { status: 200 }),
		});

		await run(message, env);

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();

		const ingestEventCalls = callsFor(db.calls, "INSERT INTO ingest_events");
		expect(ingestEventCalls).toHaveLength(1);
		expect(ingestEventCalls[0]?.args[4]).toBe("failed");
		expect(ingestEventCalls[0]?.args[5]).toBe("message_id_conflict");

		const opsEventCalls = callsFor(db.calls, "INSERT INTO ops_events");
		expect(opsEventCalls).toHaveLength(1);
		expect(opsEventCalls[0]?.args[1]).toBe("ingest.conflict");
	});

	it("retries without acking (and without a terminal ops_event) when the DO fetch fails below MAX_RETRIES", async () => {
		const db = createMockDb();
		const body = buildBody();
		const message = buildMessage(body, 1); // attempts(1) < MAX_RETRIES(3)
		const env = buildEnv({
			db,
			doFetch: () => new Response("internal error", { status: 500 }),
		});

		await run(message, env);

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
		expect(callsFor(db.calls, "INSERT INTO ops_events")).toHaveLength(0);
	});

	it("still retries but also logs a terminal ops_event when the DO fetch fails at/above MAX_RETRIES", async () => {
		const db = createMockDb();
		const body = buildBody();
		const message = buildMessage(body, 3); // attempts(3) >= MAX_RETRIES(3)
		const env = buildEnv({
			db,
			doFetch: () => new Response("internal error", { status: 500 }),
		});

		await run(message, env);

		expect(message.ack).not.toHaveBeenCalled();
		// Current behavior: even a "terminal" failure still goes through
		// message.retry() — the in-code MAX_RETRIES threshold only gates
		// whether an ops_event is logged, it doesn't stop retrying. Cloudflare
		// Queues' own configured max_retries/DLQ is what ultimately stops
		// redelivery.
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 2 });

		const opsEventCalls = callsFor(db.calls, "INSERT INTO ops_events");
		expect(opsEventCalls).toHaveLength(1);
		expect(opsEventCalls[0]?.args[1]).toBe("ingest.terminal_failure");
	});
});
