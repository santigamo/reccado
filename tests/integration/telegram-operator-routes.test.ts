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

async function configValue(key: string): Promise<string | null> {
	const row = await env.INDEX_DB.prepare("SELECT value FROM runtime_config WHERE key = ?")
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

async function opsEvents(type: string): Promise<Array<{ subject: string; payload_json: string }>> {
	const result = await env.INDEX_DB.prepare(
		"SELECT subject, payload_json FROM ops_events WHERE event_type = ? ORDER BY created_at",
	)
		.bind(type)
		.all<{ subject: string; payload_json: string }>();
	return result.results ?? [];
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

describe("POST /api/telegram/rebind", () => {
	it("dry run: checks the target with Telegram and writes nothing", async () => {
		await bind(PRIVATE_CHAT_ID, false);
		const calls = stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/rebind", {
			chatId: FORUM_CHAT_ID,
			dryRun: true,
		});

		expect(status).toBe(200);
		expect(body).toMatchObject({
			outcome: "would_rebind",
			dryRun: true,
			previous: { chatId: PRIVATE_CHAT_ID, isForum: false },
			current: { chatId: FORUM_CHAT_ID, isForum: true, type: "supergroup", title: "Santi HQ" },
			membership: { status: "administrator", canManageTopics: true, eligible: true },
		});
		expect(await configValue("telegram.chat_id")).toBe(PRIVATE_CHAT_ID);
		expect(await configValue("telegram.chat_is_forum")).toBe("0");
		expect(await opsEvents("telegram.rebound")).toHaveLength(0);
		expect(calls.map((c) => c.method)).toEqual(["getChat", "getMe", "getChatMember"]);
		expect(calls[2]?.body).toEqual({ chat_id: FORUM_CHAT_ID, user_id: BOT_ID });
	});

	it("overrides the sticky binding, audits it, keeps old topics, and the next card goes to the new chat", async () => {
		await bind(PRIVATE_CHAT_ID, false);
		await mapTopic(PRIVATE_CHAT_ID, "mbx_hello", 3);
		stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/rebind", { chatId: FORUM_CHAT_ID });

		expect(status).toBe(200);
		expect(body.outcome).toBe("rebound");
		expect(body.topics).toEqual({ mappedInNewChat: 0, keptForOtherChats: 1 });
		expect(await configValue("telegram.chat_id")).toBe(FORUM_CHAT_ID);
		expect(await configValue("telegram.chat_is_forum")).toBe("1");
		const events = await opsEvents("telegram.rebound");
		expect(events).toHaveLength(1);
		// Old and new ids, nothing else -- no title, no token.
		expect(JSON.parse(events[0]!.payload_json)).toEqual({
			oldChatId: PRIVATE_CHAT_ID,
			newChatId: FORUM_CHAT_ID,
		});
		const kept = await env.INDEX_DB.prepare(
			"SELECT topic_id FROM telegram_topics WHERE chat_id = ? AND mailbox_id = 'mbx_hello'",
		)
			.bind(PRIVATE_CHAT_ID)
			.first<{ topic_id: number }>();
		expect(kept?.topic_id).toBe(3);

		// No cache between the binding and its readers: the notifier's very next
		// card lands in the new forum, in a topic of its own.
		const { deliverInboundNotification } = await import("#/telegram/notify");
		const calls = stubTelegram();
		const outcome = await deliverInboundNotification(bridgeEnv(), {
			mailboxId: "mbx_hello",
			mailboxAddress: "hello@imsanti.dev",
			messageLocalId: "msg_after_rebind",
			threadId: "thread_after_rebind",
			subject: "Hola",
			fromAddr: "someone@example.org",
			snippet: "hola",
			hasAttachments: false,
		});
		expect(outcome.status).toBe("sent");
		const send = calls.find((c) => c.method === "sendMessage");
		expect(send?.body.chat_id).toBe(FORUM_CHAT_ID);
		expect(send?.body.message_thread_id).toBeGreaterThan(500);
	});

	it("binds a chat no /start ever adopted, storing the numeric id for an @username", async () => {
		const calls = stubTelegram({
			respond: (c) =>
				c.method === "getChat" && c.body.chat_id === "@santihq"
					? Response.json({ ok: true, result: FORUM })
					: null,
		});

		const { status, body } = await call("POST", "/api/telegram/rebind", { chatId: "@santihq" });

		expect(status).toBe(200);
		expect(body.previous).toEqual({ chatId: null, isForum: null });
		expect(await configValue("telegram.chat_id")).toBe(FORUM_CHAT_ID);
		expect(calls.find((c) => c.method === "getChatMember")?.body.chat_id).toBe(FORUM_CHAT_ID);
	});

	it("is a no-op, with no audit row, for the chat already bound", async () => {
		await bind(FORUM_CHAT_ID, true);
		stubTelegram();

		const { body } = await call("POST", "/api/telegram/rebind", { chatId: FORUM_CHAT_ID });

		expect(body.outcome).toBe("unchanged");
		expect(await opsEvents("telegram.rebound")).toHaveLength(0);
	});

	it("re-observes the forum flag of the chat already bound", async () => {
		await bind(FORUM_CHAT_ID, false);
		stubTelegram();

		const { body } = await call("POST", "/api/telegram/rebind", { chatId: FORUM_CHAT_ID });

		expect(body.outcome).toBe("rebound");
		expect(await configValue("telegram.chat_is_forum")).toBe("1");
	});

	it("skips the membership check for a private chat", async () => {
		await bind(FORUM_CHAT_ID, true);
		const calls = stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/rebind", {
			chatId: PRIVATE_CHAT_ID,
		});

		expect(status).toBe(200);
		expect(body.membership).toBeNull();
		expect(body.current).toMatchObject({ chatId: PRIVATE_CHAT_ID, isForum: false });
		expect(calls.map((c) => c.method)).toEqual(["getChat"]);
	});

	it("refuses a chat where the bot cannot post, and writes nothing", async () => {
		await bind(PRIVATE_CHAT_ID, false);
		stubTelegram({ member: { status: "left" } });

		const { status, body } = await call("POST", "/api/telegram/rebind", { chatId: FORUM_CHAT_ID });

		expect(status).toBe(409);
		expect(body.error).toBe("bot_not_eligible");
		expect(body.membership).toMatchObject({ status: "left", eligible: false });
		expect(await configValue("telegram.chat_id")).toBe(PRIVATE_CHAT_ID);
		expect(await opsEvents("telegram.rebound")).toHaveLength(0);
	});

	it("accepts a member with send rights and reports that it cannot manage topics", async () => {
		stubTelegram({ member: { status: "member" } });

		const { status, body } = await call("POST", "/api/telegram/rebind", { chatId: FORUM_CHAT_ID });

		expect(status).toBe(200);
		expect(body.membership).toMatchObject({ status: "member", canManageTopics: false });
		expect(String((body.notes as string[])[0])).toContain("--adopt");
	});

	it("answers 404 for a chat Telegram does not know", async () => {
		stubTelegram();

		const { status, body, raw } = await call("POST", "/api/telegram/rebind", {
			chatId: "-100999",
		});

		expect(status).toBe(404);
		expect(body.error).toBe("chat_not_found");
		expect(raw).not.toContain(BOT_TOKEN);
	});

	it("refuses a channel", async () => {
		stubTelegram({ chats: [{ id: -100777, type: "channel", title: "News" }] });

		const { status, body } = await call("POST", "/api/telegram/rebind", { chatId: "-100777" });

		expect(status).toBe(409);
		expect(body.error).toBe("unsupported_chat_type");
	});

	it("rejects a malformed chat id before calling Telegram", async () => {
		const calls = stubTelegram();

		const { status } = await call("POST", "/api/telegram/rebind", { chatId: "hq; DROP" });

		expect(status).toBe(400);
		expect(calls).toHaveLength(0);
	});

	it("is behind the Origin CSRF check", async () => {
		await bind(PRIVATE_CHAT_ID, false);
		const calls = stubTelegram();

		const { status } = await call(
			"POST",
			"/api/telegram/rebind",
			{ chatId: FORUM_CHAT_ID },
			{ origin: "https://evil.example" },
		);

		expect(status).toBe(403);
		expect(calls).toHaveLength(0);
		expect(await configValue("telegram.chat_id")).toBe(PRIVATE_CHAT_ID);
	});
});

async function storedMapping(
	chatId: string,
	mailboxId: string,
): Promise<{ topic_id: number; topic_name: string | null } | null> {
	return env.INDEX_DB.prepare(
		"SELECT topic_id, topic_name FROM telegram_topics WHERE chat_id = ? AND mailbox_id = ?",
	)
		.bind(chatId, mailboxId)
		.first<{ topic_id: number; topic_name: string | null }>();
}

describe("POST /api/telegram/topics", () => {
	it("creates a named topic, stores the name with the mapping, and real cards use it", async () => {
		await bind(FORUM_CHAT_ID, true);
		const calls = stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});

		expect(status).toBe(201);
		expect(body).toMatchObject({
			outcome: "created",
			chatId: FORUM_CHAT_ID,
			mapping: {
				mailboxId: "mbx_hello",
				topicId: 501,
				topicName: "imsanti",
				effectiveName: "imsanti",
			},
			replaced: null,
			topicVerified: true,
		});
		expect(calls.find((c) => c.method === "createForumTopic")?.body).toEqual({
			chat_id: FORUM_CHAT_ID,
			name: "imsanti",
		});
		expect(await storedMapping(FORUM_CHAT_ID, "mbx_hello")).toEqual({
			topic_id: 501,
			topic_name: "imsanti",
		});
		// display_name ("Santi Gamo") is untouched: it is still how replies are signed.
		const mailbox = await env.INDEX_DB.prepare(
			"SELECT display_name FROM mailboxes WHERE mailbox_id = 'mbx_hello'",
		).first<{ display_name: string }>();
		expect(mailbox?.display_name).toBe("Santi Gamo");
		expect(await opsEvents("telegram.topic_mapped")).toHaveLength(1);

		const { deliverInboundNotification } = await import("#/telegram/notify");
		const cardCalls = stubTelegram();
		await deliverInboundNotification(bridgeEnv(), {
			mailboxId: "mbx_hello",
			mailboxAddress: "hello@imsanti.dev",
			messageLocalId: "msg_named_topic",
			threadId: "thread_named_topic",
			subject: "Hola",
			fromAddr: "someone@example.org",
			snippet: null,
			hasAttachments: false,
		});
		expect(cardCalls.some((c) => c.method === "createForumTopic")).toBe(false);
		expect(cardCalls.find((c) => c.method === "sendMessage")?.body.message_thread_id).toBe(501);
	});

	it("is idempotent: the same request again is `already`, with no second topic", async () => {
		await bind(FORUM_CHAT_ID, true);
		await mapTopic(FORUM_CHAT_ID, "mbx_hello", 7, "imsanti");
		const calls = stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});

		expect(status).toBe(200);
		expect(body.outcome).toBe("already");
		expect(body.topicVerified).toBe(false);
		expect(calls.some((c) => c.method === "createForumTopic")).toBe(false);
	});

	it("answers 409 for a different mapping unless replace is set, then replaces it", async () => {
		await bind(FORUM_CHAT_ID, true);
		await mapTopic(FORUM_CHAT_ID, "mbx_hello", 7);
		const calls = stubTelegram();

		const conflict = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});
		expect(conflict.status).toBe(409);
		expect(conflict.body.error).toBe("topic_mapping_exists");
		expect(conflict.body.existing).toMatchObject({ topicId: 7, topicName: null });
		expect(calls.some((c) => c.method === "createForumTopic")).toBe(false);

		const replaced = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
			replace: true,
		});
		expect(replaced.status).toBe(201);
		expect(replaced.body.replaced).toMatchObject({ topicId: 7 });
		expect(await storedMapping(FORUM_CHAT_ID, "mbx_hello")).toEqual({
			topic_id: 501,
			topic_name: "imsanti",
		});
	});

	it("adopts an existing thread without creating anything, and says it is unverified", async () => {
		await bind(FORUM_CHAT_ID, true);
		const calls = stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_billing",
			adoptThreadId: 42,
			name: "facturas",
		});

		expect(status).toBe(201);
		expect(body).toMatchObject({
			outcome: "adopted",
			mapping: { topicId: 42, topicName: "facturas" },
			topicVerified: false,
		});
		expect(String(body.reason)).toContain("editForumTopic");
		expect(calls.map((c) => c.method)).toEqual(["getChat"]);
		expect(await storedMapping(FORUM_CHAT_ID, "mbx_billing")).toEqual({
			topic_id: 42,
			topic_name: "facturas",
		});

		const again = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_billing",
			adoptThreadId: 42,
		});
		expect(again.body.outcome).toBe("already");
	});

	it("dry run: reports what it would do and writes nothing", async () => {
		await bind(FORUM_CHAT_ID, false);
		const calls = stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
			dryRun: true,
		});

		expect(status).toBe(200);
		expect(body).toMatchObject({ outcome: "would_create", mapping: null, dryRun: true });
		expect(calls.map((c) => c.method)).toEqual(["getChat"]);
		expect(await storedMapping(FORUM_CHAT_ID, "mbx_hello")).toBeNull();
		// Even the re-observed forum flag is not written by a dry run.
		expect(await configValue("telegram.chat_is_forum")).toBe("0");
	});

	it("re-observes a stale forum flag instead of refusing", async () => {
		await bind(FORUM_CHAT_ID, false);
		stubTelegram();

		const { status } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});

		expect(status).toBe(201);
		expect(await configValue("telegram.chat_is_forum")).toBe("1");
	});

	it("refuses a chat that is not a forum", async () => {
		await bind(PRIVATE_CHAT_ID, false);
		stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});

		expect(status).toBe(409);
		expect(body.error).toBe("chat_not_forum");
	});

	it("refuses when no chat is bound", async () => {
		stubTelegram();

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});

		expect(status).toBe(409);
		expect(body.error).toBe("no_chat_bound");
	});

	it("reports a topic Telegram refused to create, and stores nothing", async () => {
		await bind(FORUM_CHAT_ID, true);
		stubTelegram({
			respond: (c) =>
				c.method === "createForumTopic"
					? Response.json({
							ok: false,
							error_code: 400,
							description: "Bad Request: not enough rights to create a topic",
						})
					: null,
		});

		const { status, body } = await call("POST", "/api/telegram/topics", {
			mailboxId: "mbx_hello",
			name: "imsanti",
		});

		expect(status).toBe(409);
		expect(body.error).toBe("topic_create_refused");
		expect(await storedMapping(FORUM_CHAT_ID, "mbx_hello")).toBeNull();
	});

	it("rejects an unknown or disabled mailbox and a body with neither name nor thread", async () => {
		await bind(FORUM_CHAT_ID, true);
		stubTelegram();

		expect(
			(await call("POST", "/api/telegram/topics", { mailboxId: "mbx_nope", name: "x" })).status,
		).toBe(404);
		expect(
			(await call("POST", "/api/telegram/topics", { mailboxId: "mbx_off", name: "x" })).status,
		).toBe(404);
		expect((await call("POST", "/api/telegram/topics", { mailboxId: "mbx_hello" })).status).toBe(
			400,
		);
		expect(
			(
				await call("POST", "/api/telegram/topics", {
					mailboxId: "mbx_hello",
					name: "x".repeat(129),
				})
			).status,
		).toBe(400);
	});
});

describe("GET /api/telegram/topics", () => {
	it("lists every mapping with its effective name and whether it is in the bound chat", async () => {
		await bind(FORUM_CHAT_ID, true);
		await mapTopic(FORUM_CHAT_ID, "mbx_hello", 7, "imsanti");
		await mapTopic(FORUM_CHAT_ID, "mbx_billing", 8);
		await mapTopic(PRIVATE_CHAT_ID, "mbx_hello", 3);

		const { status, body } = await call("GET", "/api/telegram/topics");

		expect(status).toBe(200);
		expect(body.binding).toEqual({ chatId: FORUM_CHAT_ID, isForum: true });
		const topics = body.topics as Array<Record<string, unknown>>;
		expect(topics).toHaveLength(3);
		expect(topics.find((t) => t.topicId === 7)).toMatchObject({
			effectiveName: "imsanti",
			mailboxAddress: "hello@imsanti.dev",
			inBoundChat: true,
		});
		// NULL name: follows the mailbox, which has no display_name -> the address.
		expect(topics.find((t) => t.topicId === 8)).toMatchObject({
			topicName: null,
			effectiveName: "billing@imsanti.dev",
		});
		expect(topics.find((t) => t.topicId === 3)).toMatchObject({ inBoundChat: false });
	});
});
