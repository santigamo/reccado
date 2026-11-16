import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationBetterAuthMcpFkFix from "../../migrations/d1/0018_better_auth_mcp_fk_fix.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationPasskey from "../../migrations/d1/0024_passkey.sql?raw";
import { checkRegistrationBody, sweepStaleOAuthClients } from "../../src/lib/oauth-client-hygiene";
import worker from "../../src/server";
import { renderClientConnectedNotice } from "../../src/telegram/client-connected";
import { applyMigrations } from "../helpers/migrations";

/**
 * Standard MCP connection (`claude mcp add --transport http reccado https://<host>/mcp`):
 * discovery, open RFC 7591 registration with its hardening, then login + consent + PKCE
 * token + a call to /mcp -- the steps a stock MCP client performs.
 */

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const OWNER = "owner@example.com";
const ORIGIN = "https://inbox.imsanti.dev";
const REDIRECT = "http://127.0.0.1:53682/callback";

const authEnv = () =>
	({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, OWNER_BOOTSTRAP_EMAILS: OWNER }) as Env;

async function run(request: Request, ip = "203.0.113.7"): Promise<Response> {
	if (new URL(request.url).pathname === "/mcp" && !request.headers.has("host")) {
		request.headers.set("host", new URL(request.url).host);
	}
	if (!request.headers.has("cf-connecting-ip")) request.headers.set("cf-connecting-ip", ip);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function post(path: string, body: unknown, extra: Record<string, string> = {}, ip?: string) {
	return run(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...extra },
			body: JSON.stringify(body),
		}),
		ip,
	);
}

beforeAll(async () => {
	await applyMigrations(
		testEnv.INDEX_DB,
		migrationInitial as string,
		migrationMessageIndex as string,
		migrationMailboxOwner as string,
		migrationRuntimeConfig as string,
		migrationOwnerRegistry as string,
		migrationBetterAuth as string,
		migrationBetterAuthMcp as string,
		migrationBetterAuthMcpFkFix as string,
		migrationTwoFactor as string,
		migrationAuthUpgrade as string,
		migrationPasskey as string,
	);
	// Production regression: a Worker cannot subrequest its own route on its custom
	// domain, so an HTTP fetch of our own /jwks fails there. Make it fail here too;
	// token verification must get the keys in process.
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url.endsWith("/api/auth/jwks")) return new Response(null, { status: 522 });
		return realFetch(input, init);
	});
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare('DELETE FROM "rateLimit"').run();
});

async function register(body: Record<string, unknown> = {}, ip?: string): Promise<Response> {
	return post(
		"/api/auth/oauth2/register",
		{
			redirect_uris: [REDIRECT],
			token_endpoint_auth_method: "none",
			client_name: "Claude Code",
			...body,
		},
		{},
		ip,
	);
}

describe("discovery", () => {
	it("advertises DCR and answers /mcp 401 with resource_metadata", async () => {
		const unauth = await run(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			}),
		);
		expect(unauth.status).toBe(401);
		expect(unauth.headers.get("www-authenticate")).toMatch(/Bearer .*resource_metadata=/);

		const resource = await run(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
		expect(resource.status).toBe(200);
		const resourceDoc = (await resource.json()) as {
			resource: string;
			authorization_servers: string[];
		};
		expect(resourceDoc.resource).toBe(`${ORIGIN}/mcp`);

		for (const path of [
			"/.well-known/oauth-authorization-server/api/auth",
			"/.well-known/oauth-authorization-server",
		]) {
			const response = await run(new Request(`${ORIGIN}${path}`));
			expect(response.status, path).toBe(200);
			const doc = (await response.json()) as { registration_endpoint?: string };
			expect(doc.registration_endpoint, path).toBe(`${ORIGIN}/api/auth/oauth2/register`);
		}
	});
});

describe("open dynamic client registration", () => {
	it("registers without a session, sanitizes the name and records an ops event", async () => {
		const response = await register({ client_name: `Evil\u0000‮Name${"x".repeat(300)}` });
		expect(response.status, await response.clone().text()).toBe(201);
		const client = (await response.json()) as { client_id: string; client_name: string };
		// biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control characters were stripped
		expect(client.client_name).not.toMatch(/[\u0000‮]/);
		expect(client.client_name.length).toBeLessThanOrEqual(100);
		const row = await testEnv.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'mcp.client_registered' AND subject = ?",
		)
			.bind(client.client_id)
			.first<{ payload_json: string }>();
		const payload = JSON.parse(row!.payload_json) as { redirect_hosts: string[]; ip_hash: string };
		expect(payload.redirect_hosts).toEqual(["127.0.0.1:53682"]);
		expect(payload.ip_hash).toMatch(/^[0-9a-f]{16}$/);
		expect(row!.payload_json).not.toContain("203.0.113.7");
	});

	it("rejects non-https, non-loopback and malformed redirect URIs", async () => {
		for (const uri of [
			"http://evil.example/cb",
			"javascript:alert(1)",
			"cursor://anysphere/cb",
			"https://user:pw@client.example/cb",
			"https://client.example/cb#frag",
			"not a url",
		]) {
			const response = await register({ redirect_uris: [uri] });
			expect(response.status, uri).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe("invalid_redirect_uri");
		}
		expect((await register({ redirect_uris: ["https://client.example/cb"] })).status).toBe(201);
		expect((await register({ redirect_uris: ["http://localhost:8123/cb"] })).status).toBe(201);
		expect((await register({ redirect_uris: ["http://[::1]:8123/cb"] })).status).toBe(201);
		expect(checkRegistrationBody({ client_name: 5, redirect_uris: [REDIRECT] }).ok).toBe(false);
	});

	it("rate-limits registration per IP (D1-backed)", async () => {
		for (let i = 0; i < 10; i++) {
			expect((await register({}, "198.51.100.9")).status).toBe(201);
		}
		expect((await register({}, "198.51.100.9")).status).toBe(429);
		// A different address has its own budget.
		expect((await register({}, "198.51.100.10")).status).toBe(201);
	});
});

describe("PKCE flow after open registration", () => {
	it("needs login, then consent, then the token works on /mcp", async () => {
		const reg = await register({ client_name: "Flow client" });
		expect(reg.status).toBe(201);
		const { client_id: clientId } = (await reg.json()) as { client_id: string };

		const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const challenge = btoa(
			String.fromCharCode(
				...new Uint8Array(
					await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
				),
			),
		)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
		for (const [k, v] of Object.entries({
			response_type: "code",
			client_id: clientId,
			redirect_uri: REDIRECT,
			scope: "mail:read mail:draft",
			code_challenge: challenge,
			code_challenge_method: "S256",
			resource: `${ORIGIN}/mcp`,
		}))
			authorize.searchParams.set(k, v);

		// No session: the browser is sent to /login, never to consent or back to the client.
		const anon = await run(new Request(authorize, { redirect: "manual" }));
		expect(anon.status).toBe(302);
		expect(anon.headers.get("location") ?? "").toMatch(/^\/login/);

		// Owner logs in (pairing code stands in for the e-mail OTP round trip).
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES ('std-code', ?, ?, 'manual')`,
		)
			.bind(new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
			.run();
		const pairing = await post("/api/auth/pairing", { email: OWNER, code: "std-code" });
		expect(pairing.status).toBe(200);
		const cookie = pairing.headers
			.getSetCookie()
			.map((c) => c.split(";")[0])
			.join("; ");

		const logged = await run(new Request(authorize, { headers: { cookie }, redirect: "manual" }));
		const location = logged.headers.get("location") ?? "";
		expect(location.startsWith("/consent?")).toBe(true);

		// Nothing is granted before consent: there is no consent row yet.
		const before = await testEnv.INDEX_DB.prepare(
			`SELECT COUNT(*) AS n FROM "oauthConsent" WHERE "clientId" = ?`,
		)
			.bind(clientId)
			.first<{ n: number }>();
		expect(before!.n).toBe(0);

		const consent = await post(
			"/api/auth/oauth2/consent",
			{ accept: true, oauth_query: location.split("?")[1] },
			{ cookie, origin: ORIGIN },
		);
		expect(consent.status).toBe(200);
		const result = (await consent.json()) as { redirect_uri?: string; url?: string };
		const code = new URL(result.redirect_uri ?? result.url ?? "").searchParams.get("code");
		expect(code).toBeTruthy();

		const token = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: code!,
					client_id: clientId,
					redirect_uri: REDIRECT,
					code_verifier: verifier,
				}),
			}),
		);
		expect(token.status).toBe(200);
		const { access_token: accessToken } = (await token.json()) as { access_token: string };

		const mcp = await run(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
					authorization: `Bearer ${accessToken}`,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "std-test", version: "1" },
					},
				}),
			}),
		);
		expect(mcp.status).toBe(200);
	});
});

describe("stale client sweep", () => {
	it("drops never-consented clients older than 24h and keeps the rest", async () => {
		const now = Date.now();
		const insert = (id: string, createdAt: number) =>
			testEnv.INDEX_DB.prepare(
				`INSERT INTO "oauthClient" ("id","clientId","redirectUris","createdAt") VALUES (?,?,?,?)`,
			)
				.bind(`row-${id}`, id, '["https://c.example/cb"]', createdAt)
				.run();
		await insert("sweep-old-unused", now - 25 * 3600_000);
		await insert("sweep-new-unused", now - 1 * 3600_000);
		const removed = await sweepStaleOAuthClients(testEnv.INDEX_DB, now);
		expect(removed).toBe(1);
		const left = await testEnv.INDEX_DB.prepare(
			`SELECT "clientId" FROM "oauthClient" WHERE "clientId" LIKE 'sweep-%' ORDER BY 1`,
		).all<{ clientId: string }>();
		expect(left.results.map((r) => r.clientId)).toEqual(["sweep-new-unused"]);
	});
});

describe("first-consent notice", () => {
	it("names the client, redirect host and scopes, escaping HTML", () => {
		const text = renderClientConnectedNotice({
			clientName: "<b>Claude</b>",
			redirectHosts: ["claude.ai"],
			scopes: ["mail:read", "admin"],
		});
		expect(text).toContain("Nueva app conectada");
		expect(text).toContain("&lt;b&gt;Claude&lt;/b&gt;");
		expect(text).toContain("claude.ai");
		expect(text).toContain("mail:read admin");
		expect(text).toContain("/settings/agent-access");
	});
});
