import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createAlias, createRule, deleteAlias, deleteRule } from "#/lib/admin/routing";
import { insertDomain, insertMailbox } from "#/db/d1";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

const actor = { userId: "owner", email: "owner@example.test", owners: ["owner@example.test"] };
const denied = { userId: "other", email: "other@example.test", owners: ["owner@example.test"] };
beforeAll(async () => {
	for (const sql of [migrationInitial, migrationOwner])
		for (const statement of splitSqlStatements(sql)) await env.INDEX_DB.prepare(statement).run();
	await insertDomain(env.INDEX_DB, {
		id: "domain",
		domain: "admin.test",
		zone_id: "zone",
		status: "active",
	});
	await insertMailbox(env.INDEX_DB, {
		mailbox_id: "mailbox",
		primary_address: "inbox@admin.test",
		status: "active",
		owner_email: actor.email,
		display_name: null,
	});
});
describe("routing admin service", () => {
	it("creates and removes aliases and rules", async () => {
		expect(
			(await createAlias(env, actor, { aliasAddress: "alias@admin.test", mailboxId: "mailbox" }))
				.alias.mailbox_id,
		).toBe("mailbox");
		expect((await deleteAlias(env, actor, { aliasAddress: "alias@admin.test" })).deleted).toBe(
			"hard",
		);
		const rule = await createRule(env, actor, {
			domainId: "domain",
			pattern: "*",
			priority: 1,
			action: "store",
			mailboxId: "mailbox",
		});
		expect((await deleteRule(env, actor, { ruleId: rule.id })).deleted).toBe("hard");
	});
	it("denies non-owners", async () => {
		await expect(deleteAlias(env, denied, { aliasAddress: "x@admin.test" })).rejects.toMatchObject({
			status: 403,
		});
	});
	it("rejects invalid input and reports missing rows", async () => {
		await expect(createAlias(env, actor, {})).rejects.toThrow();
		await expect(deleteRule(env, actor, { ruleId: "missing" })).rejects.toMatchObject({
			code: "routing_rule_not_found",
		});
	});
});
