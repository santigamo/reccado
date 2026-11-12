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
		body: z
			.object({ email: z.string().email().max(254), allowProviderRemoval: z.boolean().optional() })
			.strict(),
	})
	.strict();
// No mailboxId means every active mailbox the owner has.
const reconcileSchema = z.object({ mailboxId: z.string().min(1).max(100).optional() }).strict();

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
		const body = payload.body as z.infer<typeof suppressionSchema>["body"];
		const row = await suppression(env, auth, String(payload.mailboxId), body.email);
		const warnings = [{ code: "suppressed_recipient", message: "Este destinatario rebotó o se quejó: volver a enviarle puede dañar la reputación del dominio." }];
		if (body.allowProviderRemoval === true)
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
		const body = payload.body as z.infer<typeof suppressionSchema>["body"];
		await suppression(env, auth, String(payload.mailboxId), body.email);
		const result = await removeSuppression(env, auth, {
			mailboxId: String(payload.mailboxId),
			body: { email: body.email, allowProviderRemoval: body.allowProviderRemoval === true },
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
async function reconcileTargets(env: Env, auth: Parameters<typeof requireMailboxOwner>[1], id: unknown) {
	if (typeof id === "string") {
		await requireMailboxOwner(env, auth, id);
		const mailbox = await getMailbox(env.INDEX_DB, id);
		if (!mailbox) throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
		return [mailbox];
	}
	const rows = await env.INDEX_DB.prepare(
		"SELECT mailbox_id FROM mailboxes WHERE status = 'active' AND owner_email = ? ORDER BY mailbox_id",
	)
		.bind(auth.email.trim().toLowerCase())
		.all<{ mailbox_id: string }>();
	const out = [];
	for (const row of rows.results ?? []) {
		const mailbox = await getMailbox(env.INDEX_DB, row.mailbox_id);
		if (mailbox) out.push(mailbox);
	}
	return out;
}
registerControlPlaneKind("transactional_reconcile", {
	validate: (value) => strict(reconcileSchema, value),
	render: async (env, auth, payload) => {
		const mailboxes = await reconcileTargets(env, auth, payload.mailboxId);
		let total = 0;
		const fields = [];
		for (const mailbox of mailboxes) {
			const n = await staleCount(env, mailbox.mailbox_id);
			total += n;
			fields.push({ label: `Buzón ${mailbox.primary_address}`, value: String(n) });
		}
		return {
			title: "Reconciliar solicitudes transaccionales atascadas",
			fields: [{ label: "Solicitudes atascadas (aprox.)", value: String(total) }, ...fields],
			warnings: [
				{
					code: "manual_review",
					message: "Se marcan como «unknown» para revisión manual. No se reenvía ni reintenta ningún correo.",
				},
			],
		};
	},
	execute: async (env, auth, payload) => {
		const results = [];
		for (const mailbox of await reconcileTargets(env, auth, payload.mailboxId))
			results.push(await reconcile(env, auth, { mailboxId: mailbox.mailbox_id }));
		return { mailboxes: results.length, reconciled: results.reduce((n, r) => n + r.reconciled, 0) };
	},
});
