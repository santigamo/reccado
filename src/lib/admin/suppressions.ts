import type { AuthContext } from "../../api/auth";
import { mailboxStub } from "../mailbox-stub";
import { requireMailboxOwner } from "./access";
import { AdminError, readAdminResponse } from "./errors";

export async function listSuppressions(env: Env, actor: AuthContext, input: { mailboxId: string }) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	return readAdminResponse(
		await mailboxStub(env, input.mailboxId).fetch("https://mailbox-do/transactional/suppressions"),
	);
}
export async function removeSuppression(
	env: Env,
	actor: AuthContext,
	input: {
		mailboxId: string;
		body:
			| { email: string; allowProviderRemoval?: boolean }
			| Promise<{ email: string; allowProviderRemoval?: boolean }>;
	},
) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const body = await input.body;
	if (!body.email) throw new AdminError("Email required", "email_required", 400, false);
	return readAdminResponse(
		await mailboxStub(env, input.mailboxId).fetch("https://mailbox-do/transactional/suppressions", {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				email: body.email,
				allowProviderRemoval: body.allowProviderRemoval ?? false,
			}),
		}),
	);
}
