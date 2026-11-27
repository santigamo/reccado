import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getApproval, insertOpsEvent } from "../db/d1";
import { requestControlPlaneChange } from "../lib/control-plane-intents";
import { ControlPlaneRefusal } from "../lib/control-plane-registry";
import { AdminValidationError } from "../lib/admin/errors";
import { RESTORE_SCOPES, TOOL_SCOPES } from "../lib/mcp-scopes";
import { notifyIntentCreated } from "../telegram/notify";
import { mcpToolError, mcpToolResultJson } from "./errors";
import { type IntentFlow, intentResponse, resolveIntentRetry } from "./intent-flow";
import { assertScope, scopeFilteredServer } from "./scopes";
import { fetchTemplateSource } from "./template-source";
import type { McpSendAuth } from "./types";

const RATE_LIMIT = 10;
const rates = new Map<string, number>();
const SECRET_KEY = /secret|token|plaintext/i;

type Action = {
	kind: string;
	schema: z.ZodType<Record<string, unknown>>;
	/** Turns the parsed fields into the kind's payload (e.g. fetches a template sync's source). */
	prepare?: (fields: Record<string, unknown>, origin: string) => Promise<Record<string, unknown>>;
};
const obj = <T extends z.ZodRawShape>(shape: T) =>
	z.strictObject(shape) as unknown as z.ZodType<Record<string, unknown>>;
const mailboxId = z.string().min(1);

/**
 * Some MCP clients send an object or array argument as its JSON text. Accept that text and parse
 * it before validating; the published JSON Schema still shows the real object/array type.
 */
function parseJsonText(value: unknown): unknown {
	if (typeof value !== "string") return value;
	const text = value.trim();
	if (!(text.startsWith("{") || text.startsWith("["))) return value;
	try {
		return JSON.parse(text);
	} catch {
		return value;
	}
}
const body = <T extends z.ZodRawShape>(shape: T) =>
	z.preprocess(parseJsonText, z.strictObject(shape));
const list = <T extends z.ZodType>(item: T, min = 0) =>
	z.preprocess(parseJsonText, z.array(item).min(min));

// Field names mirror the src/lib/admin/* service inputs; the server-side kind `validate` stays the authority.
const TOOLS: Record<
	string,
	{ description: string; actions: Record<string, Action>; perCall?: string }
> = {
	manage_mailbox: {
		description:
			"Create, update or disable a mailbox. Applied immediately; every change keeps a before-snapshot you can undo with `restore`.",
		actions: {
			create: {
				kind: "mailbox_create",
				schema: obj({ primaryAddress: z.string().min(3), displayName: z.string().optional() }),
			},
			update: {
				kind: "mailbox_update",
				schema: obj({
					mailboxId,
					body: body({
						displayName: z.string().nullable().optional(),
						status: z.literal("active").optional(),
					}),
				}),
			},
			disable: { kind: "mailbox_disable", schema: obj({ mailboxId }) },
		},
	},
	manage_domain: {
		description:
			"Add, provision, update or disable a domain. update applies immediately (undoable with `restore`); add, provision and disable need the owner's approval on the web approval page.",
		actions: {
			add: {
				kind: "domain_add",
				schema: obj({ domain: z.string().min(3), zoneId: z.string().min(1) }),
			},
			provision: {
				kind: "domain_provision",
				schema: obj({
					domain: z.string().min(3),
					body: body({
						subdomain: z.string().optional(),
						dmarc: body({
							policy: z.enum(["none", "quarantine", "reject"]),
							alignment: z.enum(["relaxed", "strict"]).optional(),
							rua: z.string().optional(),
						}),
						inbound: z.boolean().optional(),
						mailbox: body({
							address: z.string(),
							displayName: z.string().optional(),
							ownerEmail: z.string().optional(),
						}).optional(),
					}),
				}),
			},
			update: {
				kind: "domain_update",
				schema: obj({
					domain: z.string().min(3),
					body: body({ status: z.enum(["pending", "active", "disabled"]) }),
				}),
			},
			disable: { kind: "domain_disable", schema: obj({ domain: z.string().min(3) }) },
		},
	},
	manage_routing: {
		description:
			"Add/remove aliases, upsert/remove routing rules, and ask Cloudflare to deliver an address to this Reccado (route_address). Alias and rule changes apply immediately, except a forward rule whose destination is outside the owner's domains. route_address always needs the owner's approval on the web approval page: it creates one Cloudflare Email Routing rule for an existing active mailbox/alias address and never changes or deletes an existing rule; after approval the status result says created, already routed, or why it was refused (detail.reason/message/remedy).",
		actions: {
			alias_add: { kind: "alias_add", schema: obj({ aliasAddress: z.string().min(3), mailboxId }) },
			alias_remove: { kind: "alias_remove", schema: obj({ aliasAddress: z.string().min(3) }) },
			rule_upsert: {
				kind: "routing_rule_upsert",
				schema: obj({
					ruleId: z.string().min(1).optional(),
					domainId: z.string().min(1).optional(),
					pattern: z.string().min(1).optional(),
					priority: z.number().int().min(0).optional(),
					ruleAction: z.enum(["store", "forward", "reject"]).optional(),
					mailboxId: z.string().min(1).nullable().optional(),
					forwardTo: list(z.string()).optional(),
					rejectReason: z.string().nullable().optional(),
					enabled: z.boolean().optional(),
				}),
			},
			rule_remove: { kind: "routing_rule_remove", schema: obj({ ruleId: z.string().min(1) }) },
			route_address: {
				kind: "address_route",
				schema: obj({ domain: z.string().min(3), address: z.string().min(3) }),
			},
		},
	},
	manage_template: {
		description: [
			"Upsert, archive or sync transactional templates. Applied immediately; every change keeps a before-snapshot you can undo with `restore`.",
			'sync loads many templates in one atomic call (all or nothing, at most 100): give `mailboxId` and either `templates` (items {id, subject, body_text?, body_html?}) or `source` {url, sha256?}, an https URL of a JSON document `{"templates":[...]}` (or a bare array of the same items) that the server fetches itself, so you do not have to repeat the bodies here (2 MB max; no credentials are sent; pass sha256 of the file to pin its exact bytes).',
			"Listed ids are created when new, updated when different, reported unchanged when identical; an archived id is reported and left alone; templates not listed are never touched. The result reports each id's outcome and sha256, so no read-back is needed. One `restore` of the sync's snapshot undoes all of it (previous content back; templates it created are deleted, or archived if already used to send).",
			'Template sha256 = SHA-256 hex of the UTF-8 compact JSON array [subject, body_text, body_html] (absent body = null, non-ASCII unescaped: JS JSON.stringify, Python json.dumps(..., separators=(",", ":"), ensure_ascii=False)); list_config with templates:"summary" shows the same hash per template.',
		].join(" "),
		perCall:
			"One change per call, except `sync`, which applies one whole set of templates atomically.",
		actions: {
			upsert: {
				kind: "template_upsert",
				schema: obj({
					mailboxId,
					templateId: z.string().min(1),
					body: body({
						subject: z.string().min(1),
						body_text: z.string().nullable().optional(),
						body_html: z.string().nullable().optional(),
					}),
				}),
			},
			archive: {
				kind: "template_archive",
				schema: obj({ mailboxId, templateId: z.string().min(1) }),
			},
			sync: {
				kind: "template_sync",
				schema: obj({
					mailboxId,
					templates: list(
						body({
							id: z.string().min(1),
							subject: z.string().min(1),
							body_text: z.string().nullable().optional(),
							body_html: z.string().nullable().optional(),
						}),
						1,
					)
						.describe("Templates to sync (give this or `source`).")
						.optional(),
					source: body({
						url: z.string().min(1),
						sha256: z
							.string()
							.regex(/^[0-9a-fA-F]{64}$/)
							.optional(),
					})
						.describe(
							"https URL of a JSON document with the templates, fetched by the server (give this or `templates`); optional sha256 of its exact bytes.",
						)
						.optional(),
				}),
				prepare: async (fields, origin) => {
					const { source, ...rest } = fields as {
						source?: { url: string; sha256?: string };
						templates?: unknown[];
					};
					if ((rest.templates === undefined) === (source === undefined))
						throw new ToolFailure("validation_error: give exactly one of templates or source");
					if (!source) return rest;
					const fetched = await fetchTemplateSource(source.url, {
						ownHost: new URL(origin).hostname.toLowerCase(),
						expectedSha256: source.sha256,
					});
					return { ...rest, templates: fetched.templates, source: fetched.source };
				},
			},
		},
	},
	manage_api_key: {
		description:
			"Create, rotate, revoke, change the scopes of (scopes: issues a replacement key) or edit the template allowlist of (templates: in place, no new secret) a transactional API key. revoke and templates apply immediately. create, rotate and scopes issue a secret, so they need the owner's approval on the web approval page; the secret is shown only there and is never returned here.",
		actions: {
			create: {
				kind: "api_key_create",
				schema: obj({
					mailboxId,
					body: body({
						environment: z.enum(["test", "live"]),
						sender: z.string(),
						senderName: z.string().nullable().optional(),
						scopes: list(z.string(), 1),
						templateAllowlist: list(z.string()).optional(),
						recipientPolicy: z.string().optional(),
						quotaMax: z.number().int().positive().optional(),
						expiresAt: z.string().optional(),
					}),
				}),
			},
			rotate: { kind: "api_key_rotate", schema: obj({ mailboxId, keyId: z.string().min(1) }) },
			revoke: { kind: "api_key_revoke", schema: obj({ mailboxId, keyId: z.string().min(1) }) },
			scopes: {
				kind: "api_key_scopes",
				schema: obj({
					mailboxId,
					keyId: z.string().min(1),
					scopes: list(z.string(), 1),
					templateAllowlist: list(z.string()).optional(),
				}),
			},
			templates: {
				kind: "api_key_templates",
				schema: obj({
					mailboxId,
					keyId: z.string().min(1),
					add: list(z.string()).optional(),
					remove: list(z.string()).optional(),
					set: list(z.string()).optional(),
				}),
			},
		},
	},
};

const ANNOTATIONS = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: false,
	openWorldHint: false,
} as const;
const ERRORS =
	/^(insufficient_scope: [a-z:]+|refused: [a-z_]+|rate_limited|too_many_pending_approvals|not_found|invalid_request_state|intent_stale|validation_error|tool_unavailable|invalid_origin)/;

/** Drop anything that looks like a secret before the agent sees it. */
export function stripSecrets(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripSecrets);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([k]) => !SECRET_KEY.test(k))
				.map(([k, v]) => [k, stripSecrets(v)]),
		);
	return value;
}

class ToolFailure extends Error {}

/** Per-minute buckets are keyed by the minute; drop the ones that can no longer be hit. */
function pruneRates(map: Map<string, number>): void {
	const current = String(Math.floor(Date.now() / 60000));
	for (const key of map.keys()) if (!key.endsWith(`:${current}`)) map.delete(key);
}

type Resolved = { kind: string; payload: unknown };

/** `validation_error: <path>: <message>` for the first issue (no path: just the message). */
export function validationText(issue?: { path: PropertyKey[]; message: string }): string {
	if (!issue) return "validation_error";
	const path = issue.path.map(String).join(".");
	const message = issue.message.replace(/\s+/g, " ").slice(0, 200);
	return `validation_error: ${path ? `${path}: ` : ""}${message}`;
}

async function resolveOp(
	tool: string,
	params: Record<string, unknown>,
	origin: string,
): Promise<Resolved> {
	const def = TOOLS[tool];
	if (!def) throw new ToolFailure("tool_unavailable");
	const { action, intentId: _intentId, ...rest } = params;
	const entry = typeof action === "string" ? def.actions[action] : undefined;
	if (!entry) throw new ToolFailure("validation_error: unknown action");
	const cleaned = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
	const parsed = entry.schema.safeParse(cleaned);
	if (!parsed.success) throw new ToolFailure(validationText(parsed.error.issues[0]));
	const out = entry.prepare ? await entry.prepare(parsed.data, origin) : { ...parsed.data };
	// Routing rules name their effect `ruleAction` here to avoid clashing with the tool's `action`.
	if ("ruleAction" in out) {
		out.action = out.ruleAction;
		delete out.ruleAction;
	}
	return { kind: entry.kind, payload: out };
}

const SNAPSHOT_SCOPES: Record<string, string> = {
	mailbox: "mailboxes:write",
	domain: "domains:write",
	alias: "routing:write",
	routing_rule: "routing:write",
	template: "templates:write",
	template_sync: "templates:write",
};

/** Write scope for the resource a before-snapshot recorded; null when the snapshot is unknown (the kind reports that itself). */
export async function restoreScopeFor(env: Env, opsEventId: string): Promise<string | null> {
	const row = await env.INDEX_DB.prepare(
		"SELECT payload_json FROM ops_events WHERE id = ? AND event_type = 'admin.before_snapshot'",
	)
		.bind(opsEventId)
		.first<{ payload_json: string }>();
	if (!row) return null;
	try {
		const snap = JSON.parse(row.payload_json) as { entity?: string; mailbox_id?: unknown };
		// Snapshots written before `entity` existed are mailbox rows.
		const entity = snap.entity ?? (typeof snap.mailbox_id === "string" ? "mailbox" : undefined);
		return (entity && SNAPSHOT_SCOPES[entity]) || null;
	} catch {
		return null;
	}
}

async function runIntent(
	env: Env,
	auth: McpSendAuth,
	origin: string,
	flow: IntentFlow | undefined,
	ctx: ServerContext | undefined,
	tool: string,
	params: Record<string, unknown>,
	resolve: () => Promise<Resolved>,
	kinds: string[],
	audit: { intentId?: string },
) {
	if (tool === "restore") {
		const held = RESTORE_SCOPES.find((scope) => auth.scopes.has(scope));
		if (!held) assertScope(auth, RESTORE_SCOPES[0]!);
		// The snapshot's own resource decides which write scope is needed.
		if (typeof params.opsEventId === "string") {
			const needed = await restoreScopeFor(env, params.opsEventId);
			if (needed) assertScope(auth, needed);
		}
	} else {
		assertScope(auth, TOOL_SCOPES[tool] ?? "admin");
	}
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
	const transform = (status: Record<string, unknown>) =>
		stripSecrets(status) as Record<string, unknown>;
	if (existing) {
		audit.intentId = existing;
		const row = await getApproval(env.INDEX_DB, existing);
		if (!row || row.origin !== "mcp" || !kinds.includes(row.kind)) throw new Error("not_found");
		// Only the principal that created an intent may read its status/result.
		if ((row.token_sub ?? null) !== (auth.tokenSub ?? null)) throw new Error("not_found");
		return intentResponse(env, retry ? flow : undefined, retry ? ctx : undefined, {
			intentId: existing,
			expiresAt: row.expires_at,
			origin,
			message,
			transform,
		});
	}
	const { kind, payload } = await resolve();
	let created: Awaited<ReturnType<typeof requestControlPlaneChange>>;
	try {
		created = await requestControlPlaneChange(env, auth, kind, payload, {
			oauthClientId: auth.oauthClientId,
			tokenSub: auth.tokenSub,
			tokenJti: auth.tokenJti,
			scopes: auth.scopes,
		});
	} catch (error) {
		if (error instanceof Error && error.message === "invalid_intent_kind")
			throw new ToolFailure("tool_unavailable");
		// The kind's own validation: name the first issue (e.g. a rule missing its priority).
		if (error instanceof AdminValidationError)
			throw new ToolFailure(validationText(error.firstIssue));
		const code = (error as { code?: unknown }).code;
		if (code === "validation_error")
			throw new ToolFailure(
				error instanceof Error && error.message && error.message !== "Invalid payload"
					? `validation_error: ${error.message}`
					: "validation_error",
			);
		// A kind's reasoned refusal before any approval exists (e.g. an address Reccado does not file).
		if (error instanceof ControlPlaneRefusal) throw new ToolFailure(`refused: ${error.code}`);
		throw error;
	}
	audit.intentId = created.id;
	if (created.applied) {
		// Direct change: already executed as the owner; secrets were stripped by the kind's `redact`.
		const { status, result, errorCode, snapshotIds } = created.applied;
		return mcpToolResultJson(
			transform(
				status === "applied"
					? { status, result, snapshotIds }
					: { status, error: errorCode, snapshotIds },
			),
		);
	}
	await notifyIntentCreated(env, created.id).catch(() => undefined);
	return intentResponse(env, flow, ctx, {
		intentId: created.id,
		expiresAt: created.expiresAt,
		origin,
		message,
		transform,
	});
}

function register(
	server: McpServer,
	env: Env,
	auth: McpSendAuth,
	origin: string,
	flow: IntentFlow | undefined,
	tool: string,
	description: string,
	kinds: string[],
	opSchema: z.ZodType,
	resolve: (params: Record<string, unknown>) => Promise<Resolved>,
	perCall = "One change per call.",
) {
	server.registerTool(
		tool,
		{
			description: `${description} ${perCall} A direct change returns {status:"applied", result, snapshotIds} (undo with the restore tool). A change that needs owner approval returns a pending approval with a web URL (the owner approves only on that page; Telegram just notifies); re-call with intentId to check its status/result.`,
			inputSchema: opSchema as z.ZodObject,
			outputSchema: z.record(z.string(), z.unknown()),
			annotations: ANNOTATIONS,
		},
		async (params: Record<string, unknown>, ctx?: ServerContext) => {
			const start = Date.now();
			const audit: { intentId?: string } = {};
			let reason: string | undefined;
			try {
				return await runIntent(
					env,
					auth,
					origin,
					flow,
					ctx,
					tool,
					params,
					() => resolve(params),
					kinds,
					audit,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : "internal_error";
				reason = ERRORS.test(message) ? message : "internal_error";
				return mcpToolError(reason);
			} finally {
				await insertOpsEvent(env.INDEX_DB, {
					id: crypto.randomUUID(),
					event_type: "mcp.tool_call",
					severity: reason ? "warning" : "info",
					subject: auth.email,
					payload_json: JSON.stringify({
						tool,
						scope:
							tool === "restore"
								? (RESTORE_SCOPES.find((scope) => auth.scopes.has(scope)) ?? RESTORE_SCOPES[0])
								: (TOOL_SCOPES[tool] ?? null),
						intent_id: audit.intentId ?? null,
						denied: Boolean(reason),
						reason: reason ?? null,
						latency_ms: Date.now() - start,
					}),
				}).catch(() => undefined);
			}
		},
	);
}

/**
 * Every action's fields, merged into one advertised shape so a client sees their names and types
 * (an object stays an object instead of turning into text). Each is optional here and says which
 * actions use it; the action's own strict schema in `resolveOp` still decides what is accepted.
 */
export function publishedFields(actions: Record<string, Action>): z.ZodRawShape {
	const byField = new Map<string, Array<{ action: string; schema: z.ZodType }>>();
	for (const [action, entry] of Object.entries(actions)) {
		const shape = (entry.schema as unknown as z.ZodObject).shape;
		for (const [field, schema] of Object.entries(shape)) {
			const uses = byField.get(field) ?? [];
			uses.push({ action, schema: schema as z.ZodType });
			byField.set(field, uses);
		}
	}
	const out: Record<string, z.ZodType> = {};
	for (const [field, uses] of byField) {
		const variants = new Map<string, z.ZodType>();
		for (const { schema } of uses) {
			const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
			variants.set(JSON.stringify(z.toJSONSchema(inner, { io: "input" })), inner);
		}
		const members = [...variants.values()];
		const merged = members.length === 1 ? members[0]! : z.union(members as [z.ZodType, z.ZodType]);
		const names = uses.map((use) => use.action);
		const own = members.map((member) => member.description).find(Boolean);
		const required = uses.filter(({ schema }) => !schema.safeParse(undefined).success);
		const note = required.length
			? ` Required by: ${required.map((use) => use.action).join(", ")}.`
			: "";
		out[field] = merged
			.optional()
			.describe(`${own ? `${own} ` : ""}Used by: ${names.join(", ")}.${note}`);
	}
	return out;
}

export function registerAdminTools(
	rawServer: McpServer,
	env: Env,
	auth: McpSendAuth,
	origin: string,
	flow?: IntentFlow,
) {
	const server = scopeFilteredServer(rawServer, auth);
	for (const [tool, def] of Object.entries(TOOLS)) {
		const kinds = Object.values(def.actions).map((a) => a.kind);
		const actions = Object.keys(def.actions);
		const schema = z.looseObject({
			action: z
				.enum(actions as [string, ...string[]])
				.optional()
				.describe(`One of: ${actions.join(", ")}`),
			intentId: z
				.string()
				.min(1)
				.optional()
				.describe("Only to check a pending approval: the intentId a previous call returned."),
			...publishedFields(def.actions),
		});
		register(
			server,
			env,
			auth,
			origin,
			flow,
			tool,
			def.description,
			kinds,
			schema,
			(params) => resolveOp(tool, params, origin),
			def.perCall,
		);
	}
	const single = (tool: string, description: string, kind: string, shape: z.ZodRawShape) =>
		register(
			server,
			env,
			auth,
			origin,
			flow,
			tool,
			description,
			[kind],
			z.object({ ...shape, intentId: z.string().min(1).optional() }),
			async (params) => {
				const { intentId: _i, ...rest } = params;
				const parsed = z
					.strictObject(shape)
					.safeParse(Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)));
				if (!parsed.success) throw new ToolFailure(validationText(parsed.error.issues[0]));
				return { kind, payload: parsed.data };
			},
		);
	single(
		"remove_suppression",
		"Remove an address from a mailbox's suppression list. Needs the owner's approval on the web approval page.",
		"suppression_remove",
		{
			mailboxId,
			body: body({ email: z.string().min(3), allowProviderRemoval: z.boolean().optional() }),
		},
	);
	single(
		"restore",
		"Restore a previous admin change from a snapshotId (an ops event id). Applied immediately, except restoring a forward rule to a destination outside the owner's domains, which needs the owner's approval.",
		"restore",
		{ opsEventId: z.string().min(1) },
	);
	single(
		"reconcile_stale",
		"Reconcile stale transactional send requests (marks them for manual review). Applied immediately.",
		"transactional_reconcile",
		{},
	);
}
