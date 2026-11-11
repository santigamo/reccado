import { describe, expect, it } from "vitest";
import { assertScope, McpScopeError, type McpAuthContext } from "../../src/mcp/scopes";

describe("MCP tool scope enforcement", () => {
	const auth = (scopes: string[]): McpAuthContext => ({
		userId: "owner",
		email: "owner@example.com",
		scopes: new Set(scopes),
	});
	it("accepts an explicitly granted scope", () => {
		expect(() => assertScope(auth(["mail:read"]), "mail:read")).not.toThrow();
	});
	it("denies missing scopes, including an empty claim", () => {
		expect(() => assertScope(auth([]), "mail:read")).toThrowError(McpScopeError);
		expect(() => assertScope(auth(["mail:read"]), "mail:draft")).toThrow(
			"insufficient_scope: mail:draft",
		);
	});
});
