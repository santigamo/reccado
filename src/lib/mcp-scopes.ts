export const MCP_SCOPES = [
	"mail:read",
	"mail:draft",
	"mail:send",
	"mail:read:sensitive",
	"admin",
] as const;
export const DEFAULT_MCP_SCOPES = ["mail:read", "mail:draft"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export function scopesFromClaims(claims: { scope?: unknown }): Set<string> {
	return new Set(typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : []);
}

export function requireScope(granted: ReadonlySet<string>, needed: string): boolean {
	return granted.has(needed);
}

export function insufficientScope(needed: string, resourceMetadata: string): Response {
	const quote = (value: string) => value.replace(/[\\"\r\n]/g, "");
	return Response.json(
		{ error: "insufficient_scope" },
		{
			status: 403,
			headers: {
				"WWW-Authenticate": `Bearer error="insufficient_scope", scope="${quote(needed)}", resource_metadata="${quote(resourceMetadata)}"`,
			},
		},
	);
}
