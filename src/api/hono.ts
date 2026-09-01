import { Hono } from "hono";
import { ZodError } from "zod";
import {
	type AliasRow,
	deleteAlias,
	deleteRoutingRule,
	type DomainRow,
	getAlias,
	getDomainById,
	getDomainByName,
	getMailbox,
	getRoutingRule,
	getSetupStatus,
	insertAlias,
	insertAliasIfMissing,
	insertDomain,
	insertMailbox,
	insertRoutingRule,
	listAliases,
	listDomains,
	listMailboxes,
	listRoutingRules,
	updateAlias,
	updateDomain,
	updateMailbox,
	updateRoutingRule,
} from "../db/d1";
import { AppError } from "../lib/errors";
import { provisionSendingDomain } from "../lib/provision";
import { mailboxIdFromPrimaryAddress } from "../lib/mailbox-id";
import {
	fetchWithTimeout,
	getAccessConfigStatus,
	isAbortTimeoutError,
	isLocalRequest,
} from "../lib/runtime-config";
import { assertMailboxAccess, type getAuthContext, requireAuth } from "./auth";
import {
	registerAdminRoutes,
	registerMailboxRoutes,
	registerMailboxSuppressionRoutes,
} from "./mailbox-routes";
import {
	createAliasSchema,
	createDomainSchema,
	createMailboxSchema,
	createRoutingRuleSchema,
	provisionDomainSchema,
	updateAliasSchema,
	updateDomainSchema,
	updateMailboxSchema,
	updateRoutingRuleSchema,
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

type PrimaryAliasOutcome = {
	alias: AliasRow | null;
	aliasCreated: boolean;
	/** Human-readable explanation of why no alias exists, or null when one does. */
	aliasReason: string | null;
};

/**
 * Mail only reaches a mailbox through an alias: `resolveRoutingForRecipient` matches the exact
 * alias first and only then falls back to the domain's routing rules (src/db/d1.ts). A mailbox
 * created without one therefore receives nothing — or, worse, its mail lands in whatever mailbox
 * the domain's catch-all rule points at, which looks like it half-works. `pnpm setup:mailbox`
 * always seeds the alias; POST /api/mailboxes used not to, so this closes that gap.
 *
 * Deliberately non-fatal: the endpoint already accepts addresses on domains that are not
 * registered yet and the UI calls it that way, so a 400 here would break existing callers. The
 * mailbox is created regardless and `aliasReason` says why mail will not arrive yet.
 */
async function ensurePrimaryAlias(
	db: D1Database,
	mailboxId: string,
	primaryAddress: string,
): Promise<PrimaryAliasOutcome> {
	const domainName = primaryAddress.split("@")[1];
	if (!domainName) {
		return { alias: null, aliasCreated: false, aliasReason: "Address has no domain part." };
	}
	const existing = await getAlias(db, primaryAddress);
	if (existing) {
		if (existing.mailbox_id !== mailboxId) {
			// Re-pointing it would silently divert another mailbox's mail. Report, don't steal.
			return {
				alias: existing,
				aliasCreated: false,
				aliasReason: `Alias ${primaryAddress} already routes to mailbox ${existing.mailbox_id}; it was left untouched.`,
			};
		}
		if (existing.status !== "active") {
			// Converge on the state a first-time create would have produced: a re-POST of an
			// address is a provisioning request, so it re-enables its own alias.
			await updateAlias(db, primaryAddress, { status: "active" });
			return { alias: { ...existing, status: "active" }, aliasCreated: false, aliasReason: null };
		}
		return { alias: existing, aliasCreated: false, aliasReason: null };
	}
	const domain = await getDomainByName(db, domainName);
	if (!domain) {
		return {
			alias: null,
			aliasCreated: false,
			aliasReason: `Domain ${domainName} is not registered. Register it with POST /api/domains, then repeat this request to create the alias.`,
		};
	}
	if (domain.status !== "active") {
		return {
			alias: null,
			aliasCreated: false,
			aliasReason: `Domain ${domainName} is registered but ${domain.status}. Activate it, then repeat this request to create the alias.`,
		};
	}
	const inserted = await insertAliasIfMissing(db, {
		alias_address: primaryAddress,
		mailbox_id: mailboxId,
		domain_id: domain.id,
		status: "active",
	});
	return { alias: inserted.alias, aliasCreated: inserted.created, aliasReason: null };
}

/**
 * Resolves the `:domain` path segment by name first — matching the older
 * GET /api/domains/:domain/status route — and then by id, so a caller holding a row from
 * GET /api/domains does not have to re-derive the name. A registered domain name always contains
 * a dot and ids are opaque UUIDs, so the two key spaces cannot collide.
 */
async function findDomainByParam(db: D1Database, param: string): Promise<DomainRow | null> {
	const trimmed = param.trim();
	return (await getDomainByName(db, trimmed.toLowerCase())) ?? (await getDomainById(db, trimmed));
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
			// Learn the hostname we are served on from a request that already cleared
			// Access. It is the one input the cron needs to keep the Telegram webhook
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
	// MCP auth: fail-closed if ACCESS_ALLOWED_EMAILS is unset (503),
	// 403 if authenticated identity is not in the allowlist.
	// OPTIONS (CORS preflight) bypasses auth — the MCP transport handles it.
	api.use("/mcp", async (c, next) => {
		if (c.req.method === "OPTIONS") {
			return next();
		}
		try {
			const auth = await requireAuth(c.req.raw, c.env);
			c.set("auth", auth);
			// Learn the hostname we are served on from a request that already cleared
			// Access. It is the one input the cron needs to keep the Telegram webhook
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
		// MCP fail-closed: require explicit allowlist.
		const { requireMcpAuth } = await import("../mcp/auth-import");
		try {
			requireMcpAuth(c.get("auth")!, c.env);
		} catch (error) {
			if (error instanceof Response) {
				return error;
			}
			throw error;
		}
		return next();
	});

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

	// Telegram webhook. Deliberately outside /api/* — see handleTelegramWebhook for
	// why it cannot use Access or the Origin guard, and what authenticates it instead.
	// Registered for every method (not just POST) so the handler itself decides —
	// it answers 404 when the bridge is off, which must win over a router 405.
	api.all("/telegram/webhook", async (c) => {
		const { handleTelegramWebhook } = await import("../telegram/webhook");
		return handleTelegramWebhook(c.req.raw, c.env);
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

	// Protected setup diagnostic (behind the Access perimeter, like the rest of /api/*): runtime
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
		const mailboxes = await listMailboxes(c.env.INDEX_DB);
		return c.json({ mailboxes });
	});

	api.post("/api/mailboxes", async (c) => {
		const auth = c.get("auth")!;
		const body = createMailboxSchema.parse(await c.req.json());
		const mailboxId = await mailboxIdFromPrimaryAddress(c.env, body.primaryAddress);
		const existing = await getMailbox(c.env.INDEX_DB, mailboxId);
		if (existing) {
			// Converge rather than no-op: the domain may have been registered since the first call,
			// in which case this repeat is the request that finally makes the mailbox reachable.
			const aliasState = await ensurePrimaryAlias(
				c.env.INDEX_DB,
				existing.mailbox_id,
				existing.primary_address,
			);
			return c.json({ mailbox: existing, created: false, ...aliasState });
		}
		const primaryAddress = body.primaryAddress.trim().toLowerCase();
		// insertMailbox is ON CONFLICT(primary_address) DO NOTHING and returns the *stored* id, so a
		// concurrent create for the same address lands on one row instead of forking.
		const storedMailboxId = await insertMailbox(c.env.INDEX_DB, {
			mailbox_id: mailboxId,
			primary_address: primaryAddress,
			display_name: body.displayName ?? null,
			status: "active",
			owner_email: auth.email,
		});
		const mailbox = await getMailbox(c.env.INDEX_DB, storedMailboxId);
		const aliasState = await ensurePrimaryAlias(
			c.env.INDEX_DB,
			storedMailboxId,
			mailbox?.primary_address ?? primaryAddress,
		);
		return c.json({ mailbox, created: true, ...aliasState }, 201);
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

	api.patch("/api/mailboxes/:mailboxId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const body = updateMailboxSchema.parse(await c.req.json());
		const updated = await updateMailbox(c.env.INDEX_DB, mailboxId, {
			display_name: body.displayName,
			status: body.status,
		});
		if (!updated) {
			throw new AppError("Mailbox not found", "mailbox_not_found", 404);
		}
		return c.json({ mailbox: await getMailbox(c.env.INDEX_DB, mailboxId) });
	});

	// Soft delete, and the only kind offered. A mailbox's messages live in its Durable Object and
	// in R2, and every message_index row carries its mailbox_id — dropping the row would orphan all
	// of that with nothing left pointing at the data and no way back. `status = 'disabled'` is the
	// reversible equivalent: it takes the mailbox out of listMailboxesByOwner/getMailboxForOwner,
	// so MCP and the UI stop serving it, while the archive stays reachable if it is re-enabled.
	api.delete("/api/mailboxes/:mailboxId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const updated = await updateMailbox(c.env.INDEX_DB, mailboxId, { status: "disabled" });
		if (!updated) {
			throw new AppError("Mailbox not found", "mailbox_not_found", 404);
		}
		return c.json({ mailbox: await getMailbox(c.env.INDEX_DB, mailboxId), deleted: "soft" });
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

	api.patch("/api/domains/:domain", async (c) => {
		const body = updateDomainSchema.parse(await c.req.json());
		const domain = await findDomainByParam(c.env.INDEX_DB, c.req.param("domain"));
		if (!domain) {
			throw new AppError("Domain not found", "domain_not_found", 404);
		}
		await updateDomain(c.env.INDEX_DB, domain.id, { status: body.status });
		return c.json({ domain: await getDomainById(c.env.INDEX_DB, domain.id) });
	});

	// Soft delete. aliases.domain_id and routing_rules.domain_id are foreign keys into this row, so
	// a hard delete would break or orphan every alias and rule on the domain. It is also
	// unnecessary: resolveRoutingForRecipient rejects any recipient whose domain is not 'active'
	// with `unknown_domain`, so flipping the status already produces the intended effect — the
	// domain stops accepting mail — while keeping its configuration intact for a later re-enable.
	api.delete("/api/domains/:domain", async (c) => {
		const domain = await findDomainByParam(c.env.INDEX_DB, c.req.param("domain"));
		if (!domain) {
			throw new AppError("Domain not found", "domain_not_found", 404);
		}
		await updateDomain(c.env.INDEX_DB, domain.id, { status: "disabled" });
		return c.json({ domain: await getDomainById(c.env.INDEX_DB, domain.id), deleted: "soft" });
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

	/**
	 * Provision a sending domain end to end.
	 *
	 * Answers 200 with the per-step outcomes even when steps did not succeed, and
	 * that is deliberate: the request itself was handled, and the interesting
	 * information is WHICH step is blocked and what the remedy is. Collapsing that
	 * into a 5xx would throw away the four steps that did work and leave the
	 * caller re-running the whole thing blind. A non-2xx is reserved for a request
	 * that could not be attempted at all.
	 *
	 * Idempotent by construction — every step asks what is already true — so the
	 * normal way to finish a partially provisioned domain is to send this again.
	 */
	api.post("/api/domains/:domain/provision", async (c) => {
		const body = provisionDomainSchema.parse(await c.req.json());
		const zone = c.req.param("domain").trim().toLowerCase();
		const sendingDomain = `${body.subdomain.toLowerCase()}.${zone}`;

		if (body.mailbox && !body.mailbox.address.toLowerCase().endsWith(`@${zone}`)) {
			// A mailbox on another domain would be created but unreachable: inbound
			// routing is enabled on THIS zone, so nothing would ever deliver to it.
			throw new AppError(
				`Mailbox ${body.mailbox.address} is not on ${zone}.`,
				"mailbox_outside_zone",
				400,
			);
		}

		const result = await provisionSendingDomain(c.env, c.env.INDEX_DB, {
			zone,
			sendingDomain,
			dmarc: body.dmarc,
			inbound: body.inbound,
			// Account-scoped, so it needs its own configuration rather than riding on
			// the zone token. Unset simply omits the step instead of failing the run.
			feedbackQueueId: c.env.FEEDBACK_QUEUE_ID?.trim() || undefined,
			mailbox: body.mailbox,
		});

		return c.json(result);
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

	api.patch("/api/aliases/:aliasAddress", async (c) => {
		const body = updateAliasSchema.parse(await c.req.json());
		const aliasAddress = c.req.param("aliasAddress").trim().toLowerCase();
		const updated = await updateAlias(c.env.INDEX_DB, aliasAddress, { status: body.status });
		if (!updated) {
			throw new AppError("Alias not found", "alias_not_found", 404);
		}
		return c.json({ alias: await getAlias(c.env.INDEX_DB, aliasAddress) });
	});

	// Hard delete, unlike mailboxes and domains. alias_address is the primary key, so a disabled
	// row would keep the address claimed forever and block re-pointing it at another mailbox —
	// which is the usual reason for removing an alias in the first place. Nothing references the
	// row, and the mail it used to route falls back to the domain's routing rules.
	api.delete("/api/aliases/:aliasAddress", async (c) => {
		const aliasAddress = c.req.param("aliasAddress").trim().toLowerCase();
		const deleted = await deleteAlias(c.env.INDEX_DB, aliasAddress);
		if (!deleted) {
			throw new AppError("Alias not found", "alias_not_found", 404);
		}
		return c.json({ aliasAddress, deleted: "hard" });
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

	api.patch("/api/routing-rules/:ruleId", async (c) => {
		const body = updateRoutingRuleSchema.parse(await c.req.json());
		const ruleId = c.req.param("ruleId");
		const existing = await getRoutingRule(c.env.INDEX_DB, ruleId);
		if (!existing) {
			throw new AppError("Routing rule not found", "routing_rule_not_found", 404);
		}
		// Validate the rule as it will be *after* the patch, not the fields the patch carries: a
		// PATCH that only flips `action` to "store" can strand a rule with no mailbox just as easily
		// as a bad POST can, and such a rule silently never routes.
		const action = body.action ?? existing.action;
		const mailboxId = body.mailboxId !== undefined ? body.mailboxId : existing.mailbox_id;
		const forwardTo = body.forwardTo ?? (JSON.parse(existing.forward_to_json) as string[]);
		if (action === "store") {
			if (!mailboxId) {
				throw new AppError("Store routing rules require mailboxId", "mailbox_id_required", 400);
			}
			if (!(await getMailbox(c.env.INDEX_DB, mailboxId))) {
				throw new AppError("Mailbox not found", "mailbox_not_found", 400);
			}
		}
		if (action === "forward" && forwardTo.length === 0) {
			throw new AppError(
				"Forward routing rules require at least one destination",
				"forward_to_required",
				400,
			);
		}
		await updateRoutingRule(c.env.INDEX_DB, ruleId, {
			pattern: body.pattern,
			priority: body.priority,
			action: body.action,
			mailbox_id: body.mailboxId,
			forward_to_json: body.forwardTo === undefined ? undefined : JSON.stringify(body.forwardTo),
			reject_reason: body.rejectReason,
			enabled: body.enabled === undefined ? undefined : body.enabled ? 1 : 0,
		});
		return c.json({ rule: await getRoutingRule(c.env.INDEX_DB, ruleId) });
	});

	// Hard delete: a routing rule is pure configuration. No row references it and no stored data is
	// keyed by it, so there is nothing to orphan — and leaving disabled rules behind would just
	// accumulate dead precedence entries in resolveRoutingForRecipient's priority scan.
	api.delete("/api/routing-rules/:ruleId", async (c) => {
		const ruleId = c.req.param("ruleId");
		const deleted = await deleteRoutingRule(c.env.INDEX_DB, ruleId);
		if (!deleted) {
			throw new AppError("Routing rule not found", "routing_rule_not_found", 404);
		}
		return c.json({ id: ruleId, deleted: "hard" });
	});

	registerMailboxRoutes(api);
	registerMailboxSuppressionRoutes(api);
	registerAdminRoutes(api);

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
