#!/usr/bin/env tsx
/**
 * `pnpm setup:mcp-claim` — backfills `owner_email` on existing D1 mailbox rows
 * that have NULL owner_email, so the MCP endpoint can serve them.
 *
 * MCP fails closed for NULL-owned mailboxes (returns not_found). This script
 * claims them for a specific owner email so MCP tools can access them.
 *
 * SAFETY: dry-run by default. Pass `--apply` to run. If ACCESS_ALLOWED_EMAILS
 * has more than one entry, `--owner <email>` is required to prevent accidental
 * multi-user claims. The script canonicalizes the owner email (lowercase, trim).
 *
 * Usage:
 *   pnpm setup:mcp-claim --env dev --owner alice@example.com            # local dry run
 *   pnpm setup:mcp-claim --env dev --owner alice@example.com --apply     # local apply
 *   pnpm setup:mcp-claim --env dev --owner alice@example.com --remote --apply  # remote apply
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type WranglerBlock = {
	d1_databases?: Array<{ binding: string; database_name: string }>;
};

type WranglerConfig = WranglerBlock & {
	env?: Record<string, WranglerBlock>;
};

type D1ExecuteJson = Array<{
	results: Array<{ mailbox_id: string; primary_address: string; owner_email: string | null }>;
}> | undefined;

function parseArgs(): { env: string; owner: string | null; apply: boolean; remote: boolean } {
	const args = process.argv.slice(2);
	let env = "dev";
	let owner: string | null = null;
	let apply = false;
	let remote = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--env" && args[i + 1]) env = args[++i] as string;
		if (arg === "--owner" && args[i + 1]) owner = args[++i] as string;
		if (arg === "--apply") apply = true;
		if (arg === "--remote") remote = true;
	}
	return { env, owner, apply, remote };
}

function readDevVars(): Record<string, string> {
	const devVarsPath = join(process.cwd(), ".dev.vars");
	if (!existsSync(devVarsPath)) return {};
	const content = readFileSync(devVarsPath, "utf-8");
	const vars: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, "");
		vars[key] = value;
	}
	return vars;
}

function resolveOwner(owner: string | null): string {
	if (owner) return owner.trim().toLowerCase();

	const devVars = readDevVars();
	const allowList = devVars.ACCESS_ALLOWED_EMAILS ?? process.env.ACCESS_ALLOWED_EMAILS ?? "";
	const emails = allowList
		.split(",")
		.map((e) => e.trim())
		.filter((e) => e.length > 0);

	if (emails.length === 0) {
		console.error("ERROR: No --owner specified and ACCESS_ALLOWED_EMAILS is not set.");
		console.error("Set ACCESS_ALLOWED_EMAILS in .dev.vars or pass --owner <email>.");
		process.exit(1);
	}
	if (emails.length > 1) {
		console.error(
			`ERROR: ACCESS_ALLOWED_EMAILS has ${emails.length} entries. --owner <email> is required to prevent accidental multi-user claims.`,
		);
		console.error(`Entries: ${emails.join(", ")}`);
		process.exit(1);
	}
	return emails[0]?.trim().toLowerCase() ?? "";
}

function parseJsonc(content: string): unknown {
	// Strip single-line comments (// ...) and block comments (/* ... */)
	// from JSONC before parsing as JSON.
	const stripped = content
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "")
		.trim();
	return JSON.parse(stripped);
}

function getD1DatabaseName(envName: string): string {
	const wranglerPath = join(process.cwd(), "wrangler.jsonc");
	const config = parseJsonc(readFileSync(wranglerPath, "utf-8")) as WranglerConfig;
	const block = envName === "production" ? config : config.env?.[envName] ?? config;
	const db = block.d1_databases?.find((d) => d.binding === "INDEX_DB");
	if (!db) {
		console.error(`ERROR: No INDEX_DB D1 binding found in wrangler.jsonc for env '${envName}'.`);
		process.exit(1);
	}
	return db.database_name;
}

function d1Execute(envName: string, databaseName: string, sql: string, remote: boolean): D1ExecuteJson {
	const tmpDir = mkdtempSync(join(tmpdir(), "mcp-claim-"));
	const sqlFile = join(tmpDir, "query.sql");
	writeFileSync(sqlFile, sql);
	try {
		const args = [
			"wrangler",
			"d1",
			"execute",
			databaseName,
			"--env",
			envName,
			"--file",
			sqlFile,
			"--json",
		];
		// Always pass --remote or --local explicitly so the target is unambiguous.
		args.push(remote ? "--remote" : "--local");
		const output = execFileSync("pnpm", args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return JSON.parse(output) as D1ExecuteJson;
	} finally {
		// tmp dir cleaned up by OS
	}
}

async function main(): Promise<void> {
	const { env: envName, owner: ownerArg, apply, remote } = parseArgs();
	const ownerEmail = resolveOwner(ownerArg);
	const databaseName = getD1DatabaseName(envName);

	// Both dry-run and apply use the same target: --remote if specified, --local otherwise.
	// This ensures the preview shows exactly what will be mutated.
	const targetLabel = remote ? "REMOTE" : "LOCAL";

	console.log(`Mailbox owner claim`);
	console.log(`  Env: ${envName}`);
	console.log(`  D1 database: ${databaseName}`);
	console.log(`  Target: ${targetLabel}`);
	console.log(`  Owner email: ${ownerEmail}`);
	console.log(`  Mode: ${apply ? "APPLY" : "DRY RUN (pass --apply to run)"}`);
	console.log();

	// Find mailboxes with NULL owner_email — same target for preview and apply.
	const findSql = `SELECT mailbox_id, primary_address, owner_email FROM mailboxes WHERE owner_email IS NULL`;
	const result = d1Execute(envName, databaseName, findSql, remote) ?? [];
	const nullMailboxes = result[0]?.results ?? [];

	if (nullMailboxes.length === 0) {
		console.log("No mailboxes with NULL owner_email found. Nothing to claim.");
		return;
	}

	console.log(`Found ${nullMailboxes.length} mailbox(es) with NULL owner_email:`);
	for (const m of nullMailboxes) {
		console.log(`  ${m.mailbox_id} (${m.primary_address})`);
	}
	console.log();

	if (!apply) {
		console.log("DRY RUN: no changes made. Pass --apply to claim these mailboxes.");
		return;
	}

	const updateSql = `UPDATE mailboxes SET owner_email = '${ownerEmail.replace(/'/g, "''")}' WHERE owner_email IS NULL`;
	d1Execute(envName, databaseName, updateSql, remote);
	console.log(`Claimed ${nullMailboxes.length} mailbox(es) for ${ownerEmail}.`);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
