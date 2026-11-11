import { parseAdmin } from "./errors";
import type { AuthContext } from "../../api/auth";
import { assertAdminAccess } from "./access";
import {
	createAliasSchema,
	updateAliasSchema,
	createRoutingRuleSchema,
	updateRoutingRuleSchema,
} from "../../api/schemas";
import {
	deleteAlias as deleteAliasRow,
	deleteRoutingRule as deleteRuleRow,
	getAlias,
	getDomainById,
	getDomainByName,
	getMailbox,
	getRoutingRule,
	insertAlias,
	insertRoutingRule,
	listAliases as listAliasRows,
	listRoutingRules,
	updateAlias,
	updateRoutingRule,
} from "../../db/d1";
import { AdminError } from "./errors";

export async function listAliases(env: Env, actor: AuthContext) {
	assertAdminAccess(env, actor, "");
	return { aliases: await listAliasRows(env.INDEX_DB) };
}
export async function createAlias(env: Env, actor: AuthContext, input: unknown) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(createAliasSchema, input);
	const aliasAddress = body.aliasAddress.trim().toLowerCase();
	if (!(await getMailbox(env.INDEX_DB, body.mailboxId)))
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	const domainName = aliasAddress.split("@")[1];
	if (!domainName) throw new AdminError("Invalid alias address", "invalid_alias", 400);
	const domain = await getDomainByName(env.INDEX_DB, domainName);
	if (!domain) throw new AdminError("Domain not registered", "domain_not_found", 400);
	await insertAlias(env.INDEX_DB, {
		alias_address: aliasAddress,
		mailbox_id: body.mailboxId,
		domain_id: domain.id,
		status: "active",
	});
	return { alias: { alias_address: aliasAddress, mailbox_id: body.mailboxId } };
}
export async function patchAlias(
	env: Env,
	actor: AuthContext,
	input: { aliasAddress: string; body: unknown },
) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(updateAliasSchema, input.body);
	const aliasAddress = input.aliasAddress.trim().toLowerCase();
	if (!(await updateAlias(env.INDEX_DB, aliasAddress, { status: body.status })))
		throw new AdminError("Alias not found", "alias_not_found", 404);
	return { alias: await getAlias(env.INDEX_DB, aliasAddress) };
}
export async function deleteAlias(env: Env, actor: AuthContext, input: { aliasAddress: string }) {
	assertAdminAccess(env, actor, "");
	const aliasAddress = input.aliasAddress.trim().toLowerCase();
	if (!(await deleteAliasRow(env.INDEX_DB, aliasAddress)))
		throw new AdminError("Alias not found", "alias_not_found", 404);
	return { aliasAddress, deleted: "hard" as const };
}
export async function listRules(env: Env, actor: AuthContext, input: { domainId?: string }) {
	assertAdminAccess(env, actor, "");
	return { rules: await listRoutingRules(env.INDEX_DB, input.domainId) };
}
async function validateRule(
	env: Env,
	action: string,
	mailboxId: string | null | undefined,
	forwardTo: string[],
) {
	if (action === "store") {
		if (!mailboxId)
			throw new AdminError("Store routing rules require mailboxId", "mailbox_id_required", 400);
		if (!(await getMailbox(env.INDEX_DB, mailboxId)))
			throw new AdminError("Mailbox not found", "mailbox_not_found", 400);
	}
	if (action === "forward" && forwardTo.length === 0)
		throw new AdminError(
			"Forward routing rules require at least one destination",
			"forward_to_required",
			400,
		);
}
export async function createRule(env: Env, actor: AuthContext, input: unknown) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(createRoutingRuleSchema, input);
	if (!(await getDomainById(env.INDEX_DB, body.domainId)))
		throw new AdminError("Domain not found", "domain_not_found", 400);
	await validateRule(env, body.action, body.mailboxId, body.forwardTo ?? []);
	const id = crypto.randomUUID();
	await insertRoutingRule(env.INDEX_DB, {
		id,
		domain_id: body.domainId,
		pattern: body.pattern,
		priority: body.priority,
		action: body.action,
		mailbox_id: body.mailboxId ?? null,
		forward_to_json: JSON.stringify(body.forwardTo ?? []),
		reject_reason: body.rejectReason ?? null,
		enabled: body.enabled ? 1 : 0,
	});
	return { id };
}
export async function patchRule(
	env: Env,
	actor: AuthContext,
	input: { ruleId: string; body: unknown },
) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(updateRoutingRuleSchema, input.body);
	const existing = await getRoutingRule(env.INDEX_DB, input.ruleId);
	if (!existing) throw new AdminError("Routing rule not found", "routing_rule_not_found", 404);
	await validateRule(
		env,
		body.action ?? existing.action,
		body.mailboxId !== undefined ? body.mailboxId : existing.mailbox_id,
		body.forwardTo ?? (JSON.parse(existing.forward_to_json) as string[]),
	);
	await updateRoutingRule(env.INDEX_DB, input.ruleId, {
		pattern: body.pattern,
		priority: body.priority,
		action: body.action,
		mailbox_id: body.mailboxId,
		forward_to_json: body.forwardTo === undefined ? undefined : JSON.stringify(body.forwardTo),
		reject_reason: body.rejectReason,
		enabled: body.enabled === undefined ? undefined : body.enabled ? 1 : 0,
	});
	return { rule: await getRoutingRule(env.INDEX_DB, input.ruleId) };
}
export async function deleteRule(env: Env, actor: AuthContext, input: { ruleId: string }) {
	assertAdminAccess(env, actor, "");
	if (!(await deleteRuleRow(env.INDEX_DB, input.ruleId)))
		throw new AdminError("Routing rule not found", "routing_rule_not_found", 404);
	return { id: input.ruleId, deleted: "hard" as const };
}
