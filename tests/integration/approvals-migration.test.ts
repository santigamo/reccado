import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
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
