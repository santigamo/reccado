import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationBetterAuthMcpFkFix from "../../migrations/d1/0018_better_auth_mcp_fk_fix.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import { applyMigrations } from "../helpers/migrations";

/**
 * POST /api/cloudflare/domains/:domain/routing — "Route it" from Settings.
 * Every Cloudflare call is answered by a fetch stub; nothing reaches the real API.
 */

type TestEnv = Omit<Env, "WORKER_NAME"> & { CLOUDFLARE_API_TOKEN?: string; WORKER_NAME?: string };
const testEnv = env as unknown as TestEnv;
const db = testEnv.INDEX_DB;
const realFetch = globalThis.fetch;
const realToken = testEnv.CLOUDFLARE_API_TOKEN;
const realWorker = testEnv.WORKER_NAME;

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
		migrationBetterAuthMcpFkFix,
		migrationTwoFactor,
		migrationAuthUpgrade,
	);
});

afterEach(() => {
	globalThis.fetch = realFetch;
	testEnv.CLOUDFLARE_API_TOKEN = realToken;
	testEnv.WORKER_NAME = realWorker;
});

async function run(request: Request, runEnv: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, runEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** Local-dev identity (http://localhost, no BETTER_AUTH_SECRET): the owner web session stand-in. */
async function post(path: string, body: unknown) {
	const response = await run(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const route = (domain: string, address: string) =>
	post(`/api/cloudflare/domains/${domain}/routing`, { address });

type Call = { method: string; url: string; body: unknown };

/** Answers Cloudflare from `method + url fragment -> [status, result]`; records every call. */
function stubCloudflare(routes: Array<[string, string, number, unknown]>): Call[] {
	const calls: Call[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stand-in
	globalThis.fetch = (async (input: any, init: any) => {
		const url = typeof input === "string" ? input : input.url;
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

let n = 0;
/** A registered active domain with one mailbox, and a token set. */
async function setup(): Promise<{ zone: string; zoneId: string; address: string }> {
	n += 1;
	const zone = `route-${n}.test`;
	const zoneId = `z-route-${n}`;
	expect((await post("/api/domains", { domain: zone, zoneId })).status).toBeLessThan(300);
	const address = `hello@${zone}`;
	expect((await post("/api/mailboxes", { primaryAddress: address })).status).toBe(201);
	testEnv.CLOUDFLARE_API_TOKEN = "test-token";
	testEnv.WORKER_NAME = "reccado-dev";
	return { zone, zoneId, address };
}

const routingOn: [string, string, number, unknown] = [
	"GET",
	"/email/routing",
	200,
	{ enabled: true },
];
const catchAllDrop: [string, string, number, unknown] = [
	"GET",
	"/email/routing/rules/catch_all",
	200,
	{ enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
];

async function opsEvents(subject: string) {
	return (
		await db
			.prepare("SELECT event_type, severity, payload_json FROM ops_events WHERE subject = ?")
			.bind(subject)
			.all<{ event_type: string; severity: string; payload_json: string }>()
	).results;
}

describe("POST /api/cloudflare/domains/:domain/routing", () => {
	it("creates one literal rule to this Worker and records an ops event", async () => {
		const { zone, zoneId, address } = await setup();
		const calls = stubCloudflare([
			catchAllDrop,
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
			["POST", `/zones/${zoneId}/email/routing/rules`, 200, { id: "rule-new" }],
		]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(201);
		expect(body).toEqual({
			ok: true,
			status: "created",
			address,
			worker: "reccado-dev",
			via: "rule",
			ruleId: "rule-new",
		});
		expect(calls.filter((c) => c.method !== "GET")).toEqual([
			{
				method: "POST",
				url: `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`,
				body: {
					enabled: true,
					name: "hello -> reccado-dev",
					matchers: [{ type: "literal", field: "to", value: address }],
					actions: [{ type: "worker", value: ["reccado-dev"] }],
				},
			},
		]);
		// The zone came from the registry, not the request.
		expect(calls.every((c) => c.url.includes(`/zones/${zoneId}/`))).toBe(true);
		const events = await opsEvents(address);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			event_type: "admin.cloudflare_route_created",
			severity: "info",
		});
		expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
			by: "dev@local",
			domain: zone,
			zone_id: zoneId,
			worker: "reccado-dev",
			rule_id: "rule-new",
		});
	});

	it("uses the Worker name this deployment declares, not a hardcoded one", async () => {
		const { zone, address } = await setup();
		testEnv.WORKER_NAME = "reccado";
		const calls = stubCloudflare([
			catchAllDrop,
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
			["POST", "/email/routing/rules", 200, { id: "r" }],
		]);
		const { body } = await route(zone, address);
		expect(body).toMatchObject({ ok: true, worker: "reccado" });
		expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
			actions: [{ type: "worker", value: ["reccado"] }],
		});
	});

	it("answers already, without writing, when a rule routes the address here", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([
			catchAllDrop,
			[
				"GET",
				"/email/routing/rules?",
				200,
				[
					{
						id: "r-existing",
						enabled: true,
						matchers: [{ type: "literal", field: "to", value: address }],
						actions: [{ type: "worker", value: ["reccado-dev"] }],
					},
				],
			],
			routingOn,
		]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, status: "already", via: "rule", ruleId: "r-existing" });
		expect(calls.every((c) => c.method === "GET")).toBe(true);
		expect(await opsEvents(address)).toEqual([]);
	});

	it("answers already via the catch-all, without writing", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([
			[
				"GET",
				"/email/routing/rules/catch_all",
				200,
				{
					enabled: true,
					matchers: [{ type: "all" }],
					actions: [{ type: "worker", value: ["reccado-dev"] }],
				},
			],
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
		]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: true, status: "already", via: "catch_all" });
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("refuses, without writing, when a rule sends the address elsewhere", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([
			catchAllDrop,
			[
				"GET",
				"/email/routing/rules?",
				200,
				[
					{
						id: "r-theirs",
						name: "to gmail",
						enabled: true,
						matchers: [{ type: "literal", field: "to", value: address }],
						actions: [{ type: "forward", value: ["me@gmail.test"] }],
					},
				],
			],
			routingOn,
		]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(409);
		expect(body).toMatchObject({
			ok: false,
			reason: "conflict",
			conflict: {
				via: "rule",
				id: "r-theirs",
				name: "to gmail",
				action: "forward to me@gmail.test",
			},
		});
		expect(String(body.message)).toContain("won't change or delete it");
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("refuses, without writing, when the catch-all forwards elsewhere", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([
			[
				"GET",
				"/email/routing/rules/catch_all",
				200,
				{
					enabled: true,
					matchers: [{ type: "all" }],
					actions: [{ type: "forward", value: ["x@y.test"] }],
				},
			],
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
		]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(409);
		expect(body).toMatchObject({ reason: "conflict", conflict: { via: "catch_all" } });
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("refuses when Email Routing is off for the zone, and does not turn it on", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([["GET", "/email/routing", 200, { enabled: false }]]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(422);
		expect(body).toMatchObject({ ok: false, reason: "routing_disabled" });
		expect(String(body.remedy)).toContain("Turn on Email Routing");
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("refuses with the CLI fallback when the token is missing, calling nothing", async () => {
		const { zone, address } = await setup();
		testEnv.CLOUDFLARE_API_TOKEN = "";
		const calls = stubCloudflare([]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(424);
		expect(body).toMatchObject({
			ok: false,
			reason: "token_missing",
			cli: `pnpm setup:routing --domain ${zone} --address ${address} --env <env> --apply`,
		});
		expect(String(body.remedy)).toContain("Email Routing Rules · Edit");
		expect(calls).toEqual([]);
	});

	it("refuses with the permission remedy when Cloudflare says the token may not", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([["GET", "/email/routing", 403, null]]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(424);
		expect(body).toMatchObject({ ok: false, reason: "permission" });
		expect(String(body.remedy)).toContain("Email Routing Rules · Edit");
		expect(body.cli).toBeTruthy();
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("refuses a permission error on the write itself", async () => {
		const { zone, address } = await setup();
		stubCloudflare([
			catchAllDrop,
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
			["POST", "/email/routing/rules", 403, null],
		]);
		const { status, body } = await route(zone, address);
		expect(status).toBe(424);
		expect(body).toMatchObject({ ok: false, reason: "permission" });
	});

	it("refuses an address that is not a mailbox or alias in Reccado", async () => {
		const { zone } = await setup();
		const calls = stubCloudflare([]);
		const { status, body } = await route(zone, `nobody@${zone}`);
		expect(status).toBe(422);
		expect(body).toMatchObject({ ok: false, reason: "address_unknown" });
		expect(calls).toEqual([]);
	});

	it("refuses an address on another domain, an unregistered domain and an inactive one", async () => {
		const { zone, address } = await setup();
		const calls = stubCloudflare([]);
		expect((await route(zone, "hello@elsewhere.test")).body).toMatchObject({
			reason: "invalid_address",
		});
		const missing = await route("unregistered.test", "hello@unregistered.test");
		expect(missing.status).toBe(404);
		expect(missing.body).toMatchObject({ reason: "domain_not_found" });
		await run(
			new Request(`http://localhost/api/domains/${zone}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ status: "disabled" }),
			}),
		);
		const inactive = await route(zone, address);
		expect(inactive.status).toBe(422);
		expect(inactive.body).toMatchObject({ reason: "domain_inactive" });
		expect(calls).toEqual([]);
	});

	it("routes an active alias too", async () => {
		const { zone, address } = await setup();
		const mailbox = (await db
			.prepare("SELECT mailbox_id FROM mailboxes WHERE primary_address = ?")
			.bind(address)
			.first<{ mailbox_id: string }>())!;
		expect(
			(await post("/api/aliases", { aliasAddress: `sales@${zone}`, mailboxId: mailbox.mailbox_id }))
				.status,
		).toBeLessThan(300);
		stubCloudflare([
			catchAllDrop,
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
			["POST", "/email/routing/rules", 200, { id: "r-alias" }],
		]);
		const { status, body } = await route(zone, `sales@${zone}`);
		expect(status).toBe(201);
		expect(body).toMatchObject({ ok: true, status: "created", address: `sales@${zone}` });
	});

	it("answers an empty or non-JSON body with invalid_address, not a server error", async () => {
		const { zone } = await setup();
		const calls = stubCloudflare([]);
		for (const body of [undefined, "", "not json", "{"]) {
			const response = await run(
				new Request(`http://localhost/api/cloudflare/domains/${zone}/routing`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					...(body === undefined ? {} : { body }),
				}),
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ ok: false, reason: "invalid_address" });
		}
		expect(calls).toEqual([]);
	});

	it("refuses, like the agent's address_route, an address whose mailbox has another owner", async () => {
		const { zone } = await setup();
		const now = new Date().toISOString();
		const foreign = `mbx_foreign_${n}`;
		await db
			.prepare(
				"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, 'active', ?, ?, ?)",
			)
			.bind(foreign, `other@${zone}`, "someone-else@example.org", now, now)
			.run();
		await db
			.prepare(
				"INSERT INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at) SELECT ?, ?, id, 'active', ?, ? FROM domains WHERE domain = ?",
			)
			.bind(`otheralias@${zone}`, foreign, now, now, zone)
			.run();
		const calls = stubCloudflare([
			catchAllDrop,
			["GET", "/email/routing/rules?", 200, []],
			routingOn,
			["POST", "/email/routing/rules", 200, { id: "r-foreign" }],
		]);
		for (const address of [`other@${zone}`, `otheralias@${zone}`]) {
			const { status, body } = await route(zone, address);
			expect(status).toBe(403);
			expect(body).toEqual({ error: "forbidden" });
		}
		expect(calls).toEqual([]);

		// A mailbox with no owner yet (pre-ownership rows) stays routable from the
		// owner's web session, as the rest of the UI treats it.
		await db
			.prepare("UPDATE mailboxes SET owner_email = NULL WHERE mailbox_id = ?")
			.bind(foreign)
			.run();
		const { status } = await route(zone, `other@${zone}`);
		expect(status).toBe(201);
	});
});

describe("POST /api/cloudflare/domains/:domain/routing — perimeter", () => {
	const ORIGIN = "https://example.com";
	const OWNER = "route-owner@example.com";
	const authEnv = () =>
		({
			...env,
			BETTER_AUTH_SECRET: "test-secret-0123456789-0123456789-0123",
			OWNER_BOOTSTRAP_EMAILS: OWNER,
			CLOUDFLARE_API_TOKEN: "test-token",
		}) as Env;

	const authPost = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		run(
			new Request(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
				body: JSON.stringify(body),
			}),
			authEnv(),
		);

	it("refuses a request with no session (401) and never calls Cloudflare", async () => {
		const calls = stubCloudflare([]);
		const response = await authPost("/api/cloudflare/domains/any.test/routing", {
			address: "hello@any.test",
		});
		expect(response.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it("refuses an MCP OAuth access token: only the owner web session may route", async () => {
		const code = "ROUTEPAIRING0001";
		await db
			.prepare(
				"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
			)
			.bind(code, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
			.run();
		const paired = await authPost("/api/auth/pairing", { email: OWNER, code });
		expect(paired.status, await paired.clone().text()).toBe(200);
		const cookie = paired.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");

		const register = await authPost(
			"/api/auth/oauth2/register",
			{
				redirect_uris: ["https://client.example/cb"],
				token_endpoint_auth_method: "client_secret_basic",
				client_name: "route-test",
			},
			{ cookie },
		);
		expect(register.status, await register.clone().text()).toBe(201);
		const client = (await register.json()) as { client_id: string; client_secret: string };
		const b64url = (bytes: Uint8Array) =>
			btoa(String.fromCharCode(...bytes))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
		const challenge = b64url(
			new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
		);
		const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("client_id", client.client_id);
		authorize.searchParams.set("redirect_uri", "https://client.example/cb");
		authorize.searchParams.set("scope", "config:read domains:write routing:write mailboxes:write");
		authorize.searchParams.set("code_challenge", challenge);
		authorize.searchParams.set("code_challenge_method", "S256");
		authorize.searchParams.set("resource", `${ORIGIN}/mcp`);
		const redirected = await run(
			new Request(authorize, { headers: { cookie }, redirect: "manual" }),
			authEnv(),
		);
		expect(redirected.status).toBe(302);
		const oauthQuery = (redirected.headers.get("location") ?? "").split("?")[1] ?? "";
		const consent = await authPost(
			"/api/auth/oauth2/consent",
			{ accept: true, oauth_query: oauthQuery },
			{ cookie },
		);
		expect(consent.status).toBe(200);
		const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
		const authCode = new URL(consentBody.redirect_uri ?? consentBody.url ?? "").searchParams.get(
			"code",
		);
		const token = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/token`, {
				method: "POST",
				headers: {
					authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: authCode ?? "",
					redirect_uri: "https://client.example/cb",
					code_verifier: verifier,
				}),
			}),
			authEnv(),
		);
		expect(token.status).toBe(200);
		const { access_token } = (await token.json()) as { access_token: string };
		expect(access_token).toBeTruthy();

		const calls = stubCloudflare([]);
		const response = await run(
			new Request(`${ORIGIN}/api/cloudflare/domains/any.test/routing`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
				body: JSON.stringify({ address: "hello@any.test" }),
			}),
			authEnv(),
		);
		expect(response.status).toBe(401);
		expect(calls).toEqual([]);

		// The session that minted the token can (proving the 401 above is about the bearer).
		const withSession = await authPost(
			"/api/cloudflare/domains/any.test/routing",
			{ address: "hello@any.test" },
			{ cookie },
		);
		expect(withSession.status).toBe(404);
	});
});
