import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotifyQueue } from "#/cloudflare/notify-consumer";
import type {
	InboundNotificationQueueMessage,
	TelegramCardRefreshQueueMessage,
} from "#/cloudflare/types";

type RecordedCall = { sql: string; args: unknown[] };

/**
 * What the stand-in D1 answers a SELECT with. runtime_config answers per key: the
 * chat this deployment adopted on its first /start exists (there is no configured
 * fallback to stand in for it), and telegram.chat_is_forum does not — a private
 * chat with the bot, which is the shape these tests are about. telegram_links and
 * message_index answer as if the card and the email are both still there, so a
 * test about a *missing* card has to say so.
 */
let cardLinkExists = true;

function firstRow(sql: string, args: unknown[]): Record<string, unknown> | null {
	if (sql.includes("SELECT value FROM runtime_config")) {
		return args[0] === "telegram.chat_id" ? { value: "1" } : null;
	}
	if (sql.includes("FROM telegram_links")) {
		return cardLinkExists
			? {
					chat_id: "1",
					message_id: 55,
					mailbox_id: "mbx_test",
					thread_id: "thread_1",
					message_local_id: "msg_local_1",
					topic_id: null,
					created_at: new Date().toISOString(),
				}
			: null;
	}
	if (sql.includes("FROM message_index")) {
		return {
			subject: "Hi",
			from_addr: "sender@example.com",
			to_json: JSON.stringify(["test@example.com"]),
			snippet: "hello there",
			has_attachments: 0,
		};
	}
	return null;
}

// Same D1 stand-in style as queue-consumer.test.ts: record every
// prepare(sql).bind(...args) so assertions can read what the consumer wrote.
//
// The unbound shape matters too: the noise policy reads settings with a bare
// prepare(...).first(), and a stand-in that only answers after bind() would fail
// those with "first is not a function" rather than with an empty table.
function createMockDb(): { prepare: ReturnType<typeof vi.fn>; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const results = (sql: string, args: unknown[]) => ({
		run: vi.fn().mockResolvedValue({ meta: { changes: 0 } }),
		first: vi.fn().mockResolvedValue(firstRow(sql, args)),
		all: vi.fn().mockResolvedValue({ results: [] }),
	});
	const prepare = vi.fn((sql: string) => ({
		...results(sql, []),
		bind: (...args: unknown[]) => {
			calls.push({ sql, args });
			return results(sql, args);
		},
	}));
	return { prepare, calls };
}

function callsFor(calls: RecordedCall[], sqlIncludes: string): RecordedCall[] {
	return calls.filter((call) => call.sql.includes(sqlIncludes));
}

function buildBody(): InboundNotificationQueueMessage {
	return {
		schemaVersion: 1,
		eventType: "mail.notify.v1",
		notification: {
			mailboxId: "mbx_test",
			mailboxAddress: "test@example.com",
			messageLocalId: "msg_local_1",
			threadId: "thread_1",
			subject: "Hi",
			fromAddr: "sender@example.com",
			snippet: "hello there",
			hasAttachments: false,
		},
	};
}

function buildRefreshBody(): TelegramCardRefreshQueueMessage {
	return {
		schemaVersion: 1,
		eventType: "telegram.card_refresh.v1",
		refresh: {
			mailboxId: "mbx_test",
			messageLocalId: "msg_local_1",
			threadId: null,
			status: "archived",
		},
	};
}

function buildMessage(body: unknown, attempts = 1) {
	return {
		id: "notify-1",
		attempts,
		body,
		retry: vi.fn(),
		ack: vi.fn(),
	};
}

function buildEnv(db: { prepare: ReturnType<typeof vi.fn> }, overrides: Partial<Env> = {}): Env {
	return {
		INDEX_DB: { prepare: db.prepare },
		TELEGRAM_BOT_TOKEN: "bot-token",
		TELEGRAM_ALLOWED_USER_IDS: "1",
		...overrides,
	} as unknown as Env;
}

async function run(message: ReturnType<typeof buildMessage>, env: Env): Promise<void> {
	await handleNotifyQueue(
		{ messages: [message] } as unknown as MessageBatch<unknown>,
		env,
		{} as ExecutionContext,
	);
}

/** Stubs api.telegram.org so no test can reach the network. */
function stubTelegram(handler: (method: string) => Response | Promise<Response>): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			return handler(url.split("/").pop() ?? "");
		}),
	);
}

function telegramOk(result: unknown): Response {
	return Response.json({ ok: true, result });
}

function telegramError(errorCode: number, description: string): Response {
	return Response.json({ ok: false, error_code: errorCode, description });
}

beforeEach(() => {
	cardLinkExists = true;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("notify consumer", () => {
	it("sends the card, records the reply link and acks", async () => {
		const db = createMockDb();
		stubTelegram(() => telegramOk({ message_id: 42, chat: { id: 1, type: "private" } }));
		const message = buildMessage(buildBody());

		await run(message, buildEnv(db));

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		expect(callsFor(db.calls, "telegram_links")).toHaveLength(1);
	});

	it("retries with backoff instead of losing the push when Telegram rate-limits", async () => {
		const db = createMockDb();
		stubTelegram(() => telegramError(429, "Too Many Requests: retry after 30"));
		const message = buildMessage(buildBody(), 2);

		await run(message, buildEnv(db));

		// The whole point of the split queue: a Telegram failure is redelivered
		// rather than swallowed, and the wait grows so the retry does not just
		// earn another 429.
		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
		const opsEventCalls = callsFor(db.calls, "INSERT INTO ops_events");
		expect(opsEventCalls).toHaveLength(1);
		expect(opsEventCalls[0]?.args[1]).toBe("telegram.notify_retry");
	});

	it("retries a Telegram 5xx", async () => {
		const db = createMockDb();
		stubTelegram(() => telegramError(500, "Internal Server Error"));
		const message = buildMessage(buildBody(), 1);

		await run(message, buildEnv(db));

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
	});

	it("retries a network failure", async () => {
		const db = createMockDb();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection reset");
			}),
		);
		const message = buildMessage(buildBody(), 3);

		await run(message, buildEnv(db));

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
	});

	it("acks a permanent Telegram rejection instead of retrying it forever", async () => {
		const db = createMockDb();
		stubTelegram(() => telegramError(403, "Forbidden: bot was blocked by the user"));
		const message = buildMessage(buildBody());

		await run(message, buildEnv(db));

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		const opsEventCalls = callsFor(db.calls, "INSERT INTO ops_events");
		expect(opsEventCalls).toHaveLength(1);
		expect(opsEventCalls[0]?.args[1]).toBe("telegram.notify_dropped");
	});

	it("acks without touching Telegram when the bridge is off", async () => {
		const db = createMockDb();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const message = buildMessage(buildBody());

		await run(message, buildEnv(db, { TELEGRAM_BOT_TOKEN: undefined }));

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("still delivers when no operator is linked, because the allowlist is about orders", async () => {
		const db = createMockDb();
		stubTelegram(() => telegramOk({ message_id: 42, chat: { id: 1, type: "private" } }));
		const message = buildMessage(buildBody());

		// This used to be a config error: a bot token with no allowlist made
		// readTelegramConfig throw, and the card was dropped. It was the wrong
		// question. Who may give the bot orders and who may be told about mail are
		// different permissions, and the adopted chat -- which only an operator can
		// create -- already decides the second one.
		await run(message, buildEnv(db, { TELEGRAM_ALLOWED_USER_IDS: undefined }));

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		expect(callsFor(db.calls, "telegram_links")).toHaveLength(1);
	});

	it("edits the card when a state change arrives from another surface", async () => {
		const db = createMockDb();
		const calls: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				calls.push(String(input).split("/").pop() ?? "");
				return telegramOk({ message_id: 55, chat: { id: 1, type: "private" } });
			}),
		);
		const message = buildMessage(buildRefreshBody());

		await run(message, buildEnv(db));

		expect(calls).toEqual(["editMessageText"]);
		expect(message.ack).toHaveBeenCalledTimes(1);
	});

	it("redelivers an edit Telegram rate-limited instead of losing it silently", async () => {
		const db = createMockDb();
		stubTelegram(() => telegramError(429, "Too Many Requests: retry after 30"));
		const message = buildMessage(buildRefreshBody(), 2);

		// An edit spends the same one-message-per-second budget as a card, so it
		// earns the same backoff rather than being dropped as cosmetic.
		await run(message, buildEnv(db));

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
	});

	it("acks an update whose card no longer exists instead of retrying it", async () => {
		cardLinkExists = false;
		const db = createMockDb();
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const message = buildMessage(buildRefreshBody());

		// Nothing failed: this email was never announced in Telegram, or its card is
		// gone. Redelivering would re-decide the same thing on every attempt.
		await run(message, buildEnv(db));

		expect(message.ack).toHaveBeenCalledTimes(1);
		expect(message.retry).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("retries an unreadable payload so the DLQ keeps it", async () => {
		const db = createMockDb();
		const message = buildMessage({ schemaVersion: 999 });

		await run(message, buildEnv(db));

		expect(message.ack).not.toHaveBeenCalled();
		expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 5 });
		const opsEventCalls = callsFor(db.calls, "INSERT INTO ops_events");
		expect(opsEventCalls).toHaveLength(1);
		expect(opsEventCalls[0]?.args[1]).toBe("notify.poison_schema");
	});
});
