import {
	runInDurableObject,
	createExecutionContext,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { insertMailbox } from "#/db/d1";
import { createIntent, getIntentStatus, requestControlPlaneChange } from "#/lib/approvals";
import { deriveWebhookSecret } from "#/telegram/api";
import { notifyIntentCreated } from "#/telegram/notify";
import { handleNotifyQueue } from "#/cloudflare/notify-consumer";
import { reconcileApprovalNotices, syncApprovalNotice } from "#/telegram/approval-notices";
import migrationTelegramTopics from "../../migrations/d1/0010_telegram_topics.sql?raw";
import migrationTelegramTopicName from "../../migrations/d1/0020_telegram_topic_name.sql?raw";
import migrationExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import migrationApprovalNotices from "../../migrations/d1/0031_telegram_approval_notices.sql?raw";
import worker from "../../src/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationKeys from "../../migrations/d1/0006_transactional_api_keys.sql?raw";
import migrationRequests from "../../migrations/d1/0007_transactional_requests.sql?raw";
import migrationEvents from "../../migrations/d1/0008_email_events_suppressions.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationResolved from "../../migrations/d1/0015_transactional_resolved_via.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const db = env.INDEX_DB;
const shared = env as Env;
const ORIGIN = "https://example.com";
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const BOT_TOKEN = "123:fake-token";
const OPERATOR = "424242";
const CHAT = "999";
const OWNER_EMAIL = "tg-approval-owner@example.com";

let webhookSecret = "";
let owner: { userId: string; jar: Jar };
const saved: Record<string, unknown> = {};
type Queued = { body: unknown; delaySeconds?: number };
const queued: Queued[] = [];

/** Runs captured notify-queue messages through the real consumer, then forgets them. */
async function deliverQueued(filter: (item: Queued) => boolean = () => true): Promise<void> {
	const batch = queued.filter(filter);
	queued.length = 0;
	const acked: boolean[] = [];
	await handleNotifyQueue(
		{
			queue: "inbox-mcp-notify-dev",
			messages: batch.map((item, index) => ({
				id: `q-${index}`,
				timestamp: new Date(),
				attempts: 1,
				body: item.body,
				ack: () => acked.push(true),
				retry: () => acked.push(false),
			})),
			ackAll: () => undefined,
			retryAll: () => undefined,
		} as unknown as MessageBatch<unknown>,
		shared,
		createExecutionContext(),
	);
	expect(acked.every(Boolean)).toBe(true);
}

class Jar {
	private readonly cookies = new Map<string, string>();
	absorb(response: Response): void {
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(";")[0] ?? "";
			const eq = pair.indexOf("=");
			if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}
	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

beforeAll(async () => {
	await applyMigrations(
		db,
		migrationInitial,
		migrationMessageIndex,
		migrationOwnerColumn,
		migrationTelegram,
		migrationOutbound,
		migrationKeys,
		migrationRequests,
		migrationEvents,
		migrationRuntimeConfig,
		migrationOwnerRegistry,
		migrationResolved,
		migrationBetterAuth,
		migrationBetterAuthMcp,
		migrationTwoFactor,
		migrationAuthUpgrade,
		migrationApprovals,
		migrationAudit,
		migrationApprovalMeta,
		migrationIntentPayload,
		migrationPendingUnique,
		migrationTelegramTopics,
		migrationTelegramTopicName,
		migrationExperience,
		migrationApprovalNotices,
	);
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', ?, ?)",
		)
		.bind(ORIGIN, now)
		.run();
	await db
		.prepare(
			"INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', ?, ?)",
		)
		.bind(CHAT, now)
		.run();
	// The mailbox DO reads this same isolate env, so the proof secret and the Telegram
	// settings are set on the shared object for the whole file.
	for (const key of [
		"BETTER_AUTH_SECRET",
		"TELEGRAM_BOT_TOKEN",
		"TELEGRAM_ALLOWED_USER_IDS",
	] as const) {
		saved[key] = shared[key];
	}
	shared.BETTER_AUTH_SECRET = TEST_SECRET;
	shared.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
	shared.TELEGRAM_ALLOWED_USER_IDS = OPERATOR;
	// Every notify-queue message this file produces is captured instead of being
	// delivered by the real consumer in the background: the tests drive the
	// consumer themselves (deliverQueued), with the Bot API stubbed.
	saved.NOTIFY_QUEUE = shared.NOTIFY_QUEUE;
	(shared as unknown as { NOTIFY_QUEUE: unknown }).NOTIFY_QUEUE = {
		send: async (body: unknown, options?: { delaySeconds?: number }) => {
			queued.push({ body, delaySeconds: options?.delaySeconds });
		},
	};
	webhookSecret = await deriveWebhookSecret(BOT_TOKEN);
	owner = await registerOwner(OWNER_EMAIL);
});

afterAll(() => {
	for (const [key, value] of Object.entries(saved)) {
		(shared as unknown as Record<string, unknown>)[key] = value;
	}
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function registerOwner(email: string): Promise<{ userId: string; jar: Jar }> {
	const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
		)
		.bind(code, now, new Date(Date.now() + 60 * 60 * 1000).toISOString())
		.run();
	const jar = new Jar();
	const response = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/pairing`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ email, code }),
		}),
		shared,
	);
	jar.absorb(response);
	expect(response.status, await response.clone().text()).toBe(200);
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return { userId: user?.id ?? "", jar };
}

type TelegramCall = { method: string; body: Record<string, unknown> };

function stubTelegram(): TelegramCall[] {
	const calls: TelegramCall[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
		calls.push({
			method: url.split("/").pop() ?? "",
			body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
		});
		return Response.json({ ok: true, result: { message_id: 1, chat: { id: 1, type: "private" } } });
	});
	return calls;
}

/** One callback press arriving at the webhook, exactly as Telegram delivers it. */
async function press(
	data: string,
	options: { from?: number; chat?: number } = {},
): Promise<TelegramCall[]> {
	const calls = stubTelegram();
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request("https://reccado.test/telegram/webhook", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-telegram-bot-api-secret-token": webhookSecret,
			},
			body: JSON.stringify({
				update_id: Math.floor(Math.random() * 1e9),
				callback_query: {
					id: `cb-${crypto.randomUUID()}`,
					from: { id: options.from ?? Number(OPERATOR) },
					data,
					message: {
						message_id: 77,
						chat: { id: options.chat ?? Number(CHAT), type: "private" },
						text: "🔐 Revisar envío",
					},
				},
			}),
		}),
		shared,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	expect(response.status).toBe(200);
	return calls;
}

async function mcpDraft(bodyText: string) {
	const mailboxId = `mbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const address = `${mailboxId}@imsanti.dev`;
	await insertMailbox(db, {
		mailbox_id: mailboxId,
		primary_address: address,
		display_name: "Owner",
		status: "active",
		owner_email: OWNER_EMAIL,
	});
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const created = await stub.fetch("https://mailbox-do/drafts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			to: ["stranger@example.net"],
			subject: "Hola",
			bodyText,
			bodyHtml: "<p>cuerpo</p>",
			origin: "mcp",
		}),
	});
	const { id } = (await created.json()) as { id: string };
	const armed = await stub.fetch(`https://mailbox-do/drafts/${id}/request-send`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mailboxAddress: address, displayName: "Owner" }),
	});
	const frozen = (await armed.json()) as { payload_hash?: string };
	expect(frozen.payload_hash).toMatch(/^[a-f0-9]{64}$/);
	return { mailboxId, draftId: id, payloadHash: frozen.payload_hash ?? "", stub };
}

async function sendIntent(label: string) {
	const draft = await mcpDraft(label);
	const intent = await createIntent(shared, {
		kind: "send",
		origin: "mcp",
		mailboxId: draft.mailboxId,
		draftId: draft.draftId,
		payloadHash: draft.payloadHash,
		oauthClientId: "client",
		tokenSub: owner.userId,
		tokenJti: "jti",
	});
	return { draft, intent };
}

async function messageCount(stub: DurableObjectStub): Promise<number> {
	return runInDurableObject(
		stub,
		async (_i, state) => state.storage.sql.exec("SELECT id FROM messages").toArray().length,
	);
}

async function sentRows(draftId: string) {
	return (
		await db
			.prepare(
				"SELECT intent_id, approval_channel FROM outbound_sends WHERE draft_id = ? AND status = 'sent'",
			)
			.bind(draftId)
			.all<{ intent_id: string; approval_channel: string }>()
	).results;
}

const ownerAuth = () => ({ userId: owner.userId, email: OWNER_EMAIL, owners: [OWNER_EMAIL] });

/** The owner's browser posting to the approval API, as the web page does. */
async function webPost(path: string, body: unknown): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				cookie: owner.jar.header(),
			},
			body: JSON.stringify(body),
		}),
		shared,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	expect(response.status, await response.clone().text()).toBe(200);
	return response;
}

describe("telegram notices for MCP approval requests", () => {
	const legacy = (id: string, hash: string, verb: "ia" | "ix") =>
		`${verb}:${id}:${hash.slice(0, 8)}`;

	// Every request here is left pending on purpose; close them so the per-owner
	// cap on pending approvals does not leak into the tests after this block.
	afterEach(async () => {
		await db
			.prepare(
				"UPDATE approvals SET consumed_at = ?, decision = 'denied' WHERE decision IS NULL AND consumed_at IS NULL",
			)
			.bind(new Date().toISOString())
			.run();
	});

	it("the old approve/deny callbacks do nothing: Telegram can no longer approve or deny", async () => {
		const { draft, intent } = await sendIntent("no telegram approval");
		for (const verb of ["ia", "ix"] as const) {
			const calls = await press(legacy(intent.id, intent.payloadHash, verb));
			expect(calls.some((call) => call.method === "editMessageText")).toBe(false);
			expect(calls.some((call) => call.method === "sendMessage")).toBe(false);
		}
		expect((await getIntentStatus(shared, intent.id)).status).toBe("pending");
		expect(await messageCount(draft.stub)).toBe(0);
		expect(await sentRows(draft.draftId)).toEqual([]);
	});

	it("a send approval request gets one notice with the web link and no ✅/❌ buttons", async () => {
		const { intent } = await sendIntent("notice");
		const calls = stubTelegram();
		queued.length = 0;
		await notifyIntentCreated(shared, intent.id);
		// Nothing is sent inline: the notice goes through the notify queue, plus one
		// delayed message timed just past the 10-minute expiry.
		expect(calls).toHaveLength(0);
		expect(queued).toHaveLength(2);
		const delayed = queued.find((item) => item.delaySeconds !== undefined);
		expect(delayed?.delaySeconds).toBeGreaterThan(590);
		expect(delayed?.delaySeconds).toBeLessThanOrEqual(606);
		await deliverQueued((item) => item.delaySeconds === undefined);
		const sent = calls.filter((call) => call.method === "sendMessage");
		expect(sent).toHaveLength(1);
		const body = sent[0]!.body as {
			text: string;
			reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>> };
		};
		const buttons = body.reply_markup.inline_keyboard.flat();
		expect(buttons.some((button) => button.callback_data !== undefined)).toBe(false);
		expect(buttons.map((button) => button.url)).toEqual([`${ORIGIN}/approve/${intent.id}`]);
		// The URL is carried once, by the button.
		expect(body.text).not.toContain(`${ORIGIN}/approve/${intent.id}`);
		expect(body.text).toMatch(/Caduca a las \d{2}:\d{2} \(UTC\)/);
	});

	it("goes to the mailbox's topic when the request concerns a mailbox", async () => {
		const { draft, intent } = await sendIntent("topic");
		await db
			.prepare(
				"INSERT INTO telegram_topics (chat_id, mailbox_id, topic_id, created_at) VALUES (?, ?, 314, ?)",
			)
			.bind(CHAT, draft.mailboxId, new Date().toISOString())
			.run();
		const calls = stubTelegram();
		queued.length = 0;
		await notifyIntentCreated(shared, intent.id);
		await deliverQueued((item) => item.delaySeconds === undefined);
		expect(calls.find((call) => call.method === "sendMessage")?.body.message_thread_id).toBe(314);
	});

	it("is edited in place when the request is denied, approved or expires — and only once", async () => {
		const notice = async (label: string) => {
			const { intent } = await sendIntent(label);
			stubTelegram();
			queued.length = 0;
			await notifyIntentCreated(shared, intent.id);
			await deliverQueued((item) => item.delaySeconds === undefined);
			return intent;
		};
		const editsOf = (calls: TelegramCall[]) =>
			calls.filter((call) => call.method === "editMessageText");

		// Denied on the web: the route queues the sync, the consumer edits the notice.
		const denied = await notice("deny me");
		await webPost(`/api/approvals/${denied.id}/deny`, {});
		let calls = stubTelegram();
		await deliverQueued();
		expect(editsOf(calls)).toHaveLength(1);
		expect(String(editsOf(calls)[0]!.body.text)).toContain("Denegado");
		// Decided notices keep no button at all.
		expect(editsOf(calls)[0]!.body.reply_markup).toBeUndefined();

		// Approved on the web.
		const approved = await notice("approve me");
		await webPost(`/api/approvals/${approved.id}/approve`, {
			payloadHash: approved.payloadHash,
		});
		calls = stubTelegram();
		await deliverQueued();
		expect(String(editsOf(calls)[0]?.body.text)).toContain("Aprobado");

		// Expired: the delayed message (or the hourly sweep) redraws it.
		const expired = await notice("let me expire");
		await db
			.prepare("UPDATE approvals SET expires_at = ? WHERE token = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), expired.id)
			.run();
		calls = stubTelegram();
		await syncApprovalNotice(shared, { approvalId: expired.id });
		expect(String(editsOf(calls)[0]?.body.text)).toContain("Caducado");

		// A redelivery changes nothing: the drawn state already matches.
		calls = stubTelegram();
		await syncApprovalNotice(shared, { approvalId: expired.id });
		expect(calls).toHaveLength(0);
	});

	it("the hourly sweep catches a notice whose expiry message was lost", async () => {
		const { intent } = await sendIntent("sweep");
		stubTelegram();
		queued.length = 0;
		await notifyIntentCreated(shared, intent.id);
		await deliverQueued((item) => item.delaySeconds === undefined);
		await db
			.prepare("UPDATE approvals SET expires_at = ? WHERE token = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), intent.id)
			.run();
		const calls = stubTelegram();
		expect(await reconcileApprovalNotices(shared)).toBeGreaterThanOrEqual(1);
		expect(
			calls.some(
				(call) => call.method === "editMessageText" && String(call.body.text).includes("Caducado"),
			),
		).toBe(true);
	});

	it("/approvals lists pending requests with link buttons only", async () => {
		const { intent } = await sendIntent("listed");
		const calls = stubTelegram();
		const ctx = createExecutionContext();
		await worker.fetch(
			new Request("https://reccado.test/telegram/webhook", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": webhookSecret,
				},
				body: JSON.stringify({
					update_id: Math.floor(Math.random() * 1e9),
					message: {
						message_id: 501,
						chat: { id: Number(CHAT), type: "private" },
						from: { id: Number(OPERATOR) },
						text: "/approvals",
					},
				}),
			}),
			shared,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		const sent = calls.find((call) => call.method === "sendMessage");
		expect(String(sent?.body.text)).toContain("pendiente");
		expect(String(sent?.body.text)).toContain("caduca a las");
		const markup = JSON.stringify(sent?.body.reply_markup);
		expect(markup).toContain(`${ORIGIN}/approve/${intent.id}`);
		expect(markup).not.toContain("callback_data");
	});

	it("a critical control-plane request gets a notice; a direct change sends nothing", async () => {
		await insertMailbox(db, {
			mailbox_id: "mbx_tg_notice",
			primary_address: "k@tg-notice.example",
			display_name: null,
			status: "active",
			owner_email: OWNER_EMAIL,
		});
		const principal = { tokenSub: owner.userId, oauthClientId: "client" };
		const direct = await requestControlPlaneChange(
			shared,
			ownerAuth(),
			"mailbox_update",
			{ mailboxId: "mbx_tg_notice", body: { displayName: "Notice" } },
			principal,
		);
		expect(direct.applied?.status).toBe("applied");
		const calls = stubTelegram();
		const pendingIntent = await requestControlPlaneChange(
			shared,
			ownerAuth(),
			"api_key_create",
			{
				mailboxId: "mbx_tg_notice",
				body: {
					environment: "test",
					sender: "k@tg-notice.example",
					scopes: ["transactional:status"],
				},
			},
			principal,
		);
		expect(pendingIntent.applied).toBeUndefined();
		queued.length = 0;
		await notifyIntentCreated(shared, pendingIntent.id);
		await deliverQueued((item) => item.delaySeconds === undefined);
		const sent = calls.filter((call) => call.method === "sendMessage");
		expect(sent).toHaveLength(1);
		expect(JSON.stringify(sent[0]!.body.reply_markup)).toContain(
			`${ORIGIN}/approve/${pendingIntent.id}`,
		);
		expect(JSON.stringify(sent[0]!.body)).not.toContain("callback_data");
	});
});

describe("control plane approval on the web", () => {
	it("an API key change executes only on the owner's web page, which shows the secret exactly once", async () => {
		await insertMailbox(db, {
			mailbox_id: "mbx_tg_key",
			primary_address: "k@tg-key.example",
			display_name: null,
			status: "active",
			owner_email: OWNER_EMAIL,
		});
		const intent = await requestControlPlaneChange(
			shared,
			ownerAuth(),
			"api_key_create",
			{
				mailboxId: "mbx_tg_key",
				body: { environment: "test", sender: "k@tg-key.example", scopes: ["transactional:status"] },
			},
			{ tokenSub: owner.userId, oauthClientId: "client" },
		);
		const pressed = await press(`ia:${intent.id}:${intent.payloadHash.slice(0, 8)}`);
		expect(pressed.some((call) => call.method === "editMessageText")).toBe(false);
		expect((await getIntentStatus(shared, intent.id)).status).toBe("pending");
		const row = await db
			.prepare("SELECT decision, result_json FROM approvals WHERE token = ?")
			.bind(intent.id)
			.first<{ decision: string | null; result_json: string | null }>();
		expect(row).toEqual({ decision: null, result_json: null });

		const approveWeb = async () => {
			const ctx = createExecutionContext();
			const response = await worker.fetch(
				new Request(`${ORIGIN}/api/approvals/${intent.id}/approve`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: ORIGIN,
						cookie: owner.jar.header(),
					},
					body: JSON.stringify({ payloadHash: intent.payloadHash }),
				}),
				shared,
				ctx,
			);
			await waitOnExecutionContext(ctx);
			return response;
		};
		const approved = await approveWeb();
		const body = (await approved.json()) as { status?: string; reveal?: Array<{ value: string }> };
		expect(approved.status, JSON.stringify(body)).toBe(200);
		expect(body.status).toBe("executed");
		const secret = body.reveal?.[0]?.value ?? "";
		expect(secret).toMatch(/^rck_test_/);
		const again = await approveWeb();
		const repeat = (await again.json()) as { reveal?: unknown };
		expect(repeat.reveal).toBeUndefined();
		expect(JSON.stringify(repeat)).not.toContain(secret);
	});
});

describe("web approval route", () => {
	async function post(
		path: string,
		init: { origin?: string | null; cookie?: string; body: unknown },
	) {
		const headers = new Headers({ "content-type": "application/json" });
		if (init.origin !== null) headers.set("origin", init.origin ?? ORIGIN);
		if (init.cookie) headers.set("cookie", init.cookie);
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: JSON.stringify(init.body) }),
			shared,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		return response;
	}

	it("needs the owner session and a matching Origin, and approves with them", async () => {
		const { draft, intent } = await sendIntent("web");
		const path = `/api/approvals/${intent.id}/approve`;
		const body = { payloadHash: intent.payloadHash };

		expect((await post(path, { body })).status).toBe(401);
		expect(
			(await post(path, { body, cookie: owner.jar.header(), origin: "https://evil.example" }))
				.status,
		).toBe(403);
		expect((await post(path, { body, cookie: owner.jar.header(), origin: null })).status).toBe(403);
		expect((await getIntentStatus(shared, intent.id)).status).toBe("pending");

		const wrong = await post(path, {
			body: { payloadHash: "0".repeat(64) },
			cookie: owner.jar.header(),
		});
		expect(wrong.status).toBe(409);
		expect(await messageCount(draft.stub)).toBe(0);

		const ok = await post(path, { body, cookie: owner.jar.header() });
		expect(ok.status).toBe(200);
		expect(((await ok.json()) as { status: string }).status).toBe("sent");
		expect(await messageCount(draft.stub)).toBe(1);
	});

	it("denies with the owner session only", async () => {
		const { intent } = await sendIntent("web deny");
		const path = `/api/approvals/${intent.id}/deny`;
		expect((await post(path, { body: {} })).status).toBe(401);
		expect((await post(path, { body: {}, cookie: owner.jar.header() })).status).toBe(200);
		expect((await getIntentStatus(shared, intent.id)).status).toBe("denied");
	});
});
