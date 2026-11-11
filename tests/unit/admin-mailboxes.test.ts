import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createMailbox, deleteMailbox, patchMailbox, readMailbox } from "#/lib/admin/mailboxes";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

const actor = { userId: "owner", email: "owner@example.test", owners: ["owner@example.test"] };
const denied = { userId: "other", email: "other@example.test", owners: ["owner@example.test"] };

beforeAll(async () => {
	for (const sql of [migrationInitial, migrationOwner]) {
		for (const statement of splitSqlStatements(sql)) await env.INDEX_DB.prepare(statement).run();
	}
});

describe("mailbox admin service", () => {
	it("creates, reads, updates and disables a mailbox", async () => {
		const created = await createMailbox(env, actor, { primaryAddress: "service@example.test" });
		expect(created.created).toBe(true);
		const mailboxId = created.mailbox!.mailbox_id;
		expect((await readMailbox(env, actor, { mailboxId })).mailbox?.primary_address).toBe(
			"service@example.test",
		);
		expect(
			(await patchMailbox(env, actor, { mailboxId, body: { displayName: "Service" } })).mailbox
				?.display_name,
		).toBe("Service");
		expect((await deleteMailbox(env, actor, { mailboxId })).mailbox?.status).toBe("disabled");
	});
	it("denies non-owners before access", async () => {
		await expect(readMailbox(env, denied, { mailboxId: "missing" })).rejects.toMatchObject({
			status: 403,
		});
	});
	it("reports missing mailboxes and rejects invalid input", async () => {
		await expect(readMailbox(env, actor, { mailboxId: "missing" })).rejects.toMatchObject({
			code: "mailbox_not_found",
		});
		await expect(deleteMailbox(env, actor, { mailboxId: "missing" })).rejects.toMatchObject({
			code: "mailbox_not_found",
		});
		await expect(createMailbox(env, actor, { primaryAddress: "invalid" })).rejects.toThrow();
	});
});
