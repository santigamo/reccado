import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import worker from "../../src/server";
import { applyMigrations } from "../helpers/migrations";

/**
 * Owner-gated OAuth client revoke. Tokens are minted by the real provider
 * flow; the one hand-inserted row is an oauthAccessToken whose refreshId
 * points at that refresh token, which is the foreign key that rejects a
 * naive client delete.
 */

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const OWNER = "owner@example.com";
const STRANGER = "stranger@example.com";
const ORIGIN = "https://inbox.imsanti.dev";
const RESOURCE = `${ORIGIN}/mcp`;

const authEnv = () =>
	({
		...env,
		BETTER_AUTH_SECRET: TEST_SECRET,
		OWNER_BOOTSTRAP_EMAILS: OWNER,
	}) as Env;

async function run(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function cookiesOf(response: Response): string[] {
	const jar: string[] = [];
	for (const cookie of response.headers.getSetCookie()) {
		jar.push(cookie.split(";")[0]!);
	}
	return jar;
}

async function postJson(
	path: string,
	body: unknown,
	cookie?: string,
	extraHeaders?: Record<string, string>,
): Promise<Response> {
	return run(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(cookie ? { cookie } : {}),
				...extraHeaders,
			},
			body: JSON.stringify(body),
		}),
	);
}

async function userIdByEmail(email: string): Promise<string> {
	const row = await testEnv.INDEX_DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
		.bind(email)
		.first<{ id: string }>();
	if (!row) throw new Error(`no user for ${email}`);
	return row.id;
}

async function countForClient(table: string, clientId: string): Promise<number> {
	const row = await testEnv.INDEX_DB.prepare(
		`SELECT COUNT(*) AS n FROM "${table}" WHERE "clientId" = ?`,
	)
		.bind(clientId)
		.first<{ n: number }>();
	return Number(row?.n ?? 0);
}

async function ownerSession(pairingCode: string): Promise<string> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')`,
	)
		.bind(pairingCode, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
		.run();
	const pairing = await postJson("/api/auth/pairing", { email: OWNER, code: pairingCode });
	expect(pairing.status, await pairing.clone().text()).toBe(200);
	const cookie = cookiesOf(pairing).join("; ");
	expect(cookie).not.toBe("");
	return cookie;
}

async function registerClient(
	cookie: string,
	name: string,
): Promise<{ clientId: string; clientSecret: string }> {
	const register = await postJson(
		"/api/auth/oauth2/register",
		{
			redirect_uris: ["https://client.example/cb"],
			token_endpoint_auth_method: "client_secret_basic",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_name: name,
		},
		cookie,
		{ origin: ORIGIN },
	);
	expect(register.status, await register.clone().text()).toBe(201);
	const client = (await register.json()) as { client_id: string; client_secret: string };
	expect(client.client_id).toBeTruthy();
	expect(client.client_secret).toBeTruthy();
	return { clientId: client.client_id, clientSecret: client.client_secret };
}

/** The provider only stores a refresh token when the grant asked for offline_access. */
async function allowOfflineAccess(clientId: string): Promise<void> {
	const row = await testEnv.INDEX_DB.prepare(
		`SELECT scopes FROM "oauthClient" WHERE "clientId" = ?`,
	)
		.bind(clientId)
		.first<{ scopes: string | null }>();
	let scopes: string[] = ["mail:read", "mail:draft"];
	if (row?.scopes) {
		const parsed = JSON.parse(row.scopes) as unknown;
		if (!Array.isArray(parsed) || parsed.some((scope) => typeof scope !== "string")) {
			throw new Error(`unexpected oauthClient.scopes: ${row.scopes}`);
		}
		scopes = parsed as string[];
	}
	if (!scopes.includes("offline_access")) scopes.push("offline_access");
	await testEnv.INDEX_DB.prepare(`UPDATE "oauthClient" SET scopes = ? WHERE "clientId" = ?`)
		.bind(JSON.stringify(scopes), clientId)
		.run();
}

async function authorize(
	clientId: string,
	cookie: string,
	scope: string,
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
	authorizeUrl.searchParams.set("scope", scope);
	authorizeUrl.searchParams.set("code_challenge", challenge);
	authorizeUrl.searchParams.set("code_challenge_method", "S256");
	authorizeUrl.searchParams.set("resource", RESOURCE);
	const authorizeResponse = await run(
		new Request(authorizeUrl, { headers: { cookie }, redirect: "manual" }),
	);
	expect(authorizeResponse.status, authorizeResponse.headers.get("location") ?? "").toBe(302);
	const location = authorizeResponse.headers.get("location") ?? "";
	expect(location.startsWith("/consent?"), location).toBe(true);
	return { oauthQuery: location.split("?")[1] ?? "", verifier };
}

async function mintTokens(
	clientId: string,
	clientSecret: string,
	cookie: string,
): Promise<{ refreshToken: string }> {
	const { oauthQuery, verifier } = await authorize(
		clientId,
		cookie,
		"mail:read mail:draft offline_access",
	);
	const consent = await postJson(
		"/api/auth/oauth2/consent",
		{ accept: true, oauth_query: oauthQuery },
		cookie,
		{ origin: ORIGIN },
	);
	expect(consent.status, await consent.clone().text()).toBe(200);
	const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
	const code = new URL(consentBody.redirect_uri ?? consentBody.url ?? "").searchParams.get("code");
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
				resource: RESOURCE,
			}),
		}),
	);
	expect(tokenResponse.status, await tokenResponse.clone().text()).toBe(200);
	const tokens = (await tokenResponse.json()) as { refresh_token?: string };
	expect(typeof tokens.refresh_token).toBe("string");
	return { refreshToken: tokens.refresh_token! };
}

function refreshRequest(clientId: string, clientSecret: string, refreshToken: string): Request {
	return new Request(`${ORIGIN}/api/auth/oauth2/token`, {
		method: "POST",
		headers: {
			authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
			"content-type": "application/x-www-form-urlencoded",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			resource: RESOURCE,
		}),
	});
}

async function revoke(cookie: string, clientId: string, origin?: string): Promise<Response> {
	return run(
		new Request(`${ORIGIN}/api/oauth-clients/${clientId}/revoke`, {
			method: "POST",
			headers: {
				cookie,
				...(origin ? { origin } : {}),
			},
		}),
	);
}

async function sessionCookieFor(email: string): Promise<string> {
	const { createAuth } = await import("#/api/better-auth");
	const auth = await createAuth(authEnv(), { request: new Request(`${ORIGIN}/`) });
	const ctx = await auth.$context;
	const existing = await testEnv.INDEX_DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
		.bind(email)
		.first<{ id: string }>();
	const userId = existing
		? existing.id
		: (
				await ctx.internalAdapter.createUser(
					{ email, name: email.split("@")[0] ?? email, emailVerified: true },
					{ method: "admin" },
				)
			).id;
	const session = await ctx.internalAdapter.createSession(userId, false);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(ctx.secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session.token));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${base64}`)}`;
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
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare("DELETE FROM owner_identities").run();
	await testEnv.INDEX_DB.prepare('DELETE FROM "rateLimit"').run();
	for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient"]) {
		await testEnv.INDEX_DB.prepare(`DELETE FROM "${table}"`).run();
	}
	await testEnv.INDEX_DB.prepare("DELETE FROM ops_events").run();
});

describe("POST /api/oauth-clients/:clientId/revoke", () => {
	it("revokes an authorized client, drops its rows, and rejects the refresh grant", async () => {
		const cookie = await ownerSession("REVOKEAUTH01");
		const { clientId, clientSecret } = await registerClient(cookie, "authorized-client");
		await allowOfflineAccess(clientId);
		const { refreshToken } = await mintTokens(clientId, clientSecret, cookie);
		const refreshed = await run(refreshRequest(clientId, clientSecret, refreshToken));
		expect(refreshed.status, await refreshed.clone().text()).toBe(200);

		const refreshRow = await testEnv.INDEX_DB.prepare(
			`SELECT id FROM "oauthRefreshToken" WHERE "clientId" = ? LIMIT 1`,
		)
			.bind(clientId)
			.first<{ id: string }>();
		expect(refreshRow?.id).toBeTruthy();
		const ownerId = await userIdByEmail(OWNER);
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthAccessToken" (id, token, "clientId", "userId", "refreshId", scopes, "createdAt", "expiresAt")
       VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
		)
			.bind(
				"access-row",
				"access-token-value",
				clientId,
				ownerId,
				refreshRow!.id,
				Date.now(),
				Date.now() + 3_600_000,
			)
			.run();
		expect(await countForClient("oauthConsent", clientId)).toBeGreaterThan(0);
		expect(await countForClient("oauthRefreshToken", clientId)).toBeGreaterThan(0);
		expect(await countForClient("oauthAccessToken", clientId)).toBeGreaterThan(0);

		const before = Date.now();
		const response = await revoke(cookie, clientId);
		const after = Date.now();
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as {
			revoked: boolean;
			client_id: string;
			name: string | null;
			deleted: { access_tokens: number; refresh_tokens: number; consents: number };
			access_tokens_valid_until: string;
			notice: string;
		};
		expect(body.revoked).toBe(true);
		expect(body.client_id).toBe(clientId);
		expect(body.name).toBe("authorized-client");
		expect(body.deleted.access_tokens).toBeGreaterThan(0);
		expect(body.deleted.refresh_tokens).toBeGreaterThan(0);
		expect(body.deleted.consents).toBeGreaterThan(0);
		expect(body.notice).toContain("3600");
		const validUntil = Date.parse(body.access_tokens_valid_until);
		expect(validUntil).toBeGreaterThanOrEqual(before + 3_600_000 - 2_000);
		expect(validUntil).toBeLessThanOrEqual(after + 3_600_000 + 2_000);

		expect(await countForClient("oauthClient", clientId)).toBe(0);
		expect(await countForClient("oauthConsent", clientId)).toBe(0);
		expect(await countForClient("oauthRefreshToken", clientId)).toBe(0);
		expect(await countForClient("oauthAccessToken", clientId)).toBe(0);

		const listed = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/get-clients`, { headers: { cookie } }),
		);
		expect(listed.status).toBe(200);
		const clients = (await listed.json()) as Array<{ client_id: string }>;
		expect(clients.some((client) => client.client_id === clientId)).toBe(false);

		const again = await run(refreshRequest(clientId, clientSecret, refreshToken));
		expect(again.status).toBeGreaterThanOrEqual(400);
		expect(again.status).toBeLessThan(500);
		const grant = (await again.json()) as { error?: string };
		expect(["invalid_client", "invalid_grant"]).toContain(grant.error);

		const event = await testEnv.INDEX_DB.prepare(
			`SELECT event_type, subject, payload_json FROM ops_events WHERE event_type = 'mcp.client_revoked' AND subject = ?`,
		)
			.bind(clientId)
			.first<{ event_type: string; subject: string; payload_json: string }>();
		expect(event?.event_type).toBe("mcp.client_revoked");
		const payload = JSON.parse(event?.payload_json ?? "{}") as {
			client_id: string;
			name: string;
			deleted: { access_tokens: number; refresh_tokens: number; consents: number };
		};
		expect(payload.client_id).toBe(clientId);
		expect(payload.name).toBe("authorized-client");
		expect(payload.deleted).toEqual(body.deleted);

		const repeat = await revoke(cookie, clientId);
		expect(repeat.status).toBe(404);
		expect(await repeat.json()).toEqual({ error: "client_not_found" });
		const events = await testEnv.INDEX_DB.prepare(
			`SELECT COUNT(*) AS n FROM ops_events WHERE event_type = 'mcp.client_revoked' AND subject = ?`,
		)
			.bind(clientId)
			.first<{ n: number }>();
		expect(Number(events?.n ?? 0)).toBe(1);
	});

	it("revokes an unused client the owner registered and leaves another client listed", async () => {
		const cookie = await ownerSession("REVOKEUNUSED01");
		const keep = await registerClient(cookie, "keep-me");
		const unused = await registerClient(cookie, "unused-client");
		const response = await revoke(cookie, unused.clientId);
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as {
			deleted: { access_tokens: number; refresh_tokens: number; consents: number };
			name: string | null;
		};
		expect(body.name).toBe("unused-client");
		expect(body.deleted).toEqual({ access_tokens: 0, refresh_tokens: 0, consents: 0 });
		expect(await countForClient("oauthClient", unused.clientId)).toBe(0);
		expect(await countForClient("oauthClient", keep.clientId)).toBe(1);
		const listed = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/get-clients`, { headers: { cookie } }),
		);
		const clients = (await listed.json()) as Array<{ client_id: string }>;
		expect(clients.map((client) => client.client_id)).toEqual([keep.clientId]);
	});

	it("revokes a client this owner consented to but did not register", async () => {
		const cookie = await ownerSession("REVOKECONSENT01");
		await sessionCookieFor(STRANGER);
		const ownerId = await userIdByEmail(OWNER);
		const strangerId = await userIdByEmail(STRANGER);
		const clientId = "consentonlyclient";
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthClient" (id, "clientId", "userId", name, "redirectUris") VALUES ('c-consent', ?, ?, 'Consented elsewhere', '[]')`,
		)
			.bind(clientId, strangerId)
			.run();
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthConsent" (id, "clientId", "userId", scopes) VALUES ('consent-1', ?, ?, '[]')`,
		)
			.bind(clientId, ownerId)
			.run();
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthRefreshToken" (id, token, "clientId", "userId", scopes) VALUES ('refresh-1', 'refresh-token-value', ?, ?, '[]')`,
		)
			.bind(clientId, ownerId)
			.run();
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthAccessToken" (id, token, "clientId", "userId", "refreshId", scopes) VALUES ('access-1', 'access-token-value', ?, ?, 'refresh-1', '[]')`,
		)
			.bind(clientId, ownerId)
			.run();

		const response = await revoke(cookie, clientId);
		expect(response.status, await response.clone().text()).toBe(200);
		const body = (await response.json()) as {
			deleted: { access_tokens: number; refresh_tokens: number; consents: number };
		};
		expect(body.deleted).toEqual({ access_tokens: 1, refresh_tokens: 1, consents: 1 });
		expect(await countForClient("oauthClient", clientId)).toBe(0);
		expect(await countForClient("oauthAccessToken", clientId)).toBe(0);
		expect(await countForClient("oauthRefreshToken", clientId)).toBe(0);
		expect(await countForClient("oauthConsent", clientId)).toBe(0);
	});

	it("returns 404 for an unknown id and for a client this owner neither registered nor consented to", async () => {
		const cookie = await ownerSession("REVOKEUNKNOWN01");
		await sessionCookieFor(STRANGER);
		const strangerId = await userIdByEmail(STRANGER);
		const clientId = "someoneelseclient";
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthClient" (id, "clientId", "userId", name, "redirectUris") VALUES ('c-other', ?, ?, 'Not mine', '[]')`,
		)
			.bind(clientId, strangerId)
			.run();

		const unknown = await revoke(cookie, "missingclientid");
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ error: "client_not_found" });

		const foreign = await revoke(cookie, clientId);
		expect(foreign.status).toBe(404);
		expect(await foreign.json()).toEqual({ error: "client_not_found" });
		expect(await countForClient("oauthClient", clientId)).toBe(1);

		const events = await testEnv.INDEX_DB.prepare(
			`SELECT COUNT(*) AS n FROM ops_events WHERE event_type = 'mcp.client_revoked'`,
		).first<{ n: number }>();
		expect(Number(events?.n ?? 0)).toBe(0);
	});

	it("returns 403 for a non-owner session and for a mismatched Origin", async () => {
		const cookie = await ownerSession("REVOKEDENY01");
		const { clientId } = await registerClient(cookie, "kept-client");
		const strangerCookie = await sessionCookieFor(STRANGER);

		const forbidden = await revoke(strangerCookie, clientId);
		expect(forbidden.status).toBe(403);
		expect(await forbidden.json()).toEqual({ error: "forbidden" });

		const csrf = await revoke(cookie, clientId, "https://evil.example");
		expect(csrf.status).toBe(403);
		expect(await csrf.json()).toEqual({ error: "origin_mismatch" });

		const invalid = await revoke(cookie, "bad!id");
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toEqual({ error: "invalid_client_id" });

		expect(await countForClient("oauthClient", clientId)).toBe(1);
	});
});
