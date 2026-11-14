import type { AuthContext } from "../api/auth";
import type { McpServer } from "@modelcontextprotocol/server";
import { requireScope, toolPermitted } from "../lib/mcp-scopes";

export type McpAuthContext = AuthContext & { scopes: ReadonlySet<string> };

export class McpScopeError extends Error {
	constructor(readonly scope: string) {
		super(`insufficient_scope: ${scope}`);
	}
}

export function assertScope(auth: McpAuthContext, scope: string): void {
	if (!requireScope(auth.scopes, scope)) throw new McpScopeError(scope);
}

/**
 * A view of the server that registers only the tools the token's scopes permit,
 * so `tools/list` never advertises a tool the caller cannot use.
 */
export function scopeFilteredServer(server: McpServer, auth: McpAuthContext): McpServer {
	return new Proxy(server, {
		get(target, prop) {
			if (prop === "registerTool") {
				return (name: string, ...rest: unknown[]) => {
					if (!toolPermitted(auth.scopes, name)) return undefined;
					return (target.registerTool as (...args: unknown[]) => unknown)(name, ...rest);
				};
			}
			const value: unknown = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
