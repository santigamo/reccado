import { parseAdmin } from "./errors";
import type { AuthContext } from "../../api/auth";
import { assertAdminAccess } from "./access";
import { createDomainSchema, updateDomainSchema, provisionDomainSchema } from "../../api/schemas";
import {
	getDomainById,
	getDomainByName,
	insertDomain,
	listDomains as listRows,
	updateDomain,
} from "../../db/d1";
import { AdminError } from "./errors";
import { provisionSendingDomain } from "../provision";
import { fetchWithTimeout, isAbortTimeoutError } from "../runtime-config";

async function findDomain(db: D1Database, param: string) {
	const trimmed = param.trim();
	return (await getDomainByName(db, trimmed.toLowerCase())) ?? (await getDomainById(db, trimmed));
}

export async function listDomains(env: Env, actor: AuthContext) {
	assertAdminAccess(env, actor, "");
	return { domains: await listRows(env.INDEX_DB) };
}

export async function createDomain(env: Env, actor: AuthContext, input: unknown) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(createDomainSchema, input);
	const name = body.domain.trim().toLowerCase();
	const existing = await getDomainByName(env.INDEX_DB, name);
	if (existing) return { domain: existing, created: false };
	await insertDomain(env.INDEX_DB, {
		id: crypto.randomUUID(),
		domain: name,
		zone_id: body.zoneId,
		status: "active",
	});
	return { domain: await getDomainByName(env.INDEX_DB, name), created: true };
}

export async function patchDomain(
	env: Env,
	actor: AuthContext,
	input: { domain: string; body: unknown },
) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(updateDomainSchema, input.body);
	const domain = await findDomain(env.INDEX_DB, input.domain);
	if (!domain) throw new AdminError("Domain not found", "domain_not_found", 404);
	await updateDomain(env.INDEX_DB, domain.id, { status: body.status });
	return { domain: await getDomainById(env.INDEX_DB, domain.id) };
}

export async function deleteDomain(env: Env, actor: AuthContext, input: { domain: string }) {
	assertAdminAccess(env, actor, "");
	const domain = await findDomain(env.INDEX_DB, input.domain);
	if (!domain) throw new AdminError("Domain not found", "domain_not_found", 404);
	await updateDomain(env.INDEX_DB, domain.id, { status: "disabled" });
	return { domain: await getDomainById(env.INDEX_DB, domain.id), deleted: "soft" as const };
}

export async function domainStatus(env: Env, actor: AuthContext, input: { domain: string }) {
	assertAdminAccess(env, actor, "");
	const domain = await getDomainByName(env.INDEX_DB, input.domain.trim().toLowerCase());
	if (!domain) throw new AdminError("Domain not found", "domain_not_found", 404, false);
	const token = env.CLOUDFLARE_API_TOKEN;
	if (!token)
		return { domain, cloudflare: { configured: false, reason: "CLOUDFLARE_API_TOKEN not set" } };
	let payload: { success?: boolean; result?: { status?: string; name?: string } };
	try {
		const response = await fetchWithTimeout(
			`https://api.cloudflare.com/client/v4/zones/${domain.zone_id}`,
			{ headers: { Authorization: `Bearer ${token}` }, timeoutMs: 5_000 },
		);
		payload = (await response.json()) as typeof payload;
	} catch (error) {
		return {
			domain,
			cloudflare: {
				configured: true,
				ok: false,
				reason: isAbortTimeoutError(error)
					? "Cloudflare API request timed out."
					: "Cloudflare API request failed.",
				status: null,
				name: null,
			},
		};
	}
	return {
		domain,
		cloudflare: {
			configured: true,
			ok: payload.success === true,
			reason: payload.success === true ? null : "Cloudflare API returned an unsuccessful response.",
			status: payload.result?.status ?? null,
			name: payload.result?.name ?? null,
		},
	};
}

export async function provisionDomain(
	env: Env,
	actor: AuthContext,
	input: { domain: string; body: unknown },
) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(provisionDomainSchema, input.body);
	const zone = input.domain.trim().toLowerCase();
	const sendingDomain = `${body.subdomain.toLowerCase()}.${zone}`;
	if (body.mailbox && !body.mailbox.address.toLowerCase().endsWith(`@${zone}`))
		throw new AdminError(
			`Mailbox ${body.mailbox.address} is not on ${zone}.`,
			"mailbox_outside_zone",
			400,
		);
	return provisionSendingDomain(env, env.INDEX_DB, {
		zone,
		sendingDomain,
		dmarc: body.dmarc,
		inbound: body.inbound,
		feedbackQueueId: env.FEEDBACK_QUEUE_ID?.trim() || undefined,
		mailbox: body.mailbox,
	});
}
