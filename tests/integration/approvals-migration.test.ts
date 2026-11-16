import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { deleteExpiredApprovals } from "#/db/d1";
import oldMigration from "../../migrations/d1/0004_telegram.sql?raw";
import migration from "../../migrations/d1/0022_approvals.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

it("preserves existing Telegram actions when migrating to approvals", async () => {
	const db = (env as unknown as Env).INDEX_DB;
	for (const statement of splitSqlStatements(oldMigration)) await db.prepare(statement).run();
	await db
		.prepare(
			"INSERT INTO telegram_actions VALUES ('token', 'confirm_send', 'mailbox', 'draft', '123', '2026-01-01', '2027-01-01')",
		)
		.run();
	for (const statement of splitSqlStatements(migration)) await db.prepare(statement).run();
	expect(await db.prepare("SELECT * FROM approvals WHERE token = 'token'").first()).toMatchObject({
		token: "token",
		kind: "confirm_send",
		mailbox_id: "mailbox",
		draft_id: "draft",
		telegram_user_id: "123",
		origin: "telegram",
		payload_hash: null,
		consumed_at: null,
	});
	await db
		.prepare(
			"INSERT INTO approvals (token, kind, created_at, expires_at, origin) VALUES ('future', 'admin_action', '2026', '2027', 'mcp')",
		)
		.run();
	expect(await db.prepare("SELECT kind FROM approvals WHERE token = 'future'").first()).toEqual({
		kind: "admin_action",
	});
});

it("retains MCP approvals for 30 days after the later terminal timestamp", async () => {
	const db = (env as unknown as Env).INDEX_DB;
	const now = Date.now();
	const iso = (days: number) => new Date(now + days * 86_400_000).toISOString();
	const insert = db.prepare(`INSERT INTO approvals
		(token, kind, created_at, expires_at, consumed_at, origin) VALUES (?, 'test', ?, ?, ?, ?)`);
	for (const [token, expires, consumed, origin] of [
		["telegram-expired", iso(-1), null, "telegram"],
		["web-expired", iso(-1), null, "web"],
		["mcp-recent-expiry", iso(-2), null, "mcp"],
		["mcp-recent-consumption", iso(-40), iso(-2), "mcp"],
		["mcp-old", iso(-40), iso(-35), "mcp"],
	] as const)
		await insert.bind(token, iso(-50), expires, consumed, origin).run();
	await deleteExpiredApprovals(db);
	for (const token of ["telegram-expired", "web-expired", "mcp-old"]) {
		expect(
			await db.prepare("SELECT token FROM approvals WHERE token = ?").bind(token).first(),
		).toBeNull();
	}
	for (const token of ["mcp-recent-expiry", "mcp-recent-consumption"]) {
		expect(
			await db.prepare("SELECT token FROM approvals WHERE token = ?").bind(token).first(),
		).not.toBeNull();
	}
});
