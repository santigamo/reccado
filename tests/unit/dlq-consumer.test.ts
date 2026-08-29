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
			body: JSON.stringify(first.body),
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
		expect(payload.body).toBe(String(circular));
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
