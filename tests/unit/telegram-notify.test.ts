import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverInboundNotification, type InboundNotificationInput } from "#/telegram/notify";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

const testEnv = env as unknown as Env;
const CHAT_ID = "999";

async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

async function insertMailbox(
	mailboxId: string,
	primaryAddress: string,
	displayName: string | null,
): Promise<void> {
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`,
	)
		.bind(mailboxId, primaryAddress, displayName, now, now)
		.run();
}

async function setRuntimeConfig(key: string, value: string): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	)
		.bind(key, value, new Date().toISOString())
		.run();
}

beforeAll(async () => {
	for (const migration of [
		migrationInitial,
		migrationMessageIndex,
		migrationTelegram,
		migrationRuntimeConfig,
		migrationTelegramTopics,
		migrationExperience,
	]) {
		await applyMigration(migration as string);
	}
	await insertMailbox("mbx_hello", "hello@imsanti.dev", "Hola Santi");
	await insertMailbox("mbx_billing", "billing@imsanti.dev", null);
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare("DELETE FROM telegram_topics").run();
	await testEnv.INDEX_DB.prepare("DELETE FROM telegram_links").run();
	await setRuntimeConfig("telegram.chat_id", CHAT_ID);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type BotCall = { method: string; body: Record<string, unknown> };

/**
 * Records every Bot API call and answers it. `respond` may return null to accept
 * the default success shape, so a test only spells out the calls it cares about.
 */
function stubTelegram(
	respond: (call: BotCall, index: number) => Response | null = () => null,
): BotCall[] {
	const calls: BotCall[] = [];
	let nextTopicId = 100;
	let nextMessageId = 1;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		const call: BotCall = {
			method: url.split("/").pop() ?? "",
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		};
		calls.push(call);
		const override = respond(call, calls.length - 1);
		if (override) return override;
		if (call.method === "createForumTopic") {
			nextTopicId += 1;
			return Response.json({
				ok: true,
				result: { message_thread_id: nextTopicId, name: String(call.body.name) },
			});
		}
		nextMessageId += 1;
		return Response.json({
			ok: true,
			result: { message_id: nextMessageId, chat: { id: Number(CHAT_ID), type: "supergroup" } },
		});
	});
	return calls;
}

function telegramError(errorCode: number, description: string): Response {
	return Response.json({ ok: false, error_code: errorCode, description });
}

function buildEnv(): Env {
	return {
		...testEnv,
		TELEGRAM_BOT_TOKEN: "123:fake-token",
		TELEGRAM_ALLOWED_USER_IDS: "424242",
	} as Env;
}

function notification(overrides: Partial<InboundNotificationInput> = {}): InboundNotificationInput {
	return {
		mailboxId: "mbx_hello",
		mailboxAddress: "hello@imsanti.dev",
		messageLocalId: `msg_${Math.random().toString(36).slice(2)}`,
		threadId: "thread_1",
		subject: "Factura pendiente",
		fromAddr: "sender@example.com",
		snippet: "hola",
		hasAttachments: false,
		...overrides,
	};
}

async function storedTopic(mailboxId: string): Promise<number | null> {
	const row = await testEnv.INDEX_DB.prepare(
		"SELECT topic_id FROM telegram_topics WHERE chat_id = ? AND mailbox_id = ?",
	)
		.bind(CHAT_ID, mailboxId)
		.first<{ topic_id: number }>();
	return row?.topic_id ?? null;
}

describe("inbound notification in a forum chat", () => {
	beforeEach(async () => {
		await setRuntimeConfig("telegram.chat_is_forum", "1");
	});

	it("names the topic after the mailbox, never after the email subject", async () => {
		const calls = stubTelegram();

		await deliverInboundNotification(buildEnv(), notification({ subject: "Factura pendiente" }));

		const created = calls.filter((call) => call.method === "createForumTopic");
		expect(created).toHaveLength(1);
		// The whole point of the change: a topic name is permanent chrome in the
		// operator's sidebar, so it comes from the mailbox he named, not from text a
		// stranger put in a Subject header.
		expect(created[0]?.body.name).toBe("Hola Santi");
		expect(JSON.stringify(created[0]?.body)).not.toContain("Factura pendiente");
		// The subject still belongs in the card itself — it is the message body, which
		// is read once and scrolls away, not a permanent label.
		expect(String(calls.find((call) => call.method === "sendMessage")?.body.text)).toContain(
			"Factura pendiente",
		);
	});

	it("falls back to the mailbox address when it has no display name", async () => {
		const calls = stubTelegram();

		await deliverInboundNotification(
			buildEnv(),
			notification({ mailboxId: "mbx_billing", mailboxAddress: "billing@imsanti.dev" }),
		);

		expect(calls.find((call) => call.method === "createForumTopic")?.body.name).toBe(
			"billing@imsanti.dev",
		);
	});

	it("keeps every email of one mailbox in the same topic, whatever the thread", async () => {
		const calls = stubTelegram();
		const first = await deliverInboundNotification(
			buildEnv(),
			notification({ threadId: "thread_1", subject: "Uno" }),
		);
		const second = await deliverInboundNotification(
			buildEnv(),
			notification({ threadId: "thread_2", subject: "Dos" }),
		);

		expect(first.status).toBe("sent");
		expect(second.status).toBe("sent");
		// One topic, created once: the second email reuses the mapping instead of
		// spending another createForumTopic on a rate-limited path.
		expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(1);
		const sends = calls.filter((call) => call.method === "sendMessage");
		expect(sends).toHaveLength(2);
		expect(sends[0]?.body.message_thread_id).toBe(sends[1]?.body.message_thread_id);
		expect(sends[0]?.body.message_thread_id).toBe(await storedTopic("mbx_hello"));
	});

	it("gives each mailbox its own topic", async () => {
		const calls = stubTelegram();

		await deliverInboundNotification(buildEnv(), notification());
		await deliverInboundNotification(
			buildEnv(),
			notification({ mailboxId: "mbx_billing", mailboxAddress: "billing@imsanti.dev" }),
		);

		expect(calls.filter((call) => call.method === "createForumTopic")).toHaveLength(2);
		const hello = await storedTopic("mbx_hello");
		const billing = await storedTopic("mbx_billing");
		expect(hello).not.toBeNull();
		expect(billing).not.toBeNull();
		expect(hello).not.toBe(billing);
	});

	it("recreates a topic the operator deleted and delivers the card anyway", async () => {
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, created_at) VALUES (?, ?, ?, ?)",
		)
			.bind(CHAT_ID, "mbx_hello", 42, new Date().toISOString())
			.run();

		const calls = stubTelegram((call) =>
			call.method === "sendMessage" && call.body.message_thread_id === 42
				? telegramError(400, "Bad Request: message thread not found")
				: null,
		);

		const outcome = await deliverInboundNotification(buildEnv(), notification());

		expect(outcome.status).toBe("sent");
		expect(calls.map((call) => call.method)).toEqual([
			"sendMessage",
			"createForumTopic",
			"sendMessage",
		]);
		// The stale mapping is gone, replaced by the topic that actually exists.
		const healed = await storedTopic("mbx_hello");
		expect(healed).not.toBe(42);
		expect(calls[2]?.body.message_thread_id).toBe(healed);
		const event = await testEnv.INDEX_DB.prepare(
			"SELECT event_type FROM ops_events WHERE event_type = 'telegram.topic_recreated'",
		).first<{ event_type: string }>();
		expect(event?.event_type).toBe("telegram.topic_recreated");
	});

	it("retries only once, so a failure that is not the topic is not looped on", async () => {
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, created_at) VALUES (?, ?, ?, ?)",
		)
			.bind(CHAT_ID, "mbx_hello", 42, new Date().toISOString())
			.run();

		const calls = stubTelegram((call) =>
			call.method === "sendMessage"
				? telegramError(400, "Bad Request: message thread not found")
				: null,
		);

		await expect(deliverInboundNotification(buildEnv(), notification())).rejects.toThrow(
			/message thread not found/,
		);
		expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(2);
	});

	it("degrades to a plain message when the bot may not create topics", async () => {
		const calls = stubTelegram((call) =>
			call.method === "createForumTopic"
				? telegramError(400, "Bad Request: not enough rights to manage topics")
				: null,
		);

		const outcome = await deliverInboundNotification(buildEnv(), notification());

		expect(outcome.status).toBe("sent");
		expect(calls.at(-1)?.method).toBe("sendMessage");
		expect(calls.at(-1)?.body.message_thread_id).toBeUndefined();
		expect(await storedTopic("mbx_hello")).toBeNull();
		const event = await testEnv.INDEX_DB.prepare(
			"SELECT event_type FROM ops_events WHERE event_type = 'telegram.topic_unavailable'",
		).first<{ event_type: string }>();
		expect(event?.event_type).toBe("telegram.topic_unavailable");
	});

	it("lets the queue retry when the topic could not be created right now", async () => {
		stubTelegram((call) =>
			call.method === "createForumTopic" ? telegramError(429, "Too Many Requests") : null,
		);

		// A rate limit is about the moment, not the request: redelivering costs one
		// retry, whereas degrading would silently demote this mailbox to flat
		// messages for good.
		await expect(deliverInboundNotification(buildEnv(), notification())).rejects.toThrow(
			/Too Many Requests/,
		);
		expect(await storedTopic("mbx_hello")).toBeNull();
	});
});

describe("what the card lets the operator do", () => {
	beforeEach(async () => {
		await setRuntimeConfig("telegram.chat_is_forum", "0");
	});

	function keyboard(call: BotCall | undefined): Array<Array<Record<string, string>>> {
		return (call?.body.reply_markup as { inline_keyboard: Array<Array<Record<string, string>>> })
			?.inline_keyboard;
	}

	it("offers triage, the full body and the web thread", async () => {
		await setRuntimeConfig("deployment.origin", "https://reccado.example");
		const calls = stubTelegram();

		await deliverInboundNotification(
			buildEnv(),
			notification({ threadId: "thread_42", messageLocalId: "msg_42" }),
		);

		// The point of the whole change: most mail is dispatched, not answered, and a
		// card with no buttons served only the fifth that needs a sentence back.
		const buttons = keyboard(calls.find((call) => call.method === "sendMessage"))?.[0];
		expect(buttons?.map((button) => button.callback_data ?? button.url)).toEqual([
			"v1:a",
			"v1:x",
			"https://reccado.example/mailboxes/mbx_hello/thread_42",
		]);
		// No trash button, deliberately: a delete one thumb-width from archive is a
		// machine for mistakes, and the two mistakes do not cost the same.
		expect(JSON.stringify(buttons)).not.toContain("v1:t");
	});

	it("omits the open button rather than painting a broken URL", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key = ?")
			.bind("deployment.origin")
			.run();
		const calls = stubTelegram();

		await deliverInboundNotification(buildEnv(), notification());

		// Nobody has reached this deployment over its public hostname yet, so there is
		// no URL to offer -- and a guessed one would be a dead link on every card.
		const buttons = keyboard(calls.find((call) => call.method === "sendMessage"))?.[0];
		expect(buttons?.map((button) => button.callback_data)).toEqual(["v1:a", "v1:x"]);
	});
});

describe("inbound notification in a chat without topics", () => {
	it("stays on plain messages and never calls createForumTopic", async () => {
		await setRuntimeConfig("telegram.chat_is_forum", "0");
		const calls = stubTelegram();

		const outcome = await deliverInboundNotification(buildEnv(), notification());

		expect(outcome.status).toBe("sent");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("sendMessage");
		expect(calls[0]?.body.message_thread_id).toBeUndefined();
		const link = await testEnv.INDEX_DB.prepare(
			"SELECT topic_id FROM telegram_links WHERE chat_id = ?",
		)
			.bind(CHAT_ID)
			.first<{ topic_id: number | null }>();
		expect(link?.topic_id).toBeNull();
	});

	it("treats a chat never probed by /start as a plain chat", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_is_forum")
			.run();
		const calls = stubTelegram();

		await deliverInboundNotification(buildEnv(), notification());

		expect(calls.every((call) => call.method === "sendMessage")).toBe(true);
	});

	it("skips without touching Telegram when no chat was ever adopted", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config WHERE key = ?")
			.bind("telegram.chat_id")
			.run();
		const calls = stubTelegram();

		const outcome = await deliverInboundNotification(buildEnv(), notification());

		expect(outcome).toEqual({ status: "skipped", reason: "no_chat" });
		expect(calls).toHaveLength(0);
	});
});
