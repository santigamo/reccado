#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import { deriveDevTestMailboxId } from "../src/db/seed-dev";

const secret = process.env.MAILBOX_ID_SECRET ?? "dev-mailbox-id-secret-v1";
process.env.MAILBOX_ID_SECRET = secret;

const mailboxId = await deriveDevTestMailboxId();
console.log(JSON.stringify({ mailboxId, secretUsed: secret === "dev-mailbox-id-secret-v1" ? "default-dev" : "env" }, null, 2));

if (process.argv.includes("--sql")) {
	const now = new Date().toISOString();
	console.log(`
-- Dev seed for test@example.com (mailbox_id=${mailboxId})
INSERT OR IGNORE INTO domains (id, domain, zone_id, status, created_at, updated_at)
VALUES ('dom_example_dev', 'example.com', 'dev-zone-placeholder', 'active', '${now}', '${now}');
INSERT OR IGNORE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
VALUES ('${mailboxId}', 'test@example.com', 'Dev Test Mailbox', 'active', '${now}', '${now}');
INSERT OR IGNORE INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at)
VALUES ('test@example.com', '${mailboxId}', 'dom_example_dev', 'active', '${now}', '${now}');
`);
}

if (process.argv.includes("--apply-local")) {
	const { execSync } = await import("node:child_process");
	execSync("pnpm wrangler d1 migrations apply inbox-mcp-index-dev --local", { stdio: "inherit" });
	const sql = readFileSync(new URL("../migrations/d1/0001_initial.sql", import.meta.url), "utf8");
	console.log("Run seed via wrangler d1 execute with generated SQL above, mailboxId:", mailboxId);
	void sql;
}
