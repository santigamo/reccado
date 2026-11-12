import type { AuthContext } from "../../api/auth";
import { insertOpsEvent } from "../../db/d1";

export type SnapshotEntity = "mailbox" | "domain" | "alias" | "routing_rule" | "template";

/** Before-snapshot an owner can later reapply with the `restore` kind. */
export async function writeBeforeSnapshot(
	env: Env,
	auth: AuthContext,
	entity: SnapshotEntity,
	subject: string,
	row: Record<string, unknown>,
): Promise<string> {
	const id = crypto.randomUUID();
	await insertOpsEvent(env.INDEX_DB, {
		id,
		event_type: "admin.before_snapshot",
		severity: "info",
		subject,
		payload_json: JSON.stringify({ entity, by: auth.email, ...row }),
	});
	return id;
}
