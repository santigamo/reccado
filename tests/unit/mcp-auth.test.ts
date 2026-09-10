import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	parseAllowedEmails,
	isMcpAllowed,
	requireMcpOwner,
	resolveOwnerEmails,
	type AuthContext,
} from "#/api/auth";
import { linkOwnerIdentity } from "#/db/owners";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

beforeAll(async () => {
	for (const statement of splitSqlStatements(migrationOwnerRegistry as string)) {
		await env.INDEX_DB.prepare(statement).run();
	}
});

function makeAuth(email: string): AuthContext {
	return { userId: `user-${email}`, email };
}

describe("MCP auth: parseAllowedEmails", () => {
	it("returns null when OWNER_BOOTSTRAP_EMAILS is unset", () => {
		const testEnv = { ...env, OWNER_BOOTSTRAP_EMAILS: "" } as Env;
		expect(parseAllowedEmails(testEnv)).toBeNull();
	});

	it("returns null when OWNER_BOOTSTRAP_EMAILS is whitespace-only", () => {
		const testEnv = { ...env, OWNER_BOOTSTRAP_EMAILS: "   " } as Env;
		expect(parseAllowedEmails(testEnv)).toBeNull();
	});

	it("returns trimmed lowercase emails", () => {
		const testEnv = {
			...env,
			OWNER_BOOTSTRAP_EMAILS: "Alice@Example.COM, bob@test.org",
		} as Env;
		const result = parseAllowedEmails(testEnv);
		expect(result).toEqual(["alice@example.com", "bob@test.org"]);
	});
});

describe("MCP auth: isMcpAllowed", () => {
	it("returns false when allowlist is unset (fail-closed)", () => {
		const testEnv = { ...env, OWNER_BOOTSTRAP_EMAILS: "" } as Env;
		expect(isMcpAllowed(makeAuth("alice@example.com"), testEnv)).toBe(false);
	});

	it("returns false when email is not in allowlist", () => {
		const testEnv = {
			...env,
			OWNER_BOOTSTRAP_EMAILS: "alice@example.com",
		} as Env;
		expect(isMcpAllowed(makeAuth("bob@example.com"), testEnv)).toBe(false);
	});

	it("returns true when email is in allowlist (case-insensitive)", () => {
		const testEnv = {
			...env,
			OWNER_BOOTSTRAP_EMAILS: "alice@example.com",
		} as Env;
		expect(isMcpAllowed(makeAuth("Alice@Example.com"), testEnv)).toBe(true);
	});
});

describe("MCP auth: requireMcpOwner", () => {
	it("throws 503 when allowlist is unset", () => {
		const testEnv = { ...env, OWNER_BOOTSTRAP_EMAILS: "" } as Env;
		expect(() => requireMcpOwner(makeAuth("alice@example.com"), testEnv)).toThrow(Response);
		try {
			requireMcpOwner(makeAuth("alice@example.com"), testEnv);
		} catch (error) {
			expect(error).toBeInstanceOf(Response);
			expect((error as Response).status).toBe(503);
		}
	});

	it("throws 403 when email is not in allowlist", () => {
		const testEnv = {
			...env,
			OWNER_BOOTSTRAP_EMAILS: "alice@example.com",
		} as Env;
		try {
			requireMcpOwner(makeAuth("bob@example.com"), testEnv);
		} catch (error) {
			expect(error).toBeInstanceOf(Response);
			expect((error as Response).status).toBe(403);
		}
	});

	it("returns auth context when email is in allowlist", () => {
		const testEnv = {
			...env,
			OWNER_BOOTSTRAP_EMAILS: "alice@example.com",
		} as Env;
		const auth = makeAuth("alice@example.com");
		expect(requireMcpOwner(auth, testEnv)).toBe(auth);
	});
});

describe("MCP auth: the owner registry", () => {
	beforeEach(async () => {
		await env.INDEX_DB.prepare("DELETE FROM owner_identities").run();
	});

	// The point of F13: one record of who owns this deployment, read by both the web
	// perimeter and the bot. A row here is worth exactly as much as the variable.
	it("authorises an identity that only D1 declares, with no variable set", async () => {
		await linkOwnerIdentity(env.INDEX_DB, {
			kind: "email",
			identity: "Registry@Example.com",
			linkedVia: "manual",
		});
		const testEnv = { ...env, OWNER_BOOTSTRAP_EMAILS: "" } as Env;
		const owners = await resolveOwnerEmails(testEnv);
		expect(owners).toContain("registry@example.com");

		const auth = { ...makeAuth("registry@example.com"), owners };
		expect(requireMcpOwner(auth, testEnv)).toBe(auth);
	});

	// The bootstrap has to keep working on its own, or a worker deployed before
	// migration 0012 ran would lock its operator out of the thing that fixes it.
	it("unions the bootstrap variable with the registry", async () => {
		await linkOwnerIdentity(env.INDEX_DB, {
			kind: "email",
			identity: "registry@example.com",
			linkedVia: "manual",
		});
		const owners = await resolveOwnerEmails({
			...env,
			OWNER_BOOTSTRAP_EMAILS: "bootstrap@example.com",
		} as Env);
		expect(owners.sort()).toEqual(["bootstrap@example.com", "registry@example.com"]);
	});

	it("fails closed when the registry is empty and no variable is set", async () => {
		const testEnv = { ...env, OWNER_BOOTSTRAP_EMAILS: "" } as Env;
		expect(await resolveOwnerEmails(testEnv)).toEqual([]);
		// Including for the localhost dev identity: /api/* exempts it while nothing is
		// registered, /mcp never does. An MCP client acts unattended, and "it is only
		// my laptop" is not a property of the request it makes.
		const auth: AuthContext = { userId: "dev-local", email: "dev@local", owners: [], local: true };
		expect(isMcpAllowed(auth, testEnv)).toBe(false);
		try {
			requireMcpOwner(auth, testEnv);
			expect.unreachable("requireMcpOwner must deny an unowned deployment");
		} catch (error) {
			expect((error as Response).status).toBe(503);
		}
	});
});
