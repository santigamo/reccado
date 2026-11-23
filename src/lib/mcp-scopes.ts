/**
 * Fine-grained MCP scopes (`resource:action`). There is deliberately no omnibus
 * `admin` scope: every write family has its own scope, and `tools/list` shows
 * only the tools whose scope the token carries.
 */
export const MCP_SCOPES = [
	"mail:read",
	"mail:read:sensitive",
	"mail:draft",
	"mail:send",
	"config:read",
	"mailboxes:write",
	"templates:write",
	"routing:write",
	"domains:write",
	"keys:write",
	"suppressions:write",
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * The OAuth scope that makes the authorization server issue a refresh token
 * (OIDC Core §11; Better Auth's provider mints one only when the grant carries
 * it). It grants no tool: it only lets a connected client renew its 1-hour
 * access token without sending the owner through the browser login again.
 * Every MCP authorization request gets it (better-auth.ts), and revoking the
 * client under "Connected agents" deletes its refresh tokens.
 */
export const OFFLINE_ACCESS_SCOPE = "offline_access";

/** What a client gets when it asks for nothing in particular (and the consent page's pre-ticked set). */
export const DEFAULT_MCP_SCOPES = ["mail:read", "mail:draft", "config:read"] as const;

/** Scopes that are only ever granted with an explicit, server-enforced tick on the consent page. */
export const HIGH_RISK_MCP_SCOPES: ReadonlySet<string> = new Set([
	"mail:send",
	"mail:read:sensitive",
	"keys:write",
	"routing:write",
	"domains:write",
]);

/** Scope each MCP tool requires. `restore` accepts any write scope here; the snapshot's own resource scope is checked at execute. */
export const TOOL_SCOPES: Readonly<Record<string, McpScope>> = {
	list_mailboxes: "mail:read",
	list_threads: "mail:read",
	read_thread: "mail:read",
	read_message: "mail:read",
	search_messages: "mail:read",
	save_draft: "mail:draft",
	cancel_draft: "mail:draft",
	manage_draft_attachments: "mail:draft",
	update_messages: "mail:draft",
	send: "mail:send",
	get_health: "config:read",
	list_ops: "config:read",
	list_config: "config:read",
	manage_mailbox: "mailboxes:write",
	manage_domain: "domains:write",
	manage_routing: "routing:write",
	manage_template: "templates:write",
	manage_api_key: "keys:write",
	remove_suppression: "suppressions:write",
	reconcile_stale: "keys:write",
};

/** Scopes any of which makes `restore` visible. */
export const RESTORE_SCOPES: readonly McpScope[] = [
	"mailboxes:write",
	"templates:write",
	"routing:write",
	"domains:write",
	"keys:write",
	"suppressions:write",
];

/** True when the granted set permits the named tool. Unknown tools are never permitted. */
export function toolPermitted(granted: ReadonlySet<string>, tool: string): boolean {
	if (tool === "restore") return RESTORE_SCOPES.some((scope) => granted.has(scope));
	const needed = TOOL_SCOPES[tool];
	return needed !== undefined && granted.has(needed);
}

/** The scope to name in an insufficient_scope signal for a tool. */
export function neededScopeFor(tool: string): string | undefined {
	return tool === "restore" ? RESTORE_SCOPES[0] : TOOL_SCOPES[tool];
}

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
