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

/** GET /api/oauth-clients: the owner's connected apps with consent scopes, for /security. */

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const OWNER = "owner@example.com";
const STRANGER = "stranger@example.com";
const ORIGIN = "https://inbox.imsanti.dev";

const authEnv = () => ({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, OWNER_BOOTSTRAP_EMAILS: OWNER }) as Env;

async function run(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function sessionCookieFor(email: string): Promise<{ cookie: string; userId: string }> {
	const { createAuth } = await import("#/api/better-auth");
	const auth = await createAuth(authEnv(), { request: new Request(`${ORIGIN}/`) });
	const ctx = await auth.$context;
	const existing = await testEnv.INDEX_DB.prepare(`SELECT id FROM "user" WHERE email = ?`).bind(email).first<{ id: string }>();
	const userId = existing
		? existing.id
		: (await ctx.internalAdapter.createUser({ email, name: email.split("@")[0] ?? email, emailVerified: true }, { method: "admin" })).id;
	const session = await ctx.internalAdapter.createSession(userId, false);
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(ctx.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session.token));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return { cookie: `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${base64}`)}`, userId };
}

async function insertClient(clientId: string, name: string, userId: string | null, redirect: string, createdAt: number): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO "oauthClient" (id, "clientId", name, "userId", "redirectUris", "createdAt") VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(`id-${clientId}`, clientId, name, userId, JSON.stringify([redirect]), createdAt)
		.run();
}

async function insertConsent(clientId: string, userId: string, scopes: string[]): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO "oauthConsent" (id, "clientId", "userId", scopes, "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
	)
		.bind(`consent-${clientId}`, clientId, userId, JSON.stringify(scopes), Date.now(), Date.now())
		.run();
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
	// Only the table the revoke cleanup touches; migration 0029 also alters `approvals`.
	await testEnv.INDEX_DB.prepare(
		`CREATE TABLE IF NOT EXISTS mcp_client_policies (client_id TEXT PRIMARY KEY, owner_email TEXT NOT NULL, mailbox_ids_json TEXT NOT NULL DEFAULT '[]', auto_kinds_json TEXT NOT NULL DEFAULT '[]', link_domains_json TEXT NOT NULL DEFAULT '[]', allow_variable_links INTEGER NOT NULL DEFAULT 0, max_auto_per_hour INTEGER NOT NULL DEFAULT 20, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
	).run();
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare("DELETE FROM owner_identities").run();
	await testEnv.INDEX_DB.prepare('DELETE FROM "rateLimit"').run();
	for (const table of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent", "oauthClient", "mcp_client_policies"]) {
		await testEnv.INDEX_DB.prepare(`DELETE FROM "${table}"`).run();
	}
});

type ListBody = { clients: Array<{ client_id: string; name: string | null; redirect_hosts: string[]; granted_scopes: string[]; authorized: boolean; last_token_at: string | null; created_at: string | null }> };

describe("GET /api/oauth-clients", () => {
	it("lists consented and never-consented clients with scopes, hosts and last token", async () => {
		const { cookie, userId } = await sessionCookieFor(OWNER);
		const other = await sessionCookieFor(STRANGER);
		await insertClient("c-consented", "Claude", userId, "https://claude.example/cb", 1_700_000_000_000);
		await insertConsent("c-consented", userId, ["admin", "mail:draft"]);
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO "oauthAccessToken" (id, token, "clientId", "userId", scopes, "createdAt") VALUES ('t1', 'tok1', 'c-consented', ?, '[]', ?), ('t2', 'tok2', 'c-consented', ?, '[]', ?)`,
		).bind(userId, 1_700_000_100_000, userId, 1_700_000_200_000).run();
		await insertClient("c-pending", "Pending app", userId, "https://pending.example/cb", 1_700_000_300_000);
		await insertClient("c-foreign", "Foreign", other.userId, "https://foreign.example/cb", 1_700_000_400_000);
		await insertConsent("c-foreign", other.userId, ["mail:read"]);

		const response = await run(new Request(`${ORIGIN}/api/oauth-clients`, { headers: { cookie } }));
		expect(response.status, await response.clone().text()).toBe(200);
		const { clients } = (await response.json()) as ListBody;
		expect(clients.map((c) => c.client_id)).toEqual(["c-pending", "c-consented"]);
		const consented = clients.find((c) => c.client_id === "c-consented")!;
		expect(consented).toMatchObject({ name: "Claude", redirect_hosts: ["claude.example"], granted_scopes: ["admin", "mail:draft"], authorized: true });
		expect(consented.last_token_at).toBe(new Date(1_700_000_200_000).toISOString());
		expect(clients.find((c) => c.client_id === "c-pending")).toMatchObject({ authorized: false, granted_scopes: [], last_token_at: null });
	});

	it("is owner-only", async () => {
		const unauth = await run(new Request(`${ORIGIN}/api/oauth-clients`));
		expect([401, 403]).toContain(unauth.status);
		await sessionCookieFor(OWNER);
		const { cookie } = await sessionCookieFor(STRANGER);
		const stranger = await run(new Request(`${ORIGIN}/api/oauth-clients`, { headers: { cookie } }));
		expect(stranger.status).toBe(403);
	});

	it("revoke also removes the client's delegation policy", async () => {
		const { cookie, userId } = await sessionCookieFor(OWNER);
		await insertClient("c-pol", "Delegated", userId, "https://d.example/cb", Date.now());
		await insertConsent("c-pol", userId, ["admin"]);
		await testEnv.INDEX_DB.prepare(
			`INSERT INTO mcp_client_policies (client_id, owner_email, created_at, updated_at) VALUES ('c-pol', ?, 'x', 'x')`,
		).bind(OWNER).run();
		const response = await run(new Request(`${ORIGIN}/api/oauth-clients/c-pol/revoke`, { method: "POST", headers: { cookie } }));
		expect(response.status, await response.clone().text()).toBe(200);
		const left = await testEnv.INDEX_DB.prepare("SELECT COUNT(*) AS n FROM mcp_client_policies").first<{ n: number }>();
		expect(left?.n).toBe(0);
	});
});
