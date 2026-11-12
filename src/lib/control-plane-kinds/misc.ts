import { z } from "zod";
import { getMailbox } from "../../db/d1";
import { requireMailboxOwner } from "../admin/access";
import { AdminError } from "../admin/errors";
import { reconcile } from "../admin/ops";
import { listSuppressions, removeSuppression } from "../admin/suppressions";
import { registerControlPlaneKind, show, strict } from "../control-plane-registry";

const STALE_MS = 30 * 60 * 1000; // same threshold as the DO's reconcile-stale route

const suppressionSchema = z
	.object({
		mailboxId: z.string().min(1).max(100),
		email: z.string().email().max(254),
		allowProviderRemoval: z.boolean().optional(),
	})
	.strict();
const reconcileSchema = z.object({ mailboxId: z.string().min(1).max(100) }).strict();

type Suppression = { email: string; reason?: string };
async function suppression(env: Env, auth: Parameters<typeof requireMailboxOwner>[1], mailboxId: string, email: string) {
	await requireMailboxOwner(env, auth, mailboxId);
	const result = await listSuppressions(env, auth, { mailboxId });
	const rows = (result.value as { suppressions?: Suppression[] } | undefined)?.suppressions ?? [];
	const row = rows.find((r) => r.email.toLowerCase() === email.trim().toLowerCase());
	if (!row) throw new AdminError("Suppression not found", "suppression_not_found", 404);
	return row;
}

registerControlPlaneKind("suppression_remove", {
	validate: (value) => strict(suppressionSchema, value),
	render: async (env, auth, payload) => {
		const row = await suppression(env, auth, String(payload.mailboxId), String(payload.email));
		const warnings = [{ code: "suppressed_recipient", message: "Este destinatario rebotó o se quejó: volver a enviarle puede dañar la reputación del dominio." }];
		if (payload.allowProviderRemoval === true)
			warnings.push({ code: "provider_removal", message: "Se elimina incluso la supresión del proveedor (rebote/queja)." });
		return {
			title: "Quitar supresión de destinatario",
			fields: [
				{ label: "Destinatario", value: row.email },
				{ label: "Motivo", value: show(row.reason) },
			],
			warnings,
		};
	},
	execute: async (env, auth, payload) => {
		await suppression(env, auth, String(payload.mailboxId), String(payload.email));
		const result = await removeSuppression(env, auth, {
			mailboxId: String(payload.mailboxId),
			body: { email: String(payload.email), allowProviderRemoval: payload.allowProviderRemoval === true },
		});
		return result.value ?? null;
	},
});

/** Orientative count from the (non-authoritative) D1 projection; the DO decides what it touches. */
async function staleCount(env: Env, mailboxId: string): Promise<number> {
	const cutoff = new Date(Date.now() - STALE_MS).toISOString();
	const row = await env.INDEX_DB.prepare(
		"SELECT COUNT(*) AS n FROM transactional_request_log WHERE mailbox_id = ? AND status IN ('pending','sending') AND updated_at < ?",
	)
		.bind(mailboxId, cutoff)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
async function reconcileTarget(env: Env, auth: Parameters<typeof requireMailboxOwner>[1], id: string) {
	await requireMailboxOwner(env, auth, id);
	const mailbox = await getMailbox(env.INDEX_DB, id);
	if (!mailbox) throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return mailbox;
}
registerControlPlaneKind("transactional_reconcile", {
	validate: (value) => strict(reconcileSchema, value),
	render: async (env, auth, payload) => {
		const mailbox = await reconcileTarget(env, auth, String(payload.mailboxId));
		const n = await staleCount(env, mailbox.mailbox_id);
		return {
			title: "Reconciliar solicitudes transaccionales atascadas",
			fields: [
				{ label: "Buzón", value: mailbox.primary_address },
				{ label: "Solicitudes atascadas (aprox.)", value: String(n) },
			],
			warnings: [
				{
					code: "manual_review",
					message: "Se marcan como «unknown» para revisión manual. No se reenvía ni reintenta ningún correo.",
				},
			],
		};
	},
	execute: async (env, auth, payload) => {
		await reconcileTarget(env, auth, String(payload.mailboxId));
		return reconcile(env, auth, { mailboxId: String(payload.mailboxId) });
	},
});
