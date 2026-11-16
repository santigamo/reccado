import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotifyQueue } from "#/cloudflare/notify-consumer";
import { handleInboundQueue } from "#/cloudflare/queue-consumer";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import { flushTelegramDigest, writeQuietHours } from "#/telegram/noise";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationLinkIndex from "../../migrations/d1/0013_telegram_links_message_index.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * DMARC aggregate reports never become a Telegram notice: the ingest result
 * carries the DO's classification, the consumer enqueues nothing for it, and so
 * the quiet-hours digest has nothing of it to release. Ordinary mail (including a
 * person writing about DMARC) is unchanged.
 */

type TestEnv = Env & { INDEX_DB: D1Database; MAIL_OBJECTS: R2Bucket };
const testEnv = env as unknown as TestEnv;
const CHAT_ID = "4242";
const MAILBOX_ID = "mbx-dmarc-notify";

beforeAll(async () => {
	for (const migration of [
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
		migrationTelegram,
		migrationRuntimeConfig,
		migrationLinkIndex,
		migrationExperience,
	]) {
		for (const statement of splitSqlStatements(migration as string)) {
			await testEnv.INDEX_DB.prepare(statement).run();
		}
	}
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare(
		"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)",
	)
		.bind(CHAT_ID, new Date().toISOString())
		.run();
	await testEnv.INDEX_DB.prepare("DELETE FROM telegram_retained").run();
	await writeQuietHours(testEnv.INDEX_DB, {
		startMinutes: null,
		endMinutes: null,
		utcOffsetMinutes: 0,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function reportMime(messageId: string): string {
	return [
		"From: noreply-dmarc-support@google.com",
		"To: test@example.com",
		"Subject: Report domain: send.example.com Submitter: google.com Report-ID: 1234567890",
		`Message-ID: <${messageId}>`,
		"Date: Mon, 16 Nov 2026 03:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="rpt"',
		"",
		"--rpt",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"This is an aggregate report from the submitter.",
		"--rpt",
		'Content-Type: application/zip; name="google.com!send.example.com!1763164800!1763251199.zip"',
		'Content-Disposition: attachment; filename="google.com!send.example.com!1763164800!1763251199.zip"',
		"Content-Transfer-Encoding: base64",
		"",
		"UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
		"--rpt--",
		"",
	].join("\r\n");
}

function plainMime(input: { from: string; subject: string; messageId: string; body: string }) {
	return [
		`From: ${input.from}`,
		"To: test@example.com",
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		"Date: Mon, 16 Nov 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		input.body,
		"",
	].join("\r\n");
}

/** Runs one email through the real inbound consumer and mailbox DO; returns what it enqueued for Telegram. */
async function ingestThroughConsumer(raw: string, messageId: string): Promise<unknown[]> {
	const rawBytes = new TextEncoder().encode(raw);
	const rawSha256 = await sha256Hex(rawBytes);
	const rawR2Key = rawEmailR2Key({ mailboxId: MAILBOX_ID, receivedAt: new Date(), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const body: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: new Date().toISOString(),
		receivedAt: new Date().toISOString(),
		mailboxId: MAILBOX_ID,
		domain: "example.com",
		recipient: "test@example.com",
		sender: "envelope@example.com",
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId,
		headers: { subject: null, date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
		idempotencyKey: inboundIdempotencyKey({ mailboxId: MAILBOX_ID, messageId, rawSha256 }),
	};
	const queued: unknown[] = [];
	const message = { id: crypto.randomUUID(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
	await handleInboundQueue(
		{ messages: [message] } as unknown as MessageBatch<InboundEmailQueueMessage>,
		{
			...testEnv,
			NOTIFY_QUEUE: { send: async (payload: unknown) => void queued.push(payload) },
		} as unknown as Env,
		{} as ExecutionContext,
	);
	expect(message.ack).toHaveBeenCalledTimes(1);
	expect(message.retry).not.toHaveBeenCalled();
	return queued;
}

async function indexed(messageLocalId: string): Promise<boolean> {
	const row = await testEnv.INDEX_DB.prepare(
		"SELECT 1 AS hit FROM message_index WHERE mailbox_id = ? AND message_local_id = ?",
	)
		.bind(MAILBOX_ID, messageLocalId)
		.first();
	return Boolean(row);
}

async function indexedIds(): Promise<string[]> {
	const rows = await testEnv.INDEX_DB.prepare(
		"SELECT message_local_id, subject FROM message_index WHERE mailbox_id = ?",
	)
		.bind(MAILBOX_ID)
		.all<{ message_local_id: string; subject: string | null }>();
	return rows.results.map((row) => `${row.message_local_id}|${row.subject}`);
}

type BotCall = { method: string; body: Record<string, unknown> };
function stubTelegram(): BotCall[] {
	const calls: BotCall[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch: ${url}`);
		calls.push({
			method: url.split("/").pop() ?? "",
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return Response.json({ ok: true, result: { message_id: 1 } });
	});
	return calls;
}

async function drainNotify(queued: unknown[]): Promise<void> {
	for (const body of queued) {
		const message = { id: crypto.randomUUID(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
		await handleNotifyQueue(
			{ messages: [message] } as unknown as MessageBatch<unknown>,
			{ ...testEnv, TELEGRAM_BOT_TOKEN: "123:fake-token" } as Env,
			{} as ExecutionContext,
		);
		expect(message.ack).toHaveBeenCalledTimes(1);
	}
}

describe("Telegram notices for DMARC aggregate reports", { timeout: 20_000 }, () => {
	it("a report is stored and indexed but enqueues no notice", async () => {
		const before = new Set(await indexedIds());
		const queued = await ingestThroughConsumer(
			reportMime("report-1@google.com"),
			"report-1@google.com",
		);
		expect(queued).toEqual([]);
		const added = (await indexedIds()).filter((id) => !before.has(id));
		expect(added).toHaveLength(1);
		expect(added[0]).toContain("Report domain: send.example.com");
	});

	it("ordinary mail, and a person writing about DMARC, still enqueue a notice", async () => {
		const normal = await ingestThroughConsumer(
			plainMime({
				from: "ana@example.org",
				subject: "Lunch on Friday?",
				messageId: "lunch-1@example.org",
				body: "Shall we?",
			}),
			"lunch-1@example.org",
		);
		expect(normal).toHaveLength(1);
		const human = await ingestThroughConsumer(
			plainMime({
				from: "dmarc-admin@example.org",
				subject: "Our DMARC report setup: rua address question",
				messageId: "human-dmarc-1@example.org",
				body: "Can you check the DMARC aggregate report settings for send.example.com?",
			}),
			"human-dmarc-1@example.org",
		);
		expect(human).toHaveLength(1);
		const notice = human[0] as {
			eventType: string;
			notification: { messageLocalId: string; subject: string };
		};
		expect(notice.eventType).toBe("mail.notify.v1");
		expect(notice.notification.subject).toBe("Our DMARC report setup: rua address question");
		expect(await indexed(notice.notification.messageLocalId)).toBe(true);
	});

	it("the quiet-hours digest lists the night's ordinary mail and never the report", async () => {
		const now = new Date();
		const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
		// A two-hour window around now, so the notices are retained for the digest.
		await writeQuietHours(testEnv.INDEX_DB, {
			startMinutes: (nowMinutes + 1440 - 60) % 1440,
			endMinutes: (nowMinutes + 60) % 1440,
			utcOffsetMinutes: 0,
		});
		const calls = stubTelegram();
		const queued = [
			...(await ingestThroughConsumer(reportMime("report-2@google.com"), "report-2@google.com")),
			...(await ingestThroughConsumer(
				plainMime({
					from: "ana@example.org",
					subject: "Invoice for October",
					messageId: "invoice-1@example.org",
					body: "Attached.",
				}),
				"invoice-1@example.org",
			)),
		];
		expect(queued).toHaveLength(1);
		await drainNotify(queued);
		const retained = await testEnv.INDEX_DB.prepare(
			"SELECT from_addr FROM telegram_retained WHERE chat_id = ? AND digest_at IS NULL",
		)
			.bind(CHAT_ID)
			.all<{ from_addr: string }>();
		expect(retained.results.map((row) => row.from_addr)).toEqual(["ana@example.org"]);
		expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0);

		// Three hours later the window is over: the hourly sweep's flush sends one digest.
		const outcome = await flushTelegramDigest(
			{ ...testEnv, TELEGRAM_BOT_TOKEN: "123:fake-token" } as Env,
			new Date(now.getTime() + 3 * 3600_000),
		);
		expect(outcome).toEqual({ status: "sent", count: 1 });
		const digest = calls.filter((call) => call.method === "sendMessage");
		expect(digest).toHaveLength(1);
		const text = String(digest[0]?.body.text);
		expect(text).toContain("Invoice for October");
		expect(text).not.toContain("Report domain");
		expect(text).not.toContain("noreply-dmarc-support");
	});
});
