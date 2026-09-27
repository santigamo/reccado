import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDeadLetterQueue } from "#/cloudflare/dlq-consumer";

type RecordedCall = { sql: string; args: unknown[] };

// Same D1 stand-in style as notify-consumer.test.ts: record every
// prepare(sql).bind(...args) so assertions can read what the consumer wrote.
// `failRun` models the one dependency this consumer has — the ledger itself.
function createMockDb(options: { failRun?: boolean } = {}): {
	prepare: ReturnType<typeof vi.fn>;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const prepare = vi.fn((sql: string) => ({
		bind: (...args: unknown[]) => {
			calls.push({ sql, args });
			return {
				run: vi.fn(async () => {
					if (options.failRun) throw new Error("D1_ERROR: no such table: ops_events");
				}),
			};
		},
	}));
	return { prepare, calls };
}

function opsEventCalls(calls: RecordedCall[]): RecordedCall[] {
	return calls.filter((call) => call.sql.includes("INSERT INTO ops_events"));
}

function buildMessage(body: unknown, id = "dead-1", attempts = 4) {
	return { id, attempts, body, retry: vi.fn(), ack: vi.fn() };
}

function buildEnv(db: { prepare: ReturnType<typeof vi.fn> }): Env {
	return { INDEX_DB: { prepare: db.prepare } } as unknown as Env;
}

async function run(
	messages: ReturnType<typeof buildMessage>[],
	env: Env,
	queue = "inbox-mcp-inbound-dlq-dev",
): Promise<void> {
	await handleDeadLetterQueue(
		{ queue, messages } as unknown as MessageBatch<unknown>,
		env,
		{} as ExecutionContext,
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("dead-letter queue consumer", () => {
	it("writes one tombstone per message and acks", async () => {
		const db = createMockDb();
		const first = buildMessage({ eventType: "email.received.v1", mailboxId: "mbx_a" }, "dead-1", 4);
		const second = buildMessage({ eventType: "mail.notify.v1" }, "dead-2", 6);

		await run([first, second], buildEnv(db));

		const inserts = opsEventCalls(db.calls);
		expect(inserts).toHaveLength(2);
		expect(inserts[0]?.args[1]).toBe("dlq.dead_letter");
		expect(inserts[0]?.args[2]).toBe("error");
		// The message id is the subject: it is the only handle an operator has on a
		// dead message once Queues retention has expired.
		expect(inserts[0]?.args[3]).toBe("dead-1");
		expect(JSON.parse(String(inserts[0]?.args[4]))).toEqual({
			queue: "inbox-mcp-inbound-dlq-dev",
			attempts: 4,
			summary: { kind: "inbound", eventType: "email.received.v1", mailboxId: "mbx_a" },
		});
		expect(inserts[1]?.args[3]).toBe("dead-2");
		expect(JSON.parse(String(inserts[1]?.args[4])).attempts).toBe(6);

		expect(first.ack).toHaveBeenCalledTimes(1);
		expect(second.ack).toHaveBeenCalledTimes(1);
		expect(first.retry).not.toHaveBeenCalled();
		expect(second.retry).not.toHaveBeenCalled();
	});

	it("retries instead of acking when the tombstone cannot be written", async () => {
		const db = createMockDb({ failRun: true });
		const message = buildMessage({ eventType: "email.received.v1" });

		await run([message], buildEnv(db));

		// Acking here would erase the message and the record of it in one move: a
		// death cannot be logged in a ledger that is down.
		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledTimes(1);
	});

	it("still records a tombstone for a body that cannot be serialized", async () => {
		const db = createMockDb();
		const circular: Record<string, unknown> = { eventType: "poison" };
		circular.self = circular;
		const message = buildMessage(circular, "dead-circular", 5);

		await run([message], buildEnv(db), "inbox-mcp-notify-dlq-dev");

		const inserts = opsEventCalls(db.calls);
		expect(inserts).toHaveLength(1);
		const payload = JSON.parse(String(inserts[0]?.args[4]));
		expect(payload.queue).toBe("inbox-mcp-notify-dlq-dev");
		expect(payload.summary).toEqual({
			kind: "unrecognized",
			bodyType: "object",
			eventType: "poison",
			keys: ["eventType", "self"],
		});
		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
	});

	it("never reaches the network", async () => {
		const db = createMockDb();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);

		await run([buildMessage({ eventType: "mail.notify.v1" })], buildEnv(db));

		// A tombstone is a D1 row and nothing else: no Telegram push, no callback,
		// no re-delivery. Any fetch here would mean the consumer grew a side effect.
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("dead-letter tombstones carry no recipients or content", () => {
	// Shaped like the live Cloudflare Email Sending event that leaked: the nested
	// official format, with the recipient, the rendered subject and the provider's
	// SMTP prose all present.
	const deadEvent = {
		type: "cf.email.sending.message.delivered",
		source: { type: "email.sending", zoneId: "zone-1", domain: "send.example.com" },
		payload: {
			eventId: "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f",
			messageId: "0101018f7d0c4d9a-msg-deadbeef",
			sender: "noreply@send.example.com",
			recipient: "jane.private@customer.example",
			subject: "Your login code is 482913",
			terminal: true,
			delivery: {
				status: "delivered",
				smtpResponse: "250 2.0.0 OK jane.private accepted",
			},
		},
		metadata: {
			accountId: "acct-1",
			eventSubscriptionId: "sub-1",
			eventSchemaVersion: 1,
			eventTimestamp: "2026-09-27T10:00:00.000Z",
		},
	};

	async function tombstoneFor(body: unknown, queue: string) {
		const db = createMockDb();
		const message = buildMessage(body, "dead-pii", 4);
		await run([message], buildEnv(db), queue);
		const inserts = opsEventCalls(db.calls);
		expect(inserts).toHaveLength(1);
		expect(message.ack).toHaveBeenCalledTimes(1);
		return String(inserts[0]?.args[4]);
	}

	it("keeps only safe identifiers for an Email Sending event", async () => {
		const raw = await tombstoneFor(deadEvent, "inbox-mcp-email-events-dlq-dev");

		expect(raw).not.toContain("jane.private");
		expect(raw).not.toContain("noreply@");
		expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
		expect(raw).not.toContain("482913");
		expect(raw).not.toContain("login code");
		expect(raw).not.toContain("smtpResponse");
		expect(raw).not.toContain('"body"');
		expect(raw).not.toContain('"subject"');

		expect(JSON.parse(raw)).toEqual({
			queue: "inbox-mcp-email-events-dlq-dev",
			attempts: 4,
			summary: {
				kind: "email_event",
				event_type: "cf.email.sending.message.delivered",
				event_id: "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f",
				provider_message_id: "0101018f7d0c4d9a-msg-deadbeef",
				to_domain: "customer.example",
			},
		});
	});

	it("keeps only safe identifiers for an event that failed the schema", async () => {
		const broken = {
			...deadEvent,
			payload: { ...deadEvent.payload, sender: "not an address" },
		};
		const raw = await tombstoneFor(broken, "inbox-mcp-email-events-dlq-dev");

		expect(raw).not.toContain("jane.private");
		expect(raw).not.toContain("482913");
		const summary = JSON.parse(raw).summary;
		expect(summary).toEqual({
			kind: "email_event",
			schema_valid: false,
			event_type: "cf.email.sending.message.delivered",
			event_id: "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f",
			provider_message_id: "0101018f7d0c4d9a-msg-deadbeef",
			to_domain: "customer.example",
		});
	});

	it("keeps only replay handles for a dead inbound envelope", async () => {
		const inbound = {
			schemaVersion: 1,
			eventType: "email.received.v1",
			traceId: "trace-1",
			enqueuedAt: "2026-09-27T10:00:00.000Z",
			receivedAt: "2026-09-27T10:00:00.000Z",
			mailboxId: "mbx_inbound",
			domain: "customer.example",
			recipient: "jane.private@customer.example",
			sender: "sender.person@elsewhere.example",
			rawR2Key: "raw/dev/mbx_inbound/2026/09/27/1790000000000-abc123.eml",
			rawSha256: "abc123",
			rawSize: 1234,
			messageId: "CAHyeH21-secret-thread@mail.gmail.com",
			headers: {
				subject: "Medical results for Jane",
				date: null,
				inReplyTo: null,
				references: [],
			},
			routing: { ruleId: null, action: "store", matchedAlias: "jane.private@customer.example" },
			idempotencyKey: "email:v1:mbx_inbound:message-id:cahyeh21-secret-thread@mail.gmail.com",
		};
		const raw = await tombstoneFor(inbound, "inbox-mcp-inbound-dlq-dev");

		expect(raw).not.toContain("jane.private");
		expect(raw).not.toContain("sender.person");
		expect(raw).not.toContain("Medical results");
		expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
		expect(JSON.parse(raw).summary).toEqual({
			kind: "inbound",
			eventType: "email.received.v1",
			schemaVersion: 1,
			traceId: "trace-1",
			mailboxId: "mbx_inbound",
			rawR2Key: "raw/dev/mbx_inbound/2026/09/27/1790000000000-abc123.eml",
			rawSha256: "abc123",
			rawSize: 1234,
			recipientDomain: "customer.example",
		});
	});

	it("keeps only conversation handles for a dead notification", async () => {
		const notify = {
			schemaVersion: 1,
			eventType: "mail.notify.v1",
			notification: {
				mailboxId: "mbx_notify",
				mailboxAddress: "owner.private@reccado.example",
				messageLocalId: "msg-1",
				threadId: "thr-1",
				subject: "Medical results for Jane",
				fromAddr: "Dr Who <doctor.private@clinic.example>",
				snippet: "Your biopsy came back",
				hasAttachments: false,
			},
		};
		const raw = await tombstoneFor(notify, "inbox-mcp-notify-dlq-dev");

		expect(raw).not.toContain("private");
		expect(raw).not.toContain("Medical results");
		expect(raw).not.toContain("biopsy");
		expect(raw).not.toContain('"snippet"');
		expect(JSON.parse(raw).summary).toEqual({
			kind: "notify",
			eventType: "mail.notify.v1",
			schemaVersion: 1,
			mailboxId: "mbx_notify",
			messageLocalId: "msg-1",
			threadId: "thr-1",
		});
	});

	it("records only the key names of a body no producer sends", async () => {
		const raw = await tombstoneFor(
			{ to: "jane.private@customer.example", subject: "hello", body: "hi Jane" },
			"inbox-mcp-notify-dlq-dev",
		);

		expect(raw).not.toContain("jane.private");
		expect(raw).not.toContain("hi Jane");
		expect(JSON.parse(raw).summary).toEqual({
			kind: "unrecognized",
			bodyType: "object",
			keys: ["to", "subject", "body"],
		});
	});
});
