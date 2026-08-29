import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { deriveWebhookSecret } from "#/telegram/api";
import { splitSqlStatements } from "../helpers/migrations";

const testEnv = env as unknown as Env;

const BOT_TOKEN = "123:fake-token";
const ALLOWED_USER = "424242";
/** Derived from BOT_TOKEN, exactly as the worker derives it. Filled in beforeAll. */
let SECRET = "";

async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

beforeAll(async () => {
	for (const migration of [
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
		migrationTelegram,
		migrationRuntimeConfig,
		migrationTelegramTopics,
		migrationOwnerRegistry,
		migrationExperience,
	]) {
		await applyMigration(migration as string);
	}
	SECRET = await deriveWebhookSecret(BOT_TOKEN);
});

/**
 * Captures the bot's outgoing Bot API calls instead of hitting Telegram.
 *
 * `chat` is what getChat answers: the shape of the chat is a fact the bridge
 * observes rather than a var it is told, so a test that cares about topics states
 * it here.
 */
function stubTelegramApi(
	chat: { type: string; is_forum?: boolean } = { type: "private" },
): Array<{ method: string; body: Record<string, unknown> }> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		const method = url.split("/").pop() ?? "";
		calls.push({
			method,
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		if (method === "getChat") {
			return Response.json({ ok: true, result: { id: 999, ...chat } });
		}
		return Response.json({ ok: true, result: { message_id: 1, chat: { id: 1, type: "private" } } });
	});
	return calls;
}

async function runtimeConfigValue(key: string): Promise<string | null> {
	const row = await testEnv.INDEX_DB.prepare("SELECT value FROM runtime_config WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

function telegramEnv(overrides: Partial<Env> = {}): Env {
	return {
		...testEnv,
		TELEGRAM_BOT_TOKEN: BOT_TOKEN,
		TELEGRAM_ALLOWED_USER_IDS: ALLOWED_USER,
		...overrides,
	} as Env;
}

/** A deployment nobody has paired yet: no registry row, no bootstrap variable. */
function unpairedEnv(overrides: Partial<Env> = {}): Env {
	return telegramEnv({ TELEGRAM_ALLOWED_USER_IDS: "", ...overrides });
}

async function ownerIdentities(): Promise<Array<{ kind: string; identity: string }>> {
	const result = await testEnv.INDEX_DB.prepare(
		"SELECT kind, identity FROM owner_identities ORDER BY identity",
	).all<{ kind: string; identity: string }>();
	return result.results ?? [];
}

async function insertPairingCode(
	code: string,
	options: { expiresInMs?: number; consumedAt?: string } = {},
): Promise<void> {
	const now = new Date();
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by, consumed_at)
     VALUES (?, ?, ?, 'manual', ?)`,
	)
		.bind(
			code,
			now.toISOString(),
			new Date(now.getTime() + (options.expiresInMs ?? 60_000)).toISOString(),
			options.consumedAt ?? null,
		)
		.run();
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

	it("authenticates with a secret derived from the bot token, not a configured one", async () => {
		// The whole point of the derivation: there is no secret to forget, and a
		// deployment that only has the bot token is already fully authenticated.
		stubTelegramApi();
		const response = await post(messageUpdate(), { secret: await deriveWebhookSecret(BOT_TOKEN) });
		expect(response.status).toBe(200);
	});

	// It used to answer 503 here. That was a deadlock dressed as caution: the only
	// way to become an operator is to send /start, and /start only arrives through a
	// route that answers. The secret token still gates every update, so an unpaired
	// bridge is not an open one.
	it("serves an unpaired bridge, because /start is how it stops being unpaired", async () => {
		const calls = stubTelegramApi();
		const response = await post(messageUpdate({ text: "/start" }), {
			env: unpairedEnv(),
		});
		expect(response.status).toBe(200);
		expect(String(calls[0]?.body.text)).toContain("código de emparejamiento");
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
		// Bind the deployment first: "unexpected" is only meaningful once some chat
		// has been adopted, and adoption is what /start does.
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
			.bind("telegram.chat_id", "999", new Date().toISOString())
			.run();
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
		// getChat may precede it: adoption also observes whether the chat has topics.
		const reply = calls.find((call) => call.method === "sendMessage");
		expect(reply).toBeDefined();
		expect(String(reply?.body.text)).toContain("999");
		expect(String(reply?.body.text)).toContain(ALLOWED_USER);
	});

	it("answers /start from a stranger instead of leaving them in a deadlock", async () => {
		// The old flow gated /start behind the allowlist, so the command that tells
		// you your user id only worked once your user id was already configured. A
		// first-time operator got silence and could not tell which of the webhook,
		// the secret or the allowlist was wrong.
		const calls = stubTelegramApi();
		const response = await post(messageUpdate({ from: { id: 111 }, text: "/start" }));
		expect(response.status).toBe(200);
		// One reply and nothing else: no adoption, no getChat, no D1 mutation. A
		// stranger learns their own id, which @userinfobot would tell them anyway.
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.body.text)).toContain("111");
		expect(String(calls[0]?.body.text)).toContain("código de emparejamiento");
		expect(await ownerIdentities()).toEqual([]);
	});

	it("adopts the chat on first /start and will not be moved by a later one", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_id")
			.run();

		const first = stubTelegramApi();
		await post(messageUpdate({ text: "/start" }));
		expect(String(first.find((call) => call.method === "sendMessage")?.body.text)).toContain(
			"recibirá el correo nuevo",
		);
		const row = await testEnv.INDEX_DB.prepare("SELECT value FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_id")
			.first<{ value: string }>();
		expect(row?.value).toBe("999");

		// First write wins: an allowlisted operator running /start in a group they
		// were added to must not silently redirect every future new-mail card.
		const second = stubTelegramApi();
		await post(messageUpdate({ chat: { id: 777, type: "private" }, text: "/start" }));
		expect(String(second[0]?.body.text)).toContain("otro chat vinculado");
		const unchanged = await testEnv.INDEX_DB.prepare(
			"SELECT value FROM runtime_config WHERE key = ?",
		)
			.bind("telegram.chat_id")
			.first<{ value: string }>();
		expect(unchanged?.value).toBe("999");
	});

	it("observes on /start whether the chat can hold topics, instead of being told", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key IN (?, ?)")
			.bind("telegram.chat_id", "telegram.chat_is_forum")
			.run();

		const calls = stubTelegramApi({ type: "supergroup", is_forum: true });
		await post(messageUpdate({ text: "/start" }));

		// There is no TELEGRAM_TOPICS to set: getChat already knows, and the answer is
		// cached so the notifier never spends an API call per email to re-ask.
		expect(calls.some((call) => call.method === "getChat")).toBe(true);
		expect(await runtimeConfigValue("telegram.chat_is_forum")).toBe("1");
		expect(String(calls.at(-1)?.body.text)).toContain("topic");
	});

	it("records a plain private chat as having no topics", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key IN (?, ?)")
			.bind("telegram.chat_id", "telegram.chat_is_forum")
			.run();

		const calls = stubTelegramApi({ type: "private" });
		await post(messageUpdate({ text: "/start" }));

		expect(await runtimeConfigValue("telegram.chat_is_forum")).toBe("0");
		expect(String(calls.at(-1)?.body.text)).toContain("mensajes normales");
	});

	it("re-observes topic mode on a later /start", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key IN (?, ?)")
			.bind("telegram.chat_id", "telegram.chat_is_forum")
			.run();

		stubTelegramApi({ type: "private" });
		await post(messageUpdate({ text: "/start" }));
		expect(await runtimeConfigValue("telegram.chat_is_forum")).toBe("0");

		// Turning topic mode on in Telegram and sending /start again is the whole
		// reconfiguration procedure — no redeploy, no var.
		stubTelegramApi({ type: "supergroup", is_forum: true });
		await post(messageUpdate({ text: "/start" }));
		expect(await runtimeConfigValue("telegram.chat_is_forum")).toBe("1");
	});

	it("does not answer a loose message in a topic as that mailbox's newest email", async () => {
		// A topic is now a mailbox, so "the newest link in this topic" means "whatever
		// arrived last in this mailbox" — replying to that would answer the card that
		// landed while the operator was typing, not the one he was reading.
		await testEnv.INDEX_DB.prepare(
			`INSERT OR REPLACE INTO telegram_links
       (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
       VALUES ('999', 4242, 'mbx_test', 'thread-1', 'msg-1', 7, ?)`,
		)
			.bind(new Date().toISOString())
			.run();

		const calls = stubTelegramApi();
		await post(messageUpdate({ message_thread_id: 7, is_topic_message: true }));

		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.body.text)).toContain("No sé a qué correo");
	});

	it("still resolves a reply that quotes the notification card", async () => {
		await testEnv.INDEX_DB.prepare(
			`INSERT OR REPLACE INTO telegram_links
       (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
       VALUES ('999', 4243, 'mbx_test', 'thread-1', 'msg-1', 7, ?)`,
		)
			.bind(new Date().toISOString())
			.run();

		const calls = stubTelegramApi();
		await post(
			messageUpdate({
				message_thread_id: 7,
				reply_to_message: { message_id: 4243, chat: { id: 999, type: "private" } },
			}),
		);

		// It gets past link resolution and fails later, on the mailbox DO, which is
		// the proof that the quoted card was matched.
		expect(String(calls[0]?.body.text)).not.toContain("No sé a qué correo");
	});

	it("does not let /help or /id bind the chat — only /start does", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_id")
			.run();

		const calls = stubTelegramApi();
		await post(messageUpdate({ text: "/help" }));
		expect(String(calls.find((call) => call.method === "sendMessage")?.body.text)).toContain(
			"Envía /start",
		);
		const row = await testEnv.INDEX_DB.prepare("SELECT value FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_id")
			.first<{ value: string }>();
		expect(row).toBeNull();

		// And /start still does bind, so the guard did not disable adoption outright.
		const after = stubTelegramApi();
		await post(messageUpdate({ text: "/start" }));
		expect(String(after.find((call) => call.method === "sendMessage")?.body.text)).toContain(
			"recibirá el correo nuevo",
		);
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

	it("gives a stranger who presses a card button nothing at all", async () => {
		await testEnv.INDEX_DB.prepare(
			`INSERT OR REPLACE INTO telegram_links
       (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
       VALUES ('999', 5150, 'mbx_test', 'thread-1', 'msg-1', NULL, ?)`,
		)
			.bind(new Date().toISOString())
			.run();

		const calls = stubTelegramApi();
		await post({
			update_id: 20,
			callback_query: {
				id: "cb-card",
				from: { id: 111 },
				data: "v1:a",
				message: { message_id: 5150, chat: { id: 999, type: "private" } },
			},
		});

		// The buttons carry a verb and no token, so the allowlist is the whole guard:
		// a stranger who presses one gets a refusal and nothing else -- no DO call, no
		// edit, no hint that the card resolves to anything.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("answerCallbackQuery");
		expect(calls[0]?.body.text).toBe("No autorizado");
	});

	it("archives from a card button, edits the card and answers the press", async () => {
		await testEnv.INDEX_DB.prepare(
			`INSERT OR REPLACE INTO telegram_links
       (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
       VALUES ('999', 5151, 'mbx_card', 'thread-card', 'msg-card', NULL, ?)`,
		)
			.bind(new Date().toISOString())
			.run();
		const now = new Date().toISOString();
		await testEnv.INDEX_DB.prepare(
			`INSERT OR REPLACE INTO message_index
       (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json,
        snippet, received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
       VALUES ('mbx_card', 'msg-card', 'thread-card', NULL, 'Factura', 'sender@example.com',
               '["hello@imsanti.dev"]', 'hola', ?, 0, '[]', 'inbox', 'raw/1', 'sha', ?)`,
		)
			.bind(now, now)
			.run();

		const calls = stubTelegramApi();
		await post({
			update_id: 21,
			callback_query: {
				id: "cb-archive",
				from: { id: Number(ALLOWED_USER) },
				data: "v1:a",
				message: { message_id: 5151, chat: { id: 999, type: "private" } },
			},
		});

		const edit = calls.find((call) => call.method === "editMessageText");
		expect(edit?.body.message_id).toBe(5151);
		expect(String(edit?.body.text)).toContain("· archivado");
		expect(calls.find((call) => call.method === "answerCallbackQuery")?.body.text).toBe(
			"Archivado",
		);
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

describe("telegram pairing", () => {
	const STRANGER = 111;

	// Each of these tests is a statement about a deployment in a particular state,
	// so each one starts from nothing linked and nothing adopted.
	beforeEach(async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM owner_identities").run();
		await testEnv.INDEX_DB.prepare("DELETE FROM owner_pairing_codes").run();
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_id")
			.run();
	});

	it("links the account that answers with a valid code", async () => {
		await insertPairingCode("dv4k7q2m");
		const calls = stubTelegramApi();
		const response = await post(
			messageUpdate({ from: { id: STRANGER }, text: "/start dv4k7q2m" }),
			{ env: unpairedEnv() },
		);

		expect(response.status).toBe(200);
		// The machine observed the user id; the human decided, by handing over a code
		// that means "the next account to answer with this is me".
		expect(await ownerIdentities()).toEqual([{ kind: "telegram", identity: "111" }]);
		expect(String(calls.at(-1)?.body.text)).toContain("vinculada como operador");
	});

	it("spends the code, so a second account cannot ride the same one", async () => {
		await insertPairingCode("dv4k7q2m");
		stubTelegramApi();
		await post(messageUpdate({ from: { id: STRANGER }, text: "/start dv4k7q2m" }), {
			env: unpairedEnv(),
		});

		const calls = stubTelegramApi();
		await post(messageUpdate({ from: { id: 222 }, text: "/start dv4k7q2m" }), {
			env: unpairedEnv(),
		});

		expect(await ownerIdentities()).toEqual([{ kind: "telegram", identity: "111" }]);
		expect(String(calls[0]?.body.text)).toContain("ya se usó");
	});

	it("refuses an expired code", async () => {
		await insertPairingCode("expiredcode", { expiresInMs: -60_000 });
		const calls = stubTelegramApi();
		await post(messageUpdate({ from: { id: STRANGER }, text: "/start expiredcode" }), {
			env: unpairedEnv(),
		});

		expect(await ownerIdentities()).toEqual([]);
		expect(String(calls[0]?.body.text)).toContain("caducado");
	});

	it("refuses a code that was already consumed", async () => {
		await insertPairingCode("spentcode", { consumedAt: new Date().toISOString() });
		const calls = stubTelegramApi();
		await post(messageUpdate({ from: { id: STRANGER }, text: "/start spentcode" }), {
			env: unpairedEnv(),
		});

		expect(await ownerIdentities()).toEqual([]);
		expect(String(calls[0]?.body.text)).toContain("ya se usó");
	});

	it("refuses a code nobody minted", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ from: { id: STRANGER }, text: "/start madeitup" }), {
			env: unpairedEnv(),
		});

		expect(await ownerIdentities()).toEqual([]);
		expect(String(calls[0]?.body.text)).toContain("no existe");
	});

	// /help must stay a question. A command that answers "who am I" should never be
	// able to change who you are, whatever it carries after the space.
	it("does not pair through /help", async () => {
		await insertPairingCode("helpcode");
		const calls = stubTelegramApi();
		await post(messageUpdate({ from: { id: STRANGER }, text: "/help helpcode" }), {
			env: unpairedEnv(),
		});

		expect(await ownerIdentities()).toEqual([]);
		expect(String(calls[0]?.body.text)).toContain("todavía no está autorizado");
	});

	// The bootstrap variable is the door that does not depend on the database.
	it("still honours TELEGRAM_ALLOWED_USER_IDS with an empty registry", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ text: "/start" }));

		expect(await ownerIdentities()).toEqual([]);
		expect(String(calls.at(-1)?.body.text)).toContain("recibirá el correo nuevo");
	});
});
