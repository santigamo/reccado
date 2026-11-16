import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer, type McpRequestContext } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { createAuth, AuthConfigError, getDeploymentOriginForAuth, resolveMcpResource } from "../api/better-auth";
import { recordDeploymentOrigin } from "../db/runtime-config";
import { requireMcpOwner, resolveOwnerEmails } from "./auth-import";
import { registerTools } from "./tools";
import { registerResources } from "./resources";
import { insufficientScope, neededScopeFor, scopesFromClaims, toolPermitted } from "../lib/mcp-scopes";
import type { McpSendAuth as McpAuthContext } from "./types";
import { makeIntentCodec } from "./intent-flow";

/**
 * The claims the owner gate consumes. Structural on purpose: `jose` is not a
 * direct dependency, and JWTPayload's index signature makes every JWT payload
 * assignable to this.
 */
type McpAccessTokenClaims = {
	sub?: string;
	email?: string;
	scope?: unknown;
	[key: string]: unknown;
};

/** The scope a JSON-RPC `tools/call` needs but the token lacks, or null when the call is fine / not a tool call. */
export async function missingScopeForToolCall(request: Request, granted: ReadonlySet<string>): Promise<string | null> {
	if (request.method !== "POST") return null;
	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		return null;
	}
	for (const message of Array.isArray(body) ? body : [body]) {
		if (!message || typeof message !== "object") continue;
		const { method, params } = message as { method?: unknown; params?: { name?: unknown } };
		if (method !== "tools/call" || typeof params?.name !== "string") continue;
		const needed = neededScopeFor(params.name);
		if (needed && !toolPermitted(granted, params.name)) return needed;
	}
	return null;
}

/** The SDK's validated serving era, available inside its per-request factory. */
export function isLegacyMcpRequest(context: McpRequestContext): boolean {
	return context.era === "legacy";
}

/**
 * Hosts `/mcp` answers to: localhost, the observed public origin (the one OAuth
 * tokens are bound to), operator-listed `MCP_ALLOWED_HOSTS`, and the request's own
 * `*.workers.dev` hostname. Everything else is refused by the SDK's Host check.
 */
export async function resolveAllowedHostnames(env: Env, requestHostname: string): Promise<string[]> {
	const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
	const origin = await getDeploymentOriginForAuth(env.INDEX_DB).catch(() => null);
	if (origin) {
		try {
			hosts.add(new URL(origin).hostname.toLowerCase());
		} catch {
			// A malformed stored origin contributes nothing.
		}
	}
	for (const entry of (env.MCP_ALLOWED_HOSTS ?? "").split(",")) {
		const host = entry.trim().toLowerCase();
		if (host) hosts.add(host);
	}
	if (requestHostname.endsWith(".workers.dev")) hosts.add(requestHostname);
	return [...hosts];
}

/** Bind a fresh server and its tool closures to this authenticated request. */
async function runMcpServer(
	request: Request,
	env: Env,
	ctx: ExecutionContext,
	auth: McpAuthContext,
): Promise<Response> {
	const hostname = new URL(request.url).hostname;
	const secret = env.BETTER_AUTH_SECRET?.trim();
	const local = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
	if (!secret && !local) return Response.json({ error: "auth_unavailable" }, { status: 503 });
	const codec = await makeIntentCodec(secret || `local:${env.PHASE0_DEBUG_TOKEN ?? ""}`, `${auth.userId}\0${auth.oauthClientId ?? ""}`);
	const allowedHostnames = await resolveAllowedHostnames(env, hostname);
	const handler = createMcpHandler(
		(requestContext) => {
			const server = new McpServer({ name: "reccado", version: "1.0.0" }, { requestState: { verify: codec.verify } });
			registerTools(server, env, auth, new URL(request.url).origin, { era: requestContext.era, codec });
			registerResources(server, env, auth);
			return server;
		},
		{ legacy: "stateless", allowedHostnames, allowedOriginHostnames: allowedHostnames },
	);
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
		return runMcpServer(request, env, ctx, { userId: "", email: "", scopes: new Set() });
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
			const ownerAuth: McpAuthContext = {
				userId: typeof claims.sub === "string" ? claims.sub : "",
				email: typeof claims.email === "string" ? claims.email : "",
				owners: await resolveOwnerEmails(env),
				scopes: scopesFromClaims(claims),
				oauthClientId: typeof claims.client_id === "string" ? claims.client_id : undefined,
				tokenSub: typeof claims.sub === "string" ? claims.sub : undefined,
				tokenJti: typeof claims.jti === "string" ? claims.jti : undefined,
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

			// A tool call the token's scopes do not permit (e.g. from a stale
			// tools/list, or an old `admin` token) gets the spec insufficient_scope
			// challenge naming the exact scope, instead of "unknown tool".
			const blocked = await missingScopeForToolCall(req, ownerAuth.scopes);
			if (blocked) return insufficientScope(blocked, `${new URL(resource).origin}/.well-known/oauth-protected-resource/mcp`);

			return runMcpServer(req, env, ctx, ownerAuth);
		},
		{
			// requireMcpAuth derives issuer and JWKS URL from the auth instance's
			// base URL (…/api/auth), matching how tokens are minted; the audience
			// must be the resource identifier tokens were minted for.
			resource,
			// Keys come from the same auth instance, in process. The default is an
			// HTTP fetch of our own …/api/auth/jwks, and a Worker cannot subrequest
			// its own route on its custom domain: in production every token failed
			// with "Jwks failed" (HTTP 500). Better Auth's verifier accepts a
			// function here (core oauth2/verify: `typeof jwksFetch === "string"
			// ? fetch : jwksFetch()`); the public option is typed as a URL only.
			jwksUrl: (async () => {
				const res = await auth.handler(new Request(new URL("/api/auth/jwks", request.url)));
				if (!res.ok) throw new Error(`jwks_unavailable_${res.status}`);
				return res.json();
			}) as unknown as string,
		},
	);
	return protectedHandler(request);
}
