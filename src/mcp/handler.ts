import { createMcpHandler } from "agents/mcp";
import type { AuthContext } from "../api/auth";
import { requireAuth, requireMcpAuth } from "./auth-import";
import { registerTools } from "./tools";

/**
 * Per-request MCP handler. Creates a fresh McpServer for each request to
 * avoid cross-client state leakage (per Cloudflare's createMcpHandler docs
 * for SDK 1.26.0+). Authenticates via Cloudflare Access JWT, enforces the
 * MCP fail-closed allowlist, then registers tools with the authenticated
 * identity bound into closures.
 */
export async function mcpHandler(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	// Auth: requireAuth throws a Response on failure (401/403/503).
	let auth: AuthContext;
	try {
		auth = await requireAuth(request, env);
	} catch (error) {
		if (error instanceof Response) {
			return error;
		}
		throw error;
	}

	// MCP fail-closed: require explicit allowlist, distinguish 503 vs 403.
	try {
		auth = requireMcpAuth(auth, env);
	} catch (error) {
		if (error instanceof Response) {
			return error;
		}
		throw error;
	}

	// Per-request McpServer — no module-level singleton.
	const McpServer = (await import("@modelcontextprotocol/sdk/server/mcp.js")).McpServer;
	const server = new McpServer({ name: "reccado", version: "1.0.0" });
	registerTools(server, env, auth);

	const handler = createMcpHandler(server);
	return handler(request, env, ctx);
}
