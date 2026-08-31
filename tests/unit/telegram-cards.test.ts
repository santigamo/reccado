import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCardCallback, refreshTelegramCard } from "#/telegram/cards";
import type { TelegramCallbackQuery } from "#/telegram/api";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationLinkIndex from "../../migrations/d1/0013_telegram_links_message_index.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

const testEnv = env as unknown as Env;
const CHAT_ID = "999";
const CARD_MESSAGE_ID = 4242;
const MAILBOX_ID = "mbx_cards";
const MESSAGE_LOCAL_ID = "msg_cards_1";
const THREAD_ID = "thread_cards_1";

async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

beforeAll(async () => {
	for (const migration of [
		migrationInitial,
		migrationMessageIndex,
		migrationTelegram,
		migrationRuntimeConfig,
		migrationTelegramTopics,
		migrationLinkIndex,
		migrationExperience,
	]) {
		await applyMigration(migration as string);
	}
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
     VALUES (?, 'hello@imsanti.dev', 'Hola', 'active', ?, ?)`,
	)
		.bind(MAILBOX_ID, now, now)
		.run();
});

async function seedCard(overrides: { topicId?: number | null } = {}): Promise<void> {
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO telegram_links
     (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			CHAT_ID,
			CARD_MESSAGE_ID,
			MAILBOX_ID,
			THREAD_ID,
			MESSAGE_LOCAL_ID,
			overrides.topicId ?? null,
			now,
		)
		.run();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO message_index
     (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
      received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
     VALUES (?, ?, ?, NULL, 'Factura pendiente', 'sender@example.com', ?, 'hola', ?, 0, '[]', 'inbox', 'raw/1', 'sha', ?)`,
	)
		.bind(MAILBOX_ID, MESSAGE_LOCAL_ID, THREAD_ID, JSON.stringify(["hello@imsanti.dev"]), now, now)
		.run();
}

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare("DELETE FROM telegram_links").run();
	await testEnv.INDEX_DB.prepare("DELETE FROM message_index").run();
	await testEnv.INDEX_DB.prepare("DELETE FROM runtime_config").run();
	await testEnv.INDEX_DB.prepare(
		"INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)",
	)
		.bind(CHAT_ID, new Date().toISOString())
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type BotCall = { method: string; body: Record<string, unknown> };

/**
 * Records the Bot API traffic. sendDocument is multipart rather than JSON, so its
 * parts are flattened into the same shape the JSON calls have — a test should not
 * have to know which transport a method happens to use.
 */
function stubTelegram(): BotCall[] {
	const calls: BotCall[] = [];
	let nextMessageId = 100;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		const method = url.split("/").pop() ?? "";
		const raw = init?.body;
		const body: Record<string, unknown> = {};
		if (raw instanceof FormData) {
			for (const [key, value] of raw.entries()) {
				body[key] = value instanceof File ? { filename: value.name, size: value.size } : value;
			}
		} else if (raw) {
			Object.assign(body, JSON.parse(String(raw)) as Record<string, unknown>);
		}
		calls.push({ method, body });
		nextMessageId += 1;
		return Response.json({
			ok: true,
			result: { message_id: nextMessageId, chat: { id: Number(CHAT_ID), type: "private" } },
		});
	});
	return calls;
}

type DoCall = { url: string; method: string; body: Record<string, unknown> | null };

/** The mailbox DO, reduced to the two things a card button asks of it. */
function buildEnv(bodyText: string | null): { env: Env; doCalls: DoCall[] } {
	const doCalls: DoCall[] = [];
	const stub = {
		fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			doCalls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
			});
			if (url.endsWith("/actions")) {
				return Response.json({ ok: true });
			}
			return Response.json({
				message:
					bodyText === null
						? {}
						: {
								id: MESSAGE_LOCAL_ID,
								subject: "Factura pendiente",
								from_addr: "sender@example.com",
								date_header: null,
								received_at: new Date().toISOString(),
								body_text: bodyText,
							},
			});
		},
	};
	return {
		env: {
			...testEnv,
			TELEGRAM_BOT_TOKEN: "123:fake-token",
			MAILBOX_DO: { getByName: () => stub },
			MAILBOX_JURISDICTION: "none",
		} as unknown as Env,
		doCalls,
	};
}

function press(
	data: string,
	overrides: Partial<TelegramCallbackQuery> = {},
): TelegramCallbackQuery {
	return {
		id: "cb1",
		from: { id: 424242 },
		data,
		message: {
			message_id: CARD_MESSAGE_ID,
			chat: { id: Number(CHAT_ID), type: "private" },
		},
		...overrides,
	};
}

const config = { botToken: "123:fake-token" };

describe("card triage buttons", () => {
	beforeEach(seedCard);

	it("archives through the DO, closes the card and answers the press", async () => {
		const calls = stubTelegram();
		const { env: cardEnv, doCalls } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:a"));

		// The action is a real state change in the mailbox, not a cosmetic edit.
		expect(doCalls).toEqual([
			{
				url: `https://mailbox-do/messages/${MESSAGE_LOCAL_ID}/actions`,
				method: "POST",
				body: { action: "archive" },
			},
		]);
		const edit = calls.find((call) => call.method === "editMessageText");
		expect(edit?.body.message_id).toBe(CARD_MESSAGE_ID);
		expect(String(edit?.body.text)).toContain("· archivado");
		// Archived mail is dealt with; buttons under it would only invite a second
		// decision about a settled one.
		expect(edit?.body.reply_markup).toBeUndefined();
		// Without this Telegram leaves the button spinning until it times out.
		const answer = calls.find((call) => call.method === "answerCallbackQuery");
		expect(answer?.body.text).toBe("Archivado");
	});

	it("needs no token table: the pressed message is the address", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		// Two bytes of payload, well inside the Bot API's 64-byte cap, and no row is
		// written when the card is posted or read when it is pressed.
		await handleCardCallback(cardEnv, config, press("v1:a"));

		expect(String(calls.find((call) => call.method === "editMessageText")?.body.text)).toContain(
			"Factura pendiente",
		);
		const actions = await testEnv.INDEX_DB.prepare(
			"SELECT COUNT(*) AS n FROM telegram_actions",
		).first<{ n: number }>();
		expect(actions?.n).toBe(0);
	});

	it("says so instead of acting when the card belongs to no known email", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM telegram_links").run();
		const calls = stubTelegram();
		const { env: cardEnv, doCalls } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:a"));

		expect(doCalls).toHaveLength(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("answerCallbackQuery");
	});

	it("posts the full body under the card and marks the email read", async () => {
		const calls = stubTelegram();
		const { env: cardEnv, doCalls } = buildEnv("Primera línea\n\nSegunda línea");

		await handleCardCallback(cardEnv, config, press("v1:x"));

		const sent = calls.filter((call) => call.method === "sendMessage");
		expect(sent).toHaveLength(1);
		expect(String(sent[0]?.body.text)).toContain("Segunda línea");
		// Anchored to the card, so the body is readable next to what it belongs to.
		expect(sent[0]?.body.reply_parameters).toEqual({
			message_id: CARD_MESSAGE_ID,
			allow_sending_without_reply: true,
		});
		// Pressing a button is the explicit act the card's own argument asked for, so
		// reading in Telegram finally counts as reading.
		expect(doCalls.at(-1)?.body).toEqual({ action: "mark_read" });
		expect(String(calls.find((call) => call.method === "editMessageText")?.body.text)).toContain(
			"· leído",
		);
	});

	it("splits a long body into messages Telegram will accept", async () => {
		const calls = stubTelegram();
		const paragraph = `${"palabra ".repeat(500)}\n\n`;
		const { env: cardEnv } = buildEnv(paragraph.repeat(2));

		await handleCardCallback(cardEnv, config, press("v1:x"));

		const sent = calls.filter((call) => call.method === "sendMessage");
		expect(sent.length).toBeGreaterThan(1);
		for (const call of sent) {
			expect(String(call.body.text).length).toBeLessThanOrEqual(4096);
		}
	});

	it("sends a body too long to read in a chat as a file instead", async () => {
		const calls = stubTelegram();
		const body = "línea de texto larguísima.".repeat(2000);
		const { env: cardEnv } = buildEnv(body);

		await handleCardCallback(cardEnv, config, press("v1:x"));

		// Four screens of quoted newsletter is not a conversation, and posting it
		// would spend the chat's whole rate-limit budget to be unreadable.
		expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);
		const document = calls.find((call) => call.method === "sendDocument");
		expect(document?.body.document).toMatchObject({ filename: `${MESSAGE_LOCAL_ID}.txt` });
		expect(String(document?.body.caption)).toContain(String(body.length));
	});

	it("keeps the body inside the topic the mailbox lives in", async () => {
		await seedCard({ topicId: 7 });
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:x"));

		expect(calls.find((call) => call.method === "sendMessage")?.body.message_thread_id).toBe(7);
	});

	it("ignores callback data that is not a card verb", async () => {
		const calls = stubTelegram();
		const { env: cardEnv, doCalls } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:zz"));

		expect(doCalls).toHaveLength(0);
		expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
	});
});

describe("reconciliation from another surface", () => {
	beforeEach(seedCard);

	it("restates the card when the email is archived elsewhere", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		const outcome = await refreshTelegramCard(cardEnv, {
			mailboxId: MAILBOX_ID,
			messageLocalId: MESSAGE_LOCAL_ID,
			threadId: null,
			status: "archived",
		});

		expect(outcome).toEqual({ status: "edited" });
		const edit = calls.find((call) => call.method === "editMessageText");
		expect(edit?.body.message_id).toBe(CARD_MESSAGE_ID);
		expect(String(edit?.body.text)).toContain("· archivado");
		// The edit reproduces the card rather than rewriting it: same sender, same
		// subject, same snippet, one line more.
		expect(String(edit?.body.text)).toContain("Factura pendiente");
		expect(String(edit?.body.text)).toContain("sender@example.com");
	});

	it("marks the newest card of a thread when a reply goes out elsewhere", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		const outcome = await refreshTelegramCard(cardEnv, {
			mailboxId: MAILBOX_ID,
			messageLocalId: null,
			threadId: THREAD_ID,
			status: "replied",
		});

		expect(outcome).toEqual({ status: "edited" });
		expect(String(calls.find((call) => call.method === "editMessageText")?.body.text)).toContain(
			"· respondido",
		);
	});

	it("treats an edit Telegram considers a no-op as done, not as a failure", async () => {
		vi.stubGlobal("fetch", async () =>
			Response.json({
				ok: false,
				error_code: 400,
				description: "Bad Request: message is not modified",
			}),
		);
		const { env: cardEnv } = buildEnv("cuerpo");

		// Two surfaces agreeing on the state is the ordinary case, and retrying an
		// edit that can only be refused again would spend the chat's budget on it.
		await expect(
			refreshTelegramCard(cardEnv, {
				mailboxId: MAILBOX_ID,
				messageLocalId: MESSAGE_LOCAL_ID,
				threadId: null,
				status: "archived",
			}),
		).resolves.toEqual({ status: "unchanged" });
	});

	it("skips without touching Telegram when the email was never announced", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		const outcome = await refreshTelegramCard(cardEnv, {
			mailboxId: MAILBOX_ID,
			messageLocalId: "msg_never_notified",
			threadId: null,
			status: "archived",
		});

		expect(outcome).toEqual({ status: "skipped", reason: "no_card" });
		expect(calls).toHaveLength(0);
	});

	it("skips when the bridge has no chat to edit in", async () => {
		await testEnv.INDEX_DB.prepare(
			"DELETE FROM runtime_config WHERE key = 'telegram.chat_id'",
		).run();
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		const outcome = await refreshTelegramCard(cardEnv, {
			mailboxId: MAILBOX_ID,
			messageLocalId: MESSAGE_LOCAL_ID,
			threadId: null,
			status: "archived",
		});

		expect(outcome).toEqual({ status: "skipped", reason: "no_chat" });
		expect(calls).toHaveLength(0);
	});
});
