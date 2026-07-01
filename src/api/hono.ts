import { Hono } from "hono";
import { ZodError } from "zod";
import {
	getDomainById,
	getDomainByName,
	getMailbox,
	insertAlias,
	insertDomain,
	insertMailbox,
	insertRoutingRule,
	listAliases,
	listDomains,
	listMailboxes,
	listRoutingRules,
} from "../db/d1";
import { AppError } from "../lib/errors";
import { mailboxIdFromPrimaryAddress } from "../lib/mailbox-id";
import {
	fetchWithTimeout,
	getAccessConfigStatus,
	isAbortTimeoutError,
	isLocalRequest,
} from "../lib/runtime-config";
import { assertMailboxAccess, type getAuthContext, requireAuth } from "./auth";
import { registerAdminRoutes, registerMailboxRoutes } from "./mailbox-routes";
import {
	createAliasSchema,
	createDomainSchema,
	createMailboxSchema,
	createRoutingRuleSchema,
} from "./schemas";

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
		headers.set("X-Frame-Options", "DENY");
		headers.set("Referrer-Policy", "no-referrer");
		c.res = new Response(c.res.body, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		});
	});

	// Lightweight CSRF defense for state-changing requests: an Origin header that doesn't
	// match this request's own host is rejected. Requests without an Origin header (curl,
	// tests, server-to-server calls) are not affected.
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

	api.use("/api/*", async (c, next) => {
		if (c.req.path === "/api/health" || c.req.path.startsWith("/api/debug/")) {
			return next();
		}
		try {
			const auth = await requireAuth(c.req.raw, c.env);
			c.set("auth", auth);
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
		return next();
	});

	api.get("/api/health", async (c) => {
		const access = getAccessConfigStatus(c.env);
		const authOk = access.ok && (access.mode !== "local-dev-bypass" || isLocalRequest(c.req.raw));
		const authReason =
			authOk || access.mode !== "local-dev-bypass"
				? access.reason
				: "Cloudflare Access validation is not configured for non-localhost requests.";
		const cloudflareApiConfigured = Boolean(c.env.CLOUDFLARE_API_TOKEN?.trim());
		const indexDbHealth = await checkIndexDbHealth(c.env.INDEX_DB);
		const dependencyStates = {
			auth: {
				ok: authOk,
				configured: access.configured,
				mode: access.mode,
				reason: authReason,
				missing: access.missing,
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

	api.get("/api/mailboxes", async (c) => {
		const mailboxes = await listMailboxes(c.env.INDEX_DB);
		return c.json({ mailboxes });
	});

	api.post("/api/mailboxes", async (c) => {
		const body = createMailboxSchema.parse(await c.req.json());
		const mailboxId = await mailboxIdFromPrimaryAddress(c.env, body.primaryAddress);
		const existing = await getMailbox(c.env.INDEX_DB, mailboxId);
		if (existing) {
			return c.json({ mailbox: existing, created: false });
		}
		const primaryAddress = body.primaryAddress.trim().toLowerCase();
		await insertMailbox(c.env.INDEX_DB, {
			mailbox_id: mailboxId,
			primary_address: primaryAddress,
			display_name: body.displayName ?? null,
			status: "active",
		});
		const mailbox = await getMailbox(c.env.INDEX_DB, mailboxId);
		return c.json({ mailbox, created: true }, 201);
	});

	api.get("/api/mailboxes/:mailboxId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const mailbox = await getMailbox(c.env.INDEX_DB, mailboxId);
		if (!mailbox) {
			return c.json({ error: "mailbox_not_found" }, 404);
		}
		return c.json({ mailbox });
	});

	api.get("/api/domains", async (c) => {
		return c.json({ domains: await listDomains(c.env.INDEX_DB) });
	});

	api.post("/api/domains", async (c) => {
		const body = createDomainSchema.parse(await c.req.json());
		const domain = body.domain.trim().toLowerCase();
		const existing = await getDomainByName(c.env.INDEX_DB, domain);
		if (existing) {
			return c.json({ domain: existing, created: false });
		}
		const id = crypto.randomUUID();
		await insertDomain(c.env.INDEX_DB, {
			id,
			domain,
			zone_id: body.zoneId,
			status: "active",
		});
		return c.json({ domain: await getDomainByName(c.env.INDEX_DB, domain), created: true }, 201);
	});

	api.get("/api/domains/:domain/status", async (c) => {
		const domainName = c.req.param("domain").trim().toLowerCase();
		const domain = await getDomainByName(c.env.INDEX_DB, domainName);
		if (!domain) {
			return c.json({ error: "domain_not_found" }, 404);
		}
		const token = c.env.CLOUDFLARE_API_TOKEN;
		if (!token) {
			return c.json({
				domain,
				cloudflare: { configured: false, reason: "CLOUDFLARE_API_TOKEN not set" },
			});
		}
		let payload:
			| {
					success?: boolean;
					result?: { status?: string; name?: string };
			  }
			| undefined;
		try {
			const response = await fetchWithTimeout(
				`https://api.cloudflare.com/client/v4/zones/${domain.zone_id}`,
				{
					headers: { Authorization: `Bearer ${token}` },
					timeoutMs: 5_000,
				},
			);
			payload = (await response.json()) as {
				success?: boolean;
				result?: { status?: string; name?: string };
			};
		} catch (error) {
			return c.json({
				domain,
				cloudflare: {
					configured: true,
					ok: false,
					reason: isAbortTimeoutError(error)
						? "Cloudflare API request timed out."
						: "Cloudflare API request failed.",
					status: null,
					name: null,
				},
			});
		}
		return c.json({
			domain,
			cloudflare: {
				configured: true,
				ok: payload.success === true,
				reason:
					payload.success === true ? null : "Cloudflare API returned an unsuccessful response.",
				status: payload.result?.status ?? null,
				name: payload.result?.name ?? null,
			},
		});
	});

	api.get("/api/aliases", async (c) => {
		return c.json({ aliases: await listAliases(c.env.INDEX_DB) });
	});

	api.post("/api/aliases", async (c) => {
		const body = createAliasSchema.parse(await c.req.json());
		const aliasAddress = body.aliasAddress.trim().toLowerCase();
		const mailbox = await getMailbox(c.env.INDEX_DB, body.mailboxId);
		if (!mailbox) {
			throw new AppError("Mailbox not found", "mailbox_not_found", 404);
		}
		const domainName = aliasAddress.split("@")[1];
		if (!domainName) {
			throw new AppError("Invalid alias address", "invalid_alias", 400);
		}
		const domain = await getDomainByName(c.env.INDEX_DB, domainName);
		if (!domain) {
			throw new AppError("Domain not registered", "domain_not_found", 400);
		}
		await insertAlias(c.env.INDEX_DB, {
			alias_address: aliasAddress,
			mailbox_id: body.mailboxId,
			domain_id: domain.id,
			status: "active",
		});
		return c.json({ alias: { alias_address: aliasAddress, mailbox_id: body.mailboxId } }, 201);
	});

	api.get("/api/routing-rules", async (c) => {
		const domainId = c.req.query("domainId") ?? undefined;
		return c.json({ rules: await listRoutingRules(c.env.INDEX_DB, domainId) });
	});

	api.post("/api/routing-rules", async (c) => {
		const body = createRoutingRuleSchema.parse(await c.req.json());
		const domain = await getDomainById(c.env.INDEX_DB, body.domainId);
		if (!domain) {
			throw new AppError("Domain not found", "domain_not_found", 400);
		}
		if (body.action === "store") {
			if (!body.mailboxId) {
				throw new AppError("Store routing rules require mailboxId", "mailbox_id_required", 400);
			}
			const mailbox = await getMailbox(c.env.INDEX_DB, body.mailboxId);
			if (!mailbox) {
				throw new AppError("Mailbox not found", "mailbox_not_found", 400);
			}
		}
		if (body.action === "forward" && !body.forwardTo?.length) {
			throw new AppError(
				"Forward routing rules require at least one destination",
				"forward_to_required",
				400,
			);
		}
		const id = crypto.randomUUID();
		await insertRoutingRule(c.env.INDEX_DB, {
			id,
			domain_id: body.domainId,
			pattern: body.pattern,
			priority: body.priority,
			action: body.action,
			mailbox_id: body.mailboxId ?? null,
			forward_to_json: JSON.stringify(body.forwardTo ?? []),
			reject_reason: body.rejectReason ?? null,
			enabled: body.enabled ? 1 : 0,
		});
		return c.json({ id }, 201);
	});

	registerMailboxRoutes(api);
	registerAdminRoutes(api);

	api.onError((error, c) => {
		if (error instanceof ZodError) {
			return c.json({ error: "validation_error", issues: error.flatten() }, 400);
		}
		// A malformed JSON body makes c.req.json() throw a SyntaxError; surface it as a 400
		// client error rather than a generic 500.
		if (error instanceof SyntaxError) {
			return c.json({ error: "invalid_json" }, 400);
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
