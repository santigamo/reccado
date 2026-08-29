import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleNotifyQueue } from "#/cloudflare/notify-consumer";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationLinkIndex from "../../migrations/d1/0013_telegram_links_message_index.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * The gap this closes: archiving on the web left the Telegram card claiming the
 * email was still pending, so the two surfaces described the same inbox
 * differently and only one of them was right.
 */

const testEnv = env as unknown as Env;
const CHAT_ID = "999";
const CARD_MESSAGE_ID = 8080;
const MAILBOX_ID = "mbx_reconcile";
const MESSAGE_LOCAL_ID = "msg_reconcile_1";
const THREAD_ID = "thread_reconcile_1";

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
		migrationLinkIndex,
		migrationExperience,
	]) {
		await applyMigration(migration as string);
	}
});

beforeEach(async () => {
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
     VALUES (?, 'hello@imsanti.dev', 'Hola', 'active', ?, ?)`,
	)
		.bind(MAILBOX_ID, now, now)
		.run();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)`,
	)
		.bind(CHAT_ID, now)
		.run();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO telegram_links
     (chat_id, message_id, mailbox_id, thread_id, message_local_id, topic_id, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
	)
		.bind(CHAT_ID, CARD_MESSAGE_ID, MAILBOX_ID, THREAD_ID, MESSAGE_LOCAL_ID, now)
		.run();
	await testEnv.INDEX_DB.prepare(
		`INSERT OR REPLACE INTO message_index
     (mailbox_id, message_local_id, thread_id, rfc_message_id, subject, from_addr, to_json, snippet,
      received_at, has_attachments, labels_json, state, raw_r2_key, raw_sha256, updated_at)
     VALUES (?, ?, ?, NULL, 'Factura pendiente', 'sender@example.com', '["hello@imsanti.dev"]',
             'hola', ?, 0, '[]', 'inbox', 'raw/1', 'sha', ?)`,
	)
		.bind(MAILBOX_ID, MESSAGE_LOCAL_ID, THREAD_ID, now, now)
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The API env, with the notify queue replaced by a recorder. */
function apiEnv(queued: unknown[]): Env {
	return {
		...testEnv,
		TELEGRAM_BOT_TOKEN: "123:fake-token",
		NOTIFY_QUEUE: {
			send: async (body: unknown) => {
				queued.push(body);
			},
		},
	} as unknown as Env;
}

async function archiveThroughApi(queued: unknown[]): Promise<number> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(
			`http://localhost/api/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_LOCAL_ID}/actions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "archive" }),
			},
		),
		apiEnv(queued),
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response.status;
}

type BotCall = { method: string; body: Record<string, unknown> };

function stubTelegram(): BotCall[] {
	const calls: BotCall[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) {
			throw new Error(`unexpected outbound fetch: ${url}`);
		}
		calls.push({
			method: url.split("/").pop() ?? "",
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return Response.json({ ok: true, result: { message_id: CARD_MESSAGE_ID } });
	});
	return calls;
}

async function drainNotifyQueue(body: unknown): Promise<{ acked: boolean; retried: boolean }> {
	const message = { id: "notify-1", attempts: 1, body, ack: vi.fn(), retry: vi.fn() };
	await handleNotifyQueue(
		{ messages: [message] } as unknown as MessageBatch<unknown>,
		{ ...testEnv, TELEGRAM_BOT_TOKEN: "123:fake-token" } as Env,
		{} as ExecutionContext,
	);
	return { acked: message.ack.mock.calls.length > 0, retried: message.retry.mock.calls.length > 0 };
}

describe("archiving on another surface", () => {
	it("queues a card edit rather than making the API request wait on Telegram", async () => {
		const queued: unknown[] = [];

		expect(await archiveThroughApi(queued)).toBe(200);

		// Queued, not called inline: an edit spends the chat's ~1 message per second,
		// and the request that archived the mail should not pay for that.
		expect(queued).toEqual([
			{
				schemaVersion: 1,
				eventType: "telegram.card_refresh.v1",
				refresh: {
					mailboxId: MAILBOX_ID,
					messageLocalId: MESSAGE_LOCAL_ID,
					threadId: null,
					status: "archived",
				},
			},
		]);
	});

	it("edits the Telegram card when that queued update is delivered", async () => {
		const queued: unknown[] = [];
		await archiveThroughApi(queued);
		const calls = stubTelegram();

		const outcome = await drainNotifyQueue(queued[0]);

		expect(outcome).toEqual({ acked: true, retried: false });
		const edit = calls.find((call) => call.method === "editMessageText");
		expect(edit?.body.chat_id).toBe(CHAT_ID);
		expect(edit?.body.message_id).toBe(CARD_MESSAGE_ID);
		expect(String(edit?.body.text)).toContain("· archivado");
		// The card is restated, not rewritten: it still says what it originally said.
		expect(String(edit?.body.text)).toContain("Factura pendiente");
		// And it stops offering triage for a decision already taken.
		expect(edit?.body.reply_markup).toBeUndefined();
	});

	it("acks an update for a card that is gone, instead of retrying forever", async () => {
		const queued: unknown[] = [];
		await archiveThroughApi(queued);
		await testEnv.INDEX_DB.prepare("DELETE FROM telegram_links").run();
		const calls = stubTelegram();

		const outcome = await drainNotifyQueue(queued[0]);

		expect(outcome).toEqual({ acked: true, retried: false });
		expect(calls).toHaveLength(0);
	});
});
