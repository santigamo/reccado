import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { assertMailboxAccess, getAuthContext, requireAuth } from "#/api/auth";
import { createAuth } from "#/api/better-auth";
import worker from "../../src/server";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const noSecretConfig = {} as Env;
/** 32+ chars is the issuer's own minimum; the value itself is a throwaway test secret. */
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	// 0009 runtime_config (origin recording), 0012 owner registry, 0016 better-auth
	// tables — the whole issuer surface under test here.
	await applyMigrations(
		testEnv.INDEX_DB,
		(await import("../../migrations/d1/0009_runtime_config.sql?raw")).default as string,
		migrationOwnerRegistry as string,
		migrationBetterAuth as string,
		migrationBetterAuthMcp as string,
	);
});

const authEnv = (overrides: Partial<Env> = {}) =>
	({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, ...overrides }) as unknown as Env;

/**
 * Signs a session-token cookie value exactly the way better-auth's cookie
 * layer does (HMAC-SHA256, base64, dot-joined, URL-encoded), so tests can
 * present a cookie the issuer accepts without standing up a login flow.
 */
async function signCookieValue(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return encodeURIComponent(`${value}.${base64}`);
}

/** Opens a real better-auth session in D1 and returns the Cookie header for it. */
async function openSession(
	db: D1Database,
	email: string,
	origin = "https://example.com",
): Promise<{ cookie: string; userId: string; token: string }> {
	// The request matters: the issuer anchors baseURL (and the cookie name) to the
	// origin, so the helper must present the same origin the test requests will use.
	const auth = await createAuth(
		{ INDEX_DB: db, BETTER_AUTH_SECRET: TEST_SECRET },
		{
			request: new Request(`${origin}/api/me`),
		},
	);
	const ctx = await auth.$context;
	const existing = await ctx.internalAdapter.findUserByEmail(email);
	const user =
		existing?.user ??
		(await ctx.internalAdapter.createUser(
			{ email, name: email.split("@")[0] ?? email, emailVerified: true },
			{ method: "admin" },
		));
	const session = await ctx.internalAdapter.createSession(user.id, false);
	// The cookie NAME comes from the issuer itself: with a https baseURL (the
	// request origin here) it carries the __Secure- prefix.
	return {
		cookie: `${ctx.authCookies.sessionToken.name}=${await signCookieValue(session.token, TEST_SECRET)}`,
		userId: user.id,
		token: session.token,
	};
}

describe("getAuthContext dev-localhost bypass", () => {
	it("authenticates as the dev user on localhost when BETTER_AUTH_SECRET is unset", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await getAuthContext(request, noSecretConfig);
		// `local` is what the owner checks key their one exemption off, and it is set
		// here rather than claimed by a caller precisely because this branch is the
		// only place that can prove the request came from localhost.
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local", local: true });
	});

	it("authenticates as the dev user on 127.0.0.1 when BETTER_AUTH_SECRET is unset", async () => {
		const request = new Request("http://127.0.0.1/api/me");
		const auth = await getAuthContext(request, noSecretConfig);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local", local: true });
	});

	it("does not authenticate non-localhost hosts when BETTER_AUTH_SECRET is unset", async () => {
		const request = new Request("https://example.com/api/me");
		const auth = await getAuthContext(request, noSecretConfig);
		expect(auth).toBeNull();
	});

	// WHATWG URL.hostname returns IPv6 literals in bracketed form ("[::1]"); the bypass
	// accepts both "::1" and "[::1]", so IPv6 loopback is treated as a local request.
	it("bypasses auth for IPv6 loopback (bracketed [::1] hostname)", async () => {
		const hostname = new URL("http://[::1]/api/me").hostname;
		expect(hostname).toBe("[::1]");

		const request = new Request("http://[::1]/api/me");
		const auth = await getAuthContext(request, noSecretConfig);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local" });
	});
});

describe("getAuthContext with BETTER_AUTH_SECRET misconfigured", () => {
	it("fails closed (503) when the secret is set but shorter than 32 characters", async () => {
		const request = new Request("https://example.com/api/me");
		let caught: unknown;
		try {
			await requireAuth(request, authEnv({ BETTER_AUTH_SECRET: "too-short" }));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		const response = caught as Response;
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({ error: "auth_unavailable" });
	});

	// Same posture as the old partial-Access configuration: an operator who tried
	// to configure the perimeter and got it wrong must hit a loud 503 everywhere,
	// not a quiet dev bypass.
	it("fails closed even on localhost when the secret is too short", async () => {
		const request = new Request("http://localhost/api/me");
		let caught: unknown;
		try {
			await getAuthContext(request, authEnv({ BETTER_AUTH_SECRET: "too-short" }));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("misconfigured");
	});
});

describe("getAuthContext with Better Auth sessions (0016 applied)", () => {
	it("verifies a real session cookie into an AuthContext", async () => {
		const { cookie, userId } = await openSession(testEnv.INDEX_DB, "owner@example.com");

		const request = new Request("https://example.com/api/me", { headers: { cookie } });
		const auth = await getAuthContext(request, authEnv());
		expect(auth).not.toBeNull();
		expect(auth?.userId).toBe(userId);
		expect(auth?.email).toBe("owner@example.com");
		// Owners come from the same registry+bootstrap resolution as before: the
		// issuer changed, the authorization did not.
		expect(auth?.owners).toEqual([]);
	});

	it("returns null (401 territory) when no session cookie is presented", async () => {
		const request = new Request("https://example.com/api/me");
		const auth = await getAuthContext(request, authEnv());
		expect(auth).toBeNull();
	});

	it("fails closed on a forged (wrongly signed) session cookie", async () => {
		const { token } = await openSession(testEnv.INDEX_DB, "owner@example.com");
		// Right token, wrong signature (signed with a different secret).
		const forged = `better-auth.session_token=${encodeURIComponent(
			`${token}.${btoa("forged-signature-bytes")}`,
		)}`;
		const request = new Request("https://example.com/api/me", {
			headers: { cookie: forged },
		});
		const auth = await getAuthContext(request, authEnv());
		expect(auth).toBeNull();
	});
});

describe("session cookie cache", () => {
	it("is enabled in the issuer config (the confirm-send path is the one that bypasses it)", async () => {
		const auth = await createAuth(
			{ INDEX_DB: testEnv.INDEX_DB, BETTER_AUTH_SECRET: TEST_SECRET },
			{ request: new Request("https://example.com/") },
		);
		const ctx = await auth.$context;
		expect(ctx.options.session?.cookieCache).toMatchObject({ enabled: true, maxAge: 300 });
	});

	it("bypasses the session cookie cache: a revoked session dies immediately on the fresh path", async () => {
		const { cookie } = await openSession(testEnv.INDEX_DB, "owner@example.com");
		const envWithOwner = authEnv({ OWNER_BOOTSTRAP_EMAILS: "owner@example.com" });

		const alive = new Request("https://example.com/api/me", { headers: { cookie } });
		await expect(
			requireAuth(alive, envWithOwner, { disableCookieCache: true }),
		).resolves.toMatchObject({
			email: "owner@example.com",
		});

		// Revoke at the database — the cookie itself is still perfectly signed.
		await testEnv.INDEX_DB.prepare(`DELETE FROM session`).run();

		const revoked = new Request("https://example.com/api/me", { headers: { cookie } });
		let caught: unknown;
		try {
			await requireAuth(revoked, envWithOwner, { disableCookieCache: true });
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		expect((caught as Response).status).toBe(401);
	});
});

describe("requireAuth", () => {
	it("throws a 401 Response when there is no authenticated identity", async () => {
		const request = new Request("https://example.com/api/me");
		let caught: unknown;
		try {
			await requireAuth(request, noSecretConfig);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		const response = caught as Response;
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("throws a 403 Response when OWNER_BOOTSTRAP_EMAILS is set and the identity is not listed", async () => {
		const { cookie } = await openSession(testEnv.INDEX_DB, "intruder@example.com");
		const request = new Request("https://example.com/api/me", { headers: { cookie } });
		let caught: unknown;
		try {
			await requireAuth(request, authEnv({ OWNER_BOOTSTRAP_EMAILS: "owner@example.com" }));
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		const response = caught as Response;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "forbidden" });
	});

	it("resolves when OWNER_BOOTSTRAP_EMAILS is set and the identity is listed", async () => {
		// Same origin for issuer and request: the cookie name is anchored to it.
		const { cookie } = await openSession(testEnv.INDEX_DB, "other@example.com", "http://localhost");
		const request = new Request("http://localhost/api/me", { headers: { cookie } });
		const auth = await requireAuth(
			request,
			authEnv({ OWNER_BOOTSTRAP_EMAILS: "dev@local, other@example.com" }),
		);
		expect(auth).toMatchObject({ email: "other@example.com" });
	});

	// This used to be "open single-operator mode": no allowlist meant every
	// authenticated identity was the owner. That is gone -- an unowned deployment
	// now denies -- and what survives is narrower on purpose: the dev-bypass
	// identity, which getAuthContext refuses to mint for anything but a loopback
	// request, so `pnpm dev` keeps working without opening a deployed install.
	it("resolves on localhost when nothing is registered, because that identity is the machine's own", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await requireAuth(request, noSecretConfig);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local" });
	});

	// The dev-bypass exemption is the one hole in the owner check, so it is worth
	// stating that it cannot be reached from off the machine: off localhost the
	// bypass mints no identity at all, and the request dies at 401 before ownership
	// is ever consulted. (A non-local identity that DOES exist needs to be an owner
	// in the registry or the bootstrap -- covered by the 403 test above.)
	it("never lets the dev-bypass exemption escape localhost", async () => {
		let caught: unknown;
		try {
			await requireAuth(new Request("https://example.com/api/me"), noSecretConfig);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		expect((caught as Response).status).toBe(401);
	});
});

describe("assertMailboxAccess", () => {
	const noAccessConfig = {} as Env;

	// Inverted deliberately. The old contract was "no allowlist means everyone",
	// which made an install that skipped one step indistinguishable from an install
	// that trusted everyone. There is no configuration of this system that means
	// "everyone" any more: no registered owner and no bootstrap variable denies.
	it("throws a 403 Response when no owner is registered and no bootstrap is set", () => {
		expect(() =>
			assertMailboxAccess({ userId: "u1", email: "anyone@example.com" }, "mbx_1", noAccessConfig),
		).toThrow(Response);
	});

	it("lets the localhost dev identity through while nothing is registered", () => {
		expect(() =>
			assertMailboxAccess(
				{ userId: "dev-local", email: "dev@local", owners: [], local: true },
				"mbx_1",
				noAccessConfig,
			),
		).not.toThrow();
	});

	// The exemption is for an unowned deployment only: once somebody is the owner,
	// being on localhost stops meaning anything.
	it("stops exempting the dev identity once an owner exists", () => {
		expect(() =>
			assertMailboxAccess(
				{ userId: "dev-local", email: "dev@local", owners: ["owner@example.com"], local: true },
				"mbx_1",
				noAccessConfig,
			),
		).toThrow(Response);
	});

	// The registry is the record; the variable is the bootstrap. Either alone is
	// enough, which is what keeps a worker deployed before migration 0012 working.
	it("accepts an identity that only the D1 registry declared", () => {
		expect(() =>
			assertMailboxAccess(
				{ userId: "u1", email: "Owner@Example.com", owners: ["owner@example.com"] },
				"mbx_1",
				noAccessConfig,
			),
		).not.toThrow();
	});

	it("throws a 403 Response when OWNER_BOOTSTRAP_EMAILS is set and the caller is not in it", () => {
		expect(() =>
			assertMailboxAccess({ userId: "u1", email: "intruder@example.com" }, "mbx_1", {
				OWNER_BOOTSTRAP_EMAILS: "owner@example.com",
			} as Env),
		).toThrow(Response);
	});

	it("does not throw when OWNER_BOOTSTRAP_EMAILS is set and the caller is in it (case-insensitively)", () => {
		expect(() =>
			assertMailboxAccess({ userId: "u1", email: "Owner@Example.com" }, "mbx_1", {
				OWNER_BOOTSTRAP_EMAILS: "owner@example.com",
			} as Env),
		).not.toThrow();
	});
});

// The recordDeploymentOrigin invariant, fixed at both halves (plan requirement):
// the origin is learned ONLY from a request an owner authenticated. The Hono
// middleware owns that gate, so the proof runs through the whole app.
describe("deployment-origin recording", () => {
	it("records the origin from an authenticated owner request", async () => {
		const { cookie } = await openSession(testEnv.INDEX_DB, "owner@example.com");
		const envWithOwner = authEnv({ OWNER_BOOTSTRAP_EMAILS: "owner@example.com" });

		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("https://example.com/api/me", { headers: { cookie } }),
			envWithOwner,
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const row = await testEnv.INDEX_DB.prepare(
			`SELECT value FROM runtime_config WHERE key = 'deployment.origin'`,
		).first<{ value: string }>();
		expect(row?.value).toBe("https://example.com");
	});

	it("does NOT record the origin from an unauthenticated request", async () => {
		// The positive test above already wrote an origin into the shared D1; clear it
		// so "absent afterwards" actually means "this request did not write it".
		await testEnv.INDEX_DB.prepare(
			`DELETE FROM runtime_config WHERE key = 'deployment.origin'`,
		).run();
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("https://example.com/api/mailboxes"),
			authEnv(),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);

		const row = await testEnv.INDEX_DB.prepare(
			`SELECT value FROM runtime_config WHERE key = 'deployment.origin'`,
		).first<{ value: string }>();
		expect(row?.value).not.toBe("https://example.com");
	});

	it("does NOT record the origin from /api/auth/* (nobody there is authenticated yet)", async () => {
		await testEnv.INDEX_DB.prepare(
			`DELETE FROM runtime_config WHERE key = 'deployment.origin'`,
		).run();
		const ctx = createExecutionContext();
		const response = await worker.fetch(
			new Request("https://example.com/api/auth/ok"),
			authEnv(),
			ctx,
		);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);

		const row = await testEnv.INDEX_DB.prepare(
			`SELECT value FROM runtime_config WHERE key = 'deployment.origin'`,
		).first<{ value: string }>();
		expect(row?.value).not.toBe("https://example.com");
	});
});
