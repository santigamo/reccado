import type { AuthContext } from "../api/auth";
import { checkTemplateLinks, normalizeLinkDomains, type LinkCheck } from "./template-links";

/**
 * Kinds a delegated MCP client may ever apply without a human approval. This is a hard
 * ceiling: a client's policy can only narrow it. Sends, API key create/rotate/scopes,
 * domains, aliases, routing rules and mailbox kinds are deliberately absent.
 */
export const AUTO_ELIGIBLE = [
	"template_upsert",
	"template_archive",
	"api_key_templates",
	"api_key_revoke",
	"suppression_remove",
	"restore",
] as const;
export type AutoKind = (typeof AUTO_ELIGIBLE)[number];

export type McpClientPolicy = {
	clientId: string;
	ownerEmail: string;
	mailboxIds: string[];
	autoKinds: AutoKind[];
	linkDomains: string[];
	allowVariableLinks: boolean;
	maxAutoPerHour: number;
	createdAt: string;
	updatedAt: string;
};

export const DEFAULT_MAX_AUTO_PER_HOUR = 20;
const CLIENT_ID = /^[A-Za-z0-9._~-]{1,256}$/;
const MAILBOX_ID = /^[A-Za-z0-9_-]{1,100}$/;

type Row = {
	client_id: string;
	owner_email: string;
	mailbox_ids_json: string;
	auto_kinds_json: string;
	link_domains_json: string;
	allow_variable_links: number;
	max_auto_per_hour: number;
	created_at: string;
	updated_at: string;
};
const strings = (json: string): string[] => {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
	} catch {
		return [];
	}
};
function fromRow(row: Row): McpClientPolicy {
	return {
		clientId: row.client_id,
		ownerEmail: row.owner_email,
		mailboxIds: strings(row.mailbox_ids_json),
		// Re-intersect with the ceiling on every read: a stored value outside it is ignored.
		autoKinds: strings(row.auto_kinds_json).filter((k): k is AutoKind => (AUTO_ELIGIBLE as readonly string[]).includes(k)),
		linkDomains: strings(row.link_domains_json),
		allowVariableLinks: row.allow_variable_links === 1,
		maxAutoPerHour: row.max_auto_per_hour,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export type PolicyInput = {
	clientId: string;
	mailboxIds: string[];
	autoKinds: string[];
	linkDomains: string[];
	allowVariableLinks?: boolean;
	maxAutoPerHour?: number;
};
export class PolicyError extends Error {}

/** Validates operator input; throws PolicyError with a message fit for the CLI. */
export function parsePolicyInput(input: PolicyInput): Required<PolicyInput> {
	if (!CLIENT_ID.test(input.clientId)) throw new PolicyError("client_id must be 1-256 characters from letters, digits, and . _ ~ -");
	const mailboxIds = [...new Set(input.mailboxIds)];
	if (!mailboxIds.length || mailboxIds.length > 50 || mailboxIds.some((id) => !MAILBOX_ID.test(id)))
		throw new PolicyError("mailboxIds must list 1-50 mailbox ids");
	const autoKinds = [...new Set(input.autoKinds)];
	const unknown = autoKinds.filter((k) => !(AUTO_ELIGIBLE as readonly string[]).includes(k));
	if (!autoKinds.length || unknown.length)
		throw new PolicyError(`kinds must be a non-empty subset of: ${AUTO_ELIGIBLE.join(", ")}${unknown.length ? ` (got ${unknown.join(", ")})` : ""}`);
	let linkDomains: string[];
	try {
		linkDomains = normalizeLinkDomains(input.linkDomains);
	} catch (error) {
		throw new PolicyError(error instanceof Error ? error.message : "invalid link domain");
	}
	const max = input.maxAutoPerHour ?? DEFAULT_MAX_AUTO_PER_HOUR;
	if (!Number.isInteger(max) || max < 1 || max > 1000) throw new PolicyError("max-per-hour must be an integer from 1 to 1000");
	return { clientId: input.clientId, mailboxIds, autoKinds, linkDomains, allowVariableLinks: input.allowVariableLinks === true, maxAutoPerHour: max };
}

export async function getClientPolicy(db: D1Database, clientId: string): Promise<McpClientPolicy | null> {
	const row = await db.prepare("SELECT * FROM mcp_client_policies WHERE client_id = ?").bind(clientId).first<Row>();
	return row ? fromRow(row) : null;
}
export async function listClientPolicies(db: D1Database, ownerEmail: string): Promise<McpClientPolicy[]> {
	const rows = await db
		.prepare("SELECT * FROM mcp_client_policies WHERE owner_email = ? ORDER BY client_id")
		.bind(ownerEmail.trim().toLowerCase())
		.all<Row>();
	return (rows.results ?? []).map(fromRow);
}
export async function upsertClientPolicy(db: D1Database, ownerEmail: string, input: PolicyInput): Promise<McpClientPolicy> {
	const p = parsePolicyInput(input);
	const now = new Date().toISOString();
	const owner = ownerEmail.trim().toLowerCase();
	const existing = await db.prepare("SELECT owner_email FROM mcp_client_policies WHERE client_id = ?").bind(p.clientId).first<{ owner_email: string }>();
	if (existing && existing.owner_email !== owner) throw new PolicyError("policy belongs to another owner");
	await db
		.prepare(
			`INSERT INTO mcp_client_policies (client_id, owner_email, mailbox_ids_json, auto_kinds_json, link_domains_json, allow_variable_links, max_auto_per_hour, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(client_id) DO UPDATE SET mailbox_ids_json = excluded.mailbox_ids_json, auto_kinds_json = excluded.auto_kinds_json,
			   link_domains_json = excluded.link_domains_json, allow_variable_links = excluded.allow_variable_links,
			   max_auto_per_hour = excluded.max_auto_per_hour, updated_at = excluded.updated_at`,
		)
		.bind(p.clientId, owner, JSON.stringify(p.mailboxIds), JSON.stringify(p.autoKinds), JSON.stringify(p.linkDomains), p.allowVariableLinks ? 1 : 0, p.maxAutoPerHour, now, now)
		.run();
	return (await getClientPolicy(db, p.clientId))!;
}
export async function deleteClientPolicy(db: D1Database, ownerEmail: string, clientId: string): Promise<boolean> {
	const result = await db
		.prepare("DELETE FROM mcp_client_policies WHERE client_id = ? AND owner_email = ?")
		.bind(clientId, ownerEmail.trim().toLowerCase())
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export type AutoPrincipal = {
	oauthClientId?: string | null;
	scopes?: ReadonlySet<string>;
};
/** `refused` is set only when a policy exists and the check failed; silent fallbacks leave it undefined. */
export type AutoDecision =
	| { auto: true; policy: McpClientPolicy; variableLinks: string[] }
	| { auto: false; refused?: string };

/** A token that can read mail never auto-applies: mail content is a prompt-injection channel. */
export function isDelegatedToken(scopes: ReadonlySet<string> | undefined): boolean {
	return Boolean(scopes?.has("admin")) && !scopes!.has("mail:read") && !scopes!.has("mail:read:sensitive");
}

const refuse = (reason: string): AutoDecision => ({ auto: false, refused: reason });
const mailboxOf = (item: Record<string, unknown>): string | null => (typeof item.mailboxId === "string" ? item.mailboxId : null);

async function restoreTarget(db: D1Database, opsEventId: string): Promise<{ entity?: string; mailboxId?: string } | null> {
	const row = await db
		.prepare("SELECT payload_json FROM ops_events WHERE id = ? AND event_type = 'admin.before_snapshot'")
		.bind(opsEventId)
		.first<{ payload_json: string }>();
	if (!row) return null;
	try {
		const snap = JSON.parse(row.payload_json) as Record<string, unknown>;
		return { entity: typeof snap.entity === "string" ? snap.entity : undefined, mailboxId: typeof snap.mailboxId === "string" ? snap.mailboxId : undefined };
	} catch {
		return null;
	}
}

export async function recentAutoApplied(db: D1Database, clientId: string, sinceMs = 3_600_000): Promise<number> {
	const row = await db
		.prepare("SELECT COUNT(*) AS n FROM ops_events WHERE event_type = 'admin.auto_applied' AND subject = ? AND created_at > ?")
		.bind(clientId, new Date(Date.now() - sinceMs).toISOString())
		.first<{ n: number }>();
	return row?.n ?? 0;
}

/**
 * Decides whether a whole batch may be applied without approval. Any item that fails a check
 * sends the entire batch to the normal approval flow.
 */
export async function evaluateAutoApply(
	env: Env,
	auth: AuthContext,
	principal: AutoPrincipal,
	kind: string,
	items: Array<Record<string, unknown>>,
): Promise<AutoDecision> {
	if (!principal.oauthClientId || !isDelegatedToken(principal.scopes)) return { auto: false };
	let policy: McpClientPolicy | null;
	try {
		policy = await getClientPolicy(env.INDEX_DB, principal.oauthClientId);
	} catch {
		return { auto: false };
	}
	if (!policy) return { auto: false };
	if (policy.ownerEmail.trim().toLowerCase() !== auth.email.trim().toLowerCase()) return refuse("policy belongs to another owner");
	if (!(AUTO_ELIGIBLE as readonly string[]).includes(kind)) return refuse(`kind ${kind} is never auto-applied`);
	if (!(policy.autoKinds as string[]).includes(kind)) return refuse(`kind ${kind} is not in this client's policy`);
	const links: string[] = [];
	for (const item of items) {
		if (kind === "restore") {
			const target = await restoreTarget(env.INDEX_DB, String(item.opsEventId));
			if (!target || target.entity !== "template" || !target.mailboxId || !policy.mailboxIds.includes(target.mailboxId))
				return refuse("snapshot is not one this policy could have produced");
			continue;
		}
		const mailbox = mailboxOf(item);
		if (!mailbox || !policy.mailboxIds.includes(mailbox)) return refuse(`mailbox ${mailbox ?? "(none)"} is not in this client's policy`);
		if (kind === "template_upsert") {
			const body = (item.body ?? {}) as { body_html?: string | null; body_text?: string | null };
			const check: LinkCheck = checkTemplateLinks({ bodyHtml: body.body_html, bodyText: body.body_text }, { linkDomains: policy.linkDomains, allowVariableLinks: policy.allowVariableLinks });
			if (!check.ok) return refuse(check.reason);
			links.push(...check.variableLinks);
		}
	}
	const used = await recentAutoApplied(env.INDEX_DB, policy.clientId).catch(() => 0);
	if (used + items.length > policy.maxAutoPerHour) return refuse(`hourly auto-apply limit reached (${policy.maxAutoPerHour})`);
	return { auto: true, policy, variableLinks: [...new Set(links)] };
}
