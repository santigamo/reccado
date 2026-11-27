import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import { requireMailboxOwner } from "../admin/access";
import { AdminError } from "../admin/errors";
import { getMailbox, insertOpsEvent, listDomains } from "../../db/d1";
import type { IntentField, IntentWarning } from "../approvals";
import {
	archiveTemplate,
	createTemplate,
	listTemplates,
	syncTemplates,
	updateTemplate,
} from "../admin/templates";
import { templateContentHash } from "../template-hash";
import { MAX_TEMPLATE_SYNC_BATCH } from "../transactional-send";
import { registerControlPlaneKind, show, strict, type Operation } from "../control-plane-registry";
import { lineDiff } from "./text-diff";
import { writeBeforeSnapshot } from "./snapshot";

export type TemplateRow = {
	id: string;
	subject: string;
	body_text: string | null;
	body_html: string | null;
};
const templateId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const subject = z
	.string()
	.min(1)
	.max(300)
	.refine((s) => !/[\r\n]/.test(s), "subject_contains_newline");
const upsertSchema = z
	.object({
		mailboxId: z.string().min(1).max(100),
		templateId,
		body: z
			.object({
				subject,
				body_text: z.string().max(100_000).nullable().optional(),
				body_html: z.string().max(200_000).nullable().optional(),
			})
			.strict(),
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
const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s"'<>)\]]+/gi;
const HREF_PATTERN = /\b(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Every link in text + HTML source, in order of appearance, deduplicated. */
export function extractUrls(...sources: Array<string | null | undefined>): string[] {
	const found = new Set<string>();
	for (const source of sources) {
		if (!source) continue;
		for (const m of source.matchAll(HREF_PATTERN)) {
			const value = (m[1] ?? m[2] ?? m[3] ?? "").trim();
			if (value && !value.startsWith("#")) found.add(value);
		}
		for (const m of source.matchAll(URL_PATTERN)) found.add(m[0].replace(/[.,;:!?]+$/, ""));
	}
	return [...found];
}
function hostnameOf(url: string): string | null {
	try {
		const parsed = new URL(/^www\./i.test(url) ? `https://${url}` : url);
		return /^(https?:)$/.test(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}
const owns = (owned: string[], host: string) =>
	owned.some((domain) => host === domain || host.endsWith(`.${domain}`));

async function renderUpsert(env: Env, auth: AuthContext, payload: Operation) {
	const p = payload as z.infer<typeof upsertSchema>;
	await requireMailboxOwner(env, auth, p.mailboxId);
	const before = await activeTemplate(env, auth, p.mailboxId, p.templateId);
	const fields: IntentField[] = [{ label: "Plantilla", value: p.templateId }];
	fields.push({
		label: "Asunto",
		value: before ? `${before.subject} → ${p.body.subject}` : p.body.subject,
	});
	// Effective content: what execute stores (an omitted body keeps the previous one).
	const text = p.body.body_text === undefined ? (before?.body_text ?? null) : p.body.body_text;
	const html = p.body.body_html === undefined ? (before?.body_html ?? null) : p.body.body_html;
	const note = (next: string | null | undefined) => (next === undefined ? " (sin cambios)" : "");
	fields.push({
		label: `Cuerpo texto${note(p.body.body_text)}`,
		value: text === null ? "(vacío)" : text,
		format: "pre",
	});
	fields.push({
		label: `Cuerpo HTML (código fuente, no se renderiza)${note(p.body.body_html)}`,
		value: html === null ? "(vacío)" : html,
		format: "pre",
	});
	if (before) {
		for (const [label, old, next] of [
			["Cambios en texto (- anterior / + nuevo)", before.body_text, text],
			["Cambios en HTML (- anterior / + nuevo)", before.body_html, html],
		] as const) {
			if ((old ?? "") === (next ?? "")) continue;
			const diff = lineDiff(old ?? "", next ?? "");
			fields.push({
				label,
				value: diff ?? "(demasiado grande para comparar; revisa el contenido completo)",
				format: "pre",
			});
		}
	}
	const urls = extractUrls(text, html);
	const owned = (await listDomains(env.INDEX_DB)).map((d) => d.domain.toLowerCase());
	const warnings: IntentWarning[] = before
		? [
				{
					code: "template_overwrite",
					message: "Las claves que usan esta plantilla enviarán el nuevo contenido.",
				},
			]
		: [];
	if (urls.length)
		fields.push({
			label: "Enlaces encontrados",
			value: urls.map((u) => `${hostnameOf(u) ?? "(sin host)"} — ${u}`).join("\n"),
			format: "list",
		});
	else fields.push({ label: "Enlaces encontrados", value: "(ninguno)" });
	const external = new Set<string>();
	for (const url of urls) {
		const host = hostnameOf(url);
		if (host === null) {
			if (/^\s*(javascript|data|vbscript):/i.test(url))
				warnings.push({
					code: `unsafe_link_scheme:${url.slice(0, 40)}`,
					message: `Enlace con esquema peligroso: ${url.slice(0, 80)}`,
				});
		} else if (!owns(owned, host)) external.add(host);
	}
	for (const host of external)
		warnings.push({
			code: `external_link:${host}`,
			message: `Enlace a un dominio que no es uno de tus dominios de envío: ${host}`,
		});
	return {
		title: before ? "Actualizar plantilla" : "Crear plantilla",
		fields,
		warnings,
	};
}

registerControlPlaneKind("template_upsert", {
	approval: "direct",
	covers: ["mailboxId", "templateId", "body.subject", "body.body_text", "body.body_html"],
	validate: (value) => strict(upsertSchema, value),
	render: renderUpsert,
	execute: async (env, auth, payload) => {
		await renderUpsert(env, auth, payload);
		const p = payload as z.infer<typeof upsertSchema>;
		const before = await activeTemplate(env, auth, p.mailboxId, p.templateId);
		const body = {
			subject: p.body.subject,
			body_text: p.body.body_text ?? before?.body_text ?? null,
			body_html: p.body.body_html ?? before?.body_html ?? null,
		};
		if (before) {
			await writeBeforeSnapshot(env, auth, "template", `${p.mailboxId}:${p.templateId}`, {
				mailboxId: p.mailboxId,
				...before,
			});
			return updateTemplate(env, auth, { mailboxId: p.mailboxId, templateId: p.templateId, body });
		}
		return createTemplate(env, auth, {
			mailboxId: p.mailboxId,
			body: { id: p.templateId, ...body },
		});
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
	approval: "direct",
	covers: ["mailboxId", "templateId"],
	validate: (value) => strict(archiveSchema, value),
	render: async (env, auth, payload) => {
		const row = await existing(env, auth, payload);
		return {
			title: "Archivar plantilla",
			fields: [
				{ label: "Plantilla", value: row.id },
				{ label: "Asunto", value: show(row.subject) },
			],
			warnings: [
				{
					code: "template_archived",
					message: "Las claves que usan esta plantilla dejarán de poder enviarla.",
				},
			],
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

// --- template_sync: a whole set of templates in one atomic call ---

/** D1 keeps a row under ~2 MB; the before-snapshot of a sync must fit in one ops event. */
export const MAX_SYNC_SNAPSHOT_BYTES = 1_800_000;

const syncItem = z
	.object({
		id: templateId.refine((id) => !id.includes(".."), "invalid_template_id"),
		subject,
		// The mailbox DO's own per-template limits (`templateInputProblem`), checked here first.
		body_text: z.string().max(100_000).nullable().optional(),
		body_html: z.string().max(100_000).nullable().optional(),
	})
	.strict();
const syncSchema = z
	.object({
		mailboxId: z.string().min(1).max(100),
		templates: z.array(syncItem).min(1).max(MAX_TEMPLATE_SYNC_BATCH),
		/** Where the MCP layer fetched `templates` from (recorded, never re-fetched here). */
		source: z
			.object({
				url: z.string().min(1).max(2048),
				sha256: z.string().regex(/^[0-9a-f]{64}$/),
				bytes: z.number().int().min(0),
			})
			.strict()
			.optional(),
	})
	.strict()
	.superRefine((body, ctx) => {
		const seen = new Set<string>();
		body.templates.forEach((template, index) => {
			if (seen.has(template.id))
				ctx.addIssue({
					code: "custom",
					path: ["templates", index, "id"],
					message: `duplicate_template_id: ${JSON.stringify(template.id)} appears more than once`,
				});
			seen.add(template.id);
		});
	});
type SyncPayload = z.infer<typeof syncSchema>;
type SyncItem = SyncPayload["templates"][number];

const sameContent = (row: TemplateRow, item: SyncItem) =>
	row.subject === item.subject &&
	row.body_text === (item.body_text ?? null) &&
	row.body_html === (item.body_html ?? null);

/** What the sync would do to each listed id, judged against the active templates now. */
async function planSync(env: Env, auth: AuthContext, payload: Operation) {
	const p = payload as SyncPayload;
	await requireMailboxOwner(env, auth, p.mailboxId);
	if (!(await getMailbox(env.INDEX_DB, p.mailboxId)))
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	const result = await listTemplates(env, auth, { mailboxId: p.mailboxId });
	const active = new Map(
		((result.value as { templates?: TemplateRow[] } | undefined)?.templates ?? []).map((row) => [
			row.id,
			row,
		]),
	);
	const changed: TemplateRow[] = [];
	const unchanged: string[] = [];
	// Not active now: created by the sync, or an archived id the sync reports and leaves alone.
	const absent: string[] = [];
	for (const item of p.templates) {
		const row = active.get(item.id);
		if (!row) absent.push(item.id);
		else if (sameContent(row, item)) unchanged.push(item.id);
		else
			changed.push({
				id: row.id,
				subject: row.subject,
				body_text: row.body_text,
				body_html: row.body_html,
			});
	}
	return { p, changed, unchanged, absent };
}

registerControlPlaneKind("template_sync", {
	approval: "direct",
	covers: ["mailboxId", "templates", "source"],
	validate: (value) => strict(syncSchema, value),
	render: async (env, auth, payload) => {
		const { p, changed, unchanged, absent } = await planSync(env, auth, payload);
		const fields: IntentField[] = [
			{ label: "Buzón", value: p.mailboxId },
			{
				label: "Plantillas",
				value: `${absent.length} nuevas, ${changed.length} actualizadas, ${unchanged.length} sin cambios`,
			},
		];
		const verb = (id: string) =>
			absent.includes(id) ? "crear" : unchanged.includes(id) ? "sin cambios" : "actualizar";
		fields.push({
			label: "Detalle",
			value: p.templates.map((t) => `${t.id} — ${verb(t.id)} — ${t.subject}`).join("\n"),
			format: "list",
		});
		if (p.source)
			fields.push({
				label: "Origen",
				value: `${p.source.url} (sha256 ${p.source.sha256}, ${p.source.bytes} bytes)`,
			});
		return {
			title: "Sincronizar plantillas",
			fields,
			warnings: changed.length
				? [
						{
							code: "template_overwrite",
							message: "Las claves que usan esta plantilla enviarán el nuevo contenido.",
						},
					]
				: [],
		};
	},
	execute: async (env, auth, payload) => {
		const { p, changed, absent } = await planSync(env, auth, payload);
		// One snapshot undoes the whole sync: the previous content of what it updates, and the ids
		// it may create (restore removes those still active then; archived ids stay archived).
		const snapshot = {
			mailboxId: p.mailboxId,
			restore: changed,
			remove: absent,
			...(p.source ? { source: p.source } : {}),
		};
		if (new TextEncoder().encode(JSON.stringify(snapshot)).length > MAX_SYNC_SNAPSHOT_BYTES)
			throw new AdminError(
				"The templates this sync overwrites are too large for one before-snapshot; split the sync",
				"sync_too_large",
				400,
			);
		// A sync that can only answer `unchanged` has nothing to undo.
		const snapshotId =
			changed.length || absent.length
				? await writeBeforeSnapshot(
						env,
						auth,
						"template_sync",
						`${p.mailboxId}:template_sync`,
						snapshot,
					)
				: null;
		// The mailbox DO validates the whole batch and writes it in one transaction (all or nothing).
		const synced = await syncTemplates(env, auth, {
			mailboxId: p.mailboxId,
			body: {
				templates: p.templates.map((t) => ({
					id: t.id,
					subject: t.subject,
					body_text: t.body_text ?? null,
					body_html: t.body_html ?? null,
				})),
			},
		});
		const value = synced.value as {
			results: Array<{ id: string; outcome: string; reason?: string }>;
			summary: Record<string, number>;
		};
		const hashes = new Map(
			await Promise.all(
				p.templates.map(async (t) => [t.id, await templateContentHash(t)] as const),
			),
		);
		const results = value.results.map((r) => ({
			...r,
			// Stored content now equals what was sent, except an archived id (left as it was).
			...(r.outcome === "archived" ? {} : { sha256: hashes.get(r.id) }),
		}));
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "admin.template_sync",
			severity: "info",
			subject: p.mailboxId,
			payload_json: JSON.stringify({
				by: auth.email,
				mailbox_id: p.mailboxId,
				snapshot_id: snapshotId,
				summary: value.summary,
				results,
				source: p.source ?? null,
			}),
		}).catch(() => undefined);
		return {
			mailboxId: p.mailboxId,
			summary: value.summary,
			results,
			...(p.source ? { source: p.source } : {}),
		};
	},
});
