#!/usr/bin/env tsx
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveDevTestMailboxId } from "../src/db/seed-dev";

const secret = process.env.MAILBOX_ID_SECRET ?? "dev-mailbox-id-secret-v1";
process.env.MAILBOX_ID_SECRET = secret;

const mailboxId = await deriveDevTestMailboxId();

function seedSql(now: string): string {
	return `
-- Dev seed for test@example.com (mailbox_id=${mailboxId}). Idempotent (INSERT OR IGNORE): safe to re-run.
INSERT OR IGNORE INTO domains (id, domain, zone_id, status, created_at, updated_at)
VALUES ('dom_example_dev', 'example.com', 'dev-zone-placeholder', 'active', '${now}', '${now}');
INSERT OR IGNORE INTO mailboxes (mailbox_id, primary_address, display_name, status, created_at, updated_at)
VALUES ('${mailboxId}', 'test@example.com', 'Dev Test Mailbox', 'active', '${now}', '${now}');
INSERT OR IGNORE INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at)
VALUES ('test@example.com', '${mailboxId}', 'dom_example_dev', 'active', '${now}', '${now}');
`;
}

if (process.argv.includes("--apply-local")) {
	// Same binding `pnpm dev` resolves locally (top-level `d1_databases` entry in
	// wrangler.jsonc, no --env), so this always seeds the DB the dev server actually reads.
	execSync("pnpm wrangler d1 migrations apply INDEX_DB --local", { stdio: "inherit" });

	const now = new Date().toISOString();
	const tmpDir = mkdtempSync(join(tmpdir(), "reccado-seed-dev-d1-"));
	const sqlPath = join(tmpDir, "seed-dev.sql");
	writeFileSync(sqlPath, seedSql(now), "utf8");
	execSync(`pnpm wrangler d1 execute INDEX_DB --local --file="${sqlPath}"`, { stdio: "inherit" });

	console.log(JSON.stringify({ mailboxId, seeded: true }, null, 2));
} else {
	console.log(
		JSON.stringify(
			{ mailboxId, secretUsed: secret === "dev-mailbox-id-secret-v1" ? "default-dev" : "env" },
			null,
			2,
		),
	);

	if (process.argv.includes("--sql")) {
		console.log(seedSql(new Date().toISOString()));
	}
}
