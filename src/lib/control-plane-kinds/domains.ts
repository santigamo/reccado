import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import { getDomainById, getDomainByName, type DomainRow } from "../../db/d1";
import { assertAdminAccess } from "../admin/access";
import { AdminError } from "../admin/errors";
import { createDomain, deleteDomain, patchDomain, provisionDomain } from "../admin/domains";
import { registerControlPlaneKind, show, strict } from "../control-plane-registry";
import { writeBeforeSnapshot } from "./snapshot";

const domainName = z
	.string()
	.trim()
	.toLowerCase()
	.min(3)
	.max(253)
	.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);
const addSchema = z.object({ domain: domainName, zoneId: z.string().min(1).max(64) }).strict();
const provisionSchema = z
	.object({
		domain: domainName,
		body: z
			.object({
				subdomain: z
					.string()
					.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i)
					.optional(),
				dmarc: z
					.object({
						policy: z.enum(["none", "quarantine", "reject"]),
						alignment: z.enum(["relaxed", "strict"]).optional(),
						rua: z.string().email().optional(),
					})
					.strict(),
				inbound: z.boolean().optional(),
				mailbox: z
					.object({
						address: z.string().email(),
						displayName: z.string().max(120).optional(),
						ownerEmail: z.string().email().optional(),
					})
					.strict()
					.optional(),
			})
			.strict(),
	})
	.strict();
const updateSchema = z
	.object({
		domain: domainName,
		body: z.object({ status: z.enum(["pending", "active", "disabled"]) }).strict(),
	})
	.strict();
const disableSchema = z.object({ domain: domainName }).strict();

async function existing(env: Env, auth: AuthContext, name: string): Promise<DomainRow> {
	assertAdminAccess(env, auth, "");
	const row = await getDomainByName(env.INDEX_DB, name);
	if (!row) throw new AdminError("Domain not found", "domain_not_found", 404);
	return row;
}
async function activeMailboxCount(env: Env, name: string): Promise<number> {
	const row = await env.INDEX_DB.prepare(
		"SELECT COUNT(*) AS n FROM mailboxes WHERE status = 'active' AND primary_address LIKE ?",
	)
		.bind(`%@${name}`)
		.first<{ n: number }>();
	return row?.n ?? 0;
}
async function disableWarnings(env: Env, name: string) {
	const n = await activeMailboxCount(env, name);
	const warnings = [
		{
			code: "domain_disabled",
			message: "Desactivar el dominio deja de aceptar correo entrante para todo el dominio.",
		},
	];
	if (n > 0)
		warnings.push({
			code: "domain_has_active_mailboxes",
			message: `El dominio tiene ${n} buzón(es) activo(s) que dejarán de recibir correo.`,
		});
	return warnings;
}

registerControlPlaneKind("domain_add", {
	approval: "required",
	covers: ["domain", "zoneId"],
	validate: (value) => strict(addSchema, value),
	render: async (env, auth, payload) => {
		assertAdminAccess(env, auth, "");
		const found = await getDomainByName(env.INDEX_DB, String(payload.domain));
		return {
			title: "Registrar dominio",
			fields: [
				{ label: "Dominio", value: String(payload.domain) },
				{ label: "Zona Cloudflare", value: String(payload.zoneId) },
				...(found ? [{ label: "Estado actual", value: `ya registrado (${found.status})` }] : []),
			],
			warnings: [],
		};
	},
	execute: async (env, auth, payload) => createDomain(env, auth, payload),
});

registerControlPlaneKind("domain_provision", {
	approval: "required",
	covers: ["domain", "body"],
	validate: (value) => strict(provisionSchema, value),
	render: async (env, auth, payload) => {
		assertAdminAccess(env, auth, "");
		const body = payload.body as z.infer<typeof provisionSchema>["body"];
		const zone = String(payload.domain);
		if (
			body.mailbox?.ownerEmail &&
			body.mailbox.ownerEmail.toLowerCase() !== auth.email.toLowerCase()
		)
			throw new AdminError("Forbidden", "forbidden", 403, false);
		const sending = `${(body.subdomain ?? "send").toLowerCase()}.${zone}`;
		const warnings = [
			{
				code: "dns_changes",
				message: `Crea registros DNS y activa Email Sending para ${sending} en la zona ${zone}.`,
			},
		];
		if (body.dmarc.policy !== "none")
			warnings.push({
				code: "dmarc_enforced",
				message: `DMARC en modo ${body.dmarc.policy}: afecta al correo que ya está circulando.`,
			});
		const ruaDomain = body.dmarc.rua?.split("@")[1]?.toLowerCase();
		if (
			ruaDomain &&
			ruaDomain !== zone.toLowerCase() &&
			!ruaDomain.endsWith(`.${zone.toLowerCase()}`)
		)
			warnings.push({
				code: "dmarc_external_rua",
				message: `Los informes DMARC agregados se enviarán a una dirección externa: ${body.dmarc.rua}`,
			});
		return {
			title: "Aprovisionar dominio de envío",
			fields: [
				{ label: "Zona", value: zone },
				{ label: "Dominio de envío", value: sending },
				{ label: "DMARC política", value: body.dmarc.policy },
				{ label: "DMARC alineación", value: show(body.dmarc.alignment) },
				{ label: "DMARC informes (rua)", value: show(body.dmarc.rua) },
				{ label: "Correo entrante", value: body.inbound ? "sí" : "no" },
				...(body.mailbox
					? [
							{ label: "Buzón", value: body.mailbox.address },
							{ label: "Nombre del buzón", value: show(body.mailbox.displayName) },
							{ label: "Propietario del buzón", value: show(body.mailbox.ownerEmail) },
						]
					: []),
			],
			warnings,
		};
	},
	execute: async (env, auth, payload) => {
		const body = payload.body as z.infer<typeof provisionSchema>["body"];
		if (
			body.mailbox?.ownerEmail &&
			body.mailbox.ownerEmail.toLowerCase() !== auth.email.toLowerCase()
		)
			throw new AdminError("Forbidden", "forbidden", 403, false);
		return provisionDomain(env, auth, { domain: String(payload.domain), body: payload.body });
	},
});

registerControlPlaneKind("domain_update", {
	approval: "direct",
	covers: ["domain", "body.status"],
	validate: (value) => strict(updateSchema, value),
	render: async (env, auth, payload) => {
		const before = await existing(env, auth, String(payload.domain));
		const next = (payload.body as { status: string }).status;
		return {
			title: "Actualizar dominio",
			fields: [
				{ label: "Dominio", value: before.domain },
				{ label: "Estado", value: `${before.status} → ${show(next)}` },
			],
			warnings:
				next === "active" || next === before.status
					? []
					: await disableWarnings(env, before.domain),
		};
	},
	execute: async (env, auth, payload) => {
		const before = await existing(env, auth, String(payload.domain));
		const next = (payload.body as { status: string }).status;
		if (next !== before.status && next !== "active")
			await writeBeforeSnapshot(env, auth, "domain", before.id, { ...before });
		return patchDomain(env, auth, { domain: before.domain, body: payload.body });
	},
});

registerControlPlaneKind("domain_disable", {
	approval: "required",
	covers: ["domain"],
	validate: (value) => strict(disableSchema, value),
	render: async (env, auth, payload) => {
		const before = await existing(env, auth, String(payload.domain));
		return {
			title: "Desactivar dominio",
			fields: [
				{ label: "Dominio", value: before.domain },
				{ label: "Estado", value: `${before.status} → disabled` },
			],
			warnings: await disableWarnings(env, before.domain),
		};
	},
	execute: async (env, auth, payload) => {
		const before = await existing(env, auth, String(payload.domain));
		await writeBeforeSnapshot(env, auth, "domain", before.id, { ...before });
		return deleteDomain(env, auth, { domain: before.domain });
	},
});

export async function domainById(env: Env, id: string) {
	return getDomainById(env.INDEX_DB, id);
}
