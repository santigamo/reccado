/**
 * `address_route`: make Cloudflare Email Routing deliver one Reccado address to this Worker.
 *
 * The agent-side twin of the web "Route it" button (`POST /api/cloudflare/domains/:domain/routing`).
 * It changes Cloudflare state, so it is approval-gated for every token: requested over MCP it
 * only creates an approval, and on the owner's approval it runs the very same `routeAddress`
 * the web endpoint uses — same refusals (never overwrite a rule, catch-all conflicts, routing
 * off, token missing or without permission, unknown address, ...), same single literal
 * `to:<address> -> <this Worker>` rule, same `admin.cloudflare_route_*` ops events.
 *
 * `render` is D1-only (no Cloudflare call before approval): it refuses what can never succeed
 * (unregistered or inactive domain, an address Reccado does not file, a mailbox the owner does
 * not own), and warns when this Worker cannot reach Cloudflare at all. Refusals that only
 * Cloudflare can tell (conflict, routing off, permission, ...) surface after approval as a
 * failed execution whose `detail` says why and what to do.
 */
import { z } from "zod";
import type { AuthContext } from "../../api/auth";
import { getAlias, getDomainByName, listMailboxes } from "../../db/d1";
import { assertAdminAccess, requireMailboxOwner } from "../admin/access";
import { REFUSAL_STATUS, type RouteRefusalReason, routeAddress } from "../admin/cloudflare-routing";
import type { IntentField } from "../approvals";
import {
	ControlPlaneRefusal,
	type ExecutionItem,
	type Operation,
	registerControlPlaneKind,
	strict,
} from "../control-plane-registry";

const schema = z
	.object({
		domain: z
			.string()
			.trim()
			.toLowerCase()
			.min(3)
			.max(253)
			.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
		address: z.string().trim().toLowerCase().email().max(254),
	})
	.strict()
	.refine((p) => p.address.endsWith(`@${p.domain}`), {
		path: ["address"],
		message: "address must be on domain",
	});
type Payload = z.infer<typeof schema>;

function refuse(reason: RouteRefusalReason, message: string, remedy: string): never {
	throw new ControlPlaneRefusal(message, reason, REFUSAL_STATUS[reason], {
		reason,
		message,
		remedy,
	});
}

/** D1 preflight: the same address/domain conditions `routeAddress` checks, plus ownership. */
async function target(env: Env, auth: AuthContext, payload: Operation) {
	assertAdminAccess(env, auth, "");
	const { domain: name, address } = payload as Payload;
	const domain = await getDomainByName(env.INDEX_DB, name);
	if (!domain)
		refuse(
			"domain_not_found",
			`${name} is not registered in Reccado.`,
			"Add the domain first (manage_domain add).",
		);
	if (domain.status !== "active")
		refuse(
			"domain_inactive",
			`${name} is ${domain.status} in Reccado.`,
			`Turn ${name} back on first.`,
		);
	const mailbox = (await listMailboxes(env.INDEX_DB)).find(
		(m) => m.status === "active" && m.primary_address.toLowerCase() === address,
	);
	const alias = mailbox ? null : await getAlias(env.INDEX_DB, address);
	const mailboxId = mailbox?.mailbox_id ?? (alias?.status === "active" ? alias.mailbox_id : null);
	if (!mailboxId)
		refuse(
			"address_unknown",
			`${address} is not an active mailbox or alias in Reccado.`,
			"Create the mailbox (or alias) first. Reccado only routes addresses it files.",
		);
	await requireMailboxOwner(env, auth, mailboxId);
	return { domain, address, via: mailbox ? ("mailbox" as const) : ("alias" as const) };
}

const ruleText = (address: string, worker: string | null) =>
	`to:${address} → Worker ${worker ?? "(desconocido)"}`;

registerControlPlaneKind("address_route", {
	approval: "required",
	covers: ["domain", "address"],
	validate: (value) => strict(schema, value),
	render: async (env, auth, payload) => {
		const { domain, address, via } = await target(env, auth, payload);
		const worker = env.WORKER_NAME?.trim() || null;
		const warnings = [
			{
				code: "cloudflare_route",
				message: `Crea una regla de Email Routing en Cloudflare (zona ${domain.domain}) que entrega ${address} a este Worker. No modifica ni borra ninguna regla existente ni el catch-all: si algo ya gestiona la dirección, no se cambia nada.`,
			},
		];
		if (!env.CLOUDFLARE_API_TOKEN?.trim())
			warnings.push({
				code: "routing_token_missing",
				message: "Este Worker no tiene CLOUDFLARE_API_TOKEN: al aprobar fallará sin cambiar nada.",
			});
		if (!worker)
			warnings.push({
				code: "routing_worker_unknown",
				message:
					"Este Worker no conoce su nombre (WORKER_NAME): al aprobar fallará sin cambiar nada.",
			});
		return {
			title: `Enrutar ${address} a este Reccado`,
			fields: [
				{ label: "Dirección", value: `${address} (${via === "mailbox" ? "buzón" : "alias"})` },
				{ label: "Dominio", value: domain.domain },
				{ label: "Zona Cloudflare", value: domain.zone_id },
				{ label: "Regla a crear", value: ruleText(address, worker) },
			],
			warnings,
		};
	},
	execute: async (env, auth, payload) => {
		const { domain, address } = await target(env, auth, payload);
		const result = await routeAddress(env, auth, { domain: domain.domain, body: { address } });
		if (!result.ok)
			throw new ControlPlaneRefusal(result.message, result.reason, REFUSAL_STATUS[result.reason], {
				reason: result.reason,
				message: result.message,
				remedy: result.remedy,
				...(result.cli ? { cli: result.cli } : {}),
				...(result.conflict ? { conflict: result.conflict } : {}),
			});
		return {
			status: result.status,
			domain: domain.domain,
			address: result.address,
			worker: result.worker,
			via: result.via,
			ruleId: result.ruleId,
		};
	},
	describeOutcome: (payload: Operation, item: ExecutionItem): IntentField[] => {
		const fields: IntentField[] = [
			{ label: "Dirección", value: String(payload.address) },
			{ label: "Dominio", value: String(payload.domain) },
		];
		if (item.status === "executed") {
			const r = (item.result ?? {}) as { status?: string; worker?: string; via?: string };
			fields.push({
				label: "Resultado",
				value:
					r.status === "created"
						? `Regla creada: ${ruleText(String(payload.address), r.worker ?? null)}`
						: `Ya estaba enrutada a ${r.worker ?? "este Worker"} (${r.via === "catch_all" ? "catch-all" : "regla existente"}); no se cambió nada.`,
			});
			return fields;
		}
		const detail = item.detail ?? {};
		fields.push({ label: "Motivo", value: String(detail.message ?? item.errorCode ?? "error") });
		if (typeof detail.remedy === "string")
			fields.push({ label: "Qué hacer", value: detail.remedy });
		if (typeof detail.cli === "string")
			fields.push({ label: "Comando", value: detail.cli, format: "pre" });
		return fields;
	},
});
