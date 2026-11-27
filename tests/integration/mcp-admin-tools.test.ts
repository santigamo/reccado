import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { approveIntent } from "#/lib/approvals";
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
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { insertMailbox } from "#/db/d1";
import { listApiKeyEvents } from "#/do/transactional-key-ops";
import { mailboxStub } from "#/lib/mailbox-stub";
import { getIntentView } from "#/lib/approvals";
import { registerTools } from "../../src/mcp/tools";
import { makeIntentCodec } from "../../src/mcp/intent-flow";
import * as notification from "../../src/telegram/notify";
import { vi } from "vitest";
import { revertApiKeyEventsToV15, schemaVersion } from "../helpers/api-key-events-legacy";
import { applyMigrations } from "../helpers/migrations";

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

type Handler = (args: object, ctx: ServerContext) => Promise<Record<string, unknown>>;
async function handlerFor(tool: string, auth: Record<string, unknown>, era: "legacy" | "modern") {
	const codec = await makeIntentCodec(TEST_SECRET, String(auth.userId));
	const server = new McpServer(
		{ name: "test", version: "1" },
		{ requestState: { verify: codec.verify } },
	);
	registerTools(server, env as Env, auth as never, ORIGIN, { era, codec });
	const registered = (
		server as unknown as {
			_registeredTools: Record<string, { handler: Handler; annotations?: Record<string, unknown> }>;
		}
	)._registeredTools;
	return { handler: registered[tool]?.handler as Handler, registered, codec };
}
const context = (state?: unknown) =>
	({ mcpReq: { requestState: () => state } }) as unknown as ServerContext;
const ADMIN = [
	"mail:read",
	"mailboxes:write",
	"templates:write",
	"routing:write",
	"domains:write",
	"keys:write",
	"suppressions:write",
];
const approvals = async () =>
	(await db.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n;

async function approveWeb(intentId: string, owner: { userId: string }) {
	const row = await db
		.prepare("SELECT payload_hash FROM approvals WHERE token = ?")
		.bind(intentId)
		.first<{ payload_hash: string }>();
	return approveIntent(env, {
		id: intentId,
		payloadHash: row!.payload_hash,
		channel: "web",
		approver: owner.userId,
	});
}

async function approve(owner: Awaited<ReturnType<typeof registerOwner>>, intentId: string) {
	return approveWeb(intentId, owner);
}

describe("mcp admin tools", () => {
	it("lists the tools with admin-tier annotations", async () => {
		const { registered } = await handlerFor(
			"manage_mailbox",
			{ userId: "u", email: "list@example.com", scopes: new Set(ADMIN) },
			"legacy",
		);
		for (const name of [
			"manage_mailbox",
			"manage_domain",
			"manage_routing",
			"manage_template",
			"manage_api_key",
			"remove_suppression",
			"restore",
			"reconcile_stale",
		]) {
			expect(registered[name]?.annotations, name).toMatchObject({
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			});
		}
		expect((registered.manage_api_key as unknown as { description: string }).description).toContain(
			"never returned here",
		);
	});

	it("does not register a tool whose scope is missing, so no intent can be created", async () => {
		const auth = {
			userId: "u",
			email: "noscope@example.com",
			scopes: new Set(["mail:read", "admin"]),
		};
		const { registered } = await handlerFor("manage_mailbox", auth, "legacy");
		expect(registered.manage_mailbox).toBeUndefined();
		expect(registered.manage_domain).toBeUndefined();
	});

	it("rejects invalid actions and fields without creating an intent", async () => {
		const owner = await registerOwner("invalid-admin@example.com");
		const auth = {
			userId: owner.userId,
			email: "invalid-admin@example.com",
			owners: ["invalid-admin@example.com"],
			scopes: new Set(ADMIN),
		};
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const before = await approvals();
		// Batches are gone: `operations` is just an unknown field.
		for (const args of [
			{ action: "explode" },
			{ action: "create" },
			{ action: "create", primaryAddress: "a@b.co", extra: 1 },
			{ operations: [] },
			{ action: "create", operations: [{ action: "create", primaryAddress: "a@b.co" }] },
		]) {
			const result = await handler(args, context());
			expect(result.isError, JSON.stringify(args)).toBe(true);
		}
		expect(await approvals()).toBe(before);
	});

	it("asks legacy clients to approve, then returns the executed result", async () => {
		const email = "legacy-admin@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
		const { handler } = await handlerFor("manage_domain", auth, "legacy");
		const args = { action: "add", domain: "mcp-legacy.example", zoneId: "zone-legacy" };
		const pending = (await handler(args, context())).structuredContent as {
			status: string;
			intentId: string;
			approvalUrl: string;
		};
		expect(pending).toMatchObject({
			status: "pending",
			approvalUrl: `${ORIGIN}/approve/${pending.intentId}`,
		});
		expect((await approve(owner, pending.intentId)).status).toBe("executed");
		const done = (await handler({ intentId: pending.intentId }, context())).structuredContent as {
			status: string;
			result?: unknown;
		};
		expect(done.status).toBe("executed");
		expect(
			await db
				.prepare("SELECT id FROM domains WHERE domain = ?")
				.bind("mcp-legacy.example")
				.first(),
		).not.toBeNull();
	});

	it("elicits the approval URL for modern clients and completes on retry", async () => {
		const email = "modern-admin@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
		const { handler, codec } = await handlerFor("manage_domain", auth, "modern");
		const notify = vi
			.spyOn(notification, "notifyIntentCreated")
			.mockRejectedValue(new Error("offline"));
		try {
			const args = { action: "add", domain: "mcp-modern.example", zoneId: "zone-modern" };
			const first = await handler(args, context());
			expect(first.resultType).toBe("input_required");
			const state = await codec.verify(first.requestState as string, context());
			expect(JSON.stringify(first)).toContain(`/approve/${state.intentId}`);
			expect(JSON.stringify(first)).toContain("Revisa y aprueba el cambio en example.com");
			expect((await handler(args, context(state))).resultType).toBe("input_required");
			expect((await approve(owner, state.intentId)).status).toBe("executed");
			const done = await handler(args, context(state));
			expect(done.structuredContent).toMatchObject({
				status: "executed",
				intentId: state.intentId,
			});
		} finally {
			notify.mockRestore();
		}
	});

	it("applies a direct change immediately: no approval row, no Telegram notice, secrets stripped", async () => {
		const email = "direct-admin@example.com";
		const owner = await registerOwner(email);
		const auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
		const { handler } = await handlerFor("manage_mailbox", auth, "legacy");
		const notify = vi.spyOn(notification, "notifyIntentCreated");
		try {
			const before = await approvals();
			const result = await handler(
				{ action: "create", primaryAddress: "direct-created@example.com", displayName: "Agent" },
				context(),
			);
			const content = result.structuredContent as {
				status: string;
				result?: Record<string, unknown>;
				snapshotIds: string[];
			};
			expect(content.status).toBe("applied");
			expect(content.result).toBeDefined();
			expect(await approvals()).toBe(before);
			expect(notify).not.toHaveBeenCalled();
			expect(
				await db
					.prepare("SELECT mailbox_id FROM mailboxes WHERE primary_address = ?")
					.bind("direct-created@example.com")
					.first(),
			).not.toBeNull();
			const event = await db
				.prepare(
					"SELECT payload_json FROM ops_events WHERE event_type = 'admin.applied' AND subject = 'mailbox_create' ORDER BY created_at DESC LIMIT 1",
				)
				.first<{ payload_json: string }>();
			expect(JSON.parse(event!.payload_json)).toMatchObject({
				kind: "mailbox_create",
				outcome: "applied",
				approver_user_id: owner.userId,
			});
		} finally {
			notify.mockRestore();
		}
	});
});

describe("mcp admin tools: control-plane kinds end to end", () => {
	const email = "kinds-mcp@example.com";
	let owner: Awaited<ReturnType<typeof registerOwner>>;
	let auth: Record<string, unknown>;
	beforeAll(async () => {
		owner = await registerOwner(email);
		auth = { userId: owner.userId, email, owners: [email], scopes: new Set(ADMIN) };
	});
	async function call(tool: string, args: object) {
		const { handler } = await handlerFor(tool, auth, "legacy");
		const result = await handler(args, context());
		return {
			handler,
			result,
			content: result.structuredContent as { status: string; intentId: string; result?: unknown },
		};
	}
	async function approveNext(intentId: string) {
		return approveWeb(intentId, owner);
	}

	it("manage_domain add: pending until approved, then registered", async () => {
		const { content } = await call("manage_domain", {
			action: "add",
			domain: "mcp-kinds.example",
			zoneId: "zone-mcp",
		});
		expect(content.status).toBe("pending");
		const exists = () =>
			db.prepare("SELECT status FROM domains WHERE domain = 'mcp-kinds.example'").first();
		expect(await exists()).toBeNull();
		expect((await approveNext(content.intentId)).status).toBe("executed");
		expect(await exists()).toEqual({ status: "active" });
	});

	it("manage_routing rule_upsert warns about an external forward", async () => {
		const domain = await db
			.prepare("SELECT id FROM domains WHERE domain = 'mcp-kinds.example'")
			.first<{ id: string }>();
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
		expect(view.warnings.map((w) => w.message)).toContain(
			"Reenvío a una dirección externa: outside@elsewhere.test",
		);
		expect(
			await db
				.prepare("SELECT 1 FROM routing_rules WHERE pattern = 'fwd@mcp-kinds.example'")
				.first(),
		).toBeNull();
	});

	it("manage_api_key create: the secret never reaches the tool result, only the approve response", async () => {
		await insertMailbox(db, {
			mailbox_id: "mbx_mcp_keys",
			primary_address: "keys@mcp-kinds.example",
			display_name: null,
			status: "active",
			owner_email: email,
		});
		const args = {
			action: "create",
			mailboxId: "mbx_mcp_keys",
			body: {
				environment: "test",
				sender: "keys@mcp-kinds.example",
				scopes: ["transactional:status"],
			},
		};
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

	it("publishes each action's fields and accepts objects/arrays sent as JSON text", async () => {
		await insertMailbox(db, {
			mailbox_id: "mbx_mcp_jsontext",
			primary_address: "jsontext@mcp-kinds.example",
			display_name: null,
			status: "active",
			owner_email: email,
		});
		const { handler, registered } = await handlerFor("manage_template", auth, "legacy");
		type Json = { type?: string; description?: string; properties: Record<string, Json> };
		type Std = {
			"~standard": {
				jsonSchema: { input: (o: object) => Json };
				validate: (v: unknown) => Promise<{ value?: object; issues?: unknown[] }>;
			};
		};
		const schemaOf = (tool: string) =>
			(registered[tool] as unknown as { inputSchema: Std }).inputSchema["~standard"];
		const listed = schemaOf("manage_template").jsonSchema.input({ target: "draft-2020-12" });
		expect(listed.properties.body).toMatchObject({
			type: "object",
			properties: { subject: { type: "string" } },
		});
		expect(listed.properties.templateId?.description).toContain("upsert");
		const keyListed = schemaOf("manage_api_key").jsonSchema.input({ target: "draft-2020-12" });
		expect(keyListed.properties.scopes?.type).toBe("array");

		// A client that stringifies `body` passes the SDK's input validation and the action's own schema.
		const validated = await schemaOf("manage_template").validate({
			action: "upsert",
			mailboxId: "mbx_mcp_jsontext",
			templateId: "welcome",
			body: JSON.stringify({ subject: "Hola", body_text: "Bienvenido" }),
		});
		expect(validated.issues).toBeUndefined();
		const applied = (await handler(validated.value!, context())).structuredContent as {
			status: string;
		};
		expect(applied.status).toBe("applied");

		const created = await call("manage_api_key", {
			action: "create",
			mailboxId: "mbx_mcp_jsontext",
			body: JSON.stringify({
				environment: "test",
				sender: "jsontext@mcp-kinds.example",
				scopes: ["transactional:status"],
			}),
		});
		expect(created.content.status).toBe("pending");
		// Text that is not JSON is still a validation error, with no approval created.
		const bad = await call("manage_template", {
			action: "upsert",
			mailboxId: "mbx_mcp_jsontext",
			templateId: "welcome",
			body: "{not json",
		});
		expect(bad.result.isError).toBe(true);
	});

	it("manage_api_key templates: applied in place immediately with no secret", async () => {
		await insertMailbox(db, {
			mailbox_id: "mbx_mcp_tpl",
			primary_address: "tpl@mcp-kinds.example",
			display_name: null,
			status: "active",
			owner_email: email,
		});
		const created = await call("manage_api_key", {
			action: "create",
			mailboxId: "mbx_mcp_tpl",
			body: {
				environment: "test",
				sender: "tpl@mcp-kinds.example",
				scopes: ["transactional:send", "transactional:templates:use"],
				templateAllowlist: ["welcome"],
			},
		});
		expect((await approveNext(created.content.intentId)).status).toBe("executed");
		const { keys } = (await (
			await mailboxStub(env, "mbx_mcp_tpl").fetch("https://mailbox-do/transactional/api-keys")
		).json()) as { keys: Array<{ keyId: string }> };
		const keyId = keys[0]!.keyId;
		const { content, result } = await call("manage_api_key", {
			action: "templates",
			mailboxId: "mbx_mcp_tpl",
			keyId,
			add: ["invoice"],
		});
		expect(content.status).toBe("applied");
		expect(JSON.stringify(result)).not.toContain("rck_");
		const after = (await (
			await mailboxStub(env, "mbx_mcp_tpl").fetch("https://mailbox-do/transactional/api-keys")
		).json()) as { keys: Array<{ keyId: string; templateAllowlist: string[] }> };
		expect(after.keys).toHaveLength(1);
		expect(after.keys[0]).toMatchObject({ keyId, templateAllowlist: ["welcome", "invoice"] });
	});

	it("manage_api_key templates on a mailbox with the production (v15) event CHECK", async () => {
		// Production failed here: mailboxes past v6 kept an api_key_events CHECK
		// without 'template_allowlist_updated', so the audit insert rolled the edit back.
		const MBX = "mbx_mcp_tpl_v15";
		await insertMailbox(db, {
			mailbox_id: MBX,
			primary_address: "tplv15@mcp-kinds.example",
			display_name: null,
			status: "active",
			owner_email: email,
		});
		const created = await call("manage_api_key", {
			action: "create",
			mailboxId: MBX,
			body: {
				environment: "test",
				sender: "tplv15@mcp-kinds.example",
				scopes: ["transactional:send", "transactional:templates:use"],
				templateAllowlist: ["welcome"],
			},
		});
		expect((await approveNext(created.content.intentId)).status).toBe("executed");
		const listKeys = async () =>
			(
				(await (
					await mailboxStub(env, MBX).fetch("https://mailbox-do/transactional/api-keys")
				).json()) as { keys: Array<{ keyId: string; templateAllowlist: string[] }> }
			).keys;
		const keyId = (await listKeys())[0]!.keyId;
		await runInDurableObject(mailboxStub(env, MBX), async (_i, state) =>
			revertApiKeyEventsToV15(state.storage.sql),
		);

		// Before a restart the old CHECK is live: the production error, nothing changed.
		const broken = await call("manage_api_key", {
			action: "templates",
			mailboxId: MBX,
			keyId,
			add: ["invoice"],
		});
		expect(broken.content.status).not.toBe("applied");
		expect(JSON.stringify(broken.result)).toContain("CHECK constraint failed");
		expect((await listKeys())[0]?.templateAllowlist).toEqual(["welcome"]);

		// A restart runs v16, after which the same call applies in place with its audit row.
		await abortAllDurableObjects();
		const { content } = await call("manage_api_key", {
			action: "templates",
			mailboxId: MBX,
			keyId,
			add: ["invoice"],
		});
		expect(content.status).toBe("applied");
		expect((await listKeys())[0]).toMatchObject({
			keyId,
			templateAllowlist: ["welcome", "invoice"],
		});
		const events = await runInDurableObject(mailboxStub(env, MBX), async (_i, state) => ({
			version: schemaVersion(state.storage.sql),
			types: listApiKeyEvents(state.storage.sql, keyId).map((event) => event.eventType),
		}));
		expect(events.version).toBe(16);
		expect(events.types).toEqual(["created", "template_allowlist_updated"]);
	});

	it("restore tool: disable a domain, then restore it through the tools", async () => {
		const disable = await call("manage_domain", { action: "disable", domain: "mcp-kinds.example" });
		expect((await approveNext(disable.content.intentId)).status).toBe("executed");
		const domain = await db
			.prepare("SELECT id, status FROM domains WHERE domain = 'mcp-kinds.example'")
			.first<{ id: string; status: string }>();
		expect(domain?.status).toBe("disabled");
		const snap = await db
			.prepare(
				"SELECT id FROM ops_events WHERE event_type = 'admin.before_snapshot' AND subject = ?",
			)
			.bind(domain!.id)
			.first<{ id: string }>();
		const restore = await call("restore", { opsEventId: snap!.id });
		expect(restore.content.status).toBe("applied");
		expect(
			await db.prepare("SELECT status FROM domains WHERE id = ?").bind(domain!.id).first(),
		).toEqual({ status: "active" });
		const again = await call("restore", { opsEventId: snap!.id });
		expect(again.content).toMatchObject({ status: "failed", error: "snapshot_consumed" });
	});

	it("restore requires the write scope of the snapshot's resource", async () => {
		const expected: Record<string, string> = {
			mailbox: "mailboxes:write",
			domain: "domains:write",
			alias: "routing:write",
			routing_rule: "routing:write",
			template: "templates:write",
		};
		const all = ["mailboxes:write", "domains:write", "routing:write", "templates:write"];
		for (const [entity, needed] of Object.entries(expected)) {
			const id = `scope-snap-${entity}`;
			await db
				.prepare(
					"INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at) VALUES (?, 'admin.before_snapshot', 'info', ?, ?, datetime('now'))",
				)
				.bind(id, `subj-${entity}`, JSON.stringify({ entity, by: "someone@example.com" }))
				.run();
			// Holding every write scope except the matching one is refused with the exact scope.
			const lacking = { ...auth, scopes: new Set(all.filter((scope) => scope !== needed)) };
			const denied = await (await handlerFor("restore", lacking, "legacy")).handler(
				{ opsEventId: id },
				context(),
			);
			expect(JSON.stringify(denied), entity).toContain(`insufficient_scope: ${needed}`);
			// With the matching scope the scope gate passes (the kind then fails on foreign ownership, not scope).
			const held = { ...auth, scopes: new Set([needed]) };
			const passed = await (await handlerFor("restore", held, "legacy")).handler(
				{ opsEventId: id },
				context(),
			);
			expect(JSON.stringify(passed), entity).not.toContain("insufficient_scope");
		}
	});

	it("reconcile_stale accepts an empty payload", async () => {
		const { content } = await call("reconcile_stale", {});
		expect(content.status).toBe("applied");
	});
});

describe("mcp intent principal, approver binding and approval-fatigue limits", () => {
	const emailA = "principal-a@example.com";
	const emailB = "principal-b@example.com";
	let a: Awaited<ReturnType<typeof registerOwner>>;
	let b: Awaited<ReturnType<typeof registerOwner>>;
	const authFor = (
		owner: { userId: string },
		email: string,
		extra: Record<string, unknown> = {},
	) => ({
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
		const { handler } = await handlerFor("manage_domain", auth, "legacy");
		const result = await handler(
			{ action: "add", domain: address.replace("@", "."), zoneId: "z" },
			context(),
		);
		return { handler, result, content: result.structuredContent as { intentId: string } };
	};

	it("persists the principal and records it with the approver at execute time", async () => {
		const { content } = await pending(authFor(a, emailA), "principal-created@example.com");
		const row = await db
			.prepare("SELECT oauth_client_id, token_sub, token_jti FROM approvals WHERE token = ?")
			.bind(content.intentId)
			.first();
		expect(row).toEqual({ oauth_client_id: "client-1", token_sub: a.userId, token_jti: "jti-1" });
		expect((await approveWeb(content.intentId, a)).status).toBe("executed");
		const event = await db
			.prepare("SELECT payload_json FROM ops_events WHERE id = ?")
			.bind(`approval.executed:${content.intentId}`)
			.first<{ payload_json: string }>();
		expect(JSON.parse(event!.payload_json)).toMatchObject({
			oauth_client_id: "client-1",
			token_sub: a.userId,
			token_jti: "jti-1",
			approver_user_id: a.userId,
			kind: "domain_add",
		});
	});

	it("hides an intent's status from a different principal", async () => {
		const { content } = await pending(authFor(a, emailA), "principal-hidden@example.com");
		const { handler } = await handlerFor("manage_domain", authFor(b, emailB), "legacy");
		const result = await handler({ intentId: content.intentId }, context());
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("not_found");
	});

	it("refuses approval by an owner other than the intent's creator", async () => {
		const { content } = await pending(authFor(a, emailA), "principal-cross@example.com");
		const result = await approveWeb(content.intentId, b);
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
		expect((await pending(authFor(a, emailA), "cap-other@example.com")).result.isError).not.toBe(
			true,
		);
	});

	it("notifies once per approval request with the link and no approve/deny buttons", async () => {
		await db
			.prepare(
				"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', '999', ?)",
			)
			.bind(new Date().toISOString())
			.run();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => Response.json({ ok: true, result: { message_id: 1 } }));
		try {
			const telegramEnv = { ...env, TELEGRAM_BOT_TOKEN: "123:abc" } as Env;
			const d = await registerOwner("principal-notify@example.com");
			const auth = authFor(d, "principal-notify@example.com");
			const ids: string[] = [];
			for (let i = 0; i < 2; i++)
				ids.push((await pending(auth, `notify-${i}@example.com`)).content.intentId);
			fetchSpy.mockClear();
			for (const id of ids) await notification.notifyIntentCreated(telegramEnv, id);
			const sent = fetchSpy.mock.calls.filter(([input]) =>
				String(input instanceof Request ? input.url : input).includes("sendMessage"),
			);
			expect(sent.length).toBe(2);
			const bodies = sent.map(
				([, init]) =>
					JSON.parse(String((init as RequestInit).body)) as {
						text: string;
						reply_markup: {
							inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>>;
						};
					},
			);
			for (const [i, body] of bodies.entries()) {
				const buttons = body.reply_markup.inline_keyboard.flat();
				expect(buttons.every((button) => button.callback_data === undefined)).toBe(true);
				expect(buttons.map((button) => button.url)).toEqual([`${ORIGIN}/approve/${ids[i]}`]);
				expect(body.text).toContain(`${ORIGIN}/approve/${ids[i]}`);
			}
			// Only the second (coalesced) one is the compact notice.
			expect(bodies[0]!.text).toContain("notify-0.example.com");
			expect(bodies[1]!.text).not.toContain("notify-0.example.com");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("mcp approval modes", () => {
	const email = "modes-mcp@example.com";
	let owner: Awaited<ReturnType<typeof registerOwner>>;
	let auth: Record<string, unknown>;
	beforeAll(async () => {
		owner = await registerOwner(email);
		auth = {
			userId: owner.userId,
			email,
			owners: [email],
			scopes: new Set(ADMIN),
			tokenSub: owner.userId,
		};
		await db
			.prepare(
				"INSERT INTO domains (id, domain, zone_id, status, created_at, updated_at) VALUES ('dom_modes', 'modes.example', 'z', 'active', ?, ?)",
			)
			.bind(new Date().toISOString(), new Date().toISOString())
			.run()
			.catch(() => undefined);
		await insertMailbox(db, {
			mailbox_id: "mbx_modes",
			primary_address: "main@modes.example",
			display_name: null,
			status: "active",
			owner_email: email,
		});
	});
	async function call(tool: string, args: object) {
		const { handler } = await handlerFor(tool, auth, "legacy");
		const result = await handler(args, context());
		return {
			result,
			content: result.structuredContent as {
				status: string;
				intentId?: string;
				result?: unknown;
				error?: string;
			},
		};
	}

	it("forward rules: internal destinations apply directly, external ones pend", async () => {
		const domain = await db
			.prepare("SELECT id FROM domains WHERE domain = 'modes.example'")
			.first<{ id: string }>();
		const rule = (pattern: string, forwardTo: string[]) => ({
			action: "rule_upsert",
			domainId: domain!.id,
			pattern,
			priority: 1,
			ruleAction: "forward",
			forwardTo,
		});
		expect(
			(await call("manage_routing", rule("in@modes.example", ["other@modes.example"]))).content
				.status,
		).toBe("applied");
		expect(
			await db.prepare("SELECT 1 FROM routing_rules WHERE pattern = 'in@modes.example'").first(),
		).not.toBeNull();
		const external = await call(
			"manage_routing",
			rule("out@modes.example", ["spy@elsewhere.test"]),
		);
		expect(external.content.status).toBe("pending");
		expect(
			await db.prepare("SELECT 1 FROM routing_rules WHERE pattern = 'out@modes.example'").first(),
		).toBeNull();
		expect((await approveWeb(external.content.intentId!, owner)).status).toBe("executed");
		expect(
			await db.prepare("SELECT 1 FROM routing_rules WHERE pattern = 'out@modes.example'").first(),
		).not.toBeNull();
	});

	it("editing an existing internal forward rule to an external destination pends", async () => {
		const existing = await db
			.prepare("SELECT id FROM routing_rules WHERE pattern = 'in@modes.example'")
			.first<{ id: string }>();
		const { content } = await call("manage_routing", {
			action: "rule_upsert",
			ruleId: existing!.id,
			forwardTo: ["spy@elsewhere.test"],
		});
		expect(content.status).toBe("pending");
	});

	it("every critical kind pends and executes only after web approval", async () => {
		const pendingCases: Array<[string, Record<string, unknown>]> = [
			["manage_domain", { action: "add", domain: "crit-a.example", zoneId: "z" }],
			[
				"manage_domain",
				{ action: "provision", domain: "crit-b.example", body: { dmarc: { policy: "none" } } },
			],
			["manage_domain", { action: "disable", domain: "modes.example" }],
			[
				"manage_api_key",
				{
					action: "create",
					mailboxId: "mbx_modes",
					body: {
						environment: "test",
						sender: "main@modes.example",
						scopes: ["transactional:status"],
					},
				},
			],
			["manage_api_key", { action: "rotate", mailboxId: "mbx_modes", keyId: "key_x" }],
			[
				"manage_api_key",
				{
					action: "scopes",
					mailboxId: "mbx_modes",
					keyId: "key_x",
					scopes: ["transactional:status"],
				},
			],
			["remove_suppression", { mailboxId: "mbx_modes", body: { email: "bounced@example.net" } }],
		];
		for (const [tool, args] of pendingCases) {
			const { content, result } = await call(tool, args);
			// Kinds whose target does not exist fail rendering (before a pending row); the rest must pend.
			if (result.isError) continue;
			expect(content.status, `${tool} ${JSON.stringify(args)}`).toBe("pending");
		}
		const pendingKinds = await db
			.prepare(
				"SELECT kind FROM approvals WHERE token_sub = ? AND origin = 'mcp' AND decision IS NULL",
			)
			.bind(owner.userId)
			.all<{ kind: string }>();
		const kinds = new Set(pendingKinds.results.map((r) => r.kind));
		for (const kind of ["domain_add", "domain_provision", "domain_disable", "api_key_create"])
			expect(kinds.has(kind), kind).toBe(true);
	});

	it("non-critical kinds never create an approval", async () => {
		const before = await approvals();
		const cases: Array<[string, Record<string, unknown>]> = [
			[
				"manage_template",
				{
					action: "upsert",
					mailboxId: "mbx_modes",
					templateId: "welcome",
					body: { subject: "Hola" },
				},
			],
			[
				"manage_mailbox",
				{ action: "update", mailboxId: "mbx_modes", body: { displayName: "Modes" } },
			],
			[
				"manage_routing",
				{ action: "alias_add", aliasAddress: "alias@modes.example", mailboxId: "mbx_modes" },
			],
			["manage_domain", { action: "update", domain: "modes.example", body: { status: "active" } }],
			["reconcile_stale", {}],
		];
		for (const [tool, args] of cases) {
			const { content } = await call(tool, args);
			expect(content.status, `${tool} ${JSON.stringify(args)}`).toBe("applied");
		}
		expect(await approvals()).toBe(before);
	});

	it("a direct change is undone with restore, and a tool result never carries a secret", async () => {
		const first = await call("manage_template", {
			action: "upsert",
			mailboxId: "mbx_modes",
			templateId: "undo",
			body: { subject: "Uno" },
		});
		const second = await call("manage_template", {
			action: "upsert",
			mailboxId: "mbx_modes",
			templateId: "undo",
			body: { subject: "Dos" },
		});
		const snapshotIds = (second.content as unknown as { snapshotIds: string[] }).snapshotIds;
		expect(first.content.status).toBe("applied");
		expect(snapshotIds.length).toBeGreaterThan(0);
		const restored = await call("restore", { opsEventId: snapshotIds[0] });
		expect(restored.content.status).toBe("applied");
		expect(JSON.stringify(restored.result)).not.toMatch(/rck_/);
	});
});
