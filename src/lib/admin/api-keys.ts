import { parseAdmin, readAdminResponse, type AdminProxyResult } from "./errors";
import type { AuthContext } from "../../api/auth";
import {
	createTransactionalApiKeySchema,
	updateTransactionalApiKeySchema,
} from "../../api/schemas";
import { getMailbox, upsertApiKeyProjection } from "../../db/d1";
import { AdminError } from "./errors";
import { mailboxStub } from "../mailbox-stub";
import type { TransactionalApiKeyProjection } from "../transactional-keys";
import { requireMailboxOwner } from "./access";

async function project(
	env: Env,
	key: Omit<TransactionalApiKeyProjection, "quotaUsed" | "senderName">,
) {
	try {
		await upsertApiKeyProjection(env.INDEX_DB, {
			key_id: key.keyId,
			mailbox_id: key.mailboxId,
			sender: key.sender,
			display_suffix: key.displaySuffix,
			environment: key.environment,
			scopes_json: JSON.stringify(key.scopes),
			template_allowlist_json: key.templateAllowlist ? JSON.stringify(key.templateAllowlist) : null,
			recipient_policy: key.recipientPolicy ?? null,
			quota_max: key.quotaMax ?? null,
			quota_used: 0,
			expires_at: key.expiresAt ?? null,
			status: key.status as "active" | "revoked",
			created_at: key.createdAt,
			updated_at: key.updatedAt,
			revoked_at: key.revokedAt ?? null,
		});
	} catch (error) {
		console.error("api_key_projection_failed", {
			keyId: key.keyId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
async function stub(env: Env, mailboxId: string) {
	if (!(await getMailbox(env.INDEX_DB, mailboxId)))
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return mailboxStub(env, mailboxId);
}
async function read<T>(
	response: Response,
): Promise<{ data: T | null; response: AdminProxyResult }> {
	const result = await readAdminResponse(response);
	return { data: (result.value ?? null) as T | null, response: result };
}
type Input = { mailboxId: string };
type KeyInput = Input & { keyId: string };
export async function createKey(env: Env, actor: AuthContext, input: Input & { body: unknown }) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const body = parseAdmin(createTransactionalApiKeySchema, await input.body);
	const ownerStub = await stub(env, input.mailboxId);
	const { data, response } = await read<{
		key?: TransactionalApiKeyProjection;
		projection?: TransactionalApiKeyProjection;
	}>(
		await ownerStub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	const projection = data?.projection ?? data?.key;
	if (projection) await project(env, projection);
	return response;
}
export async function listKeys(env: Env, actor: AuthContext, input: Input) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	return readAdminResponse(
		await (await stub(env, input.mailboxId)).fetch("https://mailbox-do/transactional/api-keys", {
			method: "GET",
		}),
	);
}
export async function revokeKey(env: Env, actor: AuthContext, input: KeyInput) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const ownerStub = await stub(env, input.mailboxId);
	const { data, response } = await read<{ key?: { projection?: TransactionalApiKeyProjection } }>(
		await ownerStub.fetch(`https://mailbox-do/transactional/api-keys/${input.keyId}/revoke`, {
			method: "POST",
		}),
	);
	if (data?.key?.projection) await project(env, data.key.projection);
	return response;
}
export async function patchKey(env: Env, actor: AuthContext, input: KeyInput & { body: unknown }) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const body = parseAdmin(updateTransactionalApiKeySchema, await input.body);
	const ownerStub = await stub(env, input.mailboxId);
	const { data, response } = await read<{ key?: { projection?: TransactionalApiKeyProjection } }>(
		await ownerStub.fetch(
			`https://mailbox-do/transactional/api-keys/${encodeURIComponent(input.keyId)}`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ senderName: body.senderName }),
			},
		),
	);
	if (data?.key?.projection) await project(env, data.key.projection);
	return response;
}
export async function rotateKey(env: Env, actor: AuthContext, input: KeyInput) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	const ownerStub = await stub(env, input.mailboxId);
	const { data, response } = await read<{
		key?: TransactionalApiKeyProjection;
		previousKeyProjection?: TransactionalApiKeyProjection;
	}>(
		await ownerStub.fetch(`https://mailbox-do/transactional/api-keys/${input.keyId}/rotate`, {
			method: "POST",
		}),
	);
	if (data?.previousKeyProjection) await project(env, data.previousKeyProjection);
	if (data?.key) await project(env, data.key);
	return response;
}
