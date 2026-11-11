import { assertMailboxAccess, type AuthContext } from "../../api/auth";
import { getMailboxForOwner } from "../../db/d1";
import { AdminError } from "./errors";

export function assertAdminAccess(env: Env, actor: AuthContext, mailboxId: string): void {
	try {
		assertMailboxAccess(actor, mailboxId, env);
	} catch (error) {
		if (error instanceof Response && error.status === 403)
			throw new AdminError("Forbidden", "forbidden", 403, false);
		throw error;
	}
}

/** Reuses both existing checks, including the localhost-only trusted actor. */
export async function requireMailboxOwner(
	env: Env,
	actor: AuthContext,
	mailboxId: string,
): Promise<void> {
	assertAdminAccess(env, actor, mailboxId);
	if (!(await getMailboxForOwner(env.INDEX_DB, mailboxId, actor.email))) {
		throw new AdminError("Forbidden", "forbidden", 403, false);
	}
}
