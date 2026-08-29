import { describe, expect, it } from "vitest";
import { assertMailboxAccess, getAuthContext, requireAuth } from "#/api/auth";

const noAccessConfig = {} as Env;

describe("getAuthContext dev-localhost bypass", () => {
	it("authenticates as the dev user on localhost when ACCESS_JWT_AUDIENCE is unset", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await getAuthContext(request, noAccessConfig);
		// `local` is what the owner checks key their one exemption off, and it is set
		// here rather than claimed by a caller precisely because this branch is the
		// only place that can prove the request came from localhost.
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local", local: true });
	});

	it("authenticates as the dev user on 127.0.0.1 when ACCESS_JWT_AUDIENCE is unset", async () => {
		const request = new Request("http://127.0.0.1/api/me");
		const auth = await getAuthContext(request, noAccessConfig);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local", local: true });
	});

	it("does not authenticate non-localhost hosts when ACCESS_JWT_AUDIENCE is unset", async () => {
		const request = new Request("https://example.com/api/me");
		const auth = await getAuthContext(request, noAccessConfig);
		expect(auth).toBeNull();
	});

	// WHATWG URL.hostname returns IPv6 literals in bracketed form ("[::1]"); the bypass
	// accepts both "::1" and "[::1]", so IPv6 loopback is treated as a local request.
	it("bypasses auth for IPv6 loopback (bracketed [::1] hostname)", async () => {
		const hostname = new URL("http://[::1]/api/me").hostname;
		expect(hostname).toBe("[::1]");

		const request = new Request("http://[::1]/api/me");
		const auth = await getAuthContext(request, noAccessConfig);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local" });
	});

	it("does not bypass auth once ACCESS_JWT_AUDIENCE is configured, even on localhost", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await getAuthContext(request, {
			ACCESS_JWT_AUDIENCE: "aud-1",
			ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
		} as Env);
		expect(auth).toBeNull();
	});

	it("throws for non-local requests when Access config is partially set", async () => {
		const request = new Request("https://example.com/api/me");
		await expect(
			getAuthContext(request, {
				ACCESS_JWT_AUDIENCE: "aud-1",
			} as Env),
		).rejects.toThrow("Cloudflare Access validation is misconfigured; missing ACCESS_TEAM_DOMAIN.");
	});
});

describe("getAuthContext with ACCESS_JWT_AUDIENCE configured", () => {
	const accessEnv = {
		ACCESS_JWT_AUDIENCE: "aud-1",
		ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
	} as Env;

	it("returns null when no CF-Access-JWT-Assertion header is present", async () => {
		const request = new Request("https://example.com/api/me");
		const auth = await getAuthContext(request, accessEnv);
		expect(auth).toBeNull();
	});

	it("returns null for a garbage (non-JWT) assertion token without making a network call", async () => {
		const request = new Request("https://example.com/api/me", {
			headers: { "CF-Access-JWT-Assertion": "not-a-real-jwt" },
		});
		const auth = await getAuthContext(request, accessEnv);
		expect(auth).toBeNull();
	});

	// Full signature verification needs a live Access JWKS endpoint, which isn't
	// mockable in this harness (no fetch interception available). The
	// malformed-token case above still exercises verifyAccessJwt's try/catch
	// (parseJwt throws synchronously before any network call), confirming
	// getAuthContext fails closed on bad input.
});

describe("requireAuth", () => {
	it("throws a 401 Response when there is no authenticated identity", async () => {
		const request = new Request("https://example.com/api/me");
		let caught: unknown;
		try {
			await requireAuth(request, noAccessConfig);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		const response = caught as Response;
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
	});

	it("throws a 403 Response when ACCESS_ALLOWED_EMAILS is set and the identity is not listed", async () => {
		const request = new Request("http://localhost/api/me");
		let caught: unknown;
		try {
			await requireAuth(request, { ACCESS_ALLOWED_EMAILS: "owner@example.com" } as Env);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		const response = caught as Response;
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "forbidden" });
	});

	it("resolves when ACCESS_ALLOWED_EMAILS is set and the identity is listed", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await requireAuth(request, {
			ACCESS_ALLOWED_EMAILS: "dev@local, other@example.com",
		} as Env);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local" });
	});

	// This used to be "open single-operator mode": no allowlist meant every
	// authenticated identity was the owner. That is gone -- an unowned deployment
	// now denies -- and what survives is narrower on purpose: the dev-bypass
	// identity, which getAuthContext refuses to mint for anything but a loopback
	// request, so `pnpm dev` keeps working without opening a deployed install.
	it("resolves on localhost when nothing is registered, because that identity is the machine's own", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await requireAuth(request, noAccessConfig);
		expect(auth).toMatchObject({ userId: "dev-local", email: "dev@local" });
	});

	// The dev-bypass exemption is the one hole in the owner check, so it is worth
	// stating that it cannot be reached from off the machine: off localhost the
	// bypass mints no identity at all, and the request dies at 401 before ownership
	// is ever consulted. (A non-local identity that DOES exist needs a signed Access
	// JWT, which this harness cannot mint -- the owner-empty deny for that path is
	// covered by assertMailboxAccess and requireMcpAuth below.)
	it("never lets the dev-bypass exemption escape localhost", async () => {
		let caught: unknown;
		try {
			await requireAuth(new Request("https://example.com/api/me"), noAccessConfig);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		expect((caught as Response).status).toBe(401);
	});

	it("throws a 503 Response when Access config is partially set", async () => {
		const request = new Request("https://example.com/api/me");
		let caught: unknown;
		try {
			await requireAuth(request, { ACCESS_JWT_AUDIENCE: "aud-1" } as Env);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Response);
		const response = caught as Response;
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "auth_unavailable",
			reason: "Cloudflare Access validation is misconfigured; missing ACCESS_TEAM_DOMAIN.",
		});
	});
});

describe("assertMailboxAccess", () => {
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

	it("throws a 403 Response when ACCESS_ALLOWED_EMAILS is set and the caller is not in it", () => {
		expect(() =>
			assertMailboxAccess({ userId: "u1", email: "intruder@example.com" }, "mbx_1", {
				ACCESS_ALLOWED_EMAILS: "owner@example.com",
			} as Env),
		).toThrow(Response);
	});

	it("does not throw when ACCESS_ALLOWED_EMAILS is set and the caller is in it (case-insensitively)", () => {
		expect(() =>
			assertMailboxAccess({ userId: "u1", email: "Owner@Example.com" }, "mbx_1", {
				ACCESS_ALLOWED_EMAILS: "owner@example.com",
			} as Env),
		).not.toThrow();
	});
});
