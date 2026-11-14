import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getApproval, insertOpsEvent } from "../db/d1";
import { requestControlPlaneChange } from "../lib/control-plane-intents";
import { notifyIntentCreated } from "../telegram/notify";
import { mcpToolError, mcpToolResultJson } from "./errors";
import { intentResponse, resolveIntentRetry, type IntentFlow } from "./intent-flow";
import { assertScope } from "./scopes";
import type { McpSendAuth } from "./types";

const RATE_LIMIT = 10;
const rates = new Map<string, number>();
const SECRET_KEY = /secret|token|plaintext/i;

type Action = { kind: string; schema: z.ZodType<Record<string, unknown>> };
const obj = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
const mailboxId = z.string().min(1);
const body = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

// Field names mirror the src/lib/admin/* service inputs; the server-side kind `validate` stays the authority.
const TOOLS: Record<string, { description: string; actions: Record<string, Action> }> = {
	manage_mailbox: {
		description: "Create, update or disable a mailbox. Applied immediately; every change keeps a before-snapshot you can undo with `restore`.",
		actions: {
			create: { kind: "mailbox_create", schema: obj({ primaryAddress: z.string().min(3), displayName: z.string().optional() }) },
			update: { kind: "mailbox_update", schema: obj({ mailboxId, body: body({ displayName: z.string().nullable().optional(), status: z.literal("active").optional() }) }) },
			disable: { kind: "mailbox_disable", schema: obj({ mailboxId }) },
		},
	},
	manage_domain: {
		description: "Add, provision, update or disable a domain. update applies immediately (undoable with `restore`); add, provision and disable need the owner's approval on the web approval page.",
		actions: {
			add: { kind: "domain_add", schema: obj({ domain: z.string().min(3), zoneId: z.string().min(1) }) },
			provision: { kind: "domain_provision", schema: obj({ domain: z.string().min(3), body: body({
				subdomain: z.string().optional(),
				dmarc: body({ policy: z.enum(["none", "quarantine", "reject"]), alignment: z.enum(["relaxed", "strict"]).optional(), rua: z.string().optional() }),
				inbound: z.boolean().optional(),
				mailbox: body({ address: z.string(), displayName: z.string().optional(), ownerEmail: z.string().optional() }).optional(),
			}) }) },
			update: { kind: "domain_update", schema: obj({ domain: z.string().min(3), body: body({ status: z.enum(["pending", "active", "disabled"]) }) }) },
			disable: { kind: "domain_disable", schema: obj({ domain: z.string().min(3) }) },
		},
	},
	manage_routing: {
		description: "Add/remove aliases and upsert/remove routing rules. Applied immediately, except a forward rule whose destination is outside the owner's domains, which needs the owner's approval on the web approval page.",
		actions: {
			alias_add: { kind: "alias_add", schema: obj({ aliasAddress: z.string().min(3), mailboxId }) },
			alias_remove: { kind: "alias_remove", schema: obj({ aliasAddress: z.string().min(3) }) },
			rule_upsert: { kind: "routing_rule_upsert", schema: obj({
				ruleId: z.string().min(1).optional(),
				domainId: z.string().min(1).optional(),
				pattern: z.string().min(1).optional(),
				priority: z.number().int().min(0).optional(),
				ruleAction: z.enum(["store", "forward", "reject"]).optional(),
				mailboxId: z.string().min(1).nullable().optional(),
				forwardTo: z.array(z.string()).optional(),
				rejectReason: z.string().nullable().optional(),
				enabled: z.boolean().optional(),
			}) },
			rule_remove: { kind: "routing_rule_remove", schema: obj({ ruleId: z.string().min(1) }) },
		},
	},
	manage_template: {
		description: "Upsert or archive a transactional template. Applied immediately; every change keeps a before-snapshot you can undo with `restore`.",
		actions: {
			upsert: { kind: "template_upsert", schema: obj({ mailboxId, templateId: z.string().min(1), body: body({ subject: z.string().min(1), body_text: z.string().nullable().optional(), body_html: z.string().nullable().optional() }) }) },
			archive: { kind: "template_archive", schema: obj({ mailboxId, templateId: z.string().min(1) }) },
		},
	},
	manage_api_key: {
		description: "Create, rotate, revoke, change the scopes of (scopes: issues a replacement key) or edit the template allowlist of (templates: in place, no new secret) a transactional API key. revoke and templates apply immediately. create, rotate and scopes issue a secret, so they need the owner's approval on the web approval page; the secret is shown only there and is never returned here.",
		actions: {
			create: { kind: "api_key_create", schema: obj({ mailboxId, body: body({
				environment: z.enum(["test", "live"]),
				sender: z.string(),
				senderName: z.string().nullable().optional(),
				scopes: z.array(z.string()).min(1),
				templateAllowlist: z.array(z.string()).optional(),
				recipientPolicy: z.string().optional(),
				quotaMax: z.number().int().positive().optional(),
				expiresAt: z.string().optional(),
			}) }) },
			rotate: { kind: "api_key_rotate", schema: obj({ mailboxId, keyId: z.string().min(1) }) },
			revoke: { kind: "api_key_revoke", schema: obj({ mailboxId, keyId: z.string().min(1) }) },
			scopes: { kind: "api_key_scopes", schema: obj({ mailboxId, keyId: z.string().min(1), scopes: z.array(z.string()).min(1), templateAllowlist: z.array(z.string()).optional() }) },
			templates: { kind: "api_key_templates", schema: obj({ mailboxId, keyId: z.string().min(1), add: z.array(z.string()).optional(), remove: z.array(z.string()).optional(), set: z.array(z.string()).optional() }) },
		},
	},
};

const ANNOTATIONS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const ERRORS = /^(insufficient_scope: admin|rate_limited|too_many_pending_approvals|not_found|invalid_request_state|intent_stale|validation_error|tool_unavailable|invalid_origin)/;

/** Drop anything that looks like a secret before the agent sees it. */
export function stripSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSecrets);
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, stripSecrets(v)]));
	return value;
}

class ToolFailure extends Error {}

/** Per-minute buckets are keyed by the minute; drop the ones that can no longer be hit. */
function pruneRates(map: Map<string, number>): void {
	const current = String(Math.floor(Date.now() / 60000));
	for (const key of map.keys()) if (!key.endsWith(`:${current}`)) map.delete(key);
}

type Resolved = { kind: string; payload: unknown };

function resolveOp(tool: string, params: Record<string, unknown>): Resolved {
	const def = TOOLS[tool];
	if (!def) throw new ToolFailure("tool_unavailable");
	const { action, intentId: _intentId, ...rest } = params;
	const entry = typeof action === "string" ? def.actions[action] : undefined;
	if (!entry) throw new ToolFailure("validation_error: unknown action");
	const cleaned = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
	const parsed = entry.schema.safeParse(cleaned);
	if (!parsed.success) throw new ToolFailure(`validation_error: ${parsed.error.issues[0]?.path.join(".") || "input"}`);
	const out = { ...parsed.data };
	// Routing rules name their effect `ruleAction` here to avoid clashing with the tool's `action`.
	if ("ruleAction" in out) { out.action = out.ruleAction; delete out.ruleAction; }
	return { kind: entry.kind, payload: out };
}

async function runIntent(env: Env, auth: McpSendAuth, origin: string, flow: IntentFlow | undefined, ctx: ServerContext | undefined, tool: string, params: Record<string, unknown>, resolve: () => Resolved, kinds: string[], audit: { intentId?: string }) {
	assertScope(auth, "admin");
	const key = `${auth.email}:${tool}:${Math.floor(Date.now() / 60000)}`;
	const count = rates.get(key) ?? 0;
	if (count >= RATE_LIMIT) throw new Error("rate_limited");
	rates.set(key, count + 1);
	pruneRates(rates);
	const retry = ctx ? resolveIntentRetry(ctx) : undefined;
	const given = typeof params.intentId === "string" ? params.intentId : undefined;
	if (retry && given && retry !== given) throw new Error("invalid_request_state");
	const existing = retry ?? given;
	const message = `Revisa y aprueba el cambio en ${new URL(origin).host}`;
	const transform = (status: Record<string, unknown>) => stripSecrets(status) as Record<string, unknown>;
	if (existing) {
		audit.intentId = existing;
		const row = await getApproval(env.INDEX_DB, existing);
		if (!row || row.origin !== "mcp" || !kinds.includes(row.kind)) throw new Error("not_found");
		// Only the principal that created an intent may read its status/result.
		if ((row.token_sub ?? null) !== (auth.tokenSub ?? null)) throw new Error("not_found");
		return intentResponse(env, retry ? flow : undefined, retry ? ctx : undefined, { intentId: existing, expiresAt: row.expires_at, origin, message, transform });
	}
	const { kind, payload } = resolve();
	let created: Awaited<ReturnType<typeof requestControlPlaneChange>>;
	try {
		created = await requestControlPlaneChange(env, auth, kind, payload, { oauthClientId: auth.oauthClientId, tokenSub: auth.tokenSub, tokenJti: auth.tokenJti, scopes: auth.scopes });
	} catch (error) {
		if (error instanceof Error && error.message === "invalid_intent_kind") throw new ToolFailure("tool_unavailable");
		const code = (error as { code?: unknown }).code;
		if (code === "validation_error") throw new ToolFailure("validation_error");
		throw error;
	}
	audit.intentId = created.id;
	if (created.applied) {
		// Direct change: already executed as the owner; secrets were stripped by the kind's `redact`.
		const { status, result, errorCode, snapshotIds } = created.applied;
		return mcpToolResultJson(transform(status === "applied" ? { status, result, snapshotIds } : { status, error: errorCode, snapshotIds }));
	}
	await notifyIntentCreated(env, created.id).catch(() => undefined);
	return intentResponse(env, flow, ctx, { intentId: created.id, expiresAt: created.expiresAt, origin, message, transform });
}

function register(server: McpServer, env: Env, auth: McpSendAuth, origin: string, flow: IntentFlow | undefined, tool: string, description: string, kinds: string[], opSchema: z.ZodType, resolve: (params: Record<string, unknown>) => Resolved) {
	server.registerTool(tool, {
		description: `${description} One change per call. A direct change returns {status:"applied", result, snapshotIds} (undo with the restore tool). A change that needs owner approval returns a pending approval with a web URL (the owner approves only on that page; Telegram just notifies); re-call with intentId to check its status/result.`,
		inputSchema: opSchema as z.ZodObject,
		outputSchema: z.record(z.string(), z.unknown()),
		annotations: ANNOTATIONS,
	}, async (params: Record<string, unknown>, ctx?: ServerContext) => {
		const start = Date.now();
		const audit: { intentId?: string } = {};
		let reason: string | undefined;
		try {
			return await runIntent(env, auth, origin, flow, ctx, tool, params, () => resolve(params), kinds, audit);
		} catch (error) {
			const message = error instanceof Error ? error.message : "internal_error";
			reason = ERRORS.test(message) ? message : "internal_error";
			return mcpToolError(reason);
		} finally {
			await insertOpsEvent(env.INDEX_DB, { id: crypto.randomUUID(), event_type: "mcp.tool_call", severity: reason ? "warning" : "info", subject: auth.email, payload_json: JSON.stringify({ tool, scope: "admin", intent_id: audit.intentId ?? null, denied: Boolean(reason), reason: reason ?? null, latency_ms: Date.now() - start }) }).catch(() => undefined);
		}
	});
}

export function registerAdminTools(server: McpServer, env: Env, auth: McpSendAuth, origin: string, flow?: IntentFlow) {
	for (const [tool, def] of Object.entries(TOOLS)) {
		const kinds = Object.values(def.actions).map((a) => a.kind);
		const actions = Object.keys(def.actions);
		const schema = z.looseObject({
			action: z.enum(actions as [string, ...string[]]).optional().describe(`One of: ${actions.join(", ")}`),
			intentId: z.string().min(1).optional(),
		});
		register(server, env, auth, origin, flow, tool, def.description, kinds, schema, (params) => resolveOp(tool, params));
	}
	const single = (tool: string, description: string, kind: string, shape: z.ZodRawShape) =>
		register(server, env, auth, origin, flow, tool, description, [kind], z.object({ ...shape, intentId: z.string().min(1).optional() }), (params) => {
			const { intentId: _i, ...rest } = params;
			const parsed = z.strictObject(shape).safeParse(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
			if (!parsed.success) throw new ToolFailure(`validation_error: ${parsed.error.issues[0]?.path.join(".") || "input"}`);
			return { kind, payload: parsed.data };
		});
	single("remove_suppression", "Remove an address from a mailbox's suppression list. Needs the owner's approval on the web approval page.", "suppression_remove", { mailboxId, body: body({ email: z.string().min(3), allowProviderRemoval: z.boolean().optional() }) });
	single("restore", "Restore a previous admin change from a snapshotId (an ops event id). Applied immediately, except restoring a forward rule to a destination outside the owner's domains, which needs the owner's approval.", "restore", { opsEventId: z.string().min(1) });
	single("reconcile_stale", "Reconcile stale transactional send requests (marks them for manual review). Applied immediately.", "transactional_reconcile", {});
}
