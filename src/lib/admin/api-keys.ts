import { parseAdmin, readAdminResponse, type AdminProxyResult } from "./errors";
import type { AuthContext } from "../../api/auth";
import {
	createTransactionalApiKeySchema,
	updateKeyTemplatesSchema,
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

export type KeyTemplatesInput = KeyInput & { add?: string[]; remove?: string[]; set?: string[] };

/**
 * Computes the next allowlist from a key's current one. Exactly one of `set` or
 * `add`/`remove` must be given; add/remove are relative to what is stored now.
 */
export function nextAllowlist(
	current: readonly string[] | null | undefined,
	input: { add?: string[]; remove?: string[]; set?: string[] },
): string[] {
	const hasDelta = input.add !== undefined || input.remove !== undefined;
	if ((input.set !== undefined) === hasDelta) {
		throw new AdminError(
			"Provide either set, or add/remove",
			"invalid_template_allowlist_input",
			400,
		);
	}
	if (input.set) return [...new Set(input.set.map((id) => id.trim()))];
	const removed = new Set((input.remove ?? []).map((id) => id.trim()));
	const next = (current ?? []).filter((id) => !removed.has(id));
	for (const raw of input.add ?? []) {
		const id = raw.trim();
		if (!next.includes(id)) next.push(id);
	}
	return next;
}

/** Edits a key's template allowlist in place: same key id, same secret. */
export async function updateKeyTemplates(env: Env, actor: AuthContext, input: KeyTemplatesInput) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	parseAdmin(updateKeyTemplatesSchema, {
		add: input.add,
		remove: input.remove,
		set: input.set,
	});
	const ownerStub = await stub(env, input.mailboxId);
	const listed = await read<{ keys?: TransactionalApiKeyProjection[] }>(
		await ownerStub.fetch("https://mailbox-do/transactional/api-keys", { method: "GET" }),
	);
	const existing = listed.data?.keys?.find((k) => k.keyId === input.keyId);
	if (!existing) throw new AdminError("Key not found", "key_not_found", 404);
	const next = nextAllowlist(existing.templateAllowlist, input);
	const { data, response } = await read<{ key?: { projection?: TransactionalApiKeyProjection } }>(
		await ownerStub.fetch(
			`https://mailbox-do/transactional/api-keys/${encodeURIComponent(input.keyId)}/templates`,
			{
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ templateAllowlist: next }),
			},
		),
	);
	if (data?.key?.projection) await project(env, data.key.projection);
	return response;
}
