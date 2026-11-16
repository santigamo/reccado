import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import {
	getAlias,
	getDomainById,
	getDomainByName,
	getMailbox,
	getRoutingRule,
	listDomains,
	type RoutingRuleRow,
} from "../../db/d1";
import { assertAdminAccess, requireMailboxOwner } from "../admin/access";
import { AdminError } from "../admin/errors";
import { createAlias, createRule, deleteAlias, deleteRule, patchRule } from "../admin/routing";
import { registerControlPlaneKind, show, strict, type Operation } from "../control-plane-registry";
import { writeBeforeSnapshot } from "./snapshot";

const aliasAddSchema = z
	.object({ aliasAddress: z.string().email().max(254), mailboxId: z.string().min(1).max(100) })
	.strict();
const aliasRemoveSchema = z.object({ aliasAddress: z.string().email().max(254) }).strict();
const ruleFields = {
	pattern: z.string().min(1).max(200),
	priority: z.number().int().min(0).max(100000),
	action: z.enum(["store", "forward", "reject"]),
	mailboxId: z.string().min(1).max(100).nullable(),
	forwardTo: z.array(z.string().email().max(254)).max(20),
	rejectReason: z.string().max(200).nullable(),
	enabled: z.boolean(),
};
const ruleUpsertSchema = z
	.object({
		ruleId: z.string().min(1).max(100).optional(),
		domainId: z.string().min(1).max(100).optional(),
		pattern: ruleFields.pattern.optional(),
		priority: ruleFields.priority.optional(),
		action: ruleFields.action.optional(),
		mailboxId: ruleFields.mailboxId.optional(),
		forwardTo: ruleFields.forwardTo.optional(),
		rejectReason: ruleFields.rejectReason.optional(),
		enabled: ruleFields.enabled.optional(),
	})
	.strict()
	.superRefine((row, ctx) => {
		if (row.ruleId) {
			if (row.domainId !== undefined)
				ctx.addIssue({ code: "custom", path: ["domainId"], message: "domainId is fixed" });
			if (Object.keys(row).length < 2)
				ctx.addIssue({ code: "custom", message: "Provide at least one field to update" });
		} else if (
			!row.domainId ||
			row.pattern === undefined ||
			row.priority === undefined ||
			row.action === undefined
		) {
			ctx.addIssue({ code: "custom", message: "domainId, pattern, priority, action required" });
		}
	});
const ruleRemoveSchema = z.object({ ruleId: z.string().min(1).max(100) }).strict();

async function ownedMailbox(env: Env, auth: AuthContext, mailboxId: string) {
	await requireMailboxOwner(env, auth, mailboxId);
	const mailbox = await getMailbox(env.INDEX_DB, mailboxId);
	if (!mailbox) throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return mailbox;
}

/** Destinations outside the owner's registered domains. */
export async function externalAddresses(env: Env, addresses: string[]): Promise<string[]> {
	const owned = new Set((await listDomains(env.INDEX_DB)).map((d) => d.domain.toLowerCase()));
	return addresses.filter((address) => !owned.has((address.split("@")[1] ?? "").toLowerCase()));
}

async function externalForwards(env: Env, addresses: string[]) {
	return (await externalAddresses(env, addresses)).map((address) => ({
		code: "external_forward",
		message: `Reenvío a una dirección externa: ${address}`,
	}));
}

/** A forward rule needs owner approval iff its effective destination list leaves the owner's domains. */
async function ruleApproval(env: Env, _auth: AuthContext, payload: Operation) {
	const p = payload as z.infer<typeof ruleUpsertSchema>;
	const before = p.ruleId ? await getRoutingRule(env.INDEX_DB, p.ruleId) : null;
	const action = p.action ?? before?.action;
	if (action !== "forward") return "direct" as const;
	const forward = p.forwardTo ?? (before ? (JSON.parse(before.forward_to_json) as string[]) : []);
	return (await externalAddresses(env, forward)).length
		? ("required" as const)
		: ("direct" as const);
}

async function checkRuleOwnership(
	env: Env,
	auth: AuthContext,
	ids: Array<string | null | undefined>,
) {
	assertAdminAccess(env, auth, "");
	for (const id of ids) if (id) await ownedMailbox(env, auth, id);
}

async function renderRule(env: Env, auth: AuthContext, payload: Operation) {
	const p = payload as z.infer<typeof ruleUpsertSchema>;
	let before: RoutingRuleRow | null = null;
	if (p.ruleId) {
		before = await getRoutingRule(env.INDEX_DB, p.ruleId);
		if (!before) throw new AdminError("Routing rule not found", "routing_rule_not_found", 404);
	}
	const domainId = before?.domain_id ?? p.domainId!;
	const domain = await getDomainById(env.INDEX_DB, domainId);
	if (!domain) throw new AdminError("Domain not found", "domain_not_found", 400);
	await checkRuleOwnership(env, auth, [before?.mailbox_id, p.mailboxId]);
	const oldForward = before ? (JSON.parse(before.forward_to_json) as string[]) : [];
	const forward = p.forwardTo ?? oldForward;
	const action = p.action ?? before?.action;
	const fields = [{ label: "Dominio", value: domain.domain }];
	const diff = (label: string, old: unknown, next: unknown) => {
		if (next === undefined) return;
		fields.push({ label, value: before ? `${show(old)} → ${show(next)}` : show(next) });
	};
	diff("Patrón", before?.pattern, p.pattern);
	diff("Prioridad", before?.priority, p.priority);
	diff("Acción", before?.action, p.action);
	diff("Buzón", before?.mailbox_id, p.mailboxId);
	diff("Reenviar a", oldForward.join(", "), p.forwardTo?.join(", "));
	diff("Motivo de rechazo", before?.reject_reason, p.rejectReason);
	diff("Activa", before ? Boolean(before.enabled) : undefined, p.enabled);
	return {
		title: before ? "Actualizar regla de enrutado" : "Crear regla de enrutado",
		fields,
		warnings: action === "forward" ? await externalForwards(env, forward) : [],
	};
}

registerControlPlaneKind("alias_add", {
	approval: "direct",
	covers: ["aliasAddress", "mailboxId"],
	validate: (value) => strict(aliasAddSchema, value),
	render: async (env, auth, payload) => {
		const mailbox = await ownedMailbox(env, auth, String(payload.mailboxId));
		const address = String(payload.aliasAddress).trim().toLowerCase();
		if (await getAlias(env.INDEX_DB, address))
			throw new AdminError("Alias already exists", "alias_exists", 409);
		const domain = await getDomainByName(env.INDEX_DB, address.split("@")[1] ?? "");
		if (!domain) throw new AdminError("Domain not registered", "domain_not_found", 400);
		return {
			title: "Añadir alias",
			fields: [
				{ label: "Alias", value: address },
				{ label: "Buzón", value: mailbox.primary_address },
			],
			warnings: [],
		};
	},
	execute: async (env, auth, payload) => {
		await ownedMailbox(env, auth, String(payload.mailboxId));
		return createAlias(env, auth, payload);
	},
});

async function ownedAlias(env: Env, auth: AuthContext, aliasAddress: string) {
	const address = aliasAddress.trim().toLowerCase();
	const alias = await getAlias(env.INDEX_DB, address);
	if (!alias) throw new AdminError("Alias not found", "alias_not_found", 404);
	const mailbox = await ownedMailbox(env, auth, alias.mailbox_id);
	return { alias, mailbox };
}
registerControlPlaneKind("alias_remove", {
	approval: "direct",
	covers: ["aliasAddress"],
	validate: (value) => strict(aliasRemoveSchema, value),
	render: async (env, auth, payload) => {
		const { alias, mailbox } = await ownedAlias(env, auth, String(payload.aliasAddress));
		return {
			title: "Eliminar alias",
			fields: [
				{ label: "Alias", value: alias.alias_address },
				{ label: "Buzón", value: mailbox.primary_address },
			],
			warnings:
				alias.alias_address === mailbox.primary_address
					? [
							{
								code: "primary_alias",
								message: "Es la dirección principal del buzón: dejará de recibir correo.",
							},
						]
					: [{ code: "alias_removed", message: "El correo a este alias dejará de entregarse." }],
		};
	},
	execute: async (env, auth, payload) => {
		const { alias } = await ownedAlias(env, auth, String(payload.aliasAddress));
		await writeBeforeSnapshot(env, auth, "alias", alias.alias_address, { ...alias });
		return deleteAlias(env, auth, { aliasAddress: alias.alias_address });
	},
});

registerControlPlaneKind("routing_rule_upsert", {
	approval: ruleApproval,
	covers: [
		"ruleId",
		"domainId",
		"pattern",
		"priority",
		"action",
		"mailboxId",
		"forwardTo",
		"rejectReason",
		"enabled",
	],
	validate: (value) => strict(ruleUpsertSchema, value),
	render: renderRule,
	execute: async (env, auth, payload) => {
		await renderRule(env, auth, payload);
		const p = payload as z.infer<typeof ruleUpsertSchema>;
		if (!p.ruleId) return createRule(env, auth, payload);
		const { ruleId, ...body } = p;
		const before = (await getRoutingRule(env.INDEX_DB, ruleId))!;
		await writeBeforeSnapshot(env, auth, "routing_rule", ruleId, { ...before });
		return patchRule(env, auth, { ruleId, body });
	},
});

async function ownedRule(env: Env, auth: AuthContext, ruleId: string) {
	const rule = await getRoutingRule(env.INDEX_DB, ruleId);
	if (!rule) throw new AdminError("Routing rule not found", "routing_rule_not_found", 404);
	await checkRuleOwnership(env, auth, [rule.mailbox_id]);
	return rule;
}
registerControlPlaneKind("routing_rule_remove", {
	approval: "direct",
	covers: ["ruleId"],
	validate: (value) => strict(ruleRemoveSchema, value),
	render: async (env, auth, payload) => {
		const rule = await ownedRule(env, auth, String(payload.ruleId));
		const domain = await getDomainById(env.INDEX_DB, rule.domain_id);
		return {
			title: "Eliminar regla de enrutado",
			fields: [
				{ label: "Dominio", value: show(domain?.domain) },
				{ label: "Patrón", value: rule.pattern },
				{ label: "Acción", value: rule.action },
			],
			warnings: [
				{
					code: "rule_removed",
					message: "El correo que coincidía con esta regla se enrutará de otra forma.",
				},
			],
		};
	},
	execute: async (env, auth, payload) => {
		const rule = await ownedRule(env, auth, String(payload.ruleId));
		await writeBeforeSnapshot(env, auth, "routing_rule", rule.id, { ...rule });
		return deleteRule(env, auth, { ruleId: rule.id });
	},
});
