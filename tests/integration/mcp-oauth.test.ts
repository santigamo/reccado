import { env } from "cloudflare:test";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/server";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationBetterAuthMcpFkFix from "../../migrations/d1/0018_better_auth_mcp_fk_fix.sql?raw";
import { applyMigrations } from "../helpers/migrations";

/**
 * End-to-end tests for the /mcp OAuth bearer-token perimeter
 * (docs/plans/sending-streams-and-auth.md Phase 2 item 5).
 *
 * Access tokens are NEVER hand-crafted: every token used here is minted by the
 * auth instance through the real client-facing flow — pairing → session →
 * dynamic client registration → authorize → consent → token — the same steps an
 * MCP client's operator performs. The only outbound fetch the flow makes (the
 * JWKS lookup during token verification at /mcp) is intercepted with fetchMock
 * and answered from the auth instance's own /jwks endpoint.
 */

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const OWNER = "owner@example.com";
const STRANGER = "stranger@example.com";
const ORIGIN = "https://example.com";
const RESOURCE = `${ORIGIN}/mcp`;
let cimdEnabled = false;
const metadataResponses = new Map<string, Response>();

const authEnv = () =>
	({
		...env,
		BETTER_AUTH_SECRET: TEST_SECRET,
		OWNER_BOOTSTRAP_EMAILS: OWNER,
		MCP_CIMD_ENABLED: String(cimdEnabled),
	}) as Env;

beforeAll(async () => {
	await applyMigrations(
		testEnv.INDEX_DB,
		migrationMessageIndex as string,
		migrationRuntimeConfig as string,
		migrationOwnerRegistry as string,
		migrationBetterAuth as string,
		migrationBetterAuthMcp as string,
		migrationBetterAuthMcpFkFix as string,
		migrationTwoFactor as string,
		migrationAuthUpgrade as string,
	);

	// Token verification at /mcp fetches the signing keys from our own /jwks.
	// Answer that fetch with the real JWKS document the worker serves (the lazily
	// minted key the OAuth provider signs with is the same one this endpoint
	// publishes).
	const jwksResponse = await run(new Request(`${ORIGIN}/api/auth/jwks`));
	expect(jwksResponse.status).toBe(200);
	const jwks = await jwksResponse.text();
	const realFetch = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (url === `${ORIGIN}/api/auth/jwks`) {
			return new Response(jwks, { headers: { "content-type": "application/json" } });
		}
		const metadata = metadataResponses.get(url);
		if (metadata) return metadata.clone();
		return realFetch(input, init);
	});
});

async function run(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** Collects every cookie a response handed out as `name=value` fragments. */
function cookiesOf(response: Response): string[] {
	const jar: string[] = [];
	for (const cookie of response.headers.getSetCookie()) {
		jar.push(cookie.split(";")[0]!);
	}
	return jar;
}

function cookieHeader(jar: string[]): string {
	return jar.join("; ");
}

async function postJson(
	path: string,
	body: unknown,
	cookie?: string,
	withOrigin = false,
): Promise<Response> {
	return run(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				// Session-authenticated better-auth endpoints (register, consent) run
				// behind the issuer's Origin check — a browser tab always sends one.
				...(withOrigin ? { origin: ORIGIN } : {}),
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
}

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "mcp-oauth-test", version: "1.0.0" },
	},
};

// Runs the authorize step with PKCE (dynamically registered clients require it
// by default) and returns the signed query the provider 302s to the consent
// page (src/routes/consent.tsx) with, plus the PKCE verifier for the token
// exchange.
async function runAuthorize(
	clientId: string,
	cookie: string,
	scope: string | null = "mail:read mail:draft",
): Promise<{ oauthQuery: string; verifier: string }> {
	const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
	const verifier = btoa(String.fromCharCode(...verifierBytes))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
	const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	const challenge = btoa(String.fromCharCode(...new Uint8Array(challengeBytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");

	const authorizeUrl = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
	authorizeUrl.searchParams.set("response_type", "code");
	authorizeUrl.searchParams.set("client_id", clientId);
	authorizeUrl.searchParams.set("redirect_uri", "https://client.example/cb");
	if (scope !== null) authorizeUrl.searchParams.set("scope", scope);
	authorizeUrl.searchParams.set("code_challenge", challenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	authorizeUrl.searchParams.set("resource", RESOURCE);
	const authorizeResponse = await run(
		new Request(authorizeUrl, { headers: { cookie }, redirect: "manual" }),
	);
	expect(authorizeResponse.status).toBe(302);
	const consentLocation = authorizeResponse.headers.get("location") ?? "";
	expect(consentLocation.startsWith("/consent?")).toBe(true);
	return { oauthQuery: consentLocation.split("?")[1] ?? "", verifier };
}

// The four protocol steps after registration, shared by the owner and stranger
// flows. Returns the minted access token.
async function authorizeAndMintToken(clientId: string, clientSecret: string, cookie: string) {
	const { oauthQuery, verifier } = await runAuthorize(clientId, cookie);

	// The consent page (src/routes/consent.tsx) POSTs exactly this: the decision
	// plus the raw signed query it was redirected with, over the owner session.
	const consentResponse = await postJson(
		"/api/auth/oauth2/consent",
		{ accept: true, oauth_query: oauthQuery },
		cookie,
		true,
	);
	expect(consentResponse.status).toBe(200);
	const consentBody = (await consentResponse.json()) as {
		redirect?: boolean;
		redirect_uri?: string;
		url?: string;
	};
	const redirectUri = consentBody.redirect_uri ?? consentBody.url ?? "";
	const code = new URL(redirectUri).searchParams.get("code");
	expect(code).toBeTruthy();

	const tokenResponse = await run(
		new Request(`${ORIGIN}/api/auth/oauth2/token`, {
			method: "POST",
			headers: {
				authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: code!,
				redirect_uri: "https://client.example/cb",
				code_verifier: verifier,
			}),
		}),
	);
	expect(tokenResponse.status).toBe(200);
	const tokens = (await tokenResponse.json()) as { access_token?: string };
	expect(typeof tokens.access_token).toBe("string");
	return tokens.access_token!;
}

beforeEach(async () => {
	cimdEnabled = false;
	metadataResponses.clear();
	await testEnv.INDEX_DB.prepare("DELETE FROM owner_identities").run();
	await testEnv.INDEX_DB.prepare('DELETE FROM "rateLimit"').run();
});

describe("CIMD opt-in", () => {
	it("discovers a client, displays the requested scopes and mints only approved scopes", async () => {
		const { cookie } = await ownerSessionAndClient("cimd-owner");
		cimdEnabled = true;
		const clientId = "https://client.test/metadata";
		metadataResponses.set(
			clientId,
			Response.json({
				client_id: clientId,
				client_name: "Example client",
				redirect_uris: ["https://client.example/cb"],
				token_endpoint_auth_method: "none",
			}),
		);
		for (const requested of [null, "mail:read mail:draft admin"]) {
			const { oauthQuery, verifier } = await runAuthorize(clientId, cookie, requested);
			expect(new URLSearchParams(oauthQuery).get("scope")).toBe(
				requested ?? "mail:read mail:draft",
			);
			expect(new URLSearchParams(oauthQuery).get("redirect_uri")).toBe("https://client.example/cb");
			const client = await run(
				new Request(
					`${ORIGIN}/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
					{ headers: { cookie } },
				),
			);
			expect(((await client.json()) as { client_name: string }).client_name).toBe("Example client");
			const consent = await postJson(
				"/api/auth/oauth2/consent",
				{ accept: true, oauth_query: oauthQuery },
				cookie,
				true,
			);
			expect(consent.status).toBe(200);
			const result = (await consent.json()) as { redirect_uri?: string; url?: string };
			const code = new URL(result.redirect_uri ?? result.url ?? "").searchParams.get("code");
			const token = await run(
				new Request(`${ORIGIN}/api/auth/oauth2/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: new URLSearchParams({
						grant_type: "authorization_code",
						code: code ?? "",
						client_id: clientId,
						redirect_uri: "https://client.example/cb",
						code_verifier: verifier,
					}),
				}),
			);
			expect(token.status).toBe(200);
			const body = (await token.json()) as { scope: string };
			expect(body.scope).toBe(requested ?? "mail:read mail:draft");
		}
		const rows = await testEnv.INDEX_DB.prepare(
			"SELECT id FROM ops_events WHERE event_type = 'mcp.client_first_seen' AND subject = ?",
		)
			.bind(clientId)
			.all();
		expect(rows.results).toHaveLength(1);
	});

	it("refuses a mismatched redirect and metadata redirects", async () => {
		const { cookie } = await ownerSessionAndClient("cimd-rejection-owner");
		cimdEnabled = true;
		for (const [clientId, response] of [
			[
				"https://other-client.test/metadata",
				Response.json({
					client_id: "https://other-client.test/metadata",
					client_name: "Other",
					redirect_uris: ["https://elsewhere.test/callback"],
					token_endpoint_auth_method: "none",
				}),
			],
			[
				"https://redirect-client.test/metadata",
				new Response(null, {
					status: 302,
					headers: { location: "https://elsewhere.test/metadata" },
				}),
			],
		] as const) {
			metadataResponses.set(clientId, response);
			const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
			for (const [key, value] of Object.entries({
				client_id: clientId,
				response_type: "code",
				redirect_uri: "https://client.example/cb",
				code_challenge: "a".repeat(43),
				code_challenge_method: "S256",
				resource: RESOURCE,
			}))
				url.searchParams.set(key, value);
			const result = await run(new Request(url, { headers: { cookie }, redirect: "manual" }));
			expect(result.headers.get("location") ?? "").not.toMatch(/^\/consent\?/);
		}
	});

	it("denies admin and disables URL clients by default", async () => {
		const { cookie } = await ownerSessionAndClient("cimd-deny-owner");
		const clientId = "https://deny-client.test/metadata";
		const disabled = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/authorize?client_id=${encodeURIComponent(clientId)}`, {
				headers: { cookie },
			}),
		);
		expect(disabled.status).toBe(400);
		cimdEnabled = true;
		metadataResponses.set(
			clientId,
			Response.json({
				client_id: clientId,
				client_name: "Deny client",
				redirect_uris: ["https://client.example/cb"],
				token_endpoint_auth_method: "none",
			}),
		);
		const { oauthQuery } = await runAuthorize(clientId, cookie, "admin");
		const consent = await postJson(
			"/api/auth/oauth2/consent",
			{ accept: false, oauth_query: oauthQuery },
			cookie,
			true,
		);
		const result = (await consent.json()) as { redirect_uri?: string; url?: string };
		const target = new URL(result.redirect_uri ?? result.url ?? "");
		expect(target.searchParams.get("error")).toBe("access_denied");
		expect(target.searchParams.has("code")).toBe(false);
	});

	it("rejects private names, numeric addresses and the deployment zone", async () => {
		const { cookie } = await ownerSessionAndClient("cimd-host-owner");
		cimdEnabled = true;
		for (const clientId of [
			"https://127.0.0.1/metadata",
			"https://0x7f000001/metadata",
			"https://[::1]/metadata",
			"https://service.internal/metadata",
			"https://sibling.example.com/metadata",
		]) {
			const url = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
			for (const [key, value] of Object.entries({
				client_id: clientId,
				response_type: "code",
				redirect_uri: "https://client.example/cb",
				code_challenge: "a".repeat(43),
				code_challenge_method: "S256",
				resource: RESOURCE,
			}))
				url.searchParams.set(key, value);
			const result = await run(new Request(url, { headers: { cookie }, redirect: "manual" }));
			expect(result.headers.get("location") ?? "").not.toMatch(/^\/consent\?/);
		}
	});
});

/**
 * Opens an owner session the way the rescue ladder does (the only sign-in path
 * a test can drive end to end without a mailbox), then registers an OAuth
 * client through session-backed dynamic client registration. The pairing code
 * is PRIMARY KEYed, so each caller supplies its own.
 */
async function ownerSessionAndClient(
	pairingCode: string,
): Promise<{ cookie: string; clientId: string; clientSecret: string }> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')`,
	)
		.bind(pairingCode, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
		.run();
	const pairing = await postJson("/api/auth/pairing", { email: OWNER, code: pairingCode });
	expect(pairing.status).toBe(200);
	const jar = cookiesOf(pairing);
	expect(jar.length).toBeGreaterThan(0);
	const cookie = cookieHeader(jar);

	const register = await postJson(
		"/api/auth/oauth2/register",
		{
			redirect_uris: ["https://client.example/cb"],
			token_endpoint_auth_method: "client_secret_basic",
			client_name: "mcp-oauth-test",
		},
		cookie,
		true,
	);
	expect(register.status).toBe(201);
	const client = (await register.json()) as { client_id: string; client_secret: string };
	expect(client.client_id).toBeTruthy();
	expect(client.client_secret).toBeTruthy();
	return { cookie, clientId: client.client_id, clientSecret: client.client_secret };
}

/** Mints a session for an arbitrary email through the auth instance's internal APIs. */
async function sessionCookieFor(email: string): Promise<string> {
	const { createAuth } = await import("#/api/better-auth");
	const auth = await createAuth(authEnv(), { request: new Request(`${ORIGIN}/`) });
	const ctx = await auth.$context;
	const user = await ctx.internalAdapter.createUser(
		{
			email,
			name: email.split("@")[0] ?? email,
			emailVerified: true,
		},
		{ method: "admin" },
	);
	const session = await ctx.internalAdapter.createSession(user.id, false);
	// Sign the cookie exactly the way better-auth does (HMAC-SHA256 over the
	// value, base64, dot-joined, URL-encoded) — see api/better-auth.ts.
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(ctx.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session.token));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	const name = ctx.authCookies.sessionToken.name;
	return `${name}=${encodeURIComponent(`${session.token}.${base64}`)}`;
}

describe("the /mcp bearer-token perimeter", () => {
	it("rejects a jwt plugin session token even with the MCP issuer and audience", async () => {
		const { cookie } = await ownerSessionAndClient("OAUTHJWTSESSION01");
		const tokenResponse = await run(
			new Request(`${ORIGIN}/api/auth/token`, { headers: { cookie } }),
		);
		expect(tokenResponse.status).toBe(200);
		const { token } = (await tokenResponse.json()) as { token: string };
		const payload = JSON.parse(
			atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
		) as Record<string, unknown>;
		const { createAuth } = await import("#/api/better-auth");
		const auth = await createAuth(authEnv(), { request: new Request(`${ORIGIN}/`) });
		const signJWT = (
			auth.api as unknown as {
				signJWT(args: {
					body: {
						payload: Record<string, unknown>;
						overrideOptions: { jwt: { issuer: string; audience: string } };
					};
				}): Promise<{ token: string }>;
			}
		).signJWT;
		const sameAudience = await signJWT({
			body: {
				payload: { ...payload, aud: RESOURCE, iss: `${ORIGIN}/api/auth` },
				overrideOptions: { jwt: { issuer: `${ORIGIN}/api/auth`, audience: RESOURCE } },
			},
		});
		const response = await run(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${sameAudience.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(INITIALIZE),
			}),
		);
		expect(response.status).toBe(401);
	});
	it("answers a tokenless request with 401 + RFC 9728 WWW-Authenticate, without running the MCP handler", async () => {
		const response = await run(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(INITIALIZE),
			}),
		);
		expect(response.status).toBe(401);
		const challenge = response.headers.get("www-authenticate") ?? "";
		expect(challenge).toContain("Bearer");
		expect(challenge).toContain(
			`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
		);
		// The JSON-RPC error shape the MCP client spec expects, not an initialize result.
		const body = (await response.json()) as { error?: { code?: number } };
		expect(body.error?.code).toBe(-32000);
	});

	it("serves /jwks with the signing key", async () => {
		const response = await run(new Request(`${ORIGIN}/api/auth/jwks`));
		expect(response.status).toBe(200);
		const jwks = (await response.json()) as { keys?: unknown[] };
		expect(Array.isArray(jwks.keys)).toBe(true);
		expect(jwks.keys!.length).toBeGreaterThan(0);
	});

	it("serves the RFC 8414 authorization-server metadata (basePath and root forms)", async () => {
		for (const path of [
			"/api/auth/.well-known/oauth-authorization-server",
			"/.well-known/oauth-authorization-server/api/auth",
		]) {
			const response = await run(new Request(`${ORIGIN}${path}`));
			expect(response.status, path).toBe(200);
			const metadata = (await response.json()) as {
				issuer?: string;
				token_endpoint?: string;
				registration_endpoint?: string | null;
			};
			expect(metadata.issuer, path).toBe(`${ORIGIN}/api/auth`);
			expect(metadata.token_endpoint, path).toBe(`${ORIGIN}/api/auth/oauth2/token`);
			// Session-gated registration is advertised; unauthenticated registration is not.
			expect(metadata.registration_endpoint, path).toBe(`${ORIGIN}/api/auth/oauth2/register`);
		}
	});

	it("serves the RFC 9728 protected-resource metadata for the /mcp resource", async () => {
		const response = await run(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
		expect(response.status).toBe(200);
		const metadata = (await response.json()) as {
			resource?: string;
			authorization_servers?: string[];
		};
		expect(metadata.resource).toBe(RESOURCE);
		expect(metadata.authorization_servers).toEqual([`${ORIGIN}/api/auth`]);
	});

	it("rejects unauthenticated dynamic client registration", async () => {
		const response = await postJson("/api/auth/oauth2/register", {
			redirect_uris: ["https://stranger.example/cb"],
		});
		expect(response.status).toBe(401);
	});

	it("registers, lists and revokes an owner public PKCE client", async () => {
		const { cookie } = await ownerSessionAndClient("OAUTHREGPUBLIC01");
		const response = await postJson(
			"/api/auth/oauth2/register",
			{
				client_name: "Claude Code",
				redirect_uris: ["http://localhost:33418/callback"],
				application_type: "native",
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			},
			cookie,
			true,
		);
		expect(response.status).toBe(201);
		const client = (await response.json()) as {
			client_id: string;
			client_secret?: string;
			token_endpoint_auth_method: string;
		};
		expect(client.client_id).toBeTruthy();
		expect(client.client_secret).toBeFalsy();
		expect(client.token_endpoint_auth_method).toBe("none");
		const list = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/get-clients`, { headers: { cookie } }),
		);
		expect(await list.json()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					client_id: client.client_id,
					redirect_uris: ["http://localhost:33418/callback"],
				}),
			]),
		);
		const deleted = await postJson(
			"/api/auth/oauth2/delete-client",
			{ client_id: client.client_id },
			cookie,
			true,
		);
		expect(deleted.status).toBe(200);
		const after = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/get-clients`, { headers: { cookie } }),
		);
		expect(await after.json()).not.toEqual(
			expect.arrayContaining([expect.objectContaining({ client_id: client.client_id })]),
		);
	});

	// Full flow against 0016+0017+0018: the FK fix migration recreates the four
	// oauth* tables with the canonical reference map the oauth-provider plugin
	// writes (clientId -> oauthClient(clientId), resourceId ->
	// oauthResource(identifier), sessionId -> session(id) ON DELETE SET NULL,
	// refreshId -> oauthRefreshToken(id)), so dynamic registration, consent and
	// token issuance no longer hit FOREIGN KEY constraint failures.
	it("runs the MCP handler for a valid owner token, and 403s a valid stranger token", async () => {
		const { cookie, clientId, clientSecret } = await ownerSessionAndClient("OAUTHPAIRING01");
		const ownerToken = await authorizeAndMintToken(clientId, clientSecret, cookie);

		const ownerResponse = await run(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${ownerToken}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(INITIALIZE),
			}),
		);
		expect(ownerResponse.status).toBe(200);
		const text = await ownerResponse.text();
		expect(text).toContain("reccado");
		// The initialize RESULT echoes protocolVersion and serverInfo (the method
		// name lives only on the request, so it is not in the response body).
		expect(text).toContain('"protocolVersion":"2025-06-18"');
		expect(text).toContain('"id":1');

		// Same client, but the authorizing session belongs to a stranger: the
		// token verifies (signed by us, right audience) and the owner gate still
		// denies it.
		const strangerCookie = await sessionCookieFor(STRANGER);
		const strangerToken = await authorizeAndMintToken(clientId, clientSecret, strangerCookie);
		const strangerResponse = await run(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${strangerToken}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify(INITIALIZE),
			}),
		);
		expect(strangerResponse.status).toBe(403);
		const body = (await strangerResponse.json()) as { error?: string };
		expect(body.error).toBe("forbidden");

		await testEnv.INDEX_DB.prepare("DELETE FROM owner_identities").run();
		const ctx = createExecutionContext();
		const noOwnerResponse = await worker.fetch(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
				body: JSON.stringify(INITIALIZE),
			}),
			{ ...authEnv(), OWNER_BOOTSTRAP_EMAILS: "" },
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(noOwnerResponse.status).toBe(503);
		// Upstream's client FK has no cascade: deletion of an authorized client fails.
		const revoked = await postJson(
			"/api/auth/oauth2/delete-client",
			{ client_id: clientId },
			cookie,
			true,
		);
		expect(revoked.status).toBe(500);
	});

	// The deny path the consent page's Deny button exercises: the provider does
	// not mint a code and sends the browser back to the client with the
	// RFC 6749 access_denied error instead.
	it("returns the access_denied redirect when consent is denied", async () => {
		const { cookie, clientId } = await ownerSessionAndClient("OAUTHDENY01");
		const { oauthQuery } = await runAuthorize(clientId, cookie);
		const consentResponse = await postJson(
			"/api/auth/oauth2/consent",
			{ accept: false, oauth_query: oauthQuery },
			cookie,
			true,
		);
		expect(consentResponse.status).toBe(200);
		const body = (await consentResponse.json()) as {
			redirect?: boolean;
			redirect_uri?: string;
			url?: string;
		};
		const redirectUri = body.redirect_uri ?? body.url ?? "";
		expect(redirectUri.startsWith("https://client.example/cb")).toBe(true);
		const error = new URL(redirectUri).searchParams.get("error");
		expect(error).toBe("access_denied");
	});

	// The consent endpoint fails closed on a tampered query: the signature is
	// HMACed with the auth secret, so a modified scope must be rejected.
	it("rejects a consent POST whose oauth_query does not match its signature", async () => {
		const { cookie, clientId } = await ownerSessionAndClient("OAUTHTAMPER01");
		const { oauthQuery } = await runAuthorize(clientId, cookie);
		const tampered = new URLSearchParams(oauthQuery);
		tampered.set("scope", "mail:read mail:draft admin");
		const response = await postJson(
			"/api/auth/oauth2/consent",
			{ accept: true, oauth_query: tampered.toString() },
			cookie,
			true,
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error?: string };
		expect(body.error).toBe("invalid_signature");
	});
});
