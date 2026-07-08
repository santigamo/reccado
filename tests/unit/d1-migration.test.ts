import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { insertMailbox, listMailboxesByOwner } from "#/db/d1";
import migration1 from "../../migrations/d1/0001_initial.sql?raw";
import migration2 from "../../migrations/d1/0002_message_index.sql?raw";
import migration3 from "../../migrations/d1/0003_mailbox_owner.sql?raw";

async function applyMigrations(): Promise<void> {
	const statements = [migration1, migration2, migration3]
		.join("\n")
		.split(";")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const statement of statements) {
		await env.INDEX_DB.prepare(statement).run();
	}
}

describe("D1 migration 0003_mailbox_owner", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	it("adds owner_email column to mailboxes table", async () => {
		const result = await env.INDEX_DB
			.prepare("PRAGMA table_info(mailboxes)")
			.all<{ name: string }>();
		const columns = result.results.map((r) => r.name);
		expect(columns).toContain("owner_email");
	});

	it("creates idx_mailboxes_owner index", async () => {
		const result = await env.INDEX_DB
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mailboxes_owner'")
			.first<{ name: string }>();
		expect(result?.name).toBe("idx_mailboxes_owner");
	});

	it("existing mailboxes have NULL owner_email (fail-closed for MCP)", async () => {
		const mailboxId = "mbx_migration_null_owner";
		await env.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, 'active', NULL, ?, ?)",
		)
			.bind(mailboxId, "null-owner@example.com", new Date().toISOString(), new Date().toISOString())
			.run();

		const row = await env.INDEX_DB
			.prepare("SELECT owner_email FROM mailboxes WHERE mailbox_id = ?")
			.bind(mailboxId)
			.first<{ owner_email: string | null }>();
		expect(row?.owner_email).toBeNull();
	});

	it("listMailboxesByOwner filters by owner_email and active status", async () => {
		const owner = "owner-filter@example.com";
		const mailboxId1 = "mbx_owner_filter_1";
		const mailboxId2 = "mbx_owner_filter_2";
		const mailboxId3 = "mbx_owner_filter_disabled";

		await insertMailbox(env.INDEX_DB, {
			mailbox_id: mailboxId1,
			primary_address: "filter1@example.com",
			display_name: "Owned 1",
			status: "active",
			owner_email: owner,
		});
		await insertMailbox(env.INDEX_DB, {
			mailbox_id: mailboxId2,
			primary_address: "filter2@example.com",
			display_name: "Owned 2",
			status: "active",
			owner_email: owner,
		});
		await insertMailbox(env.INDEX_DB, {
			mailbox_id: mailboxId3,
			primary_address: "filter3@example.com",
			display_name: "Disabled",
			status: "disabled",
			owner_email: owner,
		});

		const mailboxes = await listMailboxesByOwner(env.INDEX_DB, owner);
		expect(mailboxes.length).toBeGreaterThanOrEqual(2);
		expect(mailboxes.every((m) => m.owner_email === owner)).toBe(true);
		expect(mailboxes.every((m) => m.status === "active")).toBe(true);
		expect(mailboxes.some((m) => m.mailbox_id === mailboxId1)).toBe(true);
		expect(mailboxes.some((m) => m.mailbox_id === mailboxId2)).toBe(true);
		expect(mailboxes.some((m) => m.mailbox_id === mailboxId3)).toBe(false);
	});

	it("listMailboxesByOwner is case-insensitive", async () => {
		const mailboxId = "mbx_case_insensitive";
		await insertMailbox(env.INDEX_DB, {
			mailbox_id: mailboxId,
			primary_address: "case@example.com",
			display_name: "Case Test",
			status: "active",
			owner_email: "Mixed.Case@Example.com",
		});

		const mailboxes = await listMailboxesByOwner(env.INDEX_DB, "mixed.case@example.com");
		expect(mailboxes.some((m) => m.mailbox_id === mailboxId)).toBe(true);
	});
});
