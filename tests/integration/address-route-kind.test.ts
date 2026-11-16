import { env } from "cloudflare:workers";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { renderApprovalPage } from "#/components/approval-page";
import { insertMailbox } from "#/db/d1";
import { approvalTitle, fieldLabel, warningText } from "#/lib/approval-copy";
import { approveIntent, denyIntent, getIntentStatus, getIntentView } from "#/lib/approvals";
import { listApprovals } from "#/lib/approvals-list";
import { canonicalJson, hashPayload } from "#/lib/control-plane-intents";
import { insufficientScope } from "#/lib/mcp-scopes";
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
import { missingScopeForToolCall } from "../../src/mcp/handler";
import { makeIntentCodec } from "../../src/mcp/intent-flow";
import { registerTools } from "../../src/mcp/tools";
import * as notification from "../../src/telegram/notify";
import { applyMigrations } from "../helpers/migrations";

/**
 * `address_route` (manage_routing route_address): an agent may ask Cloudflare Email Routing to
 * deliver an address to this Worker, but only the owner's web approval makes it happen. Every
 * Cloudflare call is answered by a fetch stub; nothing reaches the real API.
 */

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const WORKER = "reccado-test";
/** The env the Worker runs with: a token and its own name, as `routeAddress` needs. */
const cfEnv = { ...env, CLOUDFLARE_API_TOKEN: "test-token", WORKER_NAME: WORKER } as unknown as Env;
const realFetch = globalThis.fetch;

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

let notify: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	notify = vi.spyOn(notification, "notifyIntentCreated").mockResolvedValue(undefined);
});
afterEach(() => {
	globalThis.fetch = realFetch;
	notify.mockRestore();
});

async function registerOwner(email: string): Promise<{ userId: string }> {
	const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
	await db
		.prepare(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
		)
		.bind(code, new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString())
		.run();
	const response = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/pairing`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ email, code }),
		}),
		{ ...env, BETTER_AUTH_SECRET: TEST_SECRET } as Env,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return { userId: user!.id };
}

type Handler = (args: object, ctx: ServerContext) => Promise<Record<string, unknown>>;
async function tools(auth: Record<string, unknown>, runEnv: Env = cfEnv) {
	const codec = await makeIntentCodec(TEST_SECRET, String(auth.userId));
	const server = new McpServer(
		{ name: "test", version: "1" },
		{ requestState: { verify: codec.verify } },
	);
	registerTools(server, runEnv, auth as never, ORIGIN, { era: "legacy", codec });
	return (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })
		._registeredTools;
}
const context = () => ({ mcpReq: { requestState: () => undefined } }) as unknown as ServerContext;

type Call = { method: string; url: string; body: unknown };
type Stub = [method: string, fragment: string, status: number, result: unknown];
/** Answers Cloudflare from `method + url fragment -> [status, result]` (first match wins); records every outbound call. */
function stubFetch(routes: Stub[] = []): Call[] {
	const calls: Call[] = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const hit = routes.find(([m, fragment]) => m === method && url.includes(fragment));
		if (!hit)
			return new Response(
				JSON.stringify({ success: false, errors: [{ code: 1, message: "no stub" }] }),
				{
					status: 404,
				},
			);
		const [, , status, result] = hit;
		const success = status < 400;
		return new Response(
			JSON.stringify({
				success,
				errors: success ? [] : [{ code: status === 403 ? 10000 : 1000, message: "nope" }],
				messages: [],
				result,
				result_info: { page: 1, total_pages: 1 },
			}),
			{ status },
		);
	}) as typeof fetch;
	return calls;
}
const routingOn: Stub = ["GET", "/email/routing", 200, { enabled: true }];
const catchAllDrop: Stub = [
	"GET",
	"/email/routing/rules/catch_all",
	200,
	{ enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
];
const noRules: Stub = ["GET", "/email/routing/rules?", 200, []];

const SCOPES = ["mail:read", "routing:write"];
let EMAIL = "";
let owner: { userId: string };
let auth: Record<string, unknown>;
let n = 0;

/**
 * A fresh owner (the MCP rate limit and the pending-approval cap are per principal), a
 * registered active domain, and one mailbox that owner owns.
 */
async function setup(): Promise<{
	zone: string;
	zoneId: string;
	address: string;
	mailboxId: string;
}> {
	n += 1;
	EMAIL = `route-owner-${n}@example.com`;
	owner = await registerOwner(EMAIL);
	auth = {
		userId: owner.userId,
		email: EMAIL,
		owners: [EMAIL],
		scopes: new Set(SCOPES),
		tokenSub: owner.userId,
	};
	const zone = `route-kind-${n}.test`;
	const zoneId = `z-kind-${n}`;
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO domains (id, domain, zone_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
		.bind(`dom_kind_${n}`, zone, zoneId, now, now)
		.run();
	const mailboxId = `mbx_route_kind_${n}`;
	const address = `hello@${zone}`;
	await insertMailbox(db, {
		mailbox_id: mailboxId,
		primary_address: address,
		display_name: null,
		status: "active",
		owner_email: EMAIL,
	});
	return { zone, zoneId, address, mailboxId };
}

async function requestRoute(domain: string, address: string, runEnv: Env = cfEnv) {
	const registered = await tools(auth, runEnv);
	const result = await registered.manage_routing!.handler(
		{ action: "route_address", domain, address },
		context(),
	);
	return {
		result,
		content: result.structuredContent as { status: string; intentId: string; approvalUrl?: string },
	};
}
async function poll(intentId: string) {
	const registered = await tools(auth);
	return (await registered.manage_routing!.handler({ intentId }, context())).structuredContent as {
		status: string;
		result?: {
			items: Array<{
				status: string;
				result?: Record<string, unknown>;
				errorCode?: string;
				detail?: Record<string, unknown>;
			}>;
		};
	};
}
async function storedHash(intentId: string) {
	return (await db
		.prepare("SELECT payload_hash FROM approvals WHERE token = ?")
		.bind(intentId)
		.first<{ payload_hash: string }>())!.payload_hash;
}
async function approve(intentId: string, runEnv: Env = cfEnv) {
	return approveIntent(runEnv, {
		id: intentId,
		payloadHash: await storedHash(intentId),
		channel: "web",
		approver: owner.userId,
	});
}
const cloudflareCalls = (calls: Call[]) =>
	calls.filter((c) => c.url.startsWith("https://api.cloudflare.com/"));
const approvalCount = async () =>
	(await db.prepare("SELECT COUNT(*) AS n FROM approvals").first<{ n: number }>())!.n;

describe("address_route: request over MCP", () => {
	it("only creates an approval: no Cloudflare call, a pending row bound to domain+address, a notice", async () => {
		const { zone, address } = await setup();
		const calls = stubFetch();
		const { content } = await requestRoute(zone, address);
		expect(content).toMatchObject({
			status: "pending",
			approvalUrl: `${ORIGIN}/approve/${content.intentId}`,
		});
		expect(calls).toEqual([]);
		const row = await db
			.prepare(
				"SELECT kind, origin, payload_json, payload_hash, expires_at, created_at FROM approvals WHERE token = ?",
			)
			.bind(content.intentId)
			.first<{
				kind: string;
				origin: string;
				payload_json: string;
				payload_hash: string;
				expires_at: string;
				created_at: string;
			}>();
		expect(row).toMatchObject({ kind: "address_route", origin: "mcp" });
		// The frozen payload is exactly {address, domain}; its hash is what approval is bound to.
		expect(row!.payload_json).toBe(canonicalJson({ address, domain: zone }));
		expect(row!.payload_hash).toBe(await hashPayload(canonicalJson({ address, domain: zone })));
		expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBe(600_000);
		expect(notify).toHaveBeenCalledWith(expect.anything(), content.intentId);
		expect((await poll(content.intentId)).status).toBe("pending");
		expect(calls).toEqual([]);
	});

	it("normalises case and whitespace into the frozen payload", async () => {
		const { zone, address } = await setup();
		stubFetch();
		const { content } = await requestRoute(` ${zone.toUpperCase()} `, address.toUpperCase());
		expect(content.status).toBe("pending");
		const row = await db
			.prepare("SELECT payload_json FROM approvals WHERE token = ?")
			.bind(content.intentId)
			.first<{ payload_json: string }>();
		expect(JSON.parse(row!.payload_json)).toEqual({ address, domain: zone });
	});

	it("refuses before any approval what can never be routed", async () => {
		const { zone, address, mailboxId } = await setup();
		const calls = stubFetch();
		const before = await approvalCount();
		const cases: Array<[string, string, string]> = [
			[zone, `nobody@${zone}`, "refused: address_unknown"],
			["unregistered.test", "hello@unregistered.test", "refused: domain_not_found"],
			[zone, "hello@elsewhere.test", "validation_error"],
			[zone, "not-an-address", "validation_error"],
		];
		for (const [domain, addr, expected] of cases) {
			const { result } = await requestRoute(domain, addr);
			expect(result.isError, `${domain} ${addr}`).toBe(true);
			expect(JSON.stringify(result), `${domain} ${addr}`).toContain(expected);
		}
		// Extra fields are refused (one operation, exactly these fields).
		const registered = await tools(auth);
		const extra = await registered.manage_routing!.handler(
			{ action: "route_address", domain: zone, address, worker: "evil" },
			context(),
		);
		expect(extra.isError).toBe(true);
		// An inactive domain and another owner's mailbox are refused too.
		await db.prepare("UPDATE domains SET status = 'disabled' WHERE domain = ?").bind(zone).run();
		expect(JSON.stringify((await requestRoute(zone, address)).result)).toContain(
			"refused: domain_inactive",
		);
		await db.prepare("UPDATE domains SET status = 'active' WHERE domain = ?").bind(zone).run();
		await db
			.prepare("UPDATE mailboxes SET owner_email = 'someone-else@example.com' WHERE mailbox_id = ?")
			.bind(mailboxId)
			.run();
		expect((await requestRoute(zone, address)).result.isError).toBe(true);
		expect(await approvalCount()).toBe(before);
		expect(calls).toEqual([]);
	});

	it("needs routing:write: the tool is not listed without it and a call gets the spec signal", async () => {
		await setup();
		const without = await tools({
			...auth,
			scopes: new Set(["mail:read", "mailboxes:write", "config:read"]),
		});
		expect(without.manage_routing).toBeUndefined();
		expect(without.manage_mailbox).toBeDefined();
		const call = new Request(`${ORIGIN}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "manage_routing", arguments: { action: "route_address" } },
			}),
		});
		const needed = await missingScopeForToolCall(call, new Set(["mail:read", "mailboxes:write"]));
		expect(needed).toBe("routing:write");
		const response = insufficientScope(
			needed!,
			`${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("WWW-Authenticate")).toContain(
			'error="insufficient_scope", scope="routing:write"',
		);
		expect((await tools(auth)).manage_routing).toBeDefined();
	});
});

describe("address_route: what the owner sees", () => {
	it("renders a clear summary on the approval page, in the inbox queue, and in English", async () => {
		const { zone, zoneId, address } = await setup();
		stubFetch();
		const { content } = await requestRoute(zone, address);
		const view = await getIntentView(cfEnv, content.intentId, { userId: owner.userId });
		expect(view).toMatchObject({
			kind: "address_route",
			status: "pending",
			title: `Enrutar ${address} a este Reccado`,
		});
		expect(view.fields).toEqual([
			{ label: "Dirección", value: `${address} (buzón)` },
			{ label: "Dominio", value: zone },
			{ label: "Zona Cloudflare", value: zoneId },
			{ label: "Regla a crear", value: `to:${address} → Worker ${WORKER}` },
		]);
		expect(view.warnings.map((w) => w.code)).toEqual(["cloudflare_route"]);
		const html = renderApprovalPage({
			title: view.title,
			status: view.status,
			kind: view.kind,
			fields: view.fields,
			warnings: view.warnings,
		});
		expect(html).toContain(`Route ${address} to this Reccado`);
		expect(html).toContain("Rule to create");
		expect(html).toContain("Cloudflare zone");
		expect(html).toContain(`delivers ${address} to this Worker`);
		expect(html).toContain('<button type="button">Approve</button>');
		expect(fieldLabel("Regla a crear")).toBe("Rule to create");
		expect(approvalTitle({ title: "", kind: "address_route" })).toBe(
			"Route an address to this Reccado",
		);

		// The inbox queue lists it with its fields, approvable in place (no secret to reveal).
		const queue = await listApprovals(cfEnv, owner.userId);
		const item = queue.pending.find((entry) => entry.id === content.intentId);
		expect(item).toMatchObject({
			kind: "address_route",
			revealsSecret: false,
			payloadHash: await storedHash(content.intentId),
		});
		expect(item!.fields).toEqual(view.fields);
		expect(approvalTitle(item!)).toBe(`Route ${address} to this Reccado`);
	});

	it("warns when this Worker cannot reach Cloudflare", async () => {
		const { zone, address } = await setup();
		stubFetch();
		const noToken = { ...env, CLOUDFLARE_API_TOKEN: "", WORKER_NAME: "" } as unknown as Env;
		const { content } = await requestRoute(zone, address, noToken);
		const view = await getIntentView(noToken, content.intentId, { userId: owner.userId });
		expect(view.warnings.map((w) => w.code)).toEqual([
			"cloudflare_route",
			"routing_token_missing",
			"routing_worker_unknown",
		]);
		for (const w of view.warnings) expect(warningText(w)).not.toBe(w.message);
		expect(view.fields.at(-1)?.value).toBe(`to:${address} → Worker (desconocido)`);
	});
});

describe("address_route: approval", () => {
	it("approve executes exactly the mocked Cloudflare requests, records it, and reports created", async () => {
		const { zone, zoneId, address } = await setup();
		const { content } = await requestRoute(zone, address);
		const calls = stubFetch([
			catchAllDrop,
			noRules,
			routingOn,
			["POST", `/zones/${zoneId}/email/routing/rules`, 200, { id: "rule-new" }],
		]);
		const approved = await approve(content.intentId);
		expect(approved.status).toBe("executed");
		expect(approved.reveal).toBeUndefined();
		const cf = cloudflareCalls(calls);
		expect(
			cf
				.map((c) => `${c.method} ${c.url.replace("https://api.cloudflare.com/client/v4", "")}`)
				.sort(),
		).toEqual(
			[
				`GET /zones/${zoneId}/email/routing`,
				`GET /zones/${zoneId}/email/routing/rules/catch_all`,
				`GET /zones/${zoneId}/email/routing/rules?per_page=50&page=1`,
				`POST /zones/${zoneId}/email/routing/rules`,
			].sort(),
		);
		expect(cf.find((c) => c.method === "POST")?.body).toEqual({
			enabled: true,
			name: `hello -> ${WORKER}`,
			matchers: [{ type: "literal", field: "to", value: address }],
			actions: [{ type: "worker", value: [WORKER] }],
		});
		expect(calls.length).toBe(cf.length);

		const status = await poll(content.intentId);
		expect(status).toMatchObject({
			status: "executed",
			result: {
				items: [
					{
						status: "executed",
						result: {
							status: "created",
							domain: zone,
							address,
							worker: WORKER,
							via: "rule",
							ruleId: "rule-new",
						},
					},
				],
			},
		});
		const created = await db
			.prepare(
				"SELECT payload_json FROM ops_events WHERE event_type = 'admin.cloudflare_route_created' AND subject = ?",
			)
			.bind(address)
			.first<{ payload_json: string }>();
		expect(JSON.parse(created!.payload_json)).toMatchObject({
			by: EMAIL,
			domain: zone,
			zone_id: zoneId,
			rule_id: "rule-new",
			worker: WORKER,
		});
		const executed = await db
			.prepare("SELECT payload_json FROM ops_events WHERE id = ?")
			.bind(`approval.executed:${content.intentId}`)
			.first<{ payload_json: string }>();
		expect(JSON.parse(executed!.payload_json)).toMatchObject({
			kind: "address_route",
			approver_user_id: owner.userId,
			outcomes: ["executed"],
		});

		// The decided page says what came of it.
		const view = await getIntentView(cfEnv, content.intentId, { userId: owner.userId });
		expect(view.status).toBe("executed");
		expect(view.fields.find((f) => f.label === "Resultado")?.value).toBe(
			`Regla creada: to:${address} → Worker ${WORKER}`,
		);

		// Single use: a second approve changes nothing and calls nothing.
		const again = stubFetch();
		expect((await approve(content.intentId)).resolved).toBe(true);
		expect(again).toEqual([]);
	});

	it("an address already routed to this Worker is executed as `already` without writing", async () => {
		const { zone, zoneId, address } = await setup();
		const { content } = await requestRoute(zone, address);
		const calls = stubFetch([
			catchAllDrop,
			[
				"GET",
				"/email/routing/rules?",
				200,
				[
					{
						id: "r1",
						enabled: true,
						matchers: [{ type: "literal", field: "to", value: address }],
						actions: [{ type: "worker", value: [WORKER] }],
					},
				],
			],
			routingOn,
		]);
		expect((await approve(content.intentId)).status).toBe("executed");
		expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
		expect((await poll(content.intentId)).result?.items[0]?.result).toMatchObject({
			status: "already",
			via: "rule",
			ruleId: "r1",
		});
		expect(calls.every((c) => c.url.includes(`/zones/${zoneId}/`))).toBe(true);
	});

	it("deny and expiry do nothing", async () => {
		const { zone, address } = await setup();
		const denied = await requestRoute(zone, address);
		const expired = await requestRoute(zone, address);
		const calls = stubFetch([
			catchAllDrop,
			noRules,
			routingOn,
			["POST", "/email/routing/rules", 200, { id: "x" }],
		]);
		expect((await denyIntent(cfEnv, denied.content.intentId)).status).toBe("denied");
		expect((await approve(denied.content.intentId)).status).toBe("denied");
		expect((await poll(denied.content.intentId)).status).toBe("denied");
		await db
			.prepare("UPDATE approvals SET expires_at = ? WHERE token = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), expired.content.intentId)
			.run();
		const late = await approve(expired.content.intentId);
		expect(late.error).toBe("expired");
		expect((await poll(expired.content.intentId)).status).toBe("expired");
		expect(calls).toEqual([]);
	});

	it("the payload hash binds domain and address: a different hash or a tampered payload is stale", async () => {
		const { zone, address } = await setup();
		const { content } = await requestRoute(zone, address);
		const calls = stubFetch([
			catchAllDrop,
			noRules,
			routingOn,
			["POST", "/email/routing/rules", 200, { id: "x" }],
		]);
		// The hash of the same domain with another address is not this request's hash.
		const otherHash = await hashPayload(canonicalJson({ address: `other@${zone}`, domain: zone }));
		const wrong = await approveIntent(cfEnv, {
			id: content.intentId,
			payloadHash: otherHash,
			channel: "web",
			approver: owner.userId,
		});
		expect(wrong).toMatchObject({ status: "stale", error: "stale" });
		// Swapping the stored payload (to another existing mailbox) breaks the binding too.
		await insertMailbox(db, {
			mailbox_id: `mbx_other_${n}`,
			primary_address: `other@${zone}`,
			display_name: null,
			status: "active",
			owner_email: EMAIL,
		});
		await db
			.prepare("UPDATE approvals SET payload_json = ? WHERE token = ?")
			.bind(canonicalJson({ address: `other@${zone}`, domain: zone }), content.intentId)
			.run();
		expect((await approve(content.intentId)).status).toBe("stale");
		expect((await getIntentStatus(cfEnv, content.intentId)).status).toBe("stale");
		expect(calls).toEqual([]);
	});

	it("a request whose target changed after it was made can no longer be approved", async () => {
		const { zone, address, mailboxId } = await setup();
		const { content } = await requestRoute(zone, address);
		await db
			.prepare("UPDATE mailboxes SET status = 'disabled' WHERE mailbox_id = ?")
			.bind(mailboxId)
			.run();
		const calls = stubFetch([
			catchAllDrop,
			noRules,
			routingOn,
			["POST", "/email/routing/rules", 200, { id: "x" }],
		]);
		expect((await getIntentView(cfEnv, content.intentId, { userId: owner.userId })).status).toBe(
			"stale",
		);
		const result = await approve(content.intentId);
		expect(result.error).toBe("forbidden");
		expect(result.status).toBe("pending");
		expect(calls).toEqual([]);
	});

	it("Cloudflare refusals surface as a failed execution with the reason and the remedy", async () => {
		const cases: Array<{
			name: string;
			routes: Stub[];
			runEnv?: Env;
			reason: string;
			cli?: boolean;
			writes?: number;
		}> = [
			{
				name: "conflict with a literal rule that forwards elsewhere",
				routes: [
					catchAllDrop,
					[
						"GET",
						"/email/routing/rules?",
						200,
						[
							{
								id: "theirs",
								name: "Theirs",
								enabled: true,
								matchers: [{ type: "literal", field: "to", value: "ADDRESS" }],
								actions: [{ type: "forward", value: ["x@gmail.com"] }],
							},
						],
					],
					routingOn,
				],
				reason: "conflict",
			},
			{
				name: "conflict with a catch-all that forwards",
				routes: [
					[
						"GET",
						"/email/routing/rules/catch_all",
						200,
						{
							enabled: true,
							matchers: [{ type: "all" }],
							actions: [{ type: "forward", value: ["x@gmail.com"] }],
						},
					],
					noRules,
					routingOn,
				],
				reason: "conflict",
			},
			{
				name: "routing disabled",
				routes: [["GET", "/email/routing", 200, { enabled: false }]],
				reason: "routing_disabled",
			},
			{
				name: "token without permission",
				routes: [["GET", "/email/routing", 403, null]],
				reason: "permission",
				cli: true,
			},
			{
				name: "Cloudflare error on create",
				routes: [catchAllDrop, noRules, routingOn, ["POST", "/email/routing/rules", 500, null]],
				reason: "cloudflare_error",
				writes: 1,
			},
			{
				name: "token missing",
				routes: [],
				runEnv: { ...env, CLOUDFLARE_API_TOKEN: "", WORKER_NAME: WORKER } as unknown as Env,
				reason: "token_missing",
				cli: true,
			},
		];
		for (const c of cases) {
			const { zone, address } = await setup();
			const { content } = await requestRoute(zone, address, c.runEnv ?? cfEnv);
			expect(content.status, c.name).toBe("pending");
			const routes = c.routes.map(
				([m, f, s, r]) =>
					[m, f, s, JSON.parse(JSON.stringify(r ?? null).replaceAll("ADDRESS", address))] as Stub,
			);
			const calls = stubFetch(routes);
			const approved = await approve(content.intentId, c.runEnv ?? cfEnv);
			expect(approved.status, c.name).toBe("failed");
			expect(calls.filter((call) => call.method !== "GET").length, c.name).toBe(c.writes ?? 0);
			const item = (await poll(content.intentId)).result?.items[0];
			expect(item, c.name).toMatchObject({
				status: "failed",
				errorCode: c.reason,
				detail: { reason: c.reason },
			});
			expect(typeof item?.detail?.message, c.name).toBe("string");
			expect(typeof item?.detail?.remedy, c.name).toBe("string");
			if (c.cli) expect(item?.detail?.cli, c.name).toContain(`--address ${address}`);
			if (c.reason === "conflict") expect(item?.detail?.conflict, c.name).toBeTruthy();
			const view = await getIntentView(cfEnv, content.intentId, { userId: owner.userId });
			expect(view.status, c.name).toBe("failed");
			expect(view.fields.find((f) => f.label === "Motivo")?.value, c.name).toBe(
				item?.detail?.message,
			);
			expect(view.fields.find((f) => f.label === "Qué hacer")?.value, c.name).toBe(
				item?.detail?.remedy,
			);
			const executed = await db
				.prepare("SELECT severity FROM ops_events WHERE id = ?")
				.bind(`approval.executed:${content.intentId}`)
				.first<{ severity: string }>();
			expect(executed?.severity, c.name).toBe("warning");
		}
	});
});
