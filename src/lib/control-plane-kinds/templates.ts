import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import { requireMailboxOwner } from "../admin/access";
import { AdminError } from "../admin/errors";
import { archiveTemplate, createTemplate, listTemplates, updateTemplate } from "../admin/templates";
import { registerControlPlaneKind, show, strict, type Operation } from "../control-plane-registry";
import { writeBeforeSnapshot } from "./snapshot";

export type TemplateRow = {
	id: string;
	subject: string;
	body_text: string | null;
	body_html: string | null;
};
const templateId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const upsertSchema = z
	.object({
		mailboxId: z.string().min(1).max(100),
		templateId,
		subject: z
			.string()
			.min(1)
			.max(300)
			.refine((s) => !/[\r\n]/.test(s), "subject_contains_newline"),
		bodyText: z.string().max(100_000).nullable().optional(),
		bodyHtml: z.string().max(200_000).nullable().optional(),
	})
	.strict();
const archiveSchema = z.object({ mailboxId: z.string().min(1).max(100), templateId }).strict();

export async function activeTemplate(
	env: Env,
	auth: AuthContext,
	mailboxId: string,
	id: string,
): Promise<TemplateRow | null> {
	const result = await listTemplates(env, auth, { mailboxId });
	const rows = (result.value as { templates?: TemplateRow[] } | undefined)?.templates ?? [];
	return rows.find((row) => row.id === id) ?? null;
}
const size = (value: string | null | undefined) => `${(value ?? "").length} car.`;
function bodyChange(label: string, old: string | null | undefined, next: string | null | undefined) {
	if (next === undefined) return null;
	const changed = (old ?? null) !== next;
	return { label, value: changed ? `cambia: sí (${size(old)} → ${size(next)})` : "cambia: no" };
}

async function renderUpsert(env: Env, auth: AuthContext, payload: Operation) {
	const p = payload as z.infer<typeof upsertSchema>;
	await requireMailboxOwner(env, auth, p.mailboxId);
	const before = await activeTemplate(env, auth, p.mailboxId, p.templateId);
	const fields = [{ label: "Plantilla", value: p.templateId }];
	fields.push({
		label: "Asunto",
		value: before ? `${before.subject} → ${p.subject}` : p.subject,
	});
	for (const f of [
		bodyChange("Cuerpo texto", before?.body_text, p.bodyText),
		bodyChange("Cuerpo HTML", before?.body_html, p.bodyHtml),
	])
		if (f) fields.push(f);
	return {
		title: before ? "Actualizar plantilla" : "Crear plantilla",
		fields,
		warnings: before
			? [{ code: "template_overwrite", message: "Las claves que usan esta plantilla enviarán el nuevo contenido." }]
			: [],
	};
}

registerControlPlaneKind("template_upsert", {
	validate: (value) => strict(upsertSchema, value),
	render: renderUpsert,
	execute: async (env, auth, payload) => {
		await renderUpsert(env, auth, payload);
		const p = payload as z.infer<typeof upsertSchema>;
		const before = await activeTemplate(env, auth, p.mailboxId, p.templateId);
		const body = {
			subject: p.subject,
			body_text: p.bodyText ?? before?.body_text ?? null,
			body_html: p.bodyHtml ?? before?.body_html ?? null,
		};
		if (before) {
			await writeBeforeSnapshot(env, auth, "template", `${p.mailboxId}:${p.templateId}`, {
				mailboxId: p.mailboxId,
				...before,
			});
			return updateTemplate(env, auth, { mailboxId: p.mailboxId, templateId: p.templateId, body });
		}
		return createTemplate(env, auth, { mailboxId: p.mailboxId, body: { id: p.templateId, ...body } });
	},
});

async function existing(env: Env, auth: AuthContext, payload: Operation) {
	const p = payload as z.infer<typeof archiveSchema>;
	await requireMailboxOwner(env, auth, p.mailboxId);
	const row = await activeTemplate(env, auth, p.mailboxId, p.templateId);
	if (!row) throw new AdminError("Template not found", "template_not_found", 404);
	return row;
}
registerControlPlaneKind("template_archive", {
	validate: (value) => strict(archiveSchema, value),
	render: async (env, auth, payload) => {
		const row = await existing(env, auth, payload);
		return {
			title: "Archivar plantilla",
			fields: [
				{ label: "Plantilla", value: row.id },
				{ label: "Asunto", value: show(row.subject) },
			],
			warnings: [{ code: "template_archived", message: "Las claves que usan esta plantilla dejarán de poder enviarla." }],
		};
	},
	execute: async (env, auth, payload) => {
		const row = await existing(env, auth, payload);
		const p = payload as z.infer<typeof archiveSchema>;
		await writeBeforeSnapshot(env, auth, "template", `${p.mailboxId}:${row.id}`, {
			mailboxId: p.mailboxId,
			archived: true,
			...row,
		});
		return archiveTemplate(env, auth, { mailboxId: p.mailboxId, templateId: p.templateId });
	},
});
