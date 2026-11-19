import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "#/server";
import { deriveWebhookSecret } from "#/telegram/api";
import { IDENTITY_COMMAND_NAMES, RETRIEVAL_COMMANDS, TELEGRAM_COMMANDS } from "#/telegram/commands";
import { flushTelegramDigest, writeQuietHours } from "#/telegram/noise";
import { deliverInboundNotification } from "#/telegram/notify";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationLinkIndex from "../../migrations/d1/0013_telegram_links_message_index.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import migrationTelegramTopicName from "../../migrations/d1/0020_telegram_topic_name.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * The Telegram bridge against a real mailbox Durable Object: sensitive mail kept
 * out of every surface (the DO's own classification, not a guess from the
 * snippet), conversation-wide card actions, and the command vocabulary.
 */

const testEnv = env as unknown as Env;
const BOT_TOKEN = "123:fake-token";
const ALLOWED_USER = "424242";
const CHAT_ID = "999";
const MAILBOX_ID = "mbx_ux";
const ORIGIN = "https://reccado.example";
const THREAD_ID = "thread_ux";
const OLD_MESSAGE = "msg_ux_old";
const NEW_MESSAGE = "msg_ux_new";
const OTP_THREAD = "thread_ux_otp";
const OTP_MESSAGE = "msg_ux_otp";
const OTP_CODE = "482913";
const NEW_CARD = 8100;
const OLD_CARD = 8099;
const OTP_CARD = 8200;

let SECRET = "";

async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

async function index(input: {
	messageLocalId: string;
	threadId: string;
	subject: string;
	snippet: string;
	receivedAt: string;
}): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO message_index
     (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
      received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
     VALUES (?, ?, ?, NULL, ?, 'cliente@example.com', '["hola@imsanti.dev"]', ?, ?, 0, '[]', 'inbox', 'raw/1', 'sha', ?)`,
	)
		.bind(
			MAILBOX_ID,
			input.messageLocalId,
			input.threadId,
			input.subject,
			input.snippet,
			input.receivedAt,
			input.receivedAt,
		)
		.run();
}

async function link(messageId: number, threadId: string, messageLocalId: string, at: string) {
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO telegram_links
     (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
	)
		.bind(CHAT_ID, messageId, MAILBOX_ID, threadId, messageLocalId, at)
		.run();
}

/**
 * Three inbound messages: a two-message conversation, and a one-time code the DO
 * classified at ingest. The code's snippet is deliberately innocuous, so only the
 * DO's verdict can be what hides it.
 */
async function seedDurableObject(): Promise<void> {
	const stub = testEnv.MAILBOX_DO.getByName(MAILBOX_ID);
	await runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql;
		const now = new Date().toISOString();
		for (const [thread, count] of [
			[THREAD_ID, 2],
			[OTP_THREAD, 1],
		] as const) {
			sql.exec(
				`INSERT OR REPLACE INTO threads
         (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, 'x', ?, ?, ?, ?, ?)`,
				thread,
				now,
				count,
				count,
				now,
				now,
			);
		}
		const insert = (
			id: string,
			thread: string,
			subject: string,
			body: string,
			receivedAt: string,
			sensitiveKind: string | null,
		) => {
			sql.exec(
				`INSERT OR REPLACE INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction,
          state, from_addr, to_json, cc_json, bcc_json, subject, snippet, date_header, received_at,
          raw_r2_key, raw_sha256, raw_size, body_text, sensitive_kind, sensitive_classified,
          parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, '[]', 'inbound', 'inbox', 'cliente@example.com',
                 '["hola@imsanti.dev"]', '[]', '[]', ?, 'resumen', NULL, ?, 'raw/1', 'sha', 10,
                 ?, ?, 1, 'parsed', 0, 0, ?, ?)`,
				id,
				`ingest:${id}`,
				thread,
				subject,
				receivedAt,
				body,
				sensitiveKind,
				now,
				now,
			);
			sql.exec(
				`INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text)
         VALUES (?, ?, 'cliente@example.com', 'hola@imsanti.dev', 'resumen', ?)`,
				id,
				subject,
				body,
			);
		};
		insert(
			OLD_MESSAGE,
			THREAD_ID,
			"Propuesta",
			"Primera versión.",
			"2026-11-01T09:00:00.000Z",
			null,
		);
		insert(
			NEW_MESSAGE,
			THREAD_ID,
			"Re: Propuesta",
			"Segunda versión.",
			"2026-11-01T10:00:00.000Z",
			null,
		);
		insert(
			OTP_MESSAGE,
			OTP_THREAD,
			`Acceso ${OTP_CODE}`,
			`Introduce ${OTP_CODE} para entrar.`,
			"2026-11-01T11:00:00.000Z",
			"otp",
		);
	});
}

async function inboxStates(): Promise<Array<{ id: string; state: string; is_read: number }>> {
	const stub = testEnv.MAILBOX_DO.getByName(MAILBOX_ID);
	return runInDurableObject(stub, async (_instance, state) =>
		state.storage.sql
			.exec<{ id: string; state: string; is_read: number }>(
				"SELECT id, state, is_read FROM messages WHERE thread_id = ? ORDER BY id",
				THREAD_ID,
			)
			.toArray(),
	);
}

beforeAll(async () => {
	for (const migration of [
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
		migrationTelegram,
		migrationApprovals,
		migrationOutbound,
		migrationRuntimeConfig,
		migrationTelegramTopics,
		migrationTelegramTopicName,
		migrationOwnerRegistry,
		migrationLinkIndex,
		migrationExperience,
	]) {
		await applyMigration(migration as string);
	}
	SECRET = await deriveWebhookSecret(BOT_TOKEN);
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
     VALUES (?, 'hola@imsanti.dev', 'Hola', 'active', ?, ?)`,
	)
		.bind(MAILBOX_ID, now, now)
		.run();
	for (const [key, value] of [
		["telegram.chat_id", CHAT_ID],
		["deployment.origin", ORIGIN],
	] as const) {
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		)
			.bind(key, value, now)
			.run();
	}
	await index({
		messageLocalId: OLD_MESSAGE,
		threadId: THREAD_ID,
		subject: "Propuesta",
		snippet: "Primera versión.",
		receivedAt: "2026-11-01T09:00:00.000Z",
	});
	await index({
		messageLocalId: NEW_MESSAGE,
		threadId: THREAD_ID,
		subject: "Re: Propuesta",
		snippet: "Segunda versión.",
		receivedAt: "2026-11-01T10:00:00.000Z",
	});
	await index({
		messageLocalId: OTP_MESSAGE,
		threadId: OTP_THREAD,
		subject: `Acceso ${OTP_CODE}`,
		snippet: `Introduce ${OTP_CODE} para entrar.`,
		receivedAt: "2026-11-01T11:00:00.000Z",
	});
	await seedDurableObject();
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare("DELETE FROM telegram_links").run();
	await link(OLD_CARD, THREAD_ID, OLD_MESSAGE, "2026-11-01T09:00:01.000Z");
	await link(NEW_CARD, THREAD_ID, NEW_MESSAGE, "2026-11-01T10:00:01.000Z");
	await link(OTP_CARD, OTP_THREAD, OTP_MESSAGE, "2026-11-01T11:00:01.000Z");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type BotCall = { method: string; body: Record<string, unknown> };

function stubTelegramApi(): BotCall[] {
	const calls: BotCall[] = [];
	let next = 9000;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		const body =
			init?.body instanceof FormData
				? Object.fromEntries(init.body.entries())
				: (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
		calls.push({ method: url.split("/").pop() ?? "", body });
		next += 1;
		return Response.json({
			ok: true,
			result: { message_id: next, chat: { id: Number(CHAT_ID), type: "private" } },
		});
	});
	return calls;
}

function telegramEnv(): Env {
	return {
		...testEnv,
		TELEGRAM_BOT_TOKEN: BOT_TOKEN,
		TELEGRAM_ALLOWED_USER_IDS: ALLOWED_USER,
	} as Env;
}

let updateId = 50_000;

async function post(update: Record<string, unknown>): Promise<void> {
	updateId += 1;
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request("https://reccado.test/telegram/webhook", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": SECRET,
			},
			body: JSON.stringify({ update_id: updateId, ...update }),
		}),
		telegramEnv(),
		ctx,
	);
	await waitOnExecutionContext(ctx);
	expect(response.status).toBe(200);
}

function message(text: string, extra: Record<string, unknown> = {}) {
	return {
		message: {
			message_id: updateId + 1,
			chat: { id: Number(CHAT_ID), type: "private" },
			from: { id: Number(ALLOWED_USER) },
			text,
			...extra,
		},
	};
}

function press(data: string, messageId: number) {
	return {
		callback_query: {
			id: `cb-${updateId}`,
			from: { id: Number(ALLOWED_USER) },
			data,
			message: { message_id: messageId, chat: { id: Number(CHAT_ID), type: "private" } },
		},
	};
}

describe("sensitive mail, judged by the Durable Object", () => {
	it("a new card hides the excerpt and masks the code even when the snippet looks harmless", async () => {
		const calls = stubTelegramApi();
		await deliverInboundNotification(telegramEnv(), {
			mailboxId: MAILBOX_ID,
			mailboxAddress: "hola@imsanti.dev",
			messageLocalId: OTP_MESSAGE,
			threadId: OTP_THREAD,
			subject: `Acceso ${OTP_CODE}`,
			fromAddr: "cliente@example.com",
			snippet: `Introduce ${OTP_CODE} para entrar.`,
			hasAttachments: false,
		});
		const card = calls.find((call) => call.method === "sendMessage");
		expect(JSON.stringify(card)).not.toContain(OTP_CODE);
		expect(String(card?.body.text)).toContain("Contenido sensible oculto");
	});

	it("'Leer completo' refuses and posts nothing", async () => {
		const calls = stubTelegramApi();
		await post(press("v1:x", OTP_CARD));
		expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"]);
		expect(JSON.stringify(calls)).not.toContain(OTP_CODE);
	});

	it("a search hit is masked like the card it is", async () => {
		const calls = stubTelegramApi();
		await post(message("/buscar Acceso"));
		const sent = calls.filter((call) => call.method === "sendMessage");
		expect(sent.length).toBeGreaterThan(0);
		expect(JSON.stringify(sent)).not.toContain(OTP_CODE);
	});

	it("/unread lists the conversation with its subject masked", async () => {
		const calls = stubTelegramApi();
		await post(message("/unread"));
		const text = String(calls.find((call) => call.method === "sendMessage")?.body.text);
		expect(text).toContain("sin leer");
		expect(text).toContain("Re: Propuesta");
		expect(text).toContain("🔒");
		expect(text).not.toContain(OTP_CODE);
		expect(text).toContain(`${ORIGIN}/inbox/${MAILBOX_ID}/${OTP_THREAD}`);
	});

	it("the nightly digest masks the subject of sensitive mail", async () => {
		await testEnv.INDEX_DB.prepare("DELETE FROM telegram_retained").run();
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO telegram_retained
       (id, chat_id, mailbox_id, mailbox_address, message_local_id, thread_id, from_addr, retained_at, digest_at)
       VALUES ('ret_otp', ?, ?, 'hola@imsanti.dev', ?, ?, 'cliente@example.com', ?, NULL)`,
		)
			.bind(CHAT_ID, MAILBOX_ID, OTP_MESSAGE, OTP_THREAD, new Date().toISOString())
			.run();
		await writeQuietHours(testEnv.INDEX_DB, {
			startMinutes: null,
			endMinutes: null,
			utcOffsetMinutes: 0,
		});
		const calls = stubTelegramApi();
		expect((await flushTelegramDigest(telegramEnv())).status).toBe("sent");
		const digest = String(calls.find((call) => call.method === "sendMessage")?.body.text);
		expect(digest).toContain("Acceso");
		expect(digest).not.toContain(OTP_CODE);
	});
});

describe("card actions act on the conversation", () => {
	it("archiving the newest card archives the whole thread and closes both cards", async () => {
		const calls = stubTelegramApi();
		await post(press("v1:a", NEW_CARD));
		expect((await inboxStates()).map((row) => row.state)).toEqual(["archive", "archive"]);
		const edited = calls
			.filter((call) => call.method === "editMessageText")
			.map((call) => call.body.message_id);
		expect(edited.sort()).toEqual([OLD_CARD, NEW_CARD].sort());
		// Archived cards keep only the way to the web.
		for (const edit of calls.filter((call) => call.method === "editMessageText")) {
			expect(JSON.stringify(edit.body.reply_markup)).toContain("↗ Abrir");
			expect(JSON.stringify(edit.body.reply_markup)).not.toContain("callback_data");
		}
	});
});

describe("commands", () => {
	it("an unknown command written as a reply to a card never becomes a draft", async () => {
		const calls = stubTelegramApi();
		await post(
			message("/archivar ya", {
				reply_to_message: {
					message_id: NEW_CARD,
					chat: { id: Number(CHAT_ID), type: "private" },
				},
			}),
		);
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.body.text)).toContain("Comando desconocido");
		expect(String(calls[0]?.body.text)).toContain("/help");
		const drafts = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(MAILBOX_ID),
			async (_instance, state) =>
				state.storage.sql.exec("SELECT id FROM outbound_drafts").toArray().length,
		);
		expect(drafts).toBe(0);
	});

	it("/help lists every command in the menu", async () => {
		const calls = stubTelegramApi();
		await post(message("/help"));
		const text = String(calls[0]?.body.text);
		for (const command of TELEGRAM_COMMANDS) {
			expect(text).toContain(`/${command.command}`);
		}
	});

	it("the registered menu and the real command set are the same list", () => {
		const menu = new Set(TELEGRAM_COMMANDS.map((command) => command.command));
		const handled = new Set([...RETRIEVAL_COMMANDS, ...IDENTITY_COMMAND_NAMES]);
		expect([...menu].sort()).toEqual([...handled].sort());
	});
});
