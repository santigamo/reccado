import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { insertMailbox } from "#/db/d1";
import {
	approveIntent,
	createIntent,
	denyIntent,
	fieldsFromSnapshot,
	getIntentStatus,
	getOrCreatePendingIntent,
	getIntentView,
	readFrozen,
	requestControlPlaneChange,
} from "#/lib/approvals";
import { sha256Hex } from "#/lib/crypto";
import { LINK_TARGETS_STYLE } from "#/lib/email-html";
import { OUTGOING_FONT_STYLE } from "#/lib/rich-text";
import { McpMailboxFacade } from "../../src/mcp/mailbox-facade";
import { confirmDraftSend } from "#/lib/outbound-send";
import { renderApprovalPage } from "#/components/approval-page";
import worker from "../../src/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import { McpServer, createMcpHandler, type ServerContext } from "@modelcontextprotocol/server";
import { registerSendTool } from "../../src/mcp/send-tool";
import { makeIntentCodec } from "../../src/mcp/intent-flow";
import * as notification from "../../src/telegram/notify";
import { vi } from "vitest";
import { applyMigrations } from "../helpers/migrations";

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const AGENT_SUMMARY = "AGENT_SUMMARY_DO_NOT_SHOW";

beforeAll(async () => {
	await applyMigrations(
		db,
		migrationInitial,
		migrationMessageIndex,
		migrationOwnerColumn,
		migrationTelegram,
		migrationOutbound,
		migrationRuntimeConfig,
		migrationOwnerRegistry,
		migrationBetterAuth,
		migrationBetterAuthMcp,
		migrationTwoFactor,
		migrationAuthUpgrade,
		migrationApprovals,
		migrationAudit,
		migrationApprovalMeta,
		migrationIntentPayload,
		migrationPendingUnique,
	);
	await db
		.prepare(
			"INSERT INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', ?, ?)",
		)
		.bind(ORIGIN, new Date().toISOString())
		.run();
});

function authEnv(): Env {
	return { ...env, BETTER_AUTH_SECRET: TEST_SECRET } as Env;
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

async function pair(email: string): Promise<Jar> {
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
		authEnv(),
	);
	jar.absorb(response);
	expect(response.status, await response.clone().text()).toBe(200);
	return jar;
}

async function registerOwner(email: string): Promise<{ userId: string; jar: Jar }> {
	const jar = await pair(email);
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return { userId: user?.id ?? "", jar };
}

/** Web approval as the owner (the session was already checked at the route). */
async function webApprove(
	target: Env,
	owner: { userId: string },
	intent: { id: string; payloadHash?: string },
) {
	const stored = await db
		.prepare("SELECT payload_hash FROM approvals WHERE token = ?")
		.bind(intent.id)
		.first<{ payload_hash: string }>();
	return approveIntent(target, {
		id: intent.id,
		payloadHash: intent.payloadHash ?? stored?.payload_hash ?? "",
		channel: "web",
		approver: owner.userId,
	});
}

describe("control-plane approvals", () => {
	it("refuses another owner at render and execution", async () => {
		const first = await registerOwner("control-first@example.com");
		const second = await registerOwner("control-second@example.com");
		await insertMailbox(db, {
			mailbox_id: "mbx_control_private",
			primary_address: "private-control@example.com",
			display_name: "Private",
			status: "active",
			owner_email: "control-first@example.com",
		});
		// api_key_create needs approval (it issues a secret), so it pends and the second owner is refused at the page.
		const intent = await requestControlPlaneChange(
			env,
			{
				userId: first.userId,
				email: "control-first@example.com",
				owners: ["control-first@example.com"],
			},
			"api_key_create",
			{
				mailboxId: "mbx_control_private",
				body: {
					environment: "test",
					sender: "private-control@example.com",
					scopes: ["transactional:status"],
				},
			},
		);
		expect(intent.applied).toBeUndefined();
		const view = await getIntentView(env, intent.id, { userId: second.userId });
		expect(view.status).toBe("stale");
		expect(view.fields).toEqual([]);
		const result = await webApprove(env, { userId: second.userId }, { id: intent.id });
		expect(result.error).toBe("forbidden");
		expect((await getIntentStatus(env, intent.id)).status).toBe("pending");
	});
	it("applies direct kinds immediately with a snapshot and refuses other owners", async () => {
		const email = "control-owner@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email] };
		const input = { primaryAddress: "control-create@example.com", displayName: "Initial" };
		const created = await requestControlPlaneChange(env, auth, "mailbox_create", input);
		expect(created.applied?.status).toBe("applied");
		const mailbox = await db
			.prepare("SELECT * FROM mailboxes WHERE primary_address = ?")
			.bind(input.primaryAddress)
			.first<{ mailbox_id: string }>();
		expect(mailbox).not.toBeNull();
		const disabled = await requestControlPlaneChange(env, auth, "mailbox_disable", {
			mailboxId: mailbox!.mailbox_id,
		});
		expect(disabled.applied?.status).toBe("applied");
		expect(
			await db
				.prepare("SELECT status FROM mailboxes WHERE mailbox_id = ?")
				.bind(mailbox!.mailbox_id)
				.first(),
		).toMatchObject({ status: "disabled" });
		const snapshot = await db
			.prepare(
				"SELECT id, payload_json FROM ops_events WHERE event_type = 'admin.before_snapshot' AND subject = ?",
			)
			.bind(mailbox!.mailbox_id)
			.first<{ id: string; payload_json: string }>();
		expect(JSON.parse(snapshot!.payload_json)).toMatchObject({
			status: "active",
			display_name: "Initial",
		});
		expect(disabled.applied?.snapshotIds).toContain(snapshot!.id);
		const event = await db
			.prepare(
				"SELECT payload_json FROM ops_events WHERE event_type = 'admin.applied' AND subject = 'mailbox_disable'",
			)
			.first<{ payload_json: string }>();
		expect(JSON.parse(event!.payload_json)).toMatchObject({
			kind: "mailbox_disable",
			outcome: "applied",
			approver_user_id: owner.userId,
		});
		// A non-owner is refused before anything runs.
		await expect(
			requestControlPlaneChange(env, { ...auth, email: "other@example.com" }, "mailbox_disable", {
				mailboxId: mailbox!.mailbox_id,
			}),
		).rejects.toBeTruthy();
		const foreignMailbox = await requestControlPlaneChange(env, auth, "mailbox_disable", {
			mailboxId: "mbx_not_mine",
		});
		expect(foreignMailbox.applied).toMatchObject({ status: "failed" });
		await expect(requestControlPlaneChange(env, auth, "unknown_kind", {})).rejects.toThrow();
		await expect(
			requestControlPlaneChange(env, auth, "mailbox_create", [
				{ primaryAddress: "batch@example.com" },
			]),
		).rejects.toThrow();
	});
	it("executes an approval once and rejects payload tampering", async () => {
		const email = "control-approve@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email] };
		const intent = await requestControlPlaneChange(env, auth, "domain_add", {
			domain: "control-once.example",
			zoneId: "z1",
		});
		expect(intent.applied).toBeUndefined();
		const row = () =>
			db.prepare("SELECT id FROM domains WHERE domain = 'control-once.example'").first();
		expect(await row()).toBeNull();
		expect((await webApprove(env, { userId: owner.userId }, { id: intent.id })).status).toBe(
			"executed",
		);
		expect((await webApprove(env, { userId: owner.userId }, { id: intent.id })).status).toBe(
			"executed",
		);
		expect(await row()).not.toBeNull();
		const next = await requestControlPlaneChange(env, auth, "domain_add", {
			domain: "control-tamper.example",
			zoneId: "z2",
		});
		const view = await getIntentView(env, next.id, { userId: owner.userId });
		expect(renderApprovalPage(view)).toContain("control-tamper.example");
		await db
			.prepare("UPDATE approvals SET payload_json = ? WHERE token = ?")
			.bind('{"domain":"evil.example","zoneId":"x"}', next.id)
			.run();
		expect((await webApprove(env, { userId: owner.userId }, { id: next.id })).status).toBe("stale");
		expect(
			await db.prepare("SELECT id FROM domains WHERE domain = 'evil.example'").first(),
		).toBeNull();
	});
});

async function mcpDraft(bodyText: string) {
	const mailboxId = `mbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
	const address = `${mailboxId}@imsanti.dev`;
	await insertMailbox(db, {
		mailbox_id: mailboxId,
		primary_address: address,
		display_name: "Owner",
		status: "active",
		owner_email: null,
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
	expect(created.status, await created.clone().text()).toBe(201);
	const { id } = (await created.json()) as { id: string };
	const armed = await stub.fetch(`https://mailbox-do/drafts/${id}/request-send`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mailboxAddress: address, displayName: "Owner" }),
	});
	const frozen = (await armed.json()) as { payload_hash?: string; error?: string };
	expect(frozen.payload_hash, JSON.stringify(frozen)).toMatch(/^[a-f0-9]{64}$/);
	return { mailboxId, draftId: id, payloadHash: frozen.payload_hash ?? "", stub };
}

async function messageCount(stub: DurableObjectStub): Promise<number> {
	return runInDurableObject(
		stub,
		async (_instance, state) => state.storage.sql.exec("SELECT id FROM messages").toArray().length,
	);
}

async function sentRows(draftId: string) {
	const result = await db
		.prepare(
			`SELECT status, approval_channel, intent_id, payload_hash, oauth_client_id, token_sub, token_jti
       FROM outbound_sends WHERE draft_id = ? AND status = 'sent'`,
		)
		.bind(draftId)
		.all<{
			status: string;
			approval_channel: string | null;
			intent_id: string | null;
			payload_hash: string | null;
			oauth_client_id: string | null;
			token_sub: string | null;
			token_jti: string | null;
		}>();
	return result.results;
}

describe("mcp send approval", () => {
	it("replaces an expired pending intent while retaining its expired status", async () => {
		const draft = await mcpDraft("expired intent");
		const input = {
			kind: "send" as const,
			origin: "mcp" as const,
			mailboxId: draft.mailboxId,
			draftId: draft.draftId,
			payloadHash: draft.payloadHash,
		};
		const first = await getOrCreatePendingIntent(env as Env, input);
		await db
			.prepare("UPDATE approvals SET expires_at = ? WHERE token = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), first.intent.id)
			.run();
		const second = await getOrCreatePendingIntent(env as Env, input);
		expect(second.created).toBe(true);
		expect(second.intent.id).not.toBe(first.intent.id);
		expect((await getIntentStatus(env as Env, first.intent.id)).status).toBe("expired");
	});
	it("rejects a tampered requestState at the SDK seam", async () => {
		const codec = await makeIntentCodec(TEST_SECRET, "sdk-owner");
		const auth = { userId: "sdk-owner", email: "sdk@example.com", scopes: new Set(["mail:send"]) };
		const handler = createMcpHandler(
			(context) => {
				const server = new McpServer(
					{ name: "test", version: "1" },
					{ requestState: { verify: codec.verify } },
				);
				registerSendTool(server, env as Env, auth, "http://localhost", { era: context.era, codec });
				return server;
			},
			{ legacy: "stateless" },
		);
		const state = await codec.mint({ intentId: "intent" }, { mcpReq: {} } as ServerContext);
		const response = await handler.fetch(
			new Request("http://localhost/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					"mcp-protocol-version": "2026-07-28",
					"mcp-method": "tools/call",
					"mcp-name": "send",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "send",
						arguments: { mailboxId: "m", draftId: "d" },
						requestState: `${state}tampered`,
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
						},
					},
				}),
			}),
		);
		const raw = await response.text();
		expect(raw).toContain("Invalid or expired requestState");
		expect(raw).toContain("invalid_request_state");
	});
	it("enforces scope and draft ownership, and reports legacy pending and stale status", async () => {
		const email = "legacy-send@example.com";
		const draft = await mcpDraft("legacy");
		await db
			.prepare("UPDATE mailboxes SET owner_email = ? WHERE mailbox_id = ?")
			.bind(email, draft.mailboxId)
			.run();
		const codec = await makeIntentCodec(TEST_SECRET, email);
		const makeHandler = (scopes: string[]) => {
			const server = new McpServer({ name: "test", version: "1" });
			registerSendTool(
				server,
				env as Env,
				{ userId: email, email, scopes: new Set(scopes) },
				ORIGIN,
				{ era: "legacy", codec },
			);
			return (
				server as unknown as {
					_registeredTools: Record<
						string,
						{ handler: (args: object, ctx: ServerContext) => Promise<Record<string, unknown>> }
					>;
				}
			)._registeredTools.send?.handler;
		};
		const params = { mailboxId: draft.mailboxId, draftId: draft.draftId };
		const ctx = { mcpReq: { requestState: () => undefined } } as unknown as ServerContext;
		// Without mail:send the tool is not even registered (scope-filtered tools/list).
		expect(makeHandler([])).toBeUndefined();
		expect(
			await db
				.prepare("SELECT token FROM approvals WHERE draft_id = ?")
				.bind(draft.draftId)
				.first(),
		).toBeNull();
		const handler = makeHandler(["mail:send"])!;
		await runInDurableObject(draft.stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET origin = 'web' WHERE id = ?",
				draft.draftId,
			);
		});
		expect(JSON.stringify(await handler(params, ctx))).toContain("draft_not_agent_owned");
		await runInDurableObject(draft.stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET origin = 'mcp' WHERE id = ?",
				draft.draftId,
			);
		});
		const first = await handler(params, ctx);
		const result = first.structuredContent as {
			status: string;
			intentId: string;
			approvalUrl: string;
		};
		expect(result).toMatchObject({
			status: "pending",
			approvalUrl: `${ORIGIN}/approve/${result.intentId}`,
		});
		expect((await handler(params, ctx)).structuredContent).toMatchObject({
			intentId: result.intentId,
		});
		expect(
			(await handler({ ...params, intentId: result.intentId }, ctx)).structuredContent,
		).toMatchObject({ status: "pending" });
		await draft.stub.fetch(`https://mailbox-do/drafts/${draft.draftId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bodyText: "changed" }),
		});
		expect(
			(await handler({ ...params, intentId: result.intentId }, ctx)).structuredContent,
		).toMatchObject({ status: "stale" });
	});
	it("shares a pending intent across concurrent MCP requests and completes after human approval", async () => {
		const owner = await registerOwner("mcp-tool-owner@example.com");
		const draft = await mcpDraft("Tool send");
		await db
			.prepare("UPDATE mailboxes SET owner_email = ? WHERE mailbox_id = ?")
			.bind("mcp-tool-owner@example.com", draft.mailboxId)
			.run();
		const auth = {
			userId: owner.userId,
			email: "mcp-tool-owner@example.com",
			scopes: new Set(["mail:send"]),
			oauthClientId: "client",
			tokenSub: owner.userId,
			tokenJti: "jti",
		};
		const codec = await makeIntentCodec(TEST_SECRET, owner.userId);
		const server = new McpServer(
			{ name: "test", version: "1" },
			{ requestState: { verify: codec.verify } },
		);
		registerSendTool(server, env as Env, auth, ORIGIN, { era: "modern", codec });
		const handler = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: object, ctx: ServerContext) => Promise<Record<string, unknown>> }
				>;
			}
		)._registeredTools.send!.handler;
		const params = { mailboxId: draft.mailboxId, draftId: draft.draftId };
		const context = (state?: unknown) =>
			({ mcpReq: { requestState: () => state } }) as unknown as ServerContext;
		const notify = vi
			.spyOn(notification, "notifyIntentCreated")
			.mockRejectedValue(new Error("offline"));
		try {
			const [a, b] = await Promise.all([handler(params, context()), handler(params, context())]);
			expect(a.resultType).toBe("input_required");
			const first = await codec.verify(a.requestState as string, context());
			const second = await codec.verify(b.requestState as string, context());
			expect(first.intentId).toBe(second.intentId);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(a)).toContain(`/approve/${first.intentId}`);
			expect(JSON.stringify(a)).toContain("Aprueba el envío en Telegram o revísalo en example.com");
			const pending = await handler(params, context(first));
			expect(pending.resultType).toBe("input_required");
			const shared = env as Env;
			const oldSecret = shared.BETTER_AUTH_SECRET;
			shared.BETTER_AUTH_SECRET = TEST_SECRET;
			try {
				expect(
					(await webApprove(shared, { userId: owner.userId }, { id: first.intentId })).status,
				).toBe("sent");
			} finally {
				shared.BETTER_AUTH_SECRET = oldSecret;
			}
			const sent = await handler(params, context(first));
			expect(sent.structuredContent).toMatchObject({ status: "sent", intentId: first.intentId });
			expect(await messageCount(draft.stub)).toBe(1);
			expect(await sentRows(draft.draftId)).toHaveLength(1);
		} finally {
			notify.mockRestore();
		}
	});
	it("shows the frozen mail escaped and drops any agent summary", () => {
		const extracted = fieldsFromSnapshot({
			identity: { from: "owner@imsanti.dev", fromName: "Owner", replyTo: null },
			to: ["stranger@example.net"],
			subject: "Hola",
			text: "visible",
			summary: AGENT_SUMMARY,
			agentSummary: AGENT_SUMMARY,
		});
		expect(JSON.stringify(extracted)).not.toContain(AGENT_SUMMARY);
		const html = renderApprovalPage({
			title: "Revisar envío",
			status: "pending",
			fields: [{ label: "Mensaje", value: "<script>alert(1)</script>" }],
			warnings: [{ message: "fuera" }],
		});
		expect(html).not.toContain("<script");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain(AGENT_SUMMARY);
	});

	it("refuses web confirm-send and a telegram-mode confirm, and sends once on web approval", async () => {
		const owner = await registerOwner("approve-once@example.com");
		const draft = await mcpDraft(`Hola <script>alert(1)</script> ${AGENT_SUMMARY}`);
		const intent = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId: draft.mailboxId,
			draftId: draft.draftId,
			payloadHash: draft.payloadHash,
			oauthClientId: "oauth-client",
			tokenSub: owner.userId,
			tokenJti: "token-jti",
		});

		const ctx = createExecutionContext();
		const web = await worker.fetch(
			new Request(
				`${ORIGIN}/api/mailboxes/${draft.mailboxId}/drafts/${draft.draftId}/confirm-send`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: ORIGIN,
						cookie: owner.jar.header(),
					},
					body: JSON.stringify({ idempotencyKey: "web-attempt" }),
				},
			),
			authEnv(),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(web.status).toBe(409);
		expect(await web.json()).toMatchObject({ error: "approval_required", sent: false });

		const telegram = await confirmDraftSend(env, {
			mailboxId: draft.mailboxId,
			draftId: draft.draftId,
			attemptKey: "telegram-attempt",
			approvalMode: "telegram_confirmed",
			expectedPayloadHash: draft.payloadHash,
		});
		expect(telegram.status).toBe(409);
		expect(telegram.body.error).toBe("approval_required");

		const unapproved = await confirmDraftSend(env, {
			mailboxId: draft.mailboxId,
			draftId: draft.draftId,
			attemptKey: "forged-proof",
			expectedPayloadHash: draft.payloadHash,
			approval: { intentId: intent.id, payloadHash: draft.payloadHash },
		});
		expect(unapproved.body.error).toBe("approval_required");
		expect(await messageCount(draft.stub)).toBe(0);

		const view = await getIntentView(env, intent.id, { userId: owner.userId });
		expect(view.title).toBe("Revisar envío");
		expect(view.fields.some((field) => field.value.includes(AGENT_SUMMARY))).toBe(true);
		expect(view.fields.some((field) => field.label.toLowerCase().includes("resumen"))).toBe(false);
		expect(JSON.stringify(view.warnings)).not.toContain(AGENT_SUMMARY);
		const page = renderApprovalPage(view);
		expect(page).not.toContain("<script");
		expect(page).toContain("&lt;script&gt;");
		expect(page).not.toContain("oauth-client");

		const missingOrigin = await worker.fetch(
			new Request(`${ORIGIN}/api/approvals/${intent.id}/approve`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: owner.jar.header() },
				body: JSON.stringify({ payloadHash: draft.payloadHash }),
			}),
			authEnv(),
			createExecutionContext(),
		);
		expect(missingOrigin.status).toBe(403);

		// The mailbox DO reads its own env, which is the isolate env. The signer has
		// to use that same object or the proof HMAC will not match.
		const shared = env as Env;
		const savedSecret = shared.BETTER_AUTH_SECRET;
		shared.BETTER_AUTH_SECRET = TEST_SECRET;
		const approvedCtx = createExecutionContext();
		let approved: Response;
		try {
			approved = await worker.fetch(
				new Request(`${ORIGIN}/api/approvals/${intent.id}/approve`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: ORIGIN,
						cookie: owner.jar.header(),
					},
					body: JSON.stringify({ payloadHash: draft.payloadHash }),
				}),
				shared,
				approvedCtx,
			);
			await waitOnExecutionContext(approvedCtx);
		} finally {
			shared.BETTER_AUTH_SECRET = savedSecret;
		}
		const approvedBody = (await approved.json()) as { status?: string; error?: string };
		expect(approved.status, JSON.stringify(approvedBody)).toBe(200);
		expect(approvedBody.status).toBe("sent");
		expect(await messageCount(draft.stub)).toBe(1);
		const rows = await sentRows(draft.draftId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			status: "sent",
			approval_channel: "mcp_approval",
			intent_id: intent.id,
			payload_hash: draft.payloadHash,
			oauth_client_id: "oauth-client",
			token_sub: owner.userId,
			token_jti: "token-jti",
		});

		const replay = await webApprove(env, { userId: owner.userId }, { id: intent.id });
		expect(replay.status).toBe("sent");
		expect(await messageCount(draft.stub)).toBe(1);
		expect(await sentRows(draft.draftId)).toHaveLength(1);
	});

	it("rejects a payload hash that is not the stored one", async () => {
		const owner = await registerOwner("binding@example.com");
		const first = await mcpDraft("one");
		const second = await mcpDraft("two");
		const intentB = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId: second.mailboxId,
			draftId: second.draftId,
			payloadHash: second.payloadHash,
		});
		const rejected = await webApprove(
			env,
			{ userId: owner.userId },
			{ id: intentB.id, payloadHash: first.payloadHash },
		);
		expect(rejected.error).toBe("stale");
		expect((await getIntentStatus(env, intentB.id)).status).toBe("pending");
		expect(await messageCount(second.stub)).toBe(0);
	});

	it("lets exactly one of two concurrent approvals send", async () => {
		const owner = await registerOwner("race@example.com");
		const draft = await mcpDraft("race");
		const intent = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId: draft.mailboxId,
			draftId: draft.draftId,
			payloadHash: draft.payloadHash,
		});
		const shared = env as Env;
		const savedSecret = shared.BETTER_AUTH_SECRET;
		shared.BETTER_AUTH_SECRET = TEST_SECRET;
		let left: Awaited<ReturnType<typeof webApprove>>;
		let right: Awaited<ReturnType<typeof webApprove>>;
		try {
			[left, right] = await Promise.all([
				webApprove(shared, owner, intent),
				webApprove(shared, owner, intent),
			]);
		} finally {
			shared.BETTER_AUTH_SECRET = savedSecret;
		}
		const winners = [left, right].filter(
			(result) => result.status === "sent" && !result.error && !result.resolved,
		);
		expect(winners).toHaveLength(1);
		expect(await messageCount(draft.stub)).toBe(1);
		expect(await sentRows(draft.draftId)).toHaveLength(1);
	});

	it("does not send an expired, stale, or denied intent", async () => {
		const owner = await registerOwner("terminal@example.com");
		const expiredDraft = await mcpDraft("expired");
		const expired = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId: expiredDraft.mailboxId,
			draftId: expiredDraft.draftId,
			payloadHash: expiredDraft.payloadHash,
		});
		await db
			.prepare("UPDATE approvals SET expires_at = ? WHERE token = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), expired.id)
			.run();
		const expiredResult = await webApprove(env, { userId: owner.userId }, { id: expired.id });
		expect(expiredResult.status).toBe("expired");
		expect(await messageCount(expiredDraft.stub)).toBe(0);

		const staleDraft = await mcpDraft("stale");
		const stale = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId: staleDraft.mailboxId,
			draftId: staleDraft.draftId,
			payloadHash: staleDraft.payloadHash,
		});
		const edited = await staleDraft.stub.fetch(`https://mailbox-do/drafts/${staleDraft.draftId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bodyText: "changed after the intent" }),
		});
		expect(edited.ok).toBe(true);
		const staleResult = await webApprove(env, { userId: owner.userId }, { id: stale.id });
		expect(staleResult.error).toBe("stale");
		expect(await messageCount(staleDraft.stub)).toBe(0);
		const stillOpen = await db
			.prepare("SELECT consumed_at FROM approvals WHERE token = ?")
			.bind(stale.id)
			.first<{ consumed_at: string | null }>();
		expect(stillOpen?.consumed_at).toBeNull();

		const deniedDraft = await mcpDraft("denied");
		const denied = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId: deniedDraft.mailboxId,
			draftId: deniedDraft.draftId,
			payloadHash: deniedDraft.payloadHash,
		});
		expect((await denyIntent(env, denied.id)).status).toBe("denied");
		const deniedResult = await webApprove(env, { userId: owner.userId }, { id: denied.id });
		expect(deniedResult.status).toBe("denied");
		expect(await messageCount(deniedDraft.stub)).toBe(0);
		expect((await getIntentStatus(env, "does-not-exist")).status).toBe("expired");
	});

	it("binds a Markdown draft's HTML into payload_hash, previews exactly it, and refuses it once changed", async () => {
		const email = "markdown-hash@example.com";
		const owner = await registerOwner(email);
		const mailboxId = `mbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		const address = `${mailboxId}@imsanti.dev`;
		await insertMailbox(db, {
			mailbox_id: mailboxId,
			primary_address: address,
			display_name: "Owner",
			status: "active",
			owner_email: email,
		});
		const facade = new McpMailboxFacade(env as Env, {
			userId: owner.userId,
			email,
			scopes: new Set(["mail:read", "mail:draft"]),
		});
		const { draft_id: draftId } = await facade.createDraft(mailboxId, {
			to: ["stranger@example.net"],
			subject: "Formatted",
			bodyMarkdown:
				"Hi **Ana**,\n\nSee [the doc](https://example.com/doc).\n\n<script>x()</script>",
			idempotencyKey: crypto.randomUUID(),
		});
		const stub = env.MAILBOX_DO.getByName(mailboxId);
		const stored = (await (await stub.fetch(`https://mailbox-do/drafts/${draftId}`)).json()) as {
			draft: { body_html: string; body_text: string; origin: string };
		};
		expect(stored.draft.origin).toBe("mcp");
		expect(stored.draft.body_html).toContain("<strong>Ana</strong>");
		expect(stored.draft.body_html).toContain('<a href="https://example.com/doc"');
		expect(stored.draft.body_html).not.toContain("<script");
		expect(stored.draft.body_text).toBe(
			"Hi Ana,\n\nSee the doc (https://example.com/doc).\n\n<script>x()</script>",
		);

		const armed = await stub.fetch(`https://mailbox-do/drafts/${draftId}/request-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mailboxAddress: address, displayName: "Owner" }),
		});
		const { payload_hash: payloadHash } = (await armed.json()) as { payload_hash: string };
		expect(payloadHash).toMatch(/^[a-f0-9]{64}$/);

		// The frozen payload carries the HTML, and the hash is over that payload:
		// the same snapshot with any other HTML hashes differently.
		const frozen = await readFrozen(env as Env, mailboxId, draftId);
		expect(frozen?.payloadHash).toBe(payloadHash);
		expect(frozen?.snapshot.html).toBe(stored.draft.body_html);
		const hashOf = async (snapshot: unknown) =>
			sha256Hex(new TextEncoder().encode(JSON.stringify(snapshot)));
		expect(await hashOf(frozen?.snapshot)).toBe(payloadHash);
		expect(
			await hashOf({
				...frozen?.snapshot,
				html: '<p>Hi <a href="https://evil.example">Ana</a></p>',
			}),
		).not.toBe(payloadHash);

		const intent = await createIntent(env, {
			kind: "send",
			origin: "mcp",
			mailboxId,
			draftId,
			payloadHash,
			tokenSub: owner.userId,
		});
		const view = await getIntentView(env, intent.id, { userId: owner.userId });
		expect(view.fields.find((field) => field.label === "HTML")?.value).toBe(stored.draft.body_html);

		const preview = (hash: string | null) =>
			worker.fetch(
				new Request(`${ORIGIN}/api/approvals/${intent.id}/html${hash ? `?hash=${hash}` : ""}`, {
					headers: { cookie: owner.jar.header() },
				}),
				authEnv(),
				createExecutionContext(),
			);
		const shown = await preview(payloadHash);
		expect(shown.status).toBe(200);
		expect(shown.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		const csp = shown.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("frame-ancestors 'self'");
		expect(csp).not.toContain("script-src");
		const body = await shown.text();
		// What goes on the wire: the frozen HTML inside the typography container…
		expect(body).toContain(`<div style="${OUTGOING_FONT_STYLE}"><p>Hi <strong>Ana</strong>`);
		// …with every link's target written out for the owner.
		expect(body).toContain(LINK_TARGETS_STYLE);
		expect(body).not.toContain("<script");
		// A different hash, or none for a stranger, shows nothing.
		expect((await preview("0".repeat(64))).status).toBe(404);
		const anonymous = await worker.fetch(
			new Request(`${ORIGIN}/api/approvals/${intent.id}/html`),
			authEnv(),
			createExecutionContext(),
		);
		expect(anonymous.status).toBe(401);

		// The HTML alone changes after the request was frozen: the request goes
		// stale, the preview disappears, and approving the shown hash sends nothing.
		const edited = await stub.fetch(`https://mailbox-do/drafts/${draftId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bodyHtml: '<p>Hi <a href="https://evil.example">Ana</a></p>' }),
		});
		expect(edited.ok).toBe(true);
		expect((await preview(payloadHash)).status).toBe(404);
		const result = await webApprove(env, { userId: owner.userId }, { id: intent.id, payloadHash });
		expect(result.error).toBe("stale");
		expect(await messageCount(stub)).toBe(0);
	});
});
