import { AdminError, parseAdmin, readAdminResponse } from "./errors";
import type { AuthContext } from "../../api/auth";
import { syncTransactionalTemplatesSchema } from "../../api/schemas";
import { getMailbox } from "../../db/d1";
import { mailboxStub } from "../mailbox-stub";
import { requireMailboxOwner } from "./access";

type TemplateInput = { mailboxId: string; templateId?: string; body?: unknown };

async function perform(
	env: Env,
	actor: AuthContext,
	input: TemplateInput,
	method: "GET" | "POST" | "PUT",
	suffix = "",
) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const body = await input.body;
	return readAdminResponse(
		await mailboxStub(env, input.mailboxId).fetch(
			`https://mailbox-do/transactional/templates${suffix}`,
			{
				method,
				...(body === undefined
					? {}
					: { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
			},
		),
	);
}

export function listTemplates(env: Env, actor: AuthContext, input: TemplateInput) {
	return perform(env, actor, input, "GET");
}
export function createTemplate(env: Env, actor: AuthContext, input: TemplateInput) {
	return perform(env, actor, input, "POST");
}
export function updateTemplate(
	env: Env,
	actor: AuthContext,
	input: TemplateInput & { templateId: string },
) {
	return perform(env, actor, input, "PUT", `/${input.templateId}`);
}
export function archiveTemplate(
	env: Env,
	actor: AuthContext,
	input: TemplateInput & { templateId: string },
) {
	return perform(env, actor, input, "POST", `/${input.templateId}/archive`);
}
export async function syncTemplates(env: Env, actor: AuthContext, input: TemplateInput) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const body = parseAdmin(syncTransactionalTemplatesSchema, await input.body);
	if (!(await getMailbox(env.INDEX_DB, input.mailboxId)))
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return readAdminResponse(
		await mailboxStub(env, input.mailboxId).fetch("https://mailbox-do/transactional/templates", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}
