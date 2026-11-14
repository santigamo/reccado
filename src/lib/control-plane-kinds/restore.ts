import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import {
	getAlias,
	getDomainById,
	getMailbox,
	getRoutingRule,
	insertAlias,
	insertOpsEvent,
	insertRoutingRule,
	updateDomain,
	updateMailbox,
	type DomainRow,
	type MailboxRow,
} from "../../db/d1";
import { assertAdminAccess, requireMailboxOwner } from "../admin/access";
import { AdminError } from "../admin/errors";
import { patchRule } from "../admin/routing";
import { updateTemplate } from "../admin/templates";
import { registerControlPlaneKind, strict, type Operation } from "../control-plane-registry";
import { activeTemplate } from "./templates";
import { externalAddresses } from "./routing";
import type { SnapshotEntity } from "./snapshot";

const restoreSchema = z.object({ opsEventId: z.string().min(1).max(100) }).strict();
type Snapshot = Record<string, unknown> & { entity: SnapshotEntity; by?: string };

async function loadSnapshot(env: Env, auth: AuthContext, opsEventId: string): Promise<Snapshot> {
	assertAdminAccess(env, auth, "");
	const row = await env.INDEX_DB.prepare(
		"SELECT payload_json FROM ops_events WHERE id = ? AND event_type = 'admin.before_snapshot'",
	)
		.bind(opsEventId)
		.first<{ payload_json: string }>();
	if (!row) throw new AdminError("Snapshot not found", "snapshot_not_found", 404);
	if (await env.INDEX_DB.prepare("SELECT 1 AS x FROM ops_events WHERE id = ?").bind(`restored:${opsEventId}`).first())
		throw new AdminError("Snapshot already restored", "snapshot_consumed", 409);
	const parsed = JSON.parse(row.payload_json) as Snapshot;
	// Snapshots written before `entity` existed are mailbox rows.
	if (!parsed.entity && typeof parsed.mailbox_id === "string") parsed.entity = "mailbox";
	return parsed;
}

/** Ownership of the thing being restored; disabled mailboxes fail requireMailboxOwner, so check the row. */
async function requireOwnership(env: Env, auth: AuthContext, snap: Snapshot): Promise<void> {
	const forbidden = () => new AdminError("Forbidden", "forbidden", 403, false);
	const mailboxId = snap.entity === "mailbox" ? snap.mailbox_id : snap.mailbox_id ?? snap.mailboxId;
	if (typeof mailboxId === "string") {
		const mailbox = await getMailbox(env.INDEX_DB, mailboxId);
		if (!mailbox || mailbox.owner_email?.toLowerCase() !== auth.email.toLowerCase()) throw forbidden();
		return;
	}
	if (!snap.by || snap.by.toLowerCase() !== auth.email.toLowerCase()) throw forbidden();
}

type Plan = { title: string; fields: Array<{ label: string; value: string }>; apply: () => Promise<unknown> };

async function plan(env: Env, auth: AuthContext, payload: Operation): Promise<Plan> {
	const opsEventId = String(payload.opsEventId);
	const snap = await loadSnapshot(env, auth, opsEventId);
	await requireOwnership(env, auth, snap);
	const conflict = (message: string, code: string) => new AdminError(message, code, 409);
	switch (snap.entity) {
		case "mailbox": {
			const row = snap as unknown as MailboxRow;
			const now = await getMailbox(env.INDEX_DB, row.mailbox_id);
			if (!now) throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
			if (now.status === row.status && now.display_name === row.display_name)
				throw conflict("Nothing to restore", "restore_noop");
			return {
				title: "Restaurar buzón",
				fields: [
					{ label: "Buzón", value: row.primary_address },
					{ label: "Estado", value: `${now.status} → ${row.status}` },
				],
				apply: async () => {
					await updateMailbox(env.INDEX_DB, row.mailbox_id, { status: row.status, display_name: row.display_name });
					return { restored: "mailbox", id: row.mailbox_id };
				},
			};
		}
		case "domain": {
			const row = snap as unknown as DomainRow;
			const now = await getDomainById(env.INDEX_DB, row.id);
			if (!now) throw new AdminError("Domain not found", "domain_not_found", 404);
			if (now.status === row.status) throw conflict("Nothing to restore", "restore_noop");
			return {
				title: "Restaurar dominio",
				fields: [
					{ label: "Dominio", value: row.domain },
					{ label: "Estado", value: `${now.status} → ${row.status}` },
				],
				apply: async () => {
					await updateDomain(env.INDEX_DB, row.id, { status: row.status });
					return { restored: "domain", id: row.id };
				},
			};
		}
		case "alias": {
			const row = snap as unknown as { alias_address: string; mailbox_id: string; domain_id: string; status: "active" | "disabled" };
			if (await getAlias(env.INDEX_DB, row.alias_address))
				throw conflict(`Alias ${row.alias_address} already exists`, "alias_exists");
			if (!(await getDomainById(env.INDEX_DB, row.domain_id)))
				throw new AdminError("Domain not found", "domain_not_found", 404);
			return {
				title: "Restaurar alias",
				fields: [{ label: "Alias", value: row.alias_address }],
				apply: async () => {
					await insertAlias(env.INDEX_DB, {
						alias_address: row.alias_address,
						mailbox_id: row.mailbox_id,
						domain_id: row.domain_id,
						status: row.status,
					});
					return { restored: "alias", id: row.alias_address };
				},
			};
		}
		case "routing_rule": {
			const row = snap as unknown as {
				id: string; domain_id: string; pattern: string; priority: number;
				action: "store" | "forward" | "reject"; mailbox_id: string | null;
				forward_to_json: string; reject_reason: string | null; enabled: number;
			};
			if (!(await getDomainById(env.INDEX_DB, row.domain_id)))
				throw new AdminError("Domain not found", "domain_not_found", 404);
			if (row.mailbox_id) await requireMailboxOwner(env, auth, row.mailbox_id);
			const current = await getRoutingRule(env.INDEX_DB, row.id);
			return {
				title: "Restaurar regla de enrutado",
				fields: [
					{ label: "Patrón", value: row.pattern },
					{ label: "Acción", value: row.action },
					{ label: "Estado actual", value: current ? "existe (se sobrescribe)" : "eliminada (se recrea)" },
				],
				apply: async () => {
					if (current) {
						await patchRule(env, auth, {
							ruleId: row.id,
							body: {
								pattern: row.pattern, priority: row.priority, action: row.action,
								mailboxId: row.mailbox_id, forwardTo: JSON.parse(row.forward_to_json) as string[],
								rejectReason: row.reject_reason, enabled: Boolean(row.enabled),
							},
						});
					} else {
						await insertRoutingRule(env.INDEX_DB, {
							id: row.id, domain_id: row.domain_id, pattern: row.pattern, priority: row.priority,
							action: row.action, mailbox_id: row.mailbox_id, forward_to_json: row.forward_to_json,
							reject_reason: row.reject_reason, enabled: row.enabled,
						});
					}
					return { restored: "routing_rule", id: row.id };
				},
			};
		}
		case "template": {
			const row = snap as unknown as { mailboxId: string; id: string; subject: string; body_text: string | null; body_html: string | null; archived?: boolean };
			if (row.archived)
				throw conflict("Archived templates cannot be reactivated; create it again with template_upsert", "restore_unsupported");
			const current = await activeTemplate(env, auth, row.mailboxId, row.id);
			if (!current) throw conflict("Template no longer active", "template_not_active");
			return {
				title: "Restaurar plantilla",
				fields: [
					{ label: "Plantilla", value: row.id },
					{ label: "Asunto", value: `${current.subject} → ${row.subject}` },
				],
				apply: async () => {
					await updateTemplate(env, auth, {
						mailboxId: row.mailboxId, templateId: row.id,
						body: { subject: row.subject, body_text: row.body_text, body_html: row.body_html },
					});
					return { restored: "template", id: row.id };
				},
			};
		}
		default:
			throw new AdminError("Unsupported snapshot", "restore_unsupported", 400);
	}
}

/** Restoring a forward rule that leaves the owner's domains re-opens an exfiltration path, so it needs approval. */
async function restoreApproval(env: Env, auth: AuthContext, payload: Operation) {
	const snap = await loadSnapshot(env, auth, String(payload.opsEventId));
	if (snap.entity !== "routing_rule" || snap.action !== "forward" || typeof snap.forward_to_json !== "string") return "direct" as const;
	const forward = JSON.parse(snap.forward_to_json) as string[];
	return (await externalAddresses(env, forward)).length ? ("required" as const) : ("direct" as const);
}

registerControlPlaneKind("restore", {
	approval: restoreApproval,
	covers: ["opsEventId"],
	validate: (value) => strict(restoreSchema, value),
	render: async (env, auth, payload) => {
		const p = await plan(env, auth, payload);
		return {
			title: p.title,
			fields: p.fields,
			warnings: [{ code: "restore", message: "Se reaplica el estado anterior guardado; los cambios posteriores sobre este elemento se pierden." }],
		};
	},
	execute: async (env, auth, payload) => {
		const p = await plan(env, auth, payload);
		const opsEventId = String(payload.opsEventId);
		// The primary key makes consumption atomic: a second restore of the same snapshot fails here.
		try {
			await insertOpsEvent(env.INDEX_DB, {
				id: `restored:${opsEventId}`,
				event_type: "admin.snapshot_restored",
				severity: "info",
				subject: opsEventId,
				payload_json: JSON.stringify({ by: auth.email }),
			});
		} catch {
			throw new AdminError("Snapshot already restored", "snapshot_consumed", 409);
		}
		return p.apply();
	},
});
