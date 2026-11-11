import { parseAdmin } from "./errors";
import type { AuthContext } from "../../api/auth";
import { assertAdminAccess } from "./access";
import { createMailboxSchema, updateMailboxSchema } from "../../api/schemas";
import {
	getAlias,
	getDomainByName,
	getMailbox,
	insertAliasIfMissing,
	insertMailbox,
	listMailboxes as listRows,
	updateAlias,
	updateMailbox,
} from "../../db/d1";
import { AdminError } from "./errors";
import { mailboxIdFromPrimaryAddress } from "../mailbox-id";

async function ensurePrimaryAlias(db: D1Database, mailboxId: string, primaryAddress: string) {
	const domainName = primaryAddress.split("@")[1];
	if (!domainName)
		return { alias: null, aliasCreated: false, aliasReason: "Address has no domain part." };
	const existing = await getAlias(db, primaryAddress);
	if (existing) {
		if (existing.mailbox_id !== mailboxId)
			return {
				alias: existing,
				aliasCreated: false,
				aliasReason: `Alias ${primaryAddress} already routes to mailbox ${existing.mailbox_id}; it was left untouched.`,
			};
		if (existing.status !== "active") {
			await updateAlias(db, primaryAddress, { status: "active" });
			return {
				alias: { ...existing, status: "active" as const },
				aliasCreated: false,
				aliasReason: null,
			};
		}
		return { alias: existing, aliasCreated: false, aliasReason: null };
	}
	const domain = await getDomainByName(db, domainName);
	if (!domain)
		return {
			alias: null,
			aliasCreated: false,
			aliasReason: `Domain ${domainName} is not registered. Register it with POST /api/domains, then repeat this request to create the alias.`,
		};
	if (domain.status !== "active")
		return {
			alias: null,
			aliasCreated: false,
			aliasReason: `Domain ${domainName} is registered but ${domain.status}. Activate it, then repeat this request to create the alias.`,
		};
	const inserted = await insertAliasIfMissing(db, {
		alias_address: primaryAddress,
		mailbox_id: mailboxId,
		domain_id: domain.id,
		status: "active",
	});
	return { alias: inserted.alias, aliasCreated: inserted.created, aliasReason: null };
}

export async function listMailboxes(env: Env, actor: AuthContext) {
	assertAdminAccess(env, actor, "");
	return { mailboxes: await listRows(env.INDEX_DB) };
}

export async function createMailbox(env: Env, actor: AuthContext, input: unknown) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(createMailboxSchema, input);
	const mailboxId = await mailboxIdFromPrimaryAddress(env, body.primaryAddress);
	const existing = await getMailbox(env.INDEX_DB, mailboxId);
	if (existing)
		return {
			mailbox: existing,
			created: false as const,
			...(await ensurePrimaryAlias(env.INDEX_DB, existing.mailbox_id, existing.primary_address)),
		};
	const primaryAddress = body.primaryAddress.trim().toLowerCase();
	const storedMailboxId = await insertMailbox(env.INDEX_DB, {
		mailbox_id: mailboxId,
		primary_address: primaryAddress,
		display_name: body.displayName ?? null,
		status: "active",
		owner_email: actor.email,
	});
	const mailbox = await getMailbox(env.INDEX_DB, storedMailboxId);
	return {
		mailbox,
		created: true as const,
		...(await ensurePrimaryAlias(
			env.INDEX_DB,
			storedMailboxId,
			mailbox?.primary_address ?? primaryAddress,
		)),
	};
}

export async function readMailbox(env: Env, actor: AuthContext, input: { mailboxId: string }) {
	assertAdminAccess(env, actor, input.mailboxId);
	const mailbox = await getMailbox(env.INDEX_DB, input.mailboxId);
	if (!mailbox) throw new AdminError("Mailbox not found", "mailbox_not_found", 404, false);
	return { mailbox };
}

export async function patchMailbox(
	env: Env,
	actor: AuthContext,
	input: { mailboxId: string; body: unknown },
) {
	assertAdminAccess(env, actor, input.mailboxId);
	const body = parseAdmin(updateMailboxSchema, await input.body);
	if (
		!(await updateMailbox(env.INDEX_DB, input.mailboxId, {
			display_name: body.displayName,
			status: body.status,
		}))
	)
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return { mailbox: await getMailbox(env.INDEX_DB, input.mailboxId) };
}

export async function deleteMailbox(env: Env, actor: AuthContext, input: { mailboxId: string }) {
	assertAdminAccess(env, actor, input.mailboxId);
	if (!(await updateMailbox(env.INDEX_DB, input.mailboxId, { status: "disabled" })))
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	return { mailbox: await getMailbox(env.INDEX_DB, input.mailboxId), deleted: "soft" as const };
}
