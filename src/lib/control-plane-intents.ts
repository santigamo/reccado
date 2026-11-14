import type { AuthContext } from "../api/auth";
import { requireMcpOwner, resolveOwnerEmails } from "../api/auth";
import { getMailbox, insertOpsEvent } from "../db/d1";
import { requireMailboxOwner } from "./admin/access";
import { AdminError } from "./admin/errors";
import { createMailbox, deleteMailbox, patchMailbox } from "./admin/mailboxes";
import {
	approvalModeFor,
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
	approval: "direct",
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
	approval: "direct",
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
	approval: "direct",
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
	/** Token scopes (informational; scope gating happens in the MCP layer). */
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

export type DirectOutcome = {
	status: "applied" | "failed";
	/** Result with one-time secrets removed (`redact`); absent on failure. */
	result?: unknown;
	errorCode?: string;
	/** `admin.before_snapshot` ops event ids the change wrote, usable with the `restore` kind. */
	snapshotIds: string[];
};

/** Restorable before-snapshots this owner's change wrote since `since`. */
async function snapshotsSince(env: Env, auth: AuthContext, since: string): Promise<string[]> {
	const rows = await env.INDEX_DB.prepare(
		"SELECT id FROM ops_events WHERE event_type = 'admin.before_snapshot' AND created_at >= ? AND json_extract(payload_json, '$.by') = ? ORDER BY created_at LIMIT 10",
	)
		.bind(since, auth.email)
		.all<{ id: string }>();
	return (rows.results ?? []).map((row) => row.id);
}

/**
 * Executes a validated `direct` change now as the owner (same ownership checks as an approved
 * intent) and records it as an `admin.applied` ops event naming the client/token. Snapshots the
 * kind wrote stay in `ops_events`, so the `restore` tool can undo the change.
 */
async function applyDirect(
	env: Env,
	auth: AuthContext,
	kind: string,
	payload: Operation,
	principal: IntentPrincipal,
): Promise<DirectOutcome & { id: string }> {
	const definition = controlPlaneKind(kind)!;
	const id = crypto.randomUUID();
	const since = new Date().toISOString();
	let outcome: DirectOutcome;
	try {
		// Same pre-flight an approval gets (ownership, existence, conflicts) so a refusal reports its own code.
		await definition.render(env, auth, payload);
		const result = await definition.execute(env, auth, payload);
		outcome = {
			status: "applied",
			result: (definition.redact ? definition.redact(result) : { stored: result }).stored,
			snapshotIds: await snapshotsSince(env, auth, since),
		};
	} catch (error) {
		outcome = {
			status: "failed",
			errorCode: error instanceof AdminError ? error.code : "execution_failed",
			snapshotIds: await snapshotsSince(env, auth, since).catch(() => []),
		};
	}
	await insertOpsEvent(env.INDEX_DB, {
		id: `admin.applied:${id}`,
		event_type: "admin.applied",
		severity: outcome.status === "applied" ? "info" : "warning",
		subject: kind,
		payload_json: JSON.stringify({
			kind,
			outcome: outcome.status,
			error_code: outcome.errorCode ?? null,
			oauth_client_id: principal.oauthClientId ?? null,
			token_sub: principal.tokenSub ?? null,
			token_jti: principal.tokenJti ?? null,
			approver_user_id: auth.userId,
			snapshot_ids: outcome.snapshotIds,
		}),
	}).catch(() => undefined);
	return { ...outcome, id };
}

/** `applied` is set when the change was direct and has already run; otherwise it is a pending approval. */
export type ControlPlaneRequest = { id: string; expiresAt: string; payloadHash: string; applied?: DirectOutcome };

export async function requestControlPlaneChange(
	env: Env,
	auth: AuthContext,
	kind: string,
	payload: unknown,
	principal: IntentPrincipal = {},
): Promise<ControlPlaneRequest> {
	requireMcpOwner(auth, env);
	const definition = controlPlaneKind(kind);
	if (!definition) throw new Error("invalid_intent_kind");
	const validated = definition.validate(payload);
	if ((await approvalModeFor(definition, env, auth, validated)) === "direct") {
		const { id, ...applied } = await applyDirect(env, auth, kind, validated, principal);
		return { id, expiresAt: new Date().toISOString(), payloadHash: "", applied };
	}
	await assertPendingCapacity(env, principal.tokenSub);
	await definition.render(env, auth, validated);
	const json = canonicalJson(validated);
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
	return { id, expiresAt, payloadHash };
}
