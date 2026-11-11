import type { AuthContext } from "../api/auth";
import { requireScope } from "../lib/mcp-scopes";

export type McpAuthContext = AuthContext & { scopes: ReadonlySet<string> };

export class McpScopeError extends Error {
	constructor(readonly scope: string) {
		super(`insufficient_scope: ${scope}`);
	}
}

export function assertScope(auth: McpAuthContext, scope: string): void {
	if (!requireScope(auth.scopes, scope)) throw new McpScopeError(scope);
}
