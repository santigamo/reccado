import { Hono } from "hono";
import { ZodError } from "zod";
import { assertMailboxAccess, getAuthContext, requireAuth } from "./auth";
import {
	createAliasSchema,
	createDomainSchema,
	createMailboxSchema,
	createRoutingRuleSchema,
} from "./schemas";
import {
	getDomainByName,
	getDomainById,
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
import { registerAdminRoutes, registerMailboxRoutes } from "./mailbox-routes";

export type ApiBindings = {
	Bindings: Env;
	Variables: {
		auth: Awaited<ReturnType<typeof getAuthContext>>;
	};
};

export function createApiApp(): Hono<ApiBindings> {
	const api = new Hono<ApiBindings>();

	// Baseline security headers on every response from this app.
	api.use("*", async (c, next) => {
		await next();
		c.res.headers.set("X-Content-Type-Options", "nosniff");
		c.res.headers.set("X-Frame-Options", "DENY");
		c.res.headers.set("Referrer-Policy", "no-referrer");
	});

	// Lightweight CSRF defense for state-changing requests: an Origin header that doesn't
	// match this request's own host is rejected. Requests without an Origin header (curl,
	// tests, server-to-server calls) are not affected.
	api.use("/api/*", async (c, next) => {
		const method = c.req.method.toUpperCase();
		const isStateChanging = method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
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

	api.get("/api/health", (c) => c.json({ ok: true }));

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
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/zones/${domain.zone_id}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		const payload = (await response.json()) as { success?: boolean; result?: { status?: string; name?: string } };
		return c.json({
			domain,
			cloudflare: {
				configured: true,
				ok: payload.success === true,
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
			throw new AppError("Forward routing rules require at least one destination", "forward_to_required", 400);
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
