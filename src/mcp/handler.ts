import { requireMcpAuth } from "@better-auth/mcp";
import { createMcpHandler } from "agents/mcp";
import { createAuth, AuthConfigError, resolveMcpResource } from "../api/better-auth";
import { recordDeploymentOrigin } from "../db/runtime-config";
import { requireMcpOwner, resolveOwnerEmails, type AuthContext } from "./auth-import";
import { registerTools } from "./tools";

/**
 * The claims the owner gate consumes. Structural on purpose: `jose` is not a
 * direct dependency, and JWTPayload's index signature makes every JWT payload
 * assignable to this.
 */
type McpAccessTokenClaims = {
	sub?: string;
	email?: string;
	[key: string]: unknown;
};

/**
 * Builds the per-request McpServer (no module-level singleton — per Cloudflare's
 * createMcpHandler docs for SDK 1.26.0+) with the authenticated identity bound
 * into tool closures.
 */
async function runMcpServer(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	auth: AuthContext,
): Promise<Response> {
	const McpServer = (await import("@modelcontextprotocol/sdk/server/mcp.js")).McpServer;
	const server = new McpServer({ name: "reccado", version: "1.0.0" });
	registerTools(server, env, auth);
	const handler = createMcpHandler(server);
	return handler(request, env, ctx);
}

/**
 * Per-request MCP handler, protected by OAuth 2.1 bearer tokens issued by our
 * own better-auth instance (docs/plans/sending-streams-and-auth.md Phase 2
 * item 5 — replaces the session-cookie auth).
 *
 * Two gates, in order, owned by different code:
 *
 * 1. Token verification — @better-auth/mcp's requireMcpAuth checks the bearer
 *    JWT's signature (against our /jwks), issuer, audience (the canonical /mcp
 *    resource) and expiry, and answers unauthenticated requests with the
 *    RFC 9728 WWW-Authenticate challenge MCP clients need to start the OAuth
 *    flow. No MCP handler code runs before it passes.
 *
 * 2. The owner gate — requireMcpOwner (api/auth.ts; the plugin owns the
 *    requireMcpAuth name now) re-applies today's semantics on top of the token
 *    identity: 503 when no owner is configured at all, 403 when the token's
 *    email is not in the D1 registry ∪ OWNER_BOOTSTRAP_EMAILS. A valid token
 *    for a stranger is still a stranger.
 *
 * Tools, rate-limit keys and facade scoping keep consuming auth.email exactly
 * as before — only the way the identity arrives changed.
 *
 * Operator path for the OAuth client (single operator): while logged in to the
 * dashboard, POST /api/auth/oauth2/register (session-backed dynamic client
 * registration — unauthenticated registration is disabled). A client row can
 * also be minted by hand in D1 (`INSERT INTO "oauthClient" …`, optionally with
 * "skipConsent" = 1 to skip the consent redirect — the page it would land on is
 * routes/consent.tsx; see consentPage in api/better-auth.ts).
 */
export async function mcpHandler(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
): Promise<Response> {
	// CORS preflight bypasses token verification — browsers do not send the
	// bearer header on preflights, and the MCP transport answers it (same
	// exemption the old session middleware granted).
	if (request.method === "OPTIONS") {
		return runMcpServer(request, env, ctx, { userId: "", email: "" });
	}

	let auth: Awaited<ReturnType<typeof createAuth>>;
	try {
		auth = await createAuth(env, { request });
	} catch (error) {
		if (error instanceof AuthConfigError) {
			return Response.json({ error: "auth_unavailable", reason: error.message }, { status: 503 });
		}
		throw error;
	}
	const resource = await resolveMcpResource(env, request);

	const protectedHandler = requireMcpAuth(
		auth,
		async (req, claims: McpAccessTokenClaims) => {
			// Token identity → AuthContext. The email claim is stamped at mint by
			// the mcp plugin's customAccessTokenClaims; a token without it cannot
			// match an owner and fails closed below.
			const ownerAuth: AuthContext = {
				userId: typeof claims.sub === "string" ? claims.sub : "",
				email: typeof claims.email === "string" ? claims.email : "",
				owners: await resolveOwnerEmails(env),
			};
			try {
				requireMcpOwner(ownerAuth, env);
			} catch (error) {
				if (error instanceof Response) {
					return error;
				}
				throw error;
			}

			// The origin is learned only from a request an owner authenticated —
			// the invariant recordDeploymentOrigin's callers must preserve. The
			// old /mcp middleware did this after requireAuth; the gate moved into
			// this handler with the auth, so the bookkeeping moved with it.
			try {
				ctx.waitUntil(recordDeploymentOrigin(env.INDEX_DB, req.url).catch(() => undefined));
			} catch {
				// No execution context to defer onto; the next request will record it.
			}

			return runMcpServer(req, env, ctx, ownerAuth);
		},
		{
			// requireMcpAuth derives issuer and JWKS URL from the auth instance's
			// base URL (…/api/auth), matching how tokens are minted; the audience
			// must be the resource identifier tokens were minted for.
			resource,
		},
	);
	return protectedHandler(request);
}
