import { describe, expect, it } from "vitest";
import { insufficientScope, requireScope, scopesFromClaims } from "../../src/lib/mcp-scopes";

describe("MCP scopes", () => {
	it("uses only a string scope claim and exact membership", () => {
		const scopes = scopesFromClaims({ scope: "mail:read mail:draft" });
		expect(requireScope(scopes, "mail:read")).toBe(true);
		expect(requireScope(scopes, "mail:send")).toBe(false);
		expect(scopesFromClaims({ scope: ["admin"] }).size).toBe(0);
	});
	it("builds an insufficient scope challenge", () => {
		const response = insufficientScope(
			"admin",
			"https://example.com/.well-known/oauth-protected-resource/mcp",
		);
		expect(response.status).toBe(403);
		expect(response.headers.get("www-authenticate")).toBe(
			'Bearer error="insufficient_scope", scope="admin", resource_metadata="https://example.com/.well-known/oauth-protected-resource/mcp"',
		);
	});
});
