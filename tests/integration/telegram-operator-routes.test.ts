import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
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
import migrationTelegramTopicName from "../../migrations/d1/0020_telegram_topic_name.sql?raw";
import { applyMigrations } from "../helpers/migrations";

/**
 * The /api/telegram/* operator routes end to end, through the worker's own
 * router, with the Bot API stubbed at fetch.
 *
 * Requests go to http://localhost, which the auth perimeter serves as the
 * dev-bypass owner (same as tests/integration/transactional-api-key-routes);
 * one test sends the same request from a public host to prove the perimeter
 * still applies.
 */

const env = testEnv as unknown as Env;
const BOT_TOKEN = "987654:secret-token-never-returned";
const BOT_ID = 987654;
const FORUM_CHAT_ID = "-1004344536018";
const PRIVATE_CHAT_ID = "424242";

beforeAll(async () => {
	await applyMigrations(
		env.INDEX_DB,
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
		migrationTelegram,
		migrationRuntimeConfig,
		migrationTelegramTopics,
		migrationTelegramTopicName,
		migrationOwnerRegistry,
		migrationExperience,
	);
	const now = new Date().toISOString();
	for (const [id, address, name] of [
		["mbx_hello", "hello@imsanti.dev", "Santi Gamo"],
		["mbx_billing", "billing@imsanti.dev", null],
	] as const) {
		await env.INDEX_DB.prepare(
			`INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 'dev@local', ?, ?)`,
		)
			.bind(id, address, name, now, now)
			.run();
	}
	await env.INDEX_DB.prepare(
		`INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at)
     VALUES ('mbx_off', 'off@imsanti.dev', NULL, 'disabled', 'dev@local', ?, ?)`,
	)
		.bind(now, now)
		.run();
});

beforeEach(async () => {
	await env.INDEX_DB.prepare("DELETE FROM runtime_config").run();
	await env.INDEX_DB.prepare("DELETE FROM telegram_topics").run();
	await env.INDEX_DB.prepare("DELETE FROM telegram_links").run();
	await env.INDEX_DB.prepare("DELETE FROM ops_events").run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

type BotCall = { method: string; body: Record<string, unknown> };

type ChatFixture = {
	id: number;
	type: string;
	title?: string;
	is_forum?: boolean;
	permissions?: Record<string, boolean>;
};

const FORUM: ChatFixture = {
	id: Number(FORUM_CHAT_ID),
	type: "supergroup",
	title: "Santi HQ",
	is_forum: true,
};
const PRIVATE: ChatFixture = { id: Number(PRIVATE_CHAT_ID), type: "private" };

/**
 * A fake Bot API. `chats` is what getChat knows; `member` is what getChatMember
 * answers for the bot; `respond` may override any call (return null for the
 * default). sendMessage echoes back the thread it was given, which is what a
 * real forum does for a thread that exists.
 */
function stubTelegram(
	options: {
		chats?: ChatFixture[];
		member?: Record<string, unknown>;
		respond?: (call: BotCall) => Response | null;
	} = {},
): BotCall[] {
	const calls: BotCall[] = [];
	const chats = options.chats ?? [FORUM, PRIVATE];
	let nextTopicId = 500;
	let nextMessageId = 1000;
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
		const override = options.respond?.(call);
		if (override) return override;
		switch (call.method) {
			case "getMe":
				return Response.json({
					ok: true,
					result: { id: BOT_ID, is_bot: true, first_name: "Reccado", username: "reccado_bot" },
				});
			case "getChat": {
				const chat = chats.find((entry) => String(entry.id) === String(call.body.chat_id));
				return chat
					? Response.json({ ok: true, result: chat })
					: Response.json({
							ok: false,
							error_code: 400,
							description: "Bad Request: chat not found",
						});
			}
			case "getChatMember":
				return Response.json({
					ok: true,
					result: options.member ?? { status: "administrator", can_manage_topics: true },
				});
			case "createForumTopic":
				nextTopicId += 1;
				return Response.json({
					ok: true,
					result: { message_thread_id: nextTopicId, name: call.body.name },
				});
			case "sendMessage":
				nextMessageId += 1;
				return Response.json({
					ok: true,
					result: {
						message_id: nextMessageId,
						chat: { id: Number(call.body.chat_id), type: "supergroup" },
						...(call.body.message_thread_id
							? { message_thread_id: call.body.message_thread_id, is_topic_message: true }
							: {}),
					},
				});
			default:
				return Response.json({ ok: true, result: true });
		}
	});
	return calls;
}

function bridgeEnv(overrides: Partial<Env> = {}): Env {
	return { ...env, TELEGRAM_BOT_TOKEN: BOT_TOKEN, ...overrides } as Env;
}

async function call(
	method: string,
	path: string,
	body?: unknown,
	options: { env?: Env; origin?: string; base?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
	const ctx = createExecutionContext();
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (options.origin) headers.origin = options.origin;
	const response = await worker.fetch(
		new Request(`${options.base ?? "http://localhost"}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		options.env ?? bridgeEnv(),
		ctx,
	);
	await waitOnExecutionContext(ctx);
	const raw = await response.text();
	return { status: response.status, body: JSON.parse(raw) as Record<string, unknown>, raw };
}

async function bind(chatId: string, isForum: boolean): Promise<void> {
	const now = new Date().toISOString();
	await env.INDEX_DB.batch([
		env.INDEX_DB.prepare(
			"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)",
		).bind(chatId, now),
		env.INDEX_DB.prepare(
			"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_is_forum', ?, ?)",
		).bind(isForum ? "1" : "0", now),
	]);
}

async function mapTopic(
	chatId: string,
	mailboxId: string,
	topicId: number,
	name: string | null = null,
): Promise<void> {
	await env.INDEX_DB.prepare(
		"INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, topic_name, created_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(chatId, mailboxId, topicId, name, new Date().toISOString())
		.run();
}

describe("GET /api/telegram/status", () => {
	it("reports the bot, the bound forum, the bot's rights and each active mailbox's topic", async () => {
		await bind(FORUM_CHAT_ID, true);
		await mapTopic(FORUM_CHAT_ID, "mbx_hello", 7, "imsanti");
		// A mapping in another chat is not this chat's topic.
		await mapTopic(PRIVATE_CHAT_ID, "mbx_billing", 3);
		const calls = stubTelegram();

		const { status, body, raw } = await call("GET", "/api/telegram/status");

		expect(status).toBe(200);
		expect(body.bot).toEqual({
			ok: true,
			id: BOT_ID,
			username: "reccado_bot",
			firstName: "Reccado",
		});
		expect(body.binding).toEqual({ chatId: FORUM_CHAT_ID, isForum: true });
		expect(body.chat).toEqual({
			ok: true,
			id: FORUM_CHAT_ID,
			type: "supergroup",
			title: "Santi HQ",
			isForum: true,
		});
		expect(body.membership).toMatchObject({
			ok: true,
			status: "administrator",
			canManageTopics: true,
			eligible: true,
		});
		const mailboxes = body.mailboxes as Array<Record<string, unknown>>;
		expect(mailboxes.map((m) => m.mailboxId)).toEqual(["mbx_hello", "mbx_billing"]);
		expect(mailboxes[0]?.topic).toMatchObject({
			topicId: 7,
			topicName: "imsanti",
			effectiveName: "imsanti",
		});
		expect(mailboxes[0]?.topicVerified).toBe(false);
		expect(mailboxes[1]?.topic).toBeNull();
		expect(body.topicVerification).toMatchObject({ verified: false });
		// Read-only toward Telegram: in particular no editForumTopic, which renames.
		expect(calls.map((c) => c.method).sort()).toEqual(["getChat", "getChatMember", "getMe"]);
		expect(raw).not.toContain(BOT_TOKEN);
	});

	it("reports the webhook as tracked in runtime_config, without the secret fingerprint", async () => {
		const now = new Date().toISOString();
		await env.INDEX_DB.batch([
			env.INDEX_DB.prepare(
				"INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.webhook_registration', ?, ?)",
			).bind(
				JSON.stringify({
					fingerprint: "FINGERPRINT",
					registeredAt: now,
					url: "https://x/telegram/webhook",
				}),
				now,
			),
			env.INDEX_DB.prepare(
				"INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.webhook_observation', ?, ?)",
			).bind(
				JSON.stringify({
					url: "https://x/telegram/webhook",
					lastErrorAt: null,
					lastErrorMessage: null,
					pendingUpdateCount: 2,
					observedAt: now,
				}),
				now,
			),
		]);
		stubTelegram();

		const { body, raw } = await call("GET", "/api/telegram/status");

		expect(body.webhook).toEqual({
			registration: { url: "https://x/telegram/webhook", registeredAt: now },
			observation: {
				url: "https://x/telegram/webhook",
				lastErrorAt: null,
				lastErrorMessage: null,
				pendingUpdateCount: 2,
				observedAt: now,
			},
		});
		expect(raw).not.toContain("FINGERPRINT");
		expect(body.chat).toBeNull();
		expect(body.membership).toBeNull();
	});

	it("keeps answering when Telegram fails, and redacts the token from transport errors", async () => {
		await bind(FORUM_CHAT_ID, true);
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			throw new Error(`network down while fetching ${String(input)}`);
		});

		const { status, body, raw } = await call("GET", "/api/telegram/status");

		expect(status).toBe(200);
		expect(body.bot).toMatchObject({ ok: false });
		expect(String((body.bot as { error: string }).error)).toContain("[redacted]");
		expect(raw).not.toContain(BOT_TOKEN);
	});

	it("says the bridge is off and calls nothing when there is no token", async () => {
		const calls = stubTelegram();

		const { status, body } = await call("GET", "/api/telegram/status", undefined, {
			env: bridgeEnv({ TELEGRAM_BOT_TOKEN: "" }),
		});

		expect(status).toBe(200);
		expect(body.bot).toBeNull();
		expect((body.bridge as { mode: string }).mode).toBe("off");
		expect(calls).toHaveLength(0);
	});

	it("is behind the owner session perimeter", async () => {
		const calls = stubTelegram();

		const { status, raw } = await call("GET", "/api/telegram/status", undefined, {
			base: "https://reccado.example",
		});

		expect([401, 503]).toContain(status);
		expect(raw).not.toContain("reccado_bot");
		expect(calls).toHaveLength(0);
	});
});
