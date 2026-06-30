import { describe, expect, it } from "vitest";
import { assertMailboxAccess, getAuthContext, requireAuth } from "#/api/auth";

const noAccessConfig = {} as Env;

describe("getAuthContext dev-localhost bypass", () => {
	it("authenticates as the dev user on localhost when ACCESS_JWT_AUDIENCE is unset", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await getAuthContext(request, noAccessConfig);
		expect(auth).toEqual({ userId: "dev-local", email: "dev@local" });
	});

	it("authenticates as the dev user on 127.0.0.1 when ACCESS_JWT_AUDIENCE is unset", async () => {
		const request = new Request("http://127.0.0.1/api/me");
		const auth = await getAuthContext(request, noAccessConfig);
		expect(auth).toEqual({ userId: "dev-local", email: "dev@local" });
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
		expect(auth).toEqual({ userId: "dev-local", email: "dev@local" });
	});

	it("does not bypass auth once ACCESS_JWT_AUDIENCE is configured, even on localhost", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await getAuthContext(request, {
			ACCESS_JWT_AUDIENCE: "aud-1",
			ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
		} as Env);
		expect(auth).toBeNull();
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
		expect(auth).toEqual({ userId: "dev-local", email: "dev@local" });
	});

	it("resolves for any authenticated identity when ACCESS_ALLOWED_EMAILS is unset (open single-operator mode)", async () => {
		const request = new Request("http://localhost/api/me");
		const auth = await requireAuth(request, noAccessConfig);
		expect(auth).toEqual({ userId: "dev-local", email: "dev@local" });
	});
});

describe("assertMailboxAccess", () => {
	it("never throws when ACCESS_ALLOWED_EMAILS is unset, regardless of the caller's identity", () => {
		expect(() =>
			assertMailboxAccess({ userId: "u1", email: "anyone@example.com" }, "mbx_1", noAccessConfig),
		).not.toThrow();
	});

	it("throws a 403 Response when ACCESS_ALLOWED_EMAILS is set and the caller is not in it", () => {
		expect(() =>
			assertMailboxAccess(
				{ userId: "u1", email: "intruder@example.com" },
				"mbx_1",
				{ ACCESS_ALLOWED_EMAILS: "owner@example.com" } as Env,
			),
		).toThrow(Response);
	});

	it("does not throw when ACCESS_ALLOWED_EMAILS is set and the caller is in it (case-insensitively)", () => {
		expect(() =>
			assertMailboxAccess(
				{ userId: "u1", email: "Owner@Example.com" },
				"mbx_1",
				{ ACCESS_ALLOWED_EMAILS: "owner@example.com" } as Env,
			),
		).not.toThrow();
	});
});
