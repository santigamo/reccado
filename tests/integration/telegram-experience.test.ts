import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "#/server";
import { deriveWebhookSecret } from "#/telegram/api";
import { deliverInboundNotification } from "#/telegram/notify";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationLinkIndex from "../../migrations/d1/0013_telegram_links_message_index.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * The three gestures the bridge used to swallow: correcting a draft, going to
 * look for old mail, and doing anything at all with an attachment.
 *
 * Driven through the real webhook and a real mailbox Durable Object, because the
 * claims worth testing are all about two stores agreeing — "the correction landed
 * on the same draft" and "a retrieved card resolves like one that arrived" are
 * both statements about rows, not about rendering.
 */

const testEnv = env as unknown as Env;
const BOT_TOKEN = "123:fake-token";
const ALLOWED_USER = "424242";
const CHAT_ID = "999";
const MAILBOX_ID = "mbx_exp";
const THREAD_ID = "thread_exp";
const PARENT_MESSAGE_ID = "msg_exp_parent";
const SEARCHABLE_MESSAGE_ID = "msg_exp_presupuesto";
const CARD_MESSAGE_ID = 6001;
const ATTACHMENT_R2_KEY = "raw/exp/contrato.pdf";

let SECRET = "";

async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

async function indexMessage(input: {
	messageLocalId: string;
	threadId: string;
	subject: string;
	fromAddr: string;
	hasAttachments?: boolean;
}): Promise<void> {
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO message_index
     (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
      received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, '["hola@imsanti.dev"]', 'un resumen',
             ?, ?, '[]', 'inbox', 'raw/1', 'sha', ?)`,
	)
		.bind(
			MAILBOX_ID,
			input.messageLocalId,
			input.threadId,
			input.subject,
			input.fromAddr,
			now,
			input.hasAttachments ? 1 : 0,
			now,
		)
		.run();
}

/** Two inbound emails inside the mailbox DO, one of them with a file attached. */
async function seedMailboxDurableObject(): Promise<void> {
	const stub = testEnv.MAILBOX_DO.getByName(MAILBOX_ID);
	await runInDurableObject(stub, async (_instance, state) => {
		const sql = state.storage.sql;
		const now = new Date().toISOString();
		sql.exec(
			`INSERT OR REPLACE INTO threads
       (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
       VALUES (?, 'factura de junio', ?, 1, 1, ?, ?)`,
			THREAD_ID,
			now,
			now,
			now,
		);
		const insertMessage = (id: string, subject: string, body: string, hasAttachments: number) => {
			sql.exec(
				`INSERT OR REPLACE INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction,
          state, from_addr, to_json, cc_json, bcc_json, subject, snippet, date_header, received_at,
          raw_r2_key, raw_sha256, raw_size, body_text, parse_status, has_attachments, is_read,
          created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, '[]', 'inbound', 'inbox', 'cliente@example.com',
                 '["hola@imsanti.dev"]', '[]', '[]', ?, 'un resumen', NULL, ?, 'raw/1', 'sha', 10,
                 ?, 'parsed', ?, 0, ?, ?)`,
				id,
				`ingest:${id}`,
				THREAD_ID,
				subject,
				now,
				body,
				hasAttachments,
				now,
				now,
			);
			sql.exec(
				`INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text)
         VALUES (?, ?, 'cliente@example.com', 'hola@imsanti.dev', 'un resumen', ?)`,
				id,
				subject,
				body,
			);
		};
		insertMessage(PARENT_MESSAGE_ID, "Factura de junio", "Adjunto la factura.", 1);
		insertMessage(SEARCHABLE_MESSAGE_ID, "Presupuesto", "El presupuesto de octubre.", 0);
		sql.exec(
			`INSERT OR REPLACE INTO attachments
       (id, message_id, filename, content_type, disposition, content_id, size, sha256, r2_key, created_at)
       VALUES ('att_1', ?, 'contrato.pdf', 'application/pdf', 'attachment', NULL, 240000, 'sha', ?, ?)`,
			PARENT_MESSAGE_ID,
			ATTACHMENT_R2_KEY,
			now,
		);
	});
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
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	)
		.bind(CHAT_ID, now)
		.run();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO telegram_links
     (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
	)
		.bind(CHAT_ID, CARD_MESSAGE_ID, MAILBOX_ID, THREAD_ID, PARENT_MESSAGE_ID, now)
		.run();
	await indexMessage({
		messageLocalId: PARENT_MESSAGE_ID,
		threadId: THREAD_ID,
		subject: "Factura de junio",
		fromAddr: "cliente@example.com",
		hasAttachments: true,
	});
	await indexMessage({
		messageLocalId: SEARCHABLE_MESSAGE_ID,
		threadId: THREAD_ID,
		subject: "Presupuesto",
		fromAddr: "cliente@example.com",
	});
	await seedMailboxDurableObject();
	await testEnv.MAIL_OBJECTS.put(ATTACHMENT_R2_KEY, "%PDF-1.4 fake");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type BotCall = { method: string; body: Record<string, unknown>; form?: FormData };

/**
 * Answers every Bot API call with a fresh message id, so a test can tell which
 * message the bot is talking about afterwards — which is the whole point when the
 * thing under test is "it edited *that* preview".
 */
function stubTelegramApi(): BotCall[] {
	const calls: BotCall[] = [];
	let nextMessageId = 7000;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		const method = url.split("/").pop() ?? "";
		// sendDocument travels as multipart, so there is no JSON body to read.
		const form = init?.body instanceof FormData ? init.body : undefined;
		calls.push({
			method,
			body: form ? {} : (JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>),
			form,
		});
		if (method === "getChat") {
			return Response.json({ ok: true, result: { id: Number(CHAT_ID), type: "private" } });
		}
		nextMessageId += 1;
		return Response.json({
			ok: true,
			result: { message_id: nextMessageId, chat: { id: Number(CHAT_ID), type: "private" } },
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

async function post(body: unknown): Promise<Response> {
	const request = new Request("https://reccado.test/telegram/webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-telegram-bot-api-secret-token": SECRET,
		},
		body: JSON.stringify(body),
	});
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, telegramEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

let updateId = 0;

function messageUpdate(message: Record<string, unknown>): unknown {
	updateId += 1;
	return {
		update_id: updateId,
		message: {
			chat: { id: Number(CHAT_ID), type: "private" },
			from: { id: Number(ALLOWED_USER) },
			...message,
		},
	};
}

async function draftsInMailbox(): Promise<
	Array<{ id: string; body_text: string; status: string }>
> {
	const stub = testEnv.MAILBOX_DO.getByName(MAILBOX_ID);
	return runInDurableObject(stub, async (_instance, state) =>
		state.storage.sql
			.exec<{ id: string; body_text: string; status: string }>(
				"SELECT id, body_text, status FROM outbound_drafts ORDER BY created_at ASC",
			)
			.toArray(),
	);
}

async function draftById(draftId: string): Promise<{ body_text: string; status: string } | null> {
	const drafts = await draftsInMailbox();
	return drafts.find((draft) => draft.id === draftId) ?? null;
}

type ComposedReply = {
	calls: BotCall[];
	previewMessageId: number;
	draftId: string;
	drafts: number;
};

/**
 * Writes a reply and reports which preview it produced and which draft that
 * preview is showing — read back from telegram_drafts, which is the mapping under
 * test rather than an assumption about message ids.
 */
async function composeReply(sourceMessageId: number, text: string): Promise<ComposedReply> {
	const calls = stubTelegramApi();
	await post(
		messageUpdate({
			message_id: sourceMessageId,
			text,
			reply_to_message: {
				message_id: CARD_MESSAGE_ID,
				chat: { id: Number(CHAT_ID), type: "private" },
			},
		}),
	);
	const row = await testEnv.INDEX_DB.prepare(
		`SELECT preview_message_id, draft_id FROM telegram_drafts
     WHERE chat_id = ? AND source_message_id = ?`,
	)
		.bind(CHAT_ID, sourceMessageId)
		.first<{ preview_message_id: number; draft_id: string }>();
	if (!row) throw new Error("no preview was recorded for that reply");
	return {
		calls,
		previewMessageId: row.preview_message_id,
		draftId: row.draft_id,
		drafts: (await draftsInMailbox()).length,
	};
}

describe("editable draft", () => {
	it("applies a correction quoted at the preview to the same draft", async () => {
		const composed = await composeReply(9001, "Te la mando mñana.");
		expect(
			String(composed.calls.find((call) => call.method === "sendMessage")?.body.text),
		).toContain("Borrador listo");

		const calls = stubTelegramApi();
		await post(
			messageUpdate({
				message_id: 9002,
				text: "Te la mando mañana.",
				reply_to_message: {
					message_id: composed.previewMessageId,
					chat: { id: Number(CHAT_ID), type: "private" },
				},
			}),
		);

		// The preview is corrected where it stands, and says so.
		const edit = calls.find((call) => call.method === "editMessageText");
		expect(edit?.body.message_id).toBe(composed.previewMessageId);
		expect(String(edit?.body.text)).toContain("v2");
		expect(String(edit?.body.text)).toContain("Te la mando mañana.");
		// It never used to reach this: replying to a preview hit resolveLink, which
		// only knows telegram_links, and answered "no sé a qué correo responde esto".
		expect(calls.some((call) => String(call.body.text ?? "").includes("No sé a qué correo"))).toBe(
			false,
		);

		// The same draft, corrected — not a second one racing the first to the
		// recipient, and no second Send button under it.
		expect((await draftsInMailbox()).length).toBe(composed.drafts);
		const draft = await draftById(composed.draftId);
		expect(draft?.body_text).toContain("Te la mando mañana.");
		expect(draft?.body_text).not.toContain("mñana");
	});

	it("applies a correction made by editing the original message", async () => {
		const composed = await composeReply(9101, "Te la mando mñana.");

		const calls = stubTelegramApi();
		updateId += 1;
		await post({
			update_id: updateId,
			edited_message: {
				message_id: 9101,
				chat: { id: Number(CHAT_ID), type: "private" },
				from: { id: Number(ALLOWED_USER) },
				text: "Te la mando mañana.",
			},
		});

		const edit = calls.find((call) => call.method === "editMessageText");
		expect(edit?.body.message_id).toBe(composed.previewMessageId);
		expect(String(edit?.body.text)).toContain("v2");
		expect((await draftsInMailbox()).length).toBe(composed.drafts);
		expect((await draftById(composed.draftId))?.body_text).toContain("Te la mando mañana.");
	});

	it("refuses to rewrite a draft that has already gone out", async () => {
		const composed = await composeReply(9201, "Original.");
		const stub = testEnv.MAILBOX_DO.getByName(MAILBOX_ID);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET status = 'sent' WHERE id = ?",
				composed.draftId,
			);
		});

		const calls = stubTelegramApi();
		await post(
			messageUpdate({
				message_id: 9202,
				text: "Demasiado tarde.",
				reply_to_message: {
					message_id: composed.previewMessageId,
					chat: { id: Number(CHAT_ID), type: "private" },
				},
			}),
		);

		expect(String(calls[0]?.body.text)).toContain("ya se envió");
		// The ledger still says what was actually mailed: the DO's updateDraft would
		// have overwritten it without a murmur.
		expect((await draftById(composed.draftId))?.body_text).toContain("Original.");
		// And the mapping is gone, so a second attempt is refused by lookup rather
		// than by luck.
		expect(
			await testEnv.INDEX_DB.prepare(
				"SELECT draft_id FROM telegram_drafts WHERE chat_id = ? AND preview_message_id = ?",
			)
				.bind(CHAT_ID, composed.previewMessageId)
				.first(),
		).toBeNull();
	});
});

describe("search from the chat", () => {
	it("answers with cards that are operable, not with a read-only list", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ message_id: 9301, text: "/buscar presupuesto" }));

		const sends = calls.filter((call) => call.method === "sendMessage");
		expect(String(sends[0]?.body.text)).toContain("Presupuesto");
		// The last message is the control line, so the arrows sit where the thumb is.
		expect(String(sends.at(-1)?.body.text)).toContain("🔎");

		// The card carries a link row, which is the whole difference between showing
		// mail and handing it over.
		const link = await testEnv.INDEX_DB.prepare(
			"SELECT message_id, message_local_id FROM telegram_links WHERE chat_id = ? AND message_local_id = ?",
		)
			.bind(CHAT_ID, SEARCHABLE_MESSAGE_ID)
			.first<{ message_id: number; message_local_id: string }>();
		expect(link?.message_local_id).toBe(SEARCHABLE_MESSAGE_ID);

		// And quoting that retrieved card composes a reply, exactly like quoting a
		// card that arrived on its own.
		const replyCalls = stubTelegramApi();
		await post(
			messageUpdate({
				message_id: 9302,
				text: "Va, lo reviso.",
				reply_to_message: {
					message_id: Number(link?.message_id),
					chat: { id: Number(CHAT_ID), type: "private" },
				},
			}),
		);
		expect(String(replyCalls.at(-1)?.body.text)).toContain("Borrador listo");
	});

	it("puts the unread inbox in the chat as cards, not as a list", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ message_id: 9501, text: "/inbox" }));

		const sends = calls.filter((call) => call.method === "sendMessage");
		expect(sends.length).toBeGreaterThan(0);
		expect(String(sends[0]?.body.text)).toContain("cliente@example.com");
		// Read state lives in the Durable Object and "which email to show" lives in
		// message_index; the command is only right when both were consulted.
		const links = await testEnv.INDEX_DB.prepare(
			"SELECT COUNT(*) AS total FROM telegram_links WHERE chat_id = ? AND message_local_id = ?",
		)
			.bind(CHAT_ID, PARENT_MESSAGE_ID)
			.first<{ total: number }>();
		expect(Number(links?.total)).toBeGreaterThan(0);
	});

	it("says so instead of inventing results", async () => {
		const calls = stubTelegramApi();
		await post(messageUpdate({ message_id: 9401, text: "/buscar zzzznadaaqui" }));
		expect(String(calls[0]?.body.text)).toContain("Sin resultados");
	});
});

describe("attachments, downward", () => {
	it("names the files on the card instead of admitting they exist", async () => {
		const calls = stubTelegramApi();
		await deliverInboundNotification(telegramEnv(), {
			mailboxId: MAILBOX_ID,
			mailboxAddress: "hola@imsanti.dev",
			messageLocalId: PARENT_MESSAGE_ID,
			threadId: THREAD_ID,
			subject: "Factura de junio",
			fromAddr: "cliente@example.com",
			snippet: "un resumen",
			hasAttachments: true,
		});

		const card = calls.find((call) => call.method === "sendMessage");
		expect(String(card?.body.text)).toContain("contrato.pdf (240 KB)");
		expect(String(card?.body.text)).not.toContain("📎 con adjuntos");
		const keyboard = card?.body.reply_markup as {
			inline_keyboard: Array<Array<{ text: string }>>;
		};
		expect(JSON.stringify(keyboard)).toContain("📎 Adjuntos");
	});

	it("delivers the files as documents when the button is pressed", async () => {
		const calls = stubTelegramApi();
		updateId += 1;
		await post({
			update_id: updateId,
			callback_query: {
				id: "cb-att",
				from: { id: Number(ALLOWED_USER) },
				data: "v1:f",
				message: { message_id: CARD_MESSAGE_ID, chat: { id: Number(CHAT_ID), type: "private" } },
			},
		});

		const document = calls.find((call) => call.method === "sendDocument");
		expect(document?.form?.get("chat_id")).toBe(CHAT_ID);
		expect((document?.form?.get("document") as File | null)?.name).toBe("contrato.pdf");
		expect(
			String(calls.find((call) => call.method === "answerCallbackQuery")?.body.text),
		).toContain("1 adjunto");
	});
});
