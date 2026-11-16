import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import { createTransactionalApiKeySchema, updateKeyTemplatesSchema } from "../../api/schemas";
import { requireMailboxOwner } from "../admin/access";
import { AdminError } from "../admin/errors";
import {
	createKey,
	listKeys,
	nextAllowlist,
	revokeKey,
	rotateKey,
	updateKeyTemplates,
} from "../admin/api-keys";
import { listTemplates } from "../admin/templates";
import type { IntentField, IntentWarning } from "../approvals";
import { registerControlPlaneKind, show, strict, type Operation } from "../control-plane-registry";
import { KEY_SCOPES, type TransactionalApiKeyProjection } from "../transactional-keys";

const mailboxId = z.string().min(1).max(100);
const keyId = z.string().min(1).max(100);
const scopes = z.array(z.enum(KEY_SCOPES)).min(1).max(KEY_SCOPES.length);
const createSchema = z
	.object({
		mailboxId,
		body: z
			.object({
				environment: z.enum(["test", "live"]),
				sender: z.string().email().max(254),
				senderName: z.string().max(100).nullable().optional(),
				scopes,
				templateAllowlist: z.array(z.string().min(1).max(128)).max(100).optional(),
				recipientPolicy: z.string().max(2000).optional(),
				quotaMax: z.number().int().positive().optional(),
				expiresAt: z.string().datetime().optional(),
			})
			.strict(),
	})
	.strict();
const keySchema = z.object({ mailboxId, keyId }).strict();
const scopesSchema = z
	.object({
		mailboxId,
		keyId,
		scopes,
		templateAllowlist: z.array(z.string().min(1).max(128)).max(100).optional(),
	})
	.strict();

const templatesSchema = z
	.object({
		mailboxId,
		keyId,
		add: z.array(z.string().min(1).max(128)).max(100).optional(),
		remove: z.array(z.string().min(1).max(128)).max(100).optional(),
		set: z.array(z.string().min(1).max(128)).max(100).optional(),
	})
	.strict();

async function activeKey(env: Env, auth: AuthContext, payload: Operation) {
	const id = String(payload.mailboxId);
	await requireMailboxOwner(env, auth, id);
	const result = await listKeys(env, auth, { mailboxId: id });
	const keys = (result.value as { keys?: TransactionalApiKeyProjection[] } | undefined)?.keys ?? [];
	const key = keys.find((k) => k.keyId === payload.keyId);
	if (!key) throw new AdminError("Key not found", "key_not_found", 404);
	if (key.status !== "active") throw new AdminError("Key not active", "key_not_active", 400);
	return key;
}
/** Positive rules (`!` denies) whose domain part is a wildcard match arbitrary recipients. */
function wildcardDomainRules(policy: string): string[] {
	return policy
		.split(",")
		.map((rule) => rule.trim())
		.filter((rule) => !rule.startsWith("!") && (rule.split("@")[1] ?? "").includes("*"));
}
function policyWarnings(policy: string | null | undefined, sends: boolean): IntentWarning[] {
	if (!sends) return [];
	if (!policy?.trim())
		return [
			{
				code: "no_recipient_policy",
				message: "Sin política de destinatarios: puede enviar a cualquiera.",
			},
		];
	if (wildcardDomainRules(policy).length)
		return [
			{
				code: "permissive_recipient_policy",
				message: `Política de destinatarios permisiva (comodín en el dominio): ${wildcardDomainRules(policy).join(", ")}`,
			},
		];
	return [];
}
const keyFields = (k: TransactionalApiKeyProjection): IntentField[] => [
	{ label: "Clave", value: `…${k.displaySuffix} (${k.environment})` },
	{ label: "Remitente", value: k.sender },
	{ label: "Nombre del remitente", value: show(k.senderName) },
	{ label: "Permisos", value: k.scopes.join(", ") },
	{ label: "Plantillas permitidas", value: show(k.templateAllowlist?.join(", ")) },
	{ label: "Política de destinatarios", value: show(k.recipientPolicy), format: "pre" },
];

/** Splits the plaintext key out of a service response; nothing else of it is kept. */
function redactSecret(result: unknown): { stored: unknown; secrets?: IntentField[] } {
	const value = (result as { value?: Record<string, unknown> } | null)?.value ?? {};
	const projection = (value.projection ?? value.key) as
		| Partial<TransactionalApiKeyProjection>
		| undefined;
	const stored = {
		keyId: projection?.keyId ?? null,
		displaySuffix: projection?.displaySuffix ?? null,
		environment: projection?.environment ?? null,
		status: projection?.status ?? null,
		secretIssued: typeof value.plaintextKey === "string",
	};
	return typeof value.plaintextKey === "string"
		? {
				stored,
				secrets: [{ label: "Clave API (solo se muestra una vez)", value: value.plaintextKey }],
			}
		: { stored };
}

registerControlPlaneKind("api_key_create", {
	approval: "required",
	covers: ["mailboxId", "body"],
	validate: (value) => {
		const row = strict(createSchema, value);
		strict(createTransactionalApiKeySchema, row.body);
		return row;
	},
	render: async (env, auth, payload) => {
		await requireMailboxOwner(env, auth, String(payload.mailboxId));
		const body = payload.body as z.infer<typeof createSchema>["body"];
		const warnings: IntentWarning[] = [];
		if (body.environment === "live")
			warnings.push({
				code: "live_key",
				message: "Clave de producción: podrá enviar correo real.",
			});
		warnings.push(
			...policyWarnings(body.recipientPolicy, body.scopes.includes("transactional:send")),
		);
		return {
			title: "Crear clave API",
			fields: [
				{ label: "Entorno", value: body.environment },
				{ label: "Remitente", value: body.sender },
				{ label: "Nombre del remitente", value: show(body.senderName) },
				{ label: "Permisos", value: body.scopes.join(", ") },
				{ label: "Plantillas permitidas", value: show(body.templateAllowlist?.join(", ")) },
				{ label: "Política de destinatarios", value: show(body.recipientPolicy), format: "pre" },
				{ label: "Cuota", value: show(body.quotaMax) },
				{ label: "Caduca", value: show(body.expiresAt) },
			],
			warnings,
		};
	},
	execute: async (env, auth, payload) =>
		createKey(env, auth, { mailboxId: String(payload.mailboxId), body: payload.body }),
	redact: redactSecret,
});

registerControlPlaneKind("api_key_rotate", {
	approval: "required",
	covers: ["mailboxId", "keyId"],
	validate: (value) => strict(keySchema, value),
	render: async (env, auth, payload) => {
		const key = await activeKey(env, auth, payload);
		return {
			title: "Rotar clave API",
			fields: [
				...keyFields(key),
				{ label: "Cuota", value: show(key.quotaMax) },
				{ label: "Caduca", value: show(key.expiresAt) },
			],
			warnings: [
				{ code: "key_rotated", message: "La clave actual dejará de funcionar al aprobar." },
				...policyWarnings(key.recipientPolicy, key.scopes.includes("transactional:send")),
			],
		};
	},
	execute: async (env, auth, payload) => {
		await activeKey(env, auth, payload);
		return rotateKey(env, auth, {
			mailboxId: String(payload.mailboxId),
			keyId: String(payload.keyId),
		});
	},
	redact: redactSecret,
});

registerControlPlaneKind("api_key_revoke", {
	approval: "direct",
	covers: ["mailboxId", "keyId"],
	validate: (value) => strict(keySchema, value),
	render: async (env, auth, payload) => {
		const key = await activeKey(env, auth, payload);
		return {
			title: "Revocar clave API",
			fields: keyFields(key),
			warnings: [
				{
					code: "key_revoked",
					message: "Las integraciones que usen esta clave dejarán de funcionar.",
				},
			],
		};
	},
	execute: async (env, auth, payload) => {
		await activeKey(env, auth, payload);
		const result = await revokeKey(env, auth, {
			mailboxId: String(payload.mailboxId),
			keyId: String(payload.keyId),
		});
		return redactSecret(result).stored;
	},
});

/**
 * Scopes are immutable on an existing key, so changing them issues a replacement key with the
 * same settings and revokes the old one. The new secret is revealed once, like a create.
 */
registerControlPlaneKind("api_key_scopes", {
	approval: "required",
	covers: ["mailboxId", "keyId", "scopes", "templateAllowlist"],
	validate: (value) => strict(scopesSchema, value),
	render: async (env, auth, payload) => {
		const key = await activeKey(env, auth, payload);
		const next = payload.scopes as string[];
		const nextList = payload.templateAllowlist as string[] | undefined;
		return {
			title: "Cambiar permisos de clave API",
			fields: [
				...keyFields(key).filter(
					(f) => f.label !== "Permisos" && f.label !== "Plantillas permitidas",
				),
				{ label: "Permisos", value: `${key.scopes.join(", ")} → ${next.join(", ")}` },
				{
					label: "Plantillas permitidas",
					value: `${show(key.templateAllowlist?.join(", "))} → ${show((nextList ?? key.templateAllowlist)?.join(", "))}${nextList === undefined ? " (sin cambios)" : ""}`,
				},
				{ label: "Cuota", value: show(key.quotaMax) },
				{ label: "Caduca", value: show(key.expiresAt) },
			],
			warnings: [
				...policyWarnings(key.recipientPolicy, next.includes("transactional:send")),
				{
					code: "key_replaced",
					message:
						"Se emite una clave nueva con estos permisos y la actual se revoca. Tendrás que actualizar la integración.",
				},
			],
		};
	},
	execute: async (env, auth, payload) => {
		const key = await activeKey(env, auth, payload);
		const id = String(payload.mailboxId);
		const body = {
			environment: key.environment,
			sender: key.sender,
			senderName: key.senderName,
			scopes: payload.scopes,
			templateAllowlist:
				(payload.templateAllowlist as string[] | undefined) ?? key.templateAllowlist ?? undefined,
			recipientPolicy: key.recipientPolicy ?? undefined,
			quotaMax: key.quotaMax ?? undefined,
			expiresAt: key.expiresAt ?? undefined,
		};
		const created = await createKey(env, auth, { mailboxId: id, body });
		const fresh = redactSecret(created).stored as { keyId: string | null };
		try {
			await revokeKey(env, auth, { mailboxId: id, keyId: key.keyId });
		} catch (error) {
			if (fresh.keyId)
				await revokeKey(env, auth, { mailboxId: id, keyId: fresh.keyId }).catch(() => undefined);
			throw error;
		}
		return created;
	},
	redact: redactSecret,
});

/**
 * Edits a key's template allowlist in place. No new secret is issued: the key id and secret
 * stay the same, so the integration needs no change.
 */
registerControlPlaneKind("api_key_templates", {
	approval: "direct",
	covers: ["mailboxId", "keyId", "add", "remove", "set"],
	validate: (value) => {
		const row = strict(templatesSchema, value);
		strict(updateKeyTemplatesSchema, { add: row.add, remove: row.remove, set: row.set });
		return row;
	},
	render: async (env, auth, payload) => {
		const key = await activeKey(env, auth, payload);
		const input = payload as { add?: string[]; remove?: string[]; set?: string[] };
		const before = key.templateAllowlist ?? [];
		const after = nextAllowlist(before, input);
		const added = after.filter((id) => !before.includes(id));
		const removed = before.filter((id) => !after.includes(id));
		const listed = await listTemplates(env, auth, { mailboxId: String(payload.mailboxId) });
		const existing = new Set(
			(
				(
					listed.value as {
						templates?: Array<{
							templateId?: string;
							id?: string;
							status?: string;
							archivedAt?: string | null;
						}>;
					} | null
				)?.templates ?? []
			)
				.filter((t) => t.status === undefined || t.status === "active")
				.filter((t) => !t.archivedAt)
				.map((t) => String(t.templateId ?? t.id)),
		);
		const warnings: IntentWarning[] = added
			.filter((id) => !existing.has(id))
			.map((id) => ({
				code: "template_missing",
				message: `la plantilla ${id} no existe todavía`,
			}));
		if (key.scopes.includes("transactional:send") && after.length === 0)
			warnings.push({
				code: "send_without_templates",
				message: "Una clave con permiso de envío necesita al menos una plantilla.",
			});
		const mark = (id: string) => (added.includes(id) ? `+${id}` : id);
		return {
			title: "Cambiar plantillas permitidas de clave API",
			fields: [
				...keyFields(key).filter((f) => f.label !== "Plantillas permitidas"),
				{
					label: "Plantillas permitidas",
					value: `${show(before.join(", "))} → ${show(after.map(mark).join(", "))}`,
				},
				{ label: "Añadidas", value: show(added.join(", ")) },
				{ label: "Quitadas", value: show(removed.join(", ")) },
			],
			warnings,
		};
	},
	execute: async (env, auth, payload) => {
		const input = payload as { add?: string[]; remove?: string[]; set?: string[] };
		const result = await updateKeyTemplates(env, auth, {
			mailboxId: String(payload.mailboxId),
			keyId: String(payload.keyId),
			add: input.add,
			remove: input.remove,
			set: input.set,
		});
		return redactSecret(result).stored;
	},
	redact: redactSecret,
});
