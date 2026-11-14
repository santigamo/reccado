import type { AuthContext } from "../api/auth";
import { requireMcpOwner, resolveOwnerEmails } from "../api/auth";
import { getMailbox, insertOpsEvent } from "../db/d1";
import { evaluateAutoApply, isDelegatedToken, type McpClientPolicy } from "./mcp-client-policy";
import { requireMailboxOwner } from "./admin/access";
import { AdminError } from "./admin/errors";
import { createMailbox, deleteMailbox, patchMailbox } from "./admin/mailboxes";
import {
	controlPlaneKind,
	operation,
	registerControlPlaneKind,
	show,
	type ControlPlaneKind,
	type Operation,
} from "./control-plane-registry";
import "./control-plane-kinds";

export { controlPlaneKind, registerControlPlaneKind, type ControlPlaneKind };

function mailboxId(payload: Operation): string {
	if (typeof payload.mailboxId !== "string" || !payload.mailboxId)
		throw new AdminError("Invalid mailbox", "validation_error", 400);
	return payload.mailboxId;
}
async function owned(env: Env, auth: AuthContext, payload: Operation) {
	const id = mailboxId(payload);
	await requireMailboxOwner(env, auth, id);
	const mailbox = await getMailbox(env.INDEX_DB, id);
	if (!mailbox) throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return mailbox;
}
async function checkCreateOwner(env: Env, auth: AuthContext, payload: Operation): Promise<void> {
	if (typeof payload.primaryAddress !== "string") return;
	const existing = await env.INDEX_DB.prepare(
		"SELECT mailbox_id FROM mailboxes WHERE primary_address = ?",
	)
		.bind(payload.primaryAddress.trim().toLowerCase())
		.first<{ mailbox_id: string }>();
	if (existing) await requireMailboxOwner(env, auth, existing.mailbox_id);
}

registerControlPlaneKind("mailbox_create", {
	covers: ["primaryAddress", "displayName"],
	validate: (value) => {
		const row = operation(value, ["primaryAddress", "displayName"]);
		if (
			typeof row.primaryAddress !== "string" ||
			(row.displayName !== undefined && typeof row.displayName !== "string")
		)
			throw new AdminError("Invalid payload", "validation_error", 400);
		return row;
	},
	render: async (env, auth, payload) => {
		await checkCreateOwner(env, auth, payload);
		return {
			title: "Crear buzón",
			fields: [
				{ label: "Dirección", value: show(payload.primaryAddress) },
				{ label: "Nombre", value: show(payload.displayName) },
			],
			warnings: [],
		};
	},
	execute: async (env, auth, payload) => {
		await checkCreateOwner(env, auth, payload);
		return createMailbox(env, auth, payload);
	},
});
registerControlPlaneKind("mailbox_update", {
	covers: ["mailboxId", "body.displayName", "body.status"],
	validate: (value) => {
		const row = operation(value, ["mailboxId", "body"]);
		mailboxId(row);
		const body = operation(row.body, ["displayName", "status"]);
		if (body.status !== undefined && body.status !== "active")
			throw new AdminError("Use mailbox_disable", "validation_error", 400);
		if (
			body.displayName !== undefined &&
			body.displayName !== null &&
			typeof body.displayName !== "string"
		)
			throw new AdminError("Invalid payload", "validation_error", 400);
		return row;
	},
	render: async (env, auth, payload) => {
		const before = await owned(env, auth, payload);
		const body = operation(payload.body, ["displayName", "status"]);
		const fields = [{ label: "Buzón", value: before.primary_address }];
		if ("displayName" in body)
			fields.push({
				label: "Nombre",
				value: `${show(before.display_name)} → ${show(body.displayName)}`,
			});
		if ("status" in body)
			fields.push({ label: "Estado", value: `${before.status} → ${show(body.status)}` });
		return {
			title: "Actualizar buzón",
			fields,
			warnings:
				body.status === "disabled"
					? [
							{
								code: "disabled",
								message: "Desactivar el buzón puede impedir la recepción de correo.",
							},
						]
					: [],
		};
	},
	execute: async (env, auth, payload) => {
		await owned(env, auth, payload);
		return patchMailbox(env, auth, { mailboxId: mailboxId(payload), body: payload.body });
	},
});
registerControlPlaneKind("mailbox_disable", {
	covers: ["mailboxId"],
	validate: (value) => {
		const row = operation(value, ["mailboxId"]);
		mailboxId(row);
		return row;
	},
	render: async (env, auth, payload) => {
		const before = await owned(env, auth, payload);
		return {
			title: "Desactivar buzón",
			fields: [
				{ label: "Buzón", value: before.primary_address },
				{ label: "Estado", value: `${before.status} → disabled` },
			],
			warnings: [
				{ code: "disabled", message: "Desactivar el buzón puede impedir la recepción de correo." },
			],
		};
	},
	execute: async (env, auth, payload) => {
		const before = await owned(env, auth, payload);
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "admin.before_snapshot",
			severity: "info",
			subject: before.mailbox_id,
			payload_json: JSON.stringify({ entity: "mailbox", by: auth.email, ...before }),
		});
		return deleteMailbox(env, auth, { mailboxId: before.mailbox_id });
	},
});

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null)
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
			.join(",")}}`;
	throw new Error("invalid_payload");
}
export async function hashPayload(json: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function ownerForUser(env: Env, userId: string): Promise<AuthContext> {
	const user = await env.INDEX_DB.prepare('SELECT email FROM "user" WHERE id = ?')
		.bind(userId)
		.first<{ email: string }>();
	if (!user) throw new AdminError("Forbidden", "forbidden", 403);
	const auth = { userId, email: user.email, owners: await resolveOwnerEmails(env) };
	requireMcpOwner(auth, env);
	return auth;
}
export type IntentPrincipal = {
	oauthClientId?: string | null;
	/** Token scopes; a delegated client (admin without any mail read scope) may auto-apply per policy. */
	scopes?: ReadonlySet<string>;
	tokenSub?: string | null;
	tokenJti?: string | null;
};
export const MAX_PENDING_INTENTS_PER_SUB = 5;
const bound = (value: string | null | undefined, max: number): string | null =>
	value ? value.slice(0, max) : null;

/** Live (undecided, unexpired) MCP intents a token subject already holds, send and control plane alike. */
export async function assertPendingCapacity(
	env: Env,
	tokenSub: string | null | undefined,
	except?: { mailboxId: string; draftId: string },
): Promise<void> {
	if (!tokenSub) return;
	const row = await env.INDEX_DB.prepare(
		`SELECT COUNT(*) AS n FROM approvals WHERE origin = 'mcp' AND token_sub = ? AND consumed_at IS NULL AND decision IS NULL AND expires_at > ?
		 AND NOT (kind = 'send' AND mailbox_id IS ? AND draft_id IS ?)`,
	)
		.bind(tokenSub, new Date().toISOString(), except?.mailboxId ?? null, except?.draftId ?? null)
		.first<{ n: number }>();
	if ((row?.n ?? 0) >= MAX_PENDING_INTENTS_PER_SUB) throw new Error("too_many_pending_approvals");
}
const newToken = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
};

export type AppliedItem = { status: "executed" | "failed" | "not_run"; result?: unknown; errorCode?: string };
export type AppliedChange = {
	id: string;
	items: AppliedItem[];
	/** Before-snapshot ops event ids written by each item (restorable ones only), in item order. */
	snapshotIds: string[][];
};

/** Restorable snapshots a template item wrote since `since`. Archived snapshots cannot be restored. */
async function snapshotsSince(env: Env, kind: string, item: Operation, since: string): Promise<string[]> {
	if (kind !== "template_upsert" || typeof item.mailboxId !== "string" || typeof item.templateId !== "string") return [];
	const rows = await env.INDEX_DB.prepare(
		"SELECT id FROM ops_events WHERE event_type = 'admin.before_snapshot' AND subject = ? AND created_at >= ? ORDER BY created_at",
	)
		.bind(`${item.mailboxId}:${item.templateId}`, since)
		.all<{ id: string }>();
	return (rows.results ?? []).map((row) => row.id);
}

/**
 * Executes an already-validated batch now, recording it as an approvals row decided without a
 * human click (`approved_via`). Mirrors what an approved intent does: same execute, same
 * ownership checks (the owner's own auth), results stored with secrets removed.
 */
export async function applyControlPlaneNow(
	env: Env,
	auth: AuthContext,
	input: {
		kind: string;
		validated: Operation[];
		isBatch: boolean;
		principal: IntentPrincipal;
		via: "auto" | "undo";
		clientId?: string | null;
	},
): Promise<AppliedChange> {
	const definition = controlPlaneKind(input.kind);
	if (!definition) throw new Error("invalid_intent_kind");
	const json = canonicalJson(input.isBatch ? input.validated : input.validated[0]);
	const payloadHash = await hashPayload(json);
	const id = newToken();
	const now = new Date();
	await env.INDEX_DB.prepare(
		"INSERT INTO approvals (token, kind, created_at, expires_at, payload_hash, consumed_at, decision, approved_via, origin, payload_json, oauth_client_id, token_sub, token_jti) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, 'mcp', ?, ?, ?, ?)",
	)
		.bind(
			id, input.kind, now.toISOString(), new Date(now.getTime() + 600000).toISOString(), payloadHash, now.toISOString(),
			input.via, json,
			bound(input.principal.oauthClientId, 2048), bound(input.principal.tokenSub, 512), bound(input.principal.tokenJti, 512),
		)
		.run();
	const items: AppliedItem[] = [];
	const snapshotIds: string[][] = [];
	let failed = false;
	for (const item of input.validated) {
		if (failed) {
			items.push({ status: "not_run" });
			snapshotIds.push([]);
			continue;
		}
		const since = new Date().toISOString();
		try {
			const result = await definition.execute(env, auth, item);
			items.push({ status: "executed", result: (definition.redact ? definition.redact(result) : { stored: result }).stored });
			snapshotIds.push(await snapshotsSince(env, input.kind, item, since));
		} catch (error) {
			failed = true;
			items.push({ status: "failed", errorCode: error instanceof AdminError ? error.code : "execution_failed" });
			snapshotIds.push([]);
		}
	}
	await env.INDEX_DB.prepare("UPDATE approvals SET result_json = ? WHERE token = ?").bind(JSON.stringify({ items }), id).run();
	await insertOpsEvent(env.INDEX_DB, {
		id: `approval.executed:${id}`,
		event_type: "approval.executed",
		severity: failed ? "warning" : "info",
		subject: id,
		payload_json: JSON.stringify({
			kind: input.kind, intent_id: id, approved_via: input.via,
			oauth_client_id: input.principal.oauthClientId ?? null, token_sub: input.principal.tokenSub ?? null,
			approver_user_id: auth.userId, outcomes: items.map((item) => item.status),
		}),
	}).catch(() => undefined);
	if (input.via === "auto") {
		for (const [i, item] of input.validated.entries()) {
			if (items[i]?.status !== "executed") continue;
			await insertOpsEvent(env.INDEX_DB, {
				id: `auto_applied:${id}:${i}`,
				event_type: "admin.auto_applied",
				severity: "info",
				subject: input.clientId ?? "",
				payload_json: JSON.stringify({
					client_id: input.clientId ?? null, kind: input.kind, mailbox: typeof item.mailboxId === "string" ? item.mailboxId : null,
					intent_id: id, snapshot_ids: snapshotIds[i] ?? [],
				}),
			}).catch(() => undefined);
		}
	}
	return { id, items, snapshotIds };
}

export type ControlPlaneRequest = { id: string; expiresAt: string; payloadHash: string } & {
	/** Set when the change was applied immediately under the client's policy. */
	applied?: AppliedChange & { policy: McpClientPolicy; variableLinks: string[]; summaries: string[]; targets: string[] };
	/** Set when a policy exists but a check failed, so the change is pending a human approval. */
	autoApplyRefused?: string;
};

export async function requestControlPlaneChange(
	env: Env,
	auth: AuthContext,
	kind: string,
	payload: unknown | unknown[],
	principal: IntentPrincipal = {},
): Promise<ControlPlaneRequest> {
	requireMcpOwner(auth, env);
	const delegated = isDelegatedToken(principal.scopes);
	// A delegated client that auto-applies never occupies a pending slot, so only check capacity up front for the rest.
	if (!delegated) await assertPendingCapacity(env, principal.tokenSub);
	const definition = controlPlaneKind(kind);
	if (!definition) throw new Error("invalid_intent_kind");
	const items = Array.isArray(payload) ? payload : [payload];
	if (!items.length || items.length > 100) throw new Error("invalid_payload");
	const validated = items.map(definition.validate);
	const summaries: string[] = [];
	for (const item of validated) summaries.push((await definition.render(env, auth, item)).title);
	let autoApplyRefused: string | undefined;
	if (delegated) {
		const decision = await evaluateAutoApply(env, auth, principal, kind, validated);
		if (decision.auto) {
			const applied = await applyControlPlaneNow(env, auth, {
				kind, validated, isBatch: Array.isArray(payload), principal, via: "auto", clientId: decision.policy.clientId,
			});
			return {
				id: applied.id, expiresAt: new Date().toISOString(), payloadHash: "",
				applied: {
					...applied, policy: decision.policy, variableLinks: decision.variableLinks, summaries,
					targets: validated.map((item) => [item.mailboxId, item.templateId ?? item.keyId ?? item.opsEventId].filter((v) => typeof v === "string").join("/")),
				},
			};
		}
		autoApplyRefused = decision.refused;
		await assertPendingCapacity(env, principal.tokenSub);
	}
	const json = canonicalJson(Array.isArray(payload) ? validated : validated[0]);
	const payloadHash = await hashPayload(json);
	const id = newToken();
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 600000).toISOString();
	await env.INDEX_DB.prepare(
		"INSERT INTO approvals (token, kind, created_at, expires_at, payload_hash, origin, payload_json, oauth_client_id, token_sub, token_jti) VALUES (?, ?, ?, ?, ?, 'mcp', ?, ?, ?, ?)",
	)
		.bind(
			id,
			kind,
			now.toISOString(),
			expiresAt,
			payloadHash,
			json,
			bound(principal.oauthClientId, 2048),
			bound(principal.tokenSub, 512),
			bound(principal.tokenJti, 512),
		)
		.run();
	if (autoApplyRefused)
		// Kept on the row so the approval page can show why the change was not applied automatically.
		await env.INDEX_DB.prepare("UPDATE approvals SET auto_refused = ? WHERE token = ?")
			.bind(autoApplyRefused.slice(0, 300), id)
			.run()
			.catch(() => undefined);
	return { id, expiresAt, payloadHash, ...(autoApplyRefused ? { autoApplyRefused } : {}) };
}
