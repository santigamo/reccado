import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import {
	approvalChallenge,
	approveIntent,
} from "#/lib/approvals";
import type { AuthMailSender } from "#/lib/better-auth";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationKeys from "../../migrations/d1/0006_transactional_api_keys.sql?raw";
import migrationRequests from "../../migrations/d1/0007_transactional_requests.sql?raw";
import migrationEvents from "../../migrations/d1/0008_email_events_suppressions.sql?raw";
import migrationResolved from "../../migrations/d1/0015_transactional_resolved_via.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationPasskey from "../../migrations/d1/0024_passkey.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { insertMailbox } from "#/db/d1";
import { getIntentView } from "#/lib/approvals";
import { registerTools } from "../../src/mcp/tools";
import { makeIntentCodec } from "../../src/mcp/intent-flow";
import * as notification from "../../src/telegram/notify";
import { vi } from "vitest";
import { applyMigrations } from "../helpers/migrations";
import { SoftAuthenticator } from "../helpers/soft-authenticator";

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";

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
		migrationResolved,
		migrationRuntimeConfig,
		migrationOwnerRegistry,
		migrationBetterAuth,
		migrationBetterAuthMcp,
		migrationTwoFactor,
		migrationAuthUpgrade,
		migrationApprovals,
		migrationPasskey,
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

function stubMail(): AuthMailSender & { calls: Array<{ text: string }> } {
	const calls: Array<{ text: string }> = [];
	return {
		calls,
		async sendMail(message: { text: string }) {
			calls.push({ text: message.text });
		},
	} as AuthMailSender & { calls: Array<{ text: string }> };
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

async function registerOwner(
	email: string,
): Promise<{ userId: string; jar: Jar; authenticator: SoftAuthenticator }> {
	const jar = await pair(email);
	const mail = stubMail();
	const headers = { cookie: jar.header(), "content-type": "application/json", origin: ORIGIN };
	const started = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/passkey/step-up`, { method: "POST", headers, body: "{}" }),
		authEnv(),
		{ mailSender: mail },
	);
	jar.absorb(started);
	expect(started.status, await started.clone().text()).toBe(200);
	const code = mail.calls[0]?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
	const issued = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/passkey/step-up`, {
			method: "POST",
			headers,
			body: JSON.stringify({ code }),
		}),
		authEnv(),
	);
	jar.absorb(issued);
	expect(issued.status, await issued.clone().text()).toBe(200);
	const { proof } = (await issued.json()) as { proof: string };
	const optionsResponse = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/passkey/generate-register-options`, {
			headers: { cookie: jar.header(), origin: ORIGIN, "x-passkey-stepup": proof },
		}),
		authEnv(),
	);
	jar.absorb(optionsResponse);
	expect(optionsResponse.status, await optionsResponse.clone().text()).toBe(200);
	const options = (await optionsResponse.json()) as { challenge: string; rp: { id: string } };
	const authenticator = new SoftAuthenticator(options.rp.id, ORIGIN);
	const credential = await authenticator.registration(options.challenge);
	const verified = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/passkey/verify-registration`, {
			method: "POST",
			headers: {
				cookie: jar.header(),
				"content-type": "application/json",
				origin: ORIGIN,
				"x-passkey-stepup": proof,
			},
			body: JSON.stringify({ response: credential, name: "Approval key" }),
		}),
		authEnv(),
	);
	jar.absorb(verified);
	expect(verified.status, await verified.clone().text()).toBe(200);
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	const passkey = await db
		.prepare("SELECT credentialID FROM passkey WHERE userId = ?")
		.bind(user?.id)
		.first<{ credentialID: string }>();
	authenticator.storedId = passkey?.credentialID ?? null;
	return { userId: user?.id ?? "", jar, authenticator };
}


type Handler = (args: object, ctx: ServerContext) => Promise<Record<string, unknown>>;
async function handlerFor(tool: string, auth: Record<string, unknown>, era: "legacy" | "modern") {
	const codec = await makeIntentCodec(TEST_SECRET, String(auth.userId));
	const server = new McpServer({ name: "test", version: "1" }, { requestState: { verify: codec.verify } });
	registerTools(server, env as Env, auth as never, ORIGIN, { era, codec });
	const registered = (server as unknown as { _registeredTools: Record<string, { handler: Handler; annotations?: Record<string, unknown> }> })._registeredTools;
	return { handler: registered[tool]!.handler, registered, codec };
}
const context = (state?: unknown) => ({ mcpReq: { requestState: () => state } }) as unknown as ServerContext;
const ADMIN = ["mail:read", "admin"];
const approvals = async () => (await db.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n;

async function approve(owner: Awaited<ReturnType<typeof registerOwner>>, intentId: string) {
	const row = await db.prepare("SELECT payload_hash FROM approvals WHERE token = ?").bind(intentId).first<{ payload_hash: string }>();
	const assertion = await owner.authenticator.assertion(await approvalChallenge(intentId, row!.payload_hash), 1);
	return approveIntent(env, { id: intentId, userId: owner.userId, origin: ORIGIN, assertion });
}

describe("mcp admin tools", () => {
	it("lists the tools with admin-tier annotations", async () => {
		const { registered } = await handlerFor("manage_mailbox", { userId: "u", email: "list@example.com", scopes: new Set(ADMIN) }, "legacy");
		for (const name of ["manage_mailbox", "manage_domain", "manage_routing", "manage_template", "manage_api_key", "remove_suppression", "restore", "reconcile_stale"]) {
			expect(registered[name]?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
		}
		expect((registered.manage_api_key as unknown as { description: string }).description).toContain("never returned here");
	});

	it("denies without the admin scope and creates no intent", async () => {
		const auth = { userId: "u", email: "noscope@example.com", scopes: new Set(["mail:read"]) };
		const before = await approvals();
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const result = await handler({ action: "disable", mailboxId: "x" }, context());
		expect(JSON.stringify(result)).toContain("insufficient_scope: admin");
		expect(await approvals()).toBe(before);
	});

	it("rejects invalid actions and fields without creating an intent", async () => {
		const owner = await registerOwner("invalid-admin@example.com");
		const auth = { userId: owner.userId, email: "invalid-admin@example.com", owners: ["invalid-admin@example.com"], scopes: new Set(ADMIN) };
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const before = await approvals();
		for (const args of [{ action: "explode" }, { action: "create" }, { action: "create", primaryAddress: "a@b.co", extra: 1 }, { operations: [] }, { operations: Array.from({ length: 21 }, () => ({ action: "disable", mailboxId: "m" })) }]) {
			const result = await handler(args, context());
			expect(result.isError, JSON.stringify(args)).toBe(true);
		}
		expect(await approvals()).toBe(before);
	});

	it("asks legacy clients to approve, then returns the executed result", async () => {
		const email = "legacy-admin@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const args = { action: "create", primaryAddress: "mcp-created@example.com", displayName: "Agent" };
		const pending = (await handler(args, context())).structuredContent as { status: string; intentId: string; approvalUrl: string };
		expect(pending).toMatchObject({ status: "pending", approvalUrl: `${ORIGIN}/approve/${pending.intentId}` });
		expect((await approve(owner, pending.intentId)).status).toBe("executed");
		const done = (await handler({ intentId: pending.intentId }, context())).structuredContent as { status: string; result?: unknown };
		expect(done.status).toBe("executed");
		expect(await db.prepare("SELECT mailbox_id FROM mailboxes WHERE primary_address = ?").bind("mcp-created@example.com").first()).not.toBeNull();
	});

	it("elicits the approval URL for modern clients and completes on retry", async () => {
		const email = "modern-admin@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
		const { handler, codec } = await handlerFor("manage_mailbox", auth, "modern");
		const notify = vi.spyOn(notification, "notifyIntentCreated").mockRejectedValue(new Error("offline"));
		try {
			const args = { action: "create", primaryAddress: "modern-created@example.com" };
			const first = await handler(args, context());
			expect(first.resultType).toBe("input_required");
			const state = await codec.verify(first.requestState as string, context());
			expect(JSON.stringify(first)).toContain(`/approve/${state.intentId}`);
			expect(JSON.stringify(first)).toContain("Revisa y aprueba el cambio en example.com");
			expect((await handler(args, context(state))).resultType).toBe("input_required");
			expect((await approve(owner, state.intentId)).status).toBe("executed");
			const done = await handler(args, context(state));
			expect(done.structuredContent).toMatchObject({ status: "executed", intentId: state.intentId });
		} finally { notify.mockRestore(); }
	});

	it("batches operations into one intent with per-item results", async () => {
		const email = "batch-admin@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const before = await approvals();
		const pending = (await handler({ operations: [
			{ action: "create", primaryAddress: "batch-a@example.com" },
			{ action: "create", primaryAddress: "batch-b@example.com" },
		] }, context())).structuredContent as { intentId: string };
		expect(await approvals()).toBe(before + 1);
		expect((await approve(owner, pending.intentId)).status).toBe("executed");
		const done = (await handler({ intentId: pending.intentId }, context())).structuredContent as { result?: unknown };
		expect(JSON.stringify(done.result)).toContain("batch-a@example.com");
		expect(JSON.stringify(done.result)).toContain("batch-b@example.com");
	});
});

describe("mcp admin tools: control-plane kinds end to end", () => {
	const email = "kinds-mcp@example.com";
	let owner: Awaited<ReturnType<typeof registerOwner>>;
	let auth: Record<string, unknown>;
	let counter = 100;
	beforeAll(async () => {
		owner = await registerOwner(email);
		auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
	});
	async function call(tool: string, args: object) {
		const { handler } = await handlerFor(tool, auth, "legacy");
		const result = await handler(args, context());
		return { handler, result, content: result.structuredContent as { status: string; intentId: string; result?: unknown } };
	}
	async function approveNext(intentId: string) {
		const row = await db.prepare("SELECT payload_hash FROM approvals WHERE token = ?").bind(intentId).first<{ payload_hash: string }>();
		const assertion = await owner.authenticator.assertion(await approvalChallenge(intentId, row!.payload_hash), counter++);
		return approveIntent(env, { id: intentId, userId: owner.userId, origin: ORIGIN, assertion });
	}

	it("manage_domain add: pending until approved, then registered", async () => {
		const { content } = await call("manage_domain", { action: "add", domain: "mcp-kinds.example", zoneId: "zone-mcp" });
		expect(content.status).toBe("pending");
		const exists = () => db.prepare("SELECT status FROM domains WHERE domain = 'mcp-kinds.example'").first();
		expect(await exists()).toBeNull();
		expect((await approveNext(content.intentId)).status).toBe("executed");
		expect(await exists()).toEqual({ status: "active" });
	});

	it("manage_routing rule_upsert warns about an external forward", async () => {
		const domain = await db.prepare("SELECT id FROM domains WHERE domain = 'mcp-kinds.example'").first<{ id: string }>();
		const { content } = await call("manage_routing", {
			action: "rule_upsert",
			domainId: domain!.id,
			pattern: "fwd@mcp-kinds.example",
			priority: 1,
			ruleAction: "forward",
			forwardTo: ["outside@elsewhere.test"],
		});
		expect(content.status).toBe("pending");
		const view = await getIntentView(env, content.intentId, { userId: owner.userId });
		expect(view.warnings.map((w) => w.message)).toContain("Reenvío a una dirección externa: outside@elsewhere.test");
		expect(await db.prepare("SELECT 1 FROM routing_rules WHERE pattern = 'fwd@mcp-kinds.example'").first()).toBeNull();
	});

	it("manage_api_key create: the secret never reaches the tool result, only the approve response", async () => {
		await insertMailbox(db, { mailbox_id: "mbx_mcp_keys", primary_address: "keys@mcp-kinds.example", display_name: null, status: "active", owner_email: email });
		const args = { action: "create", mailboxId: "mbx_mcp_keys", body: { environment: "test", sender: "keys@mcp-kinds.example", scopes: ["transactional:status"] } };
		const { handler, result, content } = await call("manage_api_key", args);
		expect(content.status).toBe("pending");
		expect(JSON.stringify(result)).not.toContain("rck_");
		const approved = await approveNext(content.intentId);
		const secret = approved.reveal?.[0]?.value ?? "";
		expect(secret).toMatch(/^rck_test_/);
		const done = await handler({ intentId: content.intentId }, context());
		expect((done.structuredContent as { status: string }).status).toBe("executed");
		expect(JSON.stringify(done)).not.toContain(secret);
		expect((await approveNext(content.intentId)).reveal).toBeUndefined();
	});

	it("restore tool: disable a domain, then restore it through the tools", async () => {
		const disable = await call("manage_domain", { action: "disable", domain: "mcp-kinds.example" });
		expect((await approveNext(disable.content.intentId)).status).toBe("executed");
		const domain = await db.prepare("SELECT id, status FROM domains WHERE domain = 'mcp-kinds.example'").first<{ id: string; status: string }>();
		expect(domain?.status).toBe("disabled");
		const snap = await db.prepare("SELECT id FROM ops_events WHERE event_type = 'admin.before_snapshot' AND subject = ?").bind(domain!.id).first<{ id: string }>();
		const restore = await call("restore", { opsEventId: snap!.id });
		expect(restore.content.status).toBe("pending");
		expect((await approveNext(restore.content.intentId)).status).toBe("executed");
		expect(await db.prepare("SELECT status FROM domains WHERE id = ?").bind(domain!.id).first()).toEqual({ status: "active" });
		const again = await call("restore", { opsEventId: snap!.id });
		expect(again.result.isError).toBe(true);
	});

	it("reconcile_stale accepts an empty payload", async () => {
		const { content } = await call("reconcile_stale", {});
		expect(content.status).toBe("pending");
	});
});

describe("mcp intent principal, approver binding and approval-fatigue limits", () => {
	const emailA = "principal-a@example.com";
	const emailB = "principal-b@example.com";
	let a: Awaited<ReturnType<typeof registerOwner>>;
	let b: Awaited<ReturnType<typeof registerOwner>>;
	let counter = 500;
	const authFor = (owner: { userId: string }, email: string, extra: Record<string, unknown> = {}) => ({
		userId: owner.userId,
		email,
		owners: [emailA, emailB, email],
		scopes: new Set(ADMIN),
		oauthClientId: "client-1",
		tokenSub: owner.userId,
		tokenJti: "jti-1",
		...extra,
	});
	beforeAll(async () => {
		a = await registerOwner(emailA);
		b = await registerOwner(emailB);
	});
	const pending = async (auth: Record<string, unknown>, address: string) => {
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const result = await handler({ action: "create", primaryAddress: address }, context());
		return { handler, result, content: result.structuredContent as { intentId: string } };
	};

	it("persists the principal and records it with the approver at execute time", async () => {
		const { content } = await pending(authFor(a, emailA), "principal-created@example.com");
		const row = await db.prepare("SELECT oauth_client_id, token_sub, token_jti FROM approvals WHERE token = ?").bind(content.intentId).first();
		expect(row).toEqual({ oauth_client_id: "client-1", token_sub: a.userId, token_jti: "jti-1" });
		const challenge = await db.prepare("SELECT payload_hash FROM approvals WHERE token = ?").bind(content.intentId).first<{ payload_hash: string }>();
		const assertion = await a.authenticator.assertion(await approvalChallenge(content.intentId, challenge!.payload_hash), counter++);
		expect((await approveIntent(env, { id: content.intentId, userId: a.userId, origin: ORIGIN, assertion })).status).toBe("executed");
		const event = await db.prepare("SELECT payload_json FROM ops_events WHERE id = ?").bind(`approval.executed:${content.intentId}`).first<{ payload_json: string }>();
		expect(JSON.parse(event!.payload_json)).toMatchObject({ oauth_client_id: "client-1", token_sub: a.userId, token_jti: "jti-1", approver_user_id: a.userId, kind: "mailbox_create" });
	});

	it("hides an intent's status from a different principal", async () => {
		const { content } = await pending(authFor(a, emailA), "principal-hidden@example.com");
		const { handler } = await handlerFor("manage_mailbox", authFor(b, emailB), "legacy");
		const result = await handler({ intentId: content.intentId }, context());
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("not_found");
	});

	it("refuses approval by an owner other than the intent's creator", async () => {
		const { content } = await pending(authFor(a, emailA), "principal-cross@example.com");
		const row = await db.prepare("SELECT payload_hash FROM approvals WHERE token = ?").bind(content.intentId).first<{ payload_hash: string }>();
		const assertion = await b.authenticator.assertion(await approvalChallenge(content.intentId, row!.payload_hash), counter++);
		const result = await approveIntent(env, { id: content.intentId, userId: b.userId, origin: ORIGIN, assertion });
		expect(result.error).toBe("forbidden");
		expect(result.status).toBe("pending");
	});

	it("refuses the 6th live pending intent for one token subject", async () => {
		const c = await registerOwner("principal-cap@example.com");
		const auth = authFor(c, "principal-cap@example.com");
		for (let i = 0; i < 5; i++) {
			const { result } = await pending(auth, `cap-${i}@example.com`);
			expect(result.isError, String(i)).not.toBe(true);
		}
		const sixth = await pending(auth, "cap-5@example.com");
		expect(sixth.result.isError).toBe(true);
		expect(JSON.stringify(sixth.result)).toContain("too_many_pending_approvals");
		// A different subject is unaffected.
		expect((await pending(authFor(a, emailA), "cap-other@example.com")).result.isError).not.toBe(true);
	});

	it("coalesces Telegram notifications to one per minute per token subject", async () => {
		await db.prepare("INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', '999', ?)").bind(new Date().toISOString()).run();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1 } }));
		try {
			const telegramEnv = { ...env, TELEGRAM_BOT_TOKEN: "123:abc" } as Env;
			const d = await registerOwner("principal-notify@example.com");
			const auth = authFor(d, "principal-notify@example.com");
			const ids: string[] = [];
			for (let i = 0; i < 2; i++) ids.push((await pending(auth, `notify-${i}@example.com`)).content.intentId);
			fetchSpy.mockClear();
			for (const id of ids) await notification.notifyIntentCreated(telegramEnv, id);
			const sent = fetchSpy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes("sendMessage"));
			expect(sent.length).toBe(1);
		} finally { fetchSpy.mockRestore(); }
	});
});
