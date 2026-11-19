import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramCallbackQuery } from "#/telegram/api";
import { handleCardCallback, refreshTelegramCard } from "#/telegram/cards";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationLinkIndex from "../../migrations/d1/0013_telegram_links_message_index.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import migrationTelegramTopicName from "../../migrations/d1/0020_telegram_topic_name.sql?raw";
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
		migrationApprovals,
		migrationRuntimeConfig,
		migrationTelegramTopics,
		migrationTelegramTopicName,
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

/** The mailbox DO, reduced to the things a card button asks of it. */
function buildEnv(
	bodyText: string | null,
	message: Record<string, unknown> = {},
	envOverrides: Record<string, unknown> = {},
): { env: Env; doCalls: DoCall[] } {
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
			if (url.endsWith("/bulk-actions")) {
				return Response.json({ action: "archive", changed: [] });
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
								...message,
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
			...envOverrides,
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

		// The action is a real state change in the mailbox, not a cosmetic edit -- and
		// it is the web's conversation action, not a one-message archive.
		expect(doCalls.filter((call) => call.method === "POST")).toEqual([
			{
				url: "https://mailbox-do/bulk-actions",
				method: "POST",
				body: { action: "archive", target: { threadIds: [THREAD_ID], scope: "live" } },
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
		expect(answer?.body.text).toBe("Conversación archivada");
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
		const actions = await testEnv.INDEX_DB.prepare("SELECT COUNT(*) AS n FROM approvals").first<{
			n: number;
		}>();
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
		expect(doCalls.filter((call) => call.method === "POST").at(-1)?.body).toEqual({
			action: "mark_read",
		});
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

const ORIGIN = "https://reccado.example";
const OLDER_CARD_ID = 4241;
const OLDER_MESSAGE_ID = "msg_cards_0";

async function setOrigin(): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', ?, ?)",
	)
		.bind(ORIGIN, new Date().toISOString())
		.run();
}

/** An earlier email of the same conversation, with its own card above the newest one. */
async function seedOlderCard(): Promise<void> {
	const earlier = new Date(Date.now() - 3_600_000).toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO telegram_links
     (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
	)
		.bind(CHAT_ID, OLDER_CARD_ID, MAILBOX_ID, THREAD_ID, OLDER_MESSAGE_ID, earlier)
		.run();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO message_index
     (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
      received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
     VALUES (?, ?, ?, NULL, 'Factura pendiente', 'sender@example.com', ?, 'antes', ?, 0, '[]', 'inbox', 'raw/0', 'sha', ?)`,
	)
		.bind(
			MAILBOX_ID,
			OLDER_MESSAGE_ID,
			THREAD_ID,
			JSON.stringify(["hello@imsanti.dev"]),
			earlier,
			earlier,
		)
		.run();
}

type Keyboard = Array<Array<{ text: string; callback_data?: string; url?: string }>>;

function keyboardOf(call: BotCall | undefined): Keyboard {
	return ((call?.body.reply_markup as { inline_keyboard?: Keyboard } | undefined)
		?.inline_keyboard ?? []) as Keyboard;
}

describe("sensitive mail never reaches the chat", () => {
	beforeEach(seedCard);

	const OTP_BODY = "Tu código de verificación es 482913. Caduca en 5 minutos.";

	it("refuses 'Leer completo' for a message the DO classified as a one-time code", async () => {
		const calls = stubTelegram();
		const { env: cardEnv, doCalls } = buildEnv(OTP_BODY, {
			sensitive_kind: "otp",
			sensitive_classified: 1,
		});

		await handleCardCallback(cardEnv, config, press("v1:x"));

		expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
		expect(String(calls[0]?.body.text)).toContain("sensible");
		expect(JSON.stringify(calls)).not.toContain("482913");
		// Not marked read either: nothing was read.
		expect(doCalls.filter((call) => call.method === "POST")).toHaveLength(0);
	});

	it("refuses when the DO never classified the row but its body is a code (fail closed)", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv(OTP_BODY, { sensitive_classified: 0 });

		await handleCardCallback(cardEnv, config, press("v1:x"));

		expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
		expect(JSON.stringify(calls)).not.toContain("482913");
	});

	it("refuses an HTML-only row it cannot judge", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("", {
			body_text: null,
			body_html_r2_key: "html/1",
			sensitive_classified: 0,
		});

		await handleCardCallback(cardEnv, config, press("v1:x"));

		expect(String(calls.at(-1)?.body.text)).toContain("sensible");
	});

	it("never publishes this instance's own sign-in mail, even when classification missed it", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv(
			"Sign-in code: 731942",
			{ sensitive_kind: null, sensitive_classified: 1, from_addr: "noreply@send.example" },
			{ MAIL_FROM_ADDRESS: "noreply@send.example" },
		);

		await handleCardCallback(cardEnv, config, press("v1:x"));

		expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
		expect(JSON.stringify(calls)).not.toContain("731942");
	});

	it("recognises the instance's sign-in template by its subject too", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("Sign-in code: 731942", {
			subject: "Your Reccado sign-in code",
			sensitive_kind: null,
			sensitive_classified: 1,
		});

		await handleCardCallback(cardEnv, config, press("v1:x"));

		expect(JSON.stringify(calls)).not.toContain("731942");
	});

	it("refuses the attachments of a sensitive email", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv(OTP_BODY, {
			sensitive_kind: "otp",
			sensitive_classified: 1,
			attachments: [
				{ id: "a", filename: "code.pdf", content_type: "application/pdf", size: 10, r2_key: "k" },
			],
		});

		await handleCardCallback(cardEnv, config, press("v1:f"));

		expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
		expect(String(calls[0]?.body.text)).toContain("sensible");
	});

	it("restates a sensitive card without its excerpt, with a masked subject and no body button", async () => {
		await testEnv.INDEX_DB.prepare(
			"UPDATE message_index SET subject = 'Your code is 482913', snippet = ? WHERE message_local_id = ?",
		)
			.bind(OTP_BODY, MESSAGE_LOCAL_ID)
			.run();
		await setOrigin();
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv(OTP_BODY, { sensitive_kind: "otp", sensitive_classified: 1 });

		await refreshTelegramCard(cardEnv, {
			mailboxId: MAILBOX_ID,
			messageLocalId: MESSAGE_LOCAL_ID,
			threadId: null,
			status: "read",
		});

		const edit = calls.find((call) => call.method === "editMessageText");
		const text = String(edit?.body.text);
		expect(text).not.toContain("482913");
		expect(text).toContain("Contenido sensible oculto");
		expect(text).toContain("sender@example.com");
		const data = keyboardOf(edit)
			.flat()
			.map((button) => button.callback_data ?? button.url);
		expect(data).not.toContain("v1:x");
		expect(data).toContain(`${ORIGIN}/inbox/${MAILBOX_ID}/${THREAD_ID}`);
	});
});

describe("conversation actions from a card", () => {
	beforeEach(async () => {
		await seedCard();
		await seedOlderCard();
		await setOrigin();
	});

	it("archives the whole thread and closes every card of it, keeping 'Abrir'", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:a"));

		const edits = calls.filter((call) => call.method === "editMessageText");
		expect(edits.map((edit) => edit.body.message_id).sort()).toEqual(
			[OLDER_CARD_ID, CARD_MESSAGE_ID].sort(),
		);
		for (const edit of edits) {
			expect(String(edit.body.text)).toContain("· archivado");
			expect(keyboardOf(edit)).toEqual([
				[{ text: "↗ Abrir", url: `${ORIGIN}/inbox/${MAILBOX_ID}/${THREAD_ID}` }],
			]);
		}
	});

	it("'Leído' marks the conversation read and drops itself from the card", async () => {
		const calls = stubTelegram();
		const { env: cardEnv, doCalls } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:r"));

		expect(doCalls.find((call) => call.method === "POST")?.body).toEqual({
			action: "mark_read",
			target: { threadIds: [THREAD_ID], scope: "live" },
		});
		const newest = calls.find(
			(call) => call.method === "editMessageText" && call.body.message_id === CARD_MESSAGE_ID,
		);
		expect(String(newest?.body.text)).toContain("· leído");
		const data = keyboardOf(newest)
			.flat()
			.map((button) => button.callback_data ?? button.url);
		expect(data).toContain("v1:a");
		expect(data).not.toContain("v1:r");
		expect(calls.find((call) => call.method === "answerCallbackQuery")?.body.text).toBe(
			"Conversación marcada como leída",
		);
	});

	it("keeps an older card of the thread superseded: only 'Abrir' survives", async () => {
		const calls = stubTelegram();
		const { env: cardEnv } = buildEnv("cuerpo");

		await handleCardCallback(cardEnv, config, press("v1:r"));

		const older = calls.find(
			(call) => call.method === "editMessageText" && call.body.message_id === OLDER_CARD_ID,
		);
		expect(String(older?.body.text)).toContain("más reciente");
		expect(keyboardOf(older)).toEqual([
			[{ text: "↗ Abrir", url: `${ORIGIN}/inbox/${MAILBOX_ID}/${THREAD_ID}` }],
		]);
	});
});
