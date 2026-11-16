import { Hono } from "hono";
import { ZodError } from "zod";
import { getSetupStatus } from "../db/d1";
import * as domainAdmin from "../lib/admin/domains";
import { AdminError, AdminRemoteError, AdminValidationError } from "../lib/admin/errors";
import * as mailboxAdmin from "../lib/admin/mailboxes";
import * as routingAdmin from "../lib/admin/routing";
import { AppError } from "../lib/errors";
import { getAuthConfigStatus, isLocalRequest } from "../lib/runtime-config";
import { registerApprovalRoutes } from "./approval-routes";
import { type getAuthContext, requireAuth } from "./auth";
import { handleAuthRequest, handleSetPasswordRequest } from "./better-auth";
import { registerCloudflareReadRoutes } from "./cloudflare-routes";
import {
	registerAdminRoutes,
	registerMailboxRoutes,
	registerMailboxSuppressionRoutes,
} from "./mailbox-routes";
import { registerOAuthClientRoutes } from "./oauth-client-routes";
import { registerTelegramRoutes } from "./telegram-routes";

export type ApiBindings = {
	Bindings: Env;
	Variables: {
		auth: Awaited<ReturnType<typeof getAuthContext>>;
	};
};

// Tables the D1 index schema is expected to have (see migrations/d1/0001_initial.sql
// and 0002_message_index.sql). Health checks against sqlite_master so a missing
// migration (e.g. the "aliases" table not existing) surfaces as a real failure
// instead of a hardcoded ok:true.
const REQUIRED_INDEX_DB_TABLES = ["aliases", "message_index"] as const;

type IndexDbHealth = {
	ok: boolean;
	reason: string | null;
};

async function checkIndexDbHealth(indexDb: D1Database): Promise<IndexDbHealth> {
	try {
		const placeholders = REQUIRED_INDEX_DB_TABLES.map(() => "?").join(", ");
		const result = await indexDb
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
			.bind(...REQUIRED_INDEX_DB_TABLES)
			.all<{ name: string }>();
		const foundTables = new Set(result.results.map((row) => row.name));
		const missingTables = REQUIRED_INDEX_DB_TABLES.filter((table) => !foundTables.has(table));
		if (missingTables.length > 0) {
			return {
				ok: false,
				reason: `Missing D1 table(s): ${missingTables.join(", ")}. Run migrations in migrations/d1.`,
			};
		}
		return { ok: true, reason: null };
	} catch (error) {
		return {
			ok: false,
			reason:
				error instanceof Error
					? `D1 query against INDEX_DB failed: ${error.message}`
					: "D1 query against INDEX_DB failed with an unknown error.",
		};
	}
}

/** The one API response the app frames: GET /api/mailboxes/:id/messages/:messageId/html. */
const MESSAGE_HTML_PATH = /^\/api\/mailboxes\/[^/]+\/messages\/[^/]+\/html$/;

export function createApiApp(): Hono<ApiBindings> {
	const api = new Hono<ApiBindings>();

	// Baseline security headers on every response from this app. Responses proxied straight
	// from a Durable Object (or any fetch()) have immutable headers, so rebuild the response
	// with a fresh, mutable Headers instead of mutating in place (which would throw). Skip
	// 1xx/upgrade responses, which cannot be reconstructed via the Response constructor.
	api.use("*", async (c, next) => {
		await next();
		if (c.res.status < 200) {
			return;
		}
		const headers = new Headers(c.res.headers);
		headers.set("X-Content-Type-Options", "nosniff");
		// DENY everywhere, with one exception: a message's HTML body, which the
		// inbox itself frames (sandboxed) and which declares SAMEORIGIN to match its
		// CSP frame-ancestors 'self'. Pages that ask for decisions (/approve/:id and
		// /inbox, whose approvals pane approves too; /login, /consent) are not served
		// by this app: server.ts withHtmlSecurityHeaders gives them their own DENY,
		// frame-ancestors 'none' and frame-src 'self' (plus no-referrer on /approve
		// and /inbox).
		const framable =
			MESSAGE_HTML_PATH.test(c.req.path) && headers.get("X-Frame-Options") === "SAMEORIGIN";
		if (!framable) headers.set("X-Frame-Options", "DENY");
		headers.set("Referrer-Policy", "no-referrer");
		c.res = new Response(c.res.body, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		});
	});

	// Auth helpers (requireAuth, assertMailboxAccess, requireMcpOwner) signal a
	// denial by THROWING a ready-made Response. Hono's onError only receives
	// thrown Errors — anything else is rethrown past it and escapes the app as a
	// 500. Catch it here, once, for every route registered on this app (including
	// those server.ts adds afterwards), and answer with the Response exactly as
	// the helper built it. Registered after the security-headers middleware so
	// those headers still wrap the answer.
	api.use("*", async (_c, next) => {
		try {
			await next();
		} catch (error) {
			if (error instanceof Response) return error;
			throw error;
		}
	});

	// Lightweight CSRF defense for state-changing requests: an Origin header that doesn't
	// match this request's own host is rejected. Requests without an Origin header (curl,
	// tests, server-to-server calls) are not affected.
	//
	// /api/auth/* is deliberately NOT exempt from this: the login and pairing endpoints
	// are state-changing, unauthenticated, and exactly what an attacker with a planted
	// cross-site form would target. better-auth adds its own trusted-origin check on
	// top.
	api.use("/api/*", async (c, next) => {
		const method = c.req.method.toUpperCase();
		const isStateChanging =
			method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
		if (isStateChanging && c.req.path !== "/api/health") {
			const origin = c.req.header("Origin");
			if (origin && origin !== new URL(c.req.url).origin) {
				return c.json({ error: "origin_mismatch" }, 403);
			}
		}
		return next();
	});

	// --- Web auth issuer (Better Auth) ---------------------------------------------
	//
	// /api/auth/* must be registered BEFORE the requireAuth middleware below: a login
	// request is by definition not yet authenticated, and the owner gate that closes
	// registration lives inside handleAuthRequest. Deliberately still under the CSRF
	// Origin middleware above, and deliberately NOT calling recordDeploymentOrigin:
	// the origin is learned only from a request an owner authenticated, and nobody
	// here is one yet.
	api.all("/api/auth/*", (c) => handleAuthRequest(c.req.raw, c.env));

	api.use("/api/*", async (c, next) => {
		if (c.req.path === "/api/health" || c.req.path.startsWith("/api/debug/")) {
			return next();
		}
		try {
			// The web confirm-send path verifies the session against D1 (cookie cache
			// bypassed): it is the one path where a revoked session must take effect
			// before the very next act, which is sending mail.
			const bypassCookieCache = /^\/api\/mailboxes\/[^/]+\/drafts\/[^/]+\/confirm-send$/.test(
				c.req.path,
			);
			const auth = await requireAuth(
				c.req.raw,
				c.env,
				bypassCookieCache ? { disableCookieCache: true } : undefined,
			);
			c.set("auth", auth);
			// Learn the hostname we are served on from a request that already cleared
			// the auth perimeter. It is the one input the cron needs to keep the Telegram webhook
			// registered, and gating it on authentication is what stops a forged Host
			// header from redirecting the operator's notifications.
			//
			// Isolated from the auth try/catch below on purpose: bookkeeping must never
			// be able to turn an authenticated request into a 500, and c.executionCtx
			// throws outright in contexts that have none.
			try {
				c.executionCtx.waitUntil(
					import("../db/runtime-config").then(({ recordDeploymentOrigin }) =>
						recordDeploymentOrigin(c.env.INDEX_DB, c.req.url).catch(() => undefined),
					),
				);
			} catch {
				// No execution context to defer onto; the next request will record it.
			}
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
		return next();
	});

	// MCP endpoint: dedicated middleware (does NOT inherit /api/* middleware).
	// Security headers already applied via the global api.use("*") above.
	//
	// Authentication moved into mcp/handler.ts (bearer-token verification via
	// @better-auth/mcp + the requireMcpOwner owner gate); CORS preflights
	// (OPTIONS) pass through to the MCP transport there, which answers them
	// without a token — the same exemption the old session middleware granted.
	//
	// MCP CSRF: Origin check for state-changing POST requests.
	// Non-browser MCP clients (Claude Desktop, MCP Inspector) omit Origin — allow those.
	// Browser-origin POSTs with a mismatched Origin are rejected.
	api.use("/mcp", async (c, next) => {
		if (c.req.method === "POST") {
			const origin = c.req.header("Origin");
			if (origin && origin !== new URL(c.req.url).origin) {
				return c.json({ error: "origin_mismatch" }, 403);
			}
		}
		return next();
	});

	// --- OAuth discovery (RFC 8414 / RFC 9728) ---------------------------------------
	//
	// MCP clients start the OAuth flow from the WWW-Authenticate challenge /mcp
	// answers 401 with, and fetch the well-known metadata at the ROOT of the
	// origin. The mcp plugin serves those documents through the auth handler's
	// plugin hooks, which match the raw request path BEFORE endpoint routing —
	// so forwarding the request unmodified is enough: the hooks answer the
	// protected-resource and authorization-server documents, and requests that
	// match nothing 404 in the auth router.
	api.all("/.well-known/*", (c) => handleAuthRequest(c.req.raw, c.env));

	// Telegram webhook. Deliberately outside /api/* — see handleTelegramWebhook for
	// why it cannot use the session perimeter or the Origin guard, and what authenticates it instead.
	// Registered for every method (not just POST) so the handler itself decides —
	// it answers 404 when the bridge is off, which must win over a router 405.
	api.all("/telegram/webhook", async (c) => {
		const { handleTelegramWebhook } = await import("../telegram/webhook");
		return handleTelegramWebhook(c.req.raw, c.env);
	});

	api.get("/api/health", async (c) => {
		const authConfig = getAuthConfigStatus(c.env);
		const authOk =
			authConfig.ok && (authConfig.mode !== "local-dev-bypass" || isLocalRequest(c.req.raw));
		const authReason =
			authOk || authConfig.mode !== "local-dev-bypass"
				? authConfig.reason
				: "Better Auth is not configured, so non-localhost requests cannot authenticate.";
		const cloudflareApiConfigured = Boolean(c.env.CLOUDFLARE_API_TOKEN?.trim());
		const indexDbHealth = await checkIndexDbHealth(c.env.INDEX_DB);
		const { getTelegramStatus } = await import("../telegram/status");
		// A bridge that is on but not delivering has to be visible somewhere a human
		// or a script actually looks; that it never was is why it stayed broken.
		const telegram = indexDbHealth.ok ? await getTelegramStatus(c.env).catch(() => null) : null;
		const { getSendingFeedbackStatus } = await import("../lib/feedback-liveness");
		// Same failure shape as the bridge, one layer out: sending works, the
		// channel that reports on it does not, and nothing said so. This is the
		// only check that survives having no Cloudflare token — it reads what our
		// own sends already recorded.
		const sendingFeedback = indexDbHealth.ok
			? await getSendingFeedbackStatus(c.env.INDEX_DB).catch(() => null)
			: null;
		const dependencyStates = {
			auth: {
				ok: authOk,
				configured: authConfig.configured,
				mode: authConfig.mode,
				reason: authReason,
				missing: authConfig.missing,
			},
			indexDb: {
				ok: indexDbHealth.ok,
				configured: true,
				reason: indexDbHealth.reason,
			},
			cloudflareApi: {
				ok: true,
				configured: cloudflareApiConfigured,
				reason: cloudflareApiConfigured ? null : "CLOUDFLARE_API_TOKEN is not set.",
			},
			telegram: {
				// An intentionally disabled bridge is healthy; a half-configured one is not.
				ok: telegram?.ok ?? true,
				configured: telegram ? telegram.mode !== "off" : false,
				mode: telegram?.mode ?? "unknown",
				reason: telegram?.reason ?? null,
				missing: telegram?.missing ?? [],
				webhookUrl: telegram?.webhookUrl ?? null,
				// The other side of a failing webhook: a count that climbs while the
				// error message stays generic. Null until the cron has looked once.
				pendingUpdateCount: telegram?.pendingUpdateCount ?? null,
			},
			sendingFeedback: {
				// A domain nobody has sent from yet is healthy; one that sends and is
				// never answered is not. `unobserved` stays healthy on purpose — it is
				// an absence of evidence, and treating it as a fault would repeat the
				// error this block exists to correct, pointed the other way.
				ok: sendingFeedback?.ok ?? true,
				configured: (sendingFeedback?.domains.length ?? 0) > 0,
				mode: sendingFeedback?.mode ?? "unknown",
				reason: sendingFeedback?.reason ?? null,
				// Named, because "something is dark" without which domain sends the
				// operator back to the dashboard to find out.
				darkDomains: sendingFeedback?.dark ?? [],
				maturityHours: sendingFeedback?.maturityHours ?? null,
			},
		};
		const readinessOk = authOk && indexDbHealth.ok;
		return c.json({
			ok: true,
			readiness: {
				ok: readinessOk,
				status: readinessOk ? "ready" : "degraded",
			},
			dependencies: dependencyStates,
		});
	});

	api.get("/api/me", (c) => {
		const auth = c.get("auth");
		return c.json({ userId: auth?.userId, email: auth?.email });
	});

	// Set the first factor for an owner who signed in by OTP or pairing code and
	// has no password yet. Under /api/* on purpose: it acts on the caller's own
	// session, so it must be behind the same perimeter as everything else here,
	// not alongside the unauthenticated /api/auth/* endpoints.
	api.post("/api/account/password", (c) => handleSetPasswordRequest(c.req.raw, c.env));

	// Protected setup diagnostic (behind the auth perimeter, like the rest of /api/*): runtime
	// facts the CLI `pnpm doctor` cannot infer — index health plus control-plane completeness.
	api.get("/api/setup/status", async (c) => {
		const indexDbHealth = await checkIndexDbHealth(c.env.INDEX_DB);
		if (!indexDbHealth.ok) {
			return c.json({ ok: false, indexDb: indexDbHealth, controlPlane: null }, 503);
		}
		return c.json({
			ok: true,
			indexDb: indexDbHealth,
			controlPlane: await getSetupStatus(c.env.INDEX_DB),
		});
	});

	api.get("/api/mailboxes", async (c) => {
		return c.json(await mailboxAdmin.listMailboxes(c.env, c.get("auth")!));
	});

	api.post("/api/mailboxes", async (c) => {
		const result = await mailboxAdmin.createMailbox(c.env, c.get("auth")!, await c.req.json());
		return c.json(result, result.created ? 201 : 200);
	});

	api.get("/api/mailboxes/:mailboxId", async (c) => {
		const { mailbox } = await mailboxAdmin.readMailbox(c.env, c.get("auth")!, {
			mailboxId: c.req.param("mailboxId"),
		});
		if (!mailbox) {
			return c.json({ error: "mailbox_not_found" }, 404);
		}
		return c.json({ mailbox });
	});

	api.patch("/api/mailboxes/:mailboxId", async (c) => {
		return c.json(
			await mailboxAdmin.patchMailbox(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				get body() {
					return c.req.json();
				},
			}),
		);
	});

	// Soft delete, and the only kind offered. A mailbox's messages live in its Durable Object and
	// in R2, and every message_index row carries its mailbox_id — dropping the row would orphan all
	// of that with nothing left pointing at the data and no way back. `status = 'disabled'` is the
	// reversible equivalent: it takes the mailbox out of listMailboxesByOwner/getMailboxForOwner,
	// so MCP and the UI stop serving it, while the archive stays reachable if it is re-enabled.
	api.delete("/api/mailboxes/:mailboxId", async (c) => {
		return c.json(
			await mailboxAdmin.deleteMailbox(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
			}),
		);
	});

	api.get("/api/domains", async (c) =>
		c.json(await domainAdmin.listDomains(c.env, c.get("auth")!)),
	);
	api.post("/api/domains", async (c) => {
		const result = await domainAdmin.createDomain(c.env, c.get("auth")!, await c.req.json());
		return c.json(result, result.created ? 201 : 200);
	});
	api.patch("/api/domains/:domain", async (c) =>
		c.json(
			await domainAdmin.patchDomain(c.env, c.get("auth")!, {
				domain: c.req.param("domain"),
				body: await c.req.json(),
			}),
		),
	);
	api.delete("/api/domains/:domain", async (c) =>
		c.json(
			await domainAdmin.deleteDomain(c.env, c.get("auth")!, { domain: c.req.param("domain") }),
		),
	);
	api.get("/api/domains/:domain/status", async (c) => {
		const result = await domainAdmin.domainStatus(c.env, c.get("auth")!, {
			domain: c.req.param("domain"),
		});
		return result ? c.json(result) : c.json({ error: "domain_not_found" }, 404);
	});
	api.post("/api/domains/:domain/provision", async (c) =>
		c.json(
			await domainAdmin.provisionDomain(c.env, c.get("auth")!, {
				domain: c.req.param("domain"),
				body: await c.req.json(),
			}),
		),
	);
	api.get("/api/aliases", async (c) =>
		c.json(await routingAdmin.listAliases(c.env, c.get("auth")!)),
	);
	api.post("/api/aliases", async (c) =>
		c.json(await routingAdmin.createAlias(c.env, c.get("auth")!, await c.req.json()), 201),
	);
	api.patch("/api/aliases/:aliasAddress", async (c) =>
		c.json(
			await routingAdmin.patchAlias(c.env, c.get("auth")!, {
				aliasAddress: c.req.param("aliasAddress"),
				body: await c.req.json(),
			}),
		),
	);
	api.delete("/api/aliases/:aliasAddress", async (c) =>
		c.json(
			await routingAdmin.deleteAlias(c.env, c.get("auth")!, {
				aliasAddress: c.req.param("aliasAddress"),
			}),
		),
	);
	api.get("/api/routing-rules", async (c) =>
		c.json(
			await routingAdmin.listRules(c.env, c.get("auth")!, { domainId: c.req.query("domainId") }),
		),
	);
	api.post("/api/routing-rules", async (c) =>
		c.json(await routingAdmin.createRule(c.env, c.get("auth")!, await c.req.json()), 201),
	);
	api.patch("/api/routing-rules/:ruleId", async (c) =>
		c.json(
			await routingAdmin.patchRule(c.env, c.get("auth")!, {
				ruleId: c.req.param("ruleId"),
				body: await c.req.json(),
			}),
		),
	);
	api.delete("/api/routing-rules/:ruleId", async (c) =>
		c.json(await routingAdmin.deleteRule(c.env, c.get("auth")!, { ruleId: c.req.param("ruleId") })),
	);
	registerMailboxRoutes(api);
	registerMailboxSuppressionRoutes(api);
	registerAdminRoutes(api);
	registerOAuthClientRoutes(api);
	registerTelegramRoutes(api);
	registerApprovalRoutes(api);
	registerCloudflareReadRoutes(api);

	// MCP endpoint: forward all methods (GET/POST/OPTIONS) to the MCP handler.
	api.all("/mcp", async (c) => {
		const { mcpHandler } = await import("../mcp/handler");
		return mcpHandler(c.req.raw, c.env, c.executionCtx as ExecutionContext);
	});

	api.onError((error, c) => {
		if (error instanceof ZodError) {
			return c.json({ error: "validation_error", issues: error.flatten() }, 400);
		}
		// A malformed JSON body makes c.req.json() throw a SyntaxError; surface it as a 400
		// client error rather than a generic 500.
		if (error instanceof SyntaxError) {
			return c.json({ error: "invalid_json" }, 400);
		}
		if (error instanceof AdminRemoteError) {
			return new Response(error.status === 304 ? null : error.body, {
				status: error.status,
				headers: error.headers,
			});
		}
		if (error instanceof AdminValidationError) {
			return c.json({ error: error.code, issues: error.issues }, 400);
		}
		if (error instanceof AdminError && !error.includeMessage) {
			return c.json({ error: error.code }, error.status as 400);
		}
		if (error instanceof AppError) {
			return c.json({ error: error.code, message: error.message }, error.status as 400);
		}
		if (error instanceof Response) {
			return error;
		}
		console.error("api.error", error);
		return c.json({ error: "internal_error" }, 500);
	});

	return api;
}
