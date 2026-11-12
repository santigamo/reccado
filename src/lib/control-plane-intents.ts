import type { AuthContext } from "../api/auth";
import { requireMcpOwner, resolveOwnerEmails } from "../api/auth";
import { getMailbox, insertOpsEvent } from "../db/d1";
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
export async function requestControlPlaneChange(
	env: Env,
	auth: AuthContext,
	kind: string,
	payload: unknown | unknown[],
): Promise<{ id: string; expiresAt: string; payloadHash: string }> {
	requireMcpOwner(auth, env);
	const definition = controlPlaneKind(kind);
	if (!definition) throw new Error("invalid_intent_kind");
	const items = Array.isArray(payload) ? payload : [payload];
	if (!items.length || items.length > 100) throw new Error("invalid_payload");
	const validated = items.map(definition.validate);
	for (const item of validated) await definition.render(env, auth, item);
	const json = canonicalJson(Array.isArray(payload) ? validated : validated[0]);
	const payloadHash = await hashPayload(json);
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const id = btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
	const now = new Date();
	const expiresAt = new Date(now.getTime() + 600000).toISOString();
	await env.INDEX_DB.prepare(
		"INSERT INTO approvals (token, kind, created_at, expires_at, payload_hash, origin, payload_json) VALUES (?, ?, ?, ?, ?, 'mcp', ?)",
	)
		.bind(id, kind, now.toISOString(), expiresAt, payloadHash, json)
		.run();
	return { id, expiresAt, payloadHash };
}
