import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	type AccessJwtPayload,
	parseAllowedEmails,
	isMcpAllowed,
	requireMcpAuth,
	type AuthContext,
} from "#/api/auth";

function makeAuth(email: string): AuthContext {
	return { userId: `user-${email}`, email };
}

describe("MCP auth: parseAllowedEmails", () => {
	it("returns null when ACCESS_ALLOWED_EMAILS is unset", () => {
		const testEnv = { ...env, ACCESS_ALLOWED_EMAILS: "" } as Env;
		expect(parseAllowedEmails(testEnv)).toBeNull();
	});

	it("returns null when ACCESS_ALLOWED_EMAILS is whitespace-only", () => {
		const testEnv = { ...env, ACCESS_ALLOWED_EMAILS: "   " } as Env;
		expect(parseAllowedEmails(testEnv)).toBeNull();
	});

	it("returns trimmed lowercase emails", () => {
		const testEnv = {
			...env,
			ACCESS_ALLOWED_EMAILS: "Alice@Example.COM, bob@test.org",
		} as Env;
		const result = parseAllowedEmails(testEnv);
		expect(result).toEqual(["alice@example.com", "bob@test.org"]);
	});
});

describe("MCP auth: isMcpAllowed", () => {
	it("returns false when allowlist is unset (fail-closed)", () => {
		const testEnv = { ...env, ACCESS_ALLOWED_EMAILS: "" } as Env;
		expect(isMcpAllowed(makeAuth("alice@example.com"), testEnv)).toBe(false);
	});

	it("returns false when email is not in allowlist", () => {
		const testEnv = {
			...env,
			ACCESS_ALLOWED_EMAILS: "alice@example.com",
		} as Env;
		expect(isMcpAllowed(makeAuth("bob@example.com"), testEnv)).toBe(false);
	});

	it("returns true when email is in allowlist (case-insensitive)", () => {
		const testEnv = {
			...env,
			ACCESS_ALLOWED_EMAILS: "alice@example.com",
		} as Env;
		expect(isMcpAllowed(makeAuth("Alice@Example.com"), testEnv)).toBe(true);
	});
});

describe("MCP auth: requireMcpAuth", () => {
	it("throws 503 when allowlist is unset", () => {
		const testEnv = { ...env, ACCESS_ALLOWED_EMAILS: "" } as Env;
		expect(() => requireMcpAuth(makeAuth("alice@example.com"), testEnv)).toThrow(Response);
		try {
			requireMcpAuth(makeAuth("alice@example.com"), testEnv);
		} catch (error) {
			expect(error).toBeInstanceOf(Response);
			expect((error as Response).status).toBe(503);
		}
	});

	it("throws 403 when email is not in allowlist", () => {
		const testEnv = {
			...env,
			ACCESS_ALLOWED_EMAILS: "alice@example.com",
		} as Env;
		try {
			requireMcpAuth(makeAuth("bob@example.com"), testEnv);
		} catch (error) {
			expect(error).toBeInstanceOf(Response);
			expect((error as Response).status).toBe(403);
		}
	});

	it("returns auth context when email is in allowlist", () => {
		const testEnv = {
			...env,
			ACCESS_ALLOWED_EMAILS: "alice@example.com",
		} as Env;
		const auth = makeAuth("alice@example.com");
		expect(requireMcpAuth(auth, testEnv)).toBe(auth);
	});
});

describe("AccessJwtPayload type", () => {
	it("includes iss field", () => {
		const payload: AccessJwtPayload = {
			sub: "user-123",
			email: "test@example.com",
			aud: ["test-aud"],
			exp: Math.floor(Date.now() / 1000) + 3600,
			iss: "https://team.cloudflareaccess.com",
		};
		expect(payload.iss).toBe("https://team.cloudflareaccess.com");
	});
});
