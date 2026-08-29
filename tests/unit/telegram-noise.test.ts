import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readTelegramConfig } from "#/telegram/api";
import { handleDigestExpand } from "#/telegram/cards";
import {
	flushTelegramDigest,
	isWithinQuietHours,
	parseQuietHours,
	toggleSenderMute,
	writeQuietHours,
} from "#/telegram/noise";
import { deliverInboundNotification, type InboundNotificationInput } from "#/telegram/notify";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * What a public catch-all does to a chat, and the three answers to it: a sender
 * that stops interrupting without stopping being stored, a badge for mail from
 * someone nobody has heard from, and a night that arrives as one summary instead
 * of forty cards.
 */

const testEnv = env as unknown as Env;
const CHAT_ID = "999";
const MAILBOX_ID = "mbx_noise";

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
		migrationExperience,
	]) {
		await applyMigration(migration as string);
	}
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
     VALUES (?, 'hola@imsanti.dev', 'Hola', 'active', ?, ?)`,
	)
		.bind(MAILBOX_ID, now, now)
		.run();
});

beforeEach(async () => {
	for (const table of [
		"telegram_links",
		"telegram_retained",
		"telegram_muted_senders",
		"telegram_settings",
		"message_index",
	]) {
		await testEnv.INDEX_DB.prepare(`DELETE FROM ${table}`).run();
	}
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	)
		.bind(CHAT_ID, new Date().toISOString())
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type BotCall = { method: string; body: Record<string, unknown> };

function stubTelegram(): BotCall[] {
	const calls: BotCall[] = [];
	let nextMessageId = 500;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		calls.push({
			method: url.split("/").pop() ?? "",
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		nextMessageId += 1;
		return Response.json({
			ok: true,
			result: { message_id: nextMessageId, chat: { id: Number(CHAT_ID), type: "private" } },
		});
	});
	return calls;
}

function buildEnv(): Env {
	return { ...testEnv, TELEGRAM_BOT_TOKEN: "123:fake-token" } as Env;
}

async function indexMessage(
	messageLocalId: string,
	fromAddr: string,
	receivedAt = new Date().toISOString(),
): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO message_index
     (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
      received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
     VALUES (?, ?, ?, NULL, 'Factura', ?, '["hola@imsanti.dev"]', 'hola',
             ?, 0, '[]', 'inbox', 'raw/1', 'sha', ?)`,
	)
		.bind(MAILBOX_ID, messageLocalId, `thread_${messageLocalId}`, fromAddr, receivedAt, receivedAt)
		.run();
}

function notification(overrides: Partial<InboundNotificationInput> = {}): InboundNotificationInput {
	return {
		mailboxId: MAILBOX_ID,
		mailboxAddress: "hola@imsanti.dev",
		messageLocalId: "msg_1",
		threadId: "thread_msg_1",
		subject: "Factura",
		fromAddr: "ruido@example.com",
		snippet: "hola",
		hasAttachments: false,
		...overrides,
	};
}

/** A window that certainly contains this instant, wrap-around included. */
function windowAround(now: Date, offsetStart: number, offsetEnd: number) {
	const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
	return {
		startMinutes: (((minutes + offsetStart) % 1440) + 1440) % 1440,
		endMinutes: (((minutes + offsetEnd) % 1440) + 1440) % 1440,
		utcOffsetMinutes: 0,
	};
}

describe("muted senders", () => {
	it("stops the card without stopping the mail", async () => {
		await indexMessage("msg_1", "ruido@example.com");
		await toggleSenderMute(testEnv.INDEX_DB, {
			sender: "Ruido@Example.com",
			mutedBy: "424242",
		});

		const calls = stubTelegram();
		const outcome = await deliverInboundNotification(buildEnv(), notification());

		expect(outcome).toEqual({ status: "skipped", reason: "muted_sender" });
		// Nothing was said to Telegram, and the email is still indexed and findable —
		// which is the whole distinction between muting and filtering.
		expect(calls).toHaveLength(0);
		const stored = await testEnv.INDEX_DB.prepare(
			"SELECT message_local_id FROM message_index WHERE mailbox_id = ? AND message_local_id = ?",
		)
			.bind(MAILBOX_ID, "msg_1")
			.first<{ message_local_id: string }>();
		expect(stored?.message_local_id).toBe("msg_1");
	});

	it("un-mutes on a second press, so the decision is reversible", async () => {
		await indexMessage("msg_1", "ruido@example.com");
		expect(
			await toggleSenderMute(testEnv.INDEX_DB, { sender: "ruido@example.com", mutedBy: "1" }),
		).toBe(true);
		expect(
			await toggleSenderMute(testEnv.INDEX_DB, { sender: "ruido@example.com", mutedBy: "1" }),
		).toBe(false);

		const calls = stubTelegram();
		expect(await deliverInboundNotification(buildEnv(), notification())).toEqual({
			status: "sent",
		});
		expect(calls.some((call) => call.method === "sendMessage")).toBe(true);
	});
});

describe("first-contact badge", () => {
	it("marks the first email from an address and nothing after it", async () => {
		await indexMessage("msg_1", "desconocido@example.com");
		const first = stubTelegram();
		await deliverInboundNotification(
			buildEnv(),
			notification({ fromAddr: "desconocido@example.com" }),
		);
		expect(String(first[0]?.body.text)).toContain("primer correo de este remitente");

		// A second email from the same address: the badge is a statement about the
		// sender, not decoration on the card.
		await indexMessage("msg_2", "desconocido@example.com");
		const second = stubTelegram();
		await deliverInboundNotification(
			buildEnv(),
			notification({
				messageLocalId: "msg_2",
				threadId: "thread_msg_2",
				fromAddr: "desconocido@example.com",
			}),
		);
		expect(String(second[0]?.body.text)).not.toContain("primer correo de este remitente");
	});
});

describe("quiet hours", () => {
	it("wraps around midnight instead of describing an empty interval", () => {
		const night = { startMinutes: 23 * 60, endMinutes: 8 * 60, utcOffsetMinutes: 0 };
		expect(isWithinQuietHours(night, new Date("2026-01-01T23:30:00Z"))).toBe(true);
		expect(isWithinQuietHours(night, new Date("2026-01-02T03:00:00Z"))).toBe(true);
		expect(isWithinQuietHours(night, new Date("2026-01-02T09:00:00Z"))).toBe(false);
	});

	it("reads the window in the operator's clock, not the worker's", () => {
		const madridNight = parseQuietHours("23:00-08:00 +02:00");
		expect(madridNight).toEqual({
			startMinutes: 23 * 60,
			endMinutes: 8 * 60,
			utcOffsetMinutes: 120,
		});
		// 21:30 UTC is 23:30 in Madrid, which is inside the window the operator stated.
		expect(
			madridNight !== "off" &&
				madridNight !== null &&
				isWithinQuietHours(madridNight, new Date("2026-01-01T21:30:00Z")),
		).toBe(true);
	});

	it("retains the card instead of sending it, and the mail stays indexed", async () => {
		await writeQuietHours(testEnv.INDEX_DB, windowAround(new Date(), -60, 60));
		await indexMessage("msg_1", "nocturno@example.com");

		const calls = stubTelegram();
		const outcome = await deliverInboundNotification(
			buildEnv(),
			notification({ fromAddr: "nocturno@example.com" }),
		);

		expect(outcome).toEqual({ status: "skipped", reason: "quiet_hours" });
		expect(calls).toHaveLength(0);
		const retained = await testEnv.INDEX_DB.prepare(
			"SELECT message_local_id FROM telegram_retained WHERE chat_id = ? AND digest_at IS NULL",
		)
			.bind(CHAT_ID)
			.all<{ message_local_id: string }>();
		expect(retained.results?.map((row) => row.message_local_id)).toEqual(["msg_1"]);
	});

	it("groups the night into one message with a button per email", async () => {
		await writeQuietHours(testEnv.INDEX_DB, windowAround(new Date(), -60, 60));
		await indexMessage("msg_1", "uno@example.com");
		await indexMessage("msg_2", "dos@example.com");
		stubTelegram();
		await deliverInboundNotification(buildEnv(), notification({ fromAddr: "uno@example.com" }));
		await deliverInboundNotification(
			buildEnv(),
			notification({
				messageLocalId: "msg_2",
				threadId: "thread_msg_2",
				fromAddr: "dos@example.com",
			}),
		);

		// Morning: the window is over and the retained night is released.
		await writeQuietHours(testEnv.INDEX_DB, {
			startMinutes: null,
			endMinutes: null,
			utcOffsetMinutes: 0,
		});
		const calls = stubTelegram();
		const outcome = await flushTelegramDigest(buildEnv());

		expect(outcome).toEqual({ status: "sent", count: 2 });
		// One message for the whole night. Two cards would already be two seconds of
		// the chat's budget; forty would be a morning of 429s.
		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.body.text)).toContain("2 correos retenidos");
		expect(String(calls[0]?.body.text)).toContain("uno@example.com");
		const keyboard = calls[0]?.body.reply_markup as {
			inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
		};
		expect(keyboard.inline_keyboard[0]?.map((button) => button.text)).toEqual(["1", "2"]);

		// And a second flush finds nothing: the digest is not re-sent every hour.
		expect(await flushTelegramDigest(buildEnv())).toEqual({
			status: "skipped",
			reason: "nothing_pending",
		});
	});

	it("expands a digest line into a real, operable card", async () => {
		await writeQuietHours(testEnv.INDEX_DB, windowAround(new Date(), -60, 60));
		await indexMessage("msg_1", "uno@example.com");
		stubTelegram();
		await deliverInboundNotification(buildEnv(), notification({ fromAddr: "uno@example.com" }));
		const retained = await testEnv.INDEX_DB.prepare(
			"SELECT id FROM telegram_retained LIMIT 1",
		).first<{ id: string }>();

		const calls = stubTelegram();
		const config = readTelegramConfig(buildEnv())!;
		await handleDigestExpand(
			buildEnv(),
			config,
			{
				id: "cb-digest",
				from: { id: 424242 },
				data: `v1:g:${retained?.id}`,
				message: { message_id: 4242, chat: { id: Number(CHAT_ID), type: "private" } },
			},
			String(retained?.id),
		);

		const card = calls.find((call) => call.method === "sendMessage");
		expect(String(card?.body.text)).toContain("uno@example.com");
		// The point of expanding: what comes back is a card with a link row, so it can
		// be quoted to reply and its buttons resolve like any other.
		const link = await testEnv.INDEX_DB.prepare(
			"SELECT message_local_id FROM telegram_links WHERE chat_id = ?",
		)
			.bind(CHAT_ID)
			.first<{ message_local_id: string }>();
		expect(link?.message_local_id).toBe("msg_1");
	});
});
