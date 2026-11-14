import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationPolicies from "../../migrations/d1/0029_mcp_client_policies.sql?raw";
import migrationDrop from "../../migrations/d1/0030_drop_mcp_client_policies.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const db = env.INDEX_DB;
const hasTable = async () =>
	(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_policies'").first()) !== null;

describe("migration 0030: drop mcp_client_policies", () => {
	it("drops the table on a database that has it, keeps the approvals columns, and is idempotent", async () => {
		await applyMigrations(db, migrationTelegram, migrationApprovals, migrationPolicies);
		expect(await hasTable()).toBe(true);
		await applyMigrations(db, migrationDrop);
		expect(await hasTable()).toBe(false);
		const columns = (await db.prepare("PRAGMA table_info(approvals)").all<{ name: string }>()).results.map((c) => c.name);
		expect(columns).toEqual(expect.arrayContaining(["approved_via", "auto_refused"]));
		await applyMigrations(db, migrationDrop);
		expect(await hasTable()).toBe(false);
	});
});
