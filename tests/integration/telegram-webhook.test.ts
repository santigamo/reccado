import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";

const testEnv = env as unknown as Env;

const SECRET = "webhook-secret-value";
const ALLOWED_USER = "424242";

async function applyMigration(sql: string): Promise<void> {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	for (const statement of statements) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

beforeAll(async () => {
	for (const migration of [
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
		migrationTelegram,
	]) {
		await applyMigration(migration as string);
	}
});

/** Captures the bot's outgoing Bot API calls instead of hitting Telegram. */
function stubTelegramApi(): Array<{ method: string; body: Record<string, unknown> }> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		calls.push({
			method: url.split("/").pop() ?? "",
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return Response.json({ ok: true, result: { message_id: 1, chat: { id: 1, type: "private" } } });
	});
	return calls;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

function telegramEnv(overrides: Partial<Env> = {}): Env {
	return {
		...testEnv,
		TELEGRAM_BOT_TOKEN: "123:fake-token",
		TELEGRAM_WEBHOOK_SECRET: SECRET,
		TELEGRAM_ALLOWED_USER_IDS: ALLOWED_USER,
		TELEGRAM_CHAT_ID: "999",
		...overrides,
	} as Env;
}

async function post(
	body: unknown,
	options: { secret?: string | null; env?: Env; method?: string } = {},
): Promise<Response> {
	const headers = new Headers({ "content-type": "application/json" });
	if (options.secret !== null) {
		headers.set("x-telegram-bot-api-secret-token", options.secret ?? SECRET);
	}
	const request = new Request("https://reccado.test/telegram/webhook", {
		method: options.method ?? "POST",
		headers,
		body: options.method === "GET" ? undefined : JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, options.env ?? telegramEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function messageUpdate(overrides: Record<string, unknown> = {}): unknown {
	return {
		update_id: 1,
		message: {
			message_id: 10,
			chat: { id: 999, type: "private" },
			from: { id: Number(ALLOWED_USER) },
			text: "Te la mando mañana.",
			...overrides,
		},
	};
}

describe("telegram webhook", () => {
	it("is invisible when the bridge is not configured", async () => {
		const response = await post(messageUpdate(), {
			env: { ...testEnv, TELEGRAM_BOT_TOKEN: undefined } as Env,
		});
		expect(response.status).toBe(404);
	});

	it("refuses to run half-configured", async () => {
		const response = await post(messageUpdate(), {
			env: telegramEnv({ TELEGRAM_WEBHOOK_SECRET: undefined }),
		});
		expect(response.status).toBe(503);
	});

	it("refuses to run without an allowlist", async () => {
		const response = await post(messageUpdate(), {
			env: telegramEnv({ TELEGRAM_ALLOWED_USER_IDS: "" }),
		});
		expect(response.status).toBe(503);
	});

	it("rejects a request with the wrong secret token", async () => {
		const response = await post(messageUpdate(), { secret: "wrong" });
		expect(response.status).toBe(401);
	});

	it("rejects a request with no secret token at all", async () => {
		const response = await post(messageUpdate(), { secret: null });
		expect(response.status).toBe(401);
	});

	it("rejects non-POST requests", async () => {
		const response = await post(undefined, { method: "GET" });
		expect(response.status).toBe(405);
	});

	it("ignores a user outside the allowlist without calling Telegram", async () => {
		const calls = stubTelegramApi();
		const response = await post(messageUpdate({ from: { id: 111 } }));
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(0);
	});

	it("ignores messages from an unexpected chat", async () => {
		const calls = stubTelegramApi();
		const response = await post(messageUpdate({ chat: { id: 555, type: "private" } }));
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(0);
	});

	it("tells the operator when it cannot tell which email a reply belongs to", async () => {
		const calls = stubTelegramApi();
		const response = await post(messageUpdate());
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("sendMessage");
		expect(String(calls[0]?.body.text)).toContain("No sé a qué correo");
	});

	it("answers /start with the ids needed to finish setup", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ text: "/start" }));
		expect(calls[0]?.method).toBe("sendMessage");
		expect(String(calls[0]?.body.text)).toContain("999");
		expect(String(calls[0]?.body.text)).toContain(ALLOWED_USER);
	});

	it("says so when a reply carries no text to send", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ text: undefined }));
		expect(String(calls[0]?.body.text)).toContain("solo puedo enviar texto");
	});

	it("rejects a callback from a user outside the allowlist", async () => {
		const calls = stubTelegramApi();
		await post({
			update_id: 2,
			callback_query: { id: "cb1", from: { id: 111 }, data: "s:deadbeef" },
		});
		expect(calls[0]?.method).toBe("answerCallbackQuery");
		expect(calls[0]?.body.text).toBe("No autorizado");
	});

	it("reports an unknown or expired confirm token", async () => {
		const calls = stubTelegramApi();
		await post({
			update_id: 3,
			callback_query: { id: "cb2", from: { id: Number(ALLOWED_USER) }, data: "s:notatoken" },
		});
		expect(calls[0]?.method).toBe("answerCallbackQuery");
		expect(calls[0]?.body.text).toBe("Caducado");
	});

	it("does not act on a token issued to a different user", async () => {
		const calls = stubTelegramApi();
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO telegram_actions (token, kind, mailbox_id, draft_id, telegram_user_id, created_at, expires_at)
       VALUES (?, 'confirm_send', 'mbx_test', 'draft-1', '777', ?, ?)`,
		)
			.bind(
				"tokenforsomeoneelse",
				new Date().toISOString(),
				new Date(Date.now() + 60_000).toISOString(),
			)
			.run();
		await post({
			update_id: 4,
			callback_query: {
				id: "cb3",
				from: { id: Number(ALLOWED_USER) },
				data: "s:tokenforsomeoneelse",
			},
		});
		expect(calls[0]?.body.text).toBe("No autorizado");
	});
});
