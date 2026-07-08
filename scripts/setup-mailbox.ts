#!/usr/bin/env tsx
/**
 * `pnpm setup:mailbox` — seeds the D1 control-plane rows a mailbox needs to actually
 * receive mail (domain + mailbox + alias, optionally a catch-all routing rule), deriving
 * the `mailbox_id` with the SAME MAILBOX_ID_SECRET the Worker uses so the ids line up.
 *
 * This is the step that turns "deployed" into "an inbox that receives": `resolveRoutingForRecipient`
 * stores mail for a recipient as soon as an active alias + active domain exist (src/db/d1.ts).
 *
 * SAFETY: dry-run by default (prints the mailbox id, the SQL, and the exact `wrangler d1
 * execute` command). Pass `--apply` to run it. The SQL uses conflict-safe inserts/upserts and
 * resolves the live domain row by name, so it is idempotent and safe to re-run.
 *
 * The secret coupling (important): the Worker's MAILBOX_ID_SECRET is write-only in Cloudflare,
 * so for a REMOTE seed you must supply the same value — the CLI cannot read it back, and a
 * mismatched secret derives a mailbox id the Worker will never route to. Prefer passing it via
 * the MAILBOX_ID_SECRET env var (not `--secret`, which would land in shell history / process
 * listings). Locally it is read from `.dev.vars`.
 *
 * Usage:
 *   pnpm setup:mailbox --domain example.com --address inbox@example.com            # local dry run
 *   pnpm setup:mailbox --domain example.com --address inbox@example.com --local --apply
 *   MAILBOX_ID_SECRET=<secret> pnpm setup:mailbox --domain example.com \
 *     --address inbox@example.com --env dev --catch-all --apply                    # remote
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPrimaryAddress, deriveMailboxId } from "../src/lib/mailbox-id";

type WranglerBlock = {
	d1_databases?: Array<{ binding: string; database_name: string }>;
};

type WranglerConfig = WranglerBlock & {
	env?: Record<string, WranglerBlock>;
};

type D1ExecuteJson = Array<{
	results?: Array<Record<string, unknown>>;
	success?: boolean;
	meta?: { duration?: number };
}>;

function parseArgs(argv: string[]): Record<string, string> {
	const args: Record<string, string> = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) continue;
		const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
		if (!rawKey) continue;
		if (inlineValue !== undefined) {
			args[rawKey] = inlineValue;
			continue;
		}
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			args[rawKey] = "true";
			continue;
		}
		args[rawKey] = next;
		i += 1;
	}
	return args;
}

function stripJsonc(input: string): string {
	return input.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Reads a single key out of a dotenv-style file, ignoring comments. */
function readDotEnvValue(path: string, key: string): string | undefined {
	if (!existsSync(path)) return undefined;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sep = trimmed.indexOf("=");
		if (sep !== -1 && trimmed.slice(0, sep).trim() === key) {
			return trimmed.slice(sep + 1).trim();
		}
	}
	return undefined;
}

/** SQL single-quoted string literal with quotes escaped. */
function q(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function runD1Query(execArgs: string[], sqlCommand: string): D1ExecuteJson {
	return JSON.parse(
		execFileSync("pnpm", ["wrangler", ...execArgs, `--command=${sqlCommand}`, "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "inherit"],
		}),
	) as D1ExecuteJson;
}

const args = parseArgs(process.argv.slice(2));
const apply = args.apply === "true";
const local = args.local === "true";
const targetEnv = args.env;
const catchAll = args["catch-all"] === "true";
const envLabel = targetEnv ?? "production";

const domain = args.domain?.trim().toLowerCase();
const rawAddress = args.address?.trim();
if (!domain || !rawAddress) {
	console.error("setup:mailbox: --domain and --address are required.");
	console.error("Example: pnpm setup:mailbox --domain example.com --address inbox@example.com");
	process.exit(1);
}

let address: string;
try {
	address = canonicalPrimaryAddress(rawAddress);
} catch {
	console.error(`setup:mailbox: invalid --address "${rawAddress}".`);
	process.exit(1);
}
if (!address.endsWith(`@${domain}`)) {
	console.error(`setup:mailbox: --address ${address} is not on --domain ${domain}.`);
	process.exit(1);
}

const displayName = args["display-name"]?.trim() || address.split("@")[0] || "Inbox";
const zoneId = args["zone-id"]?.trim() || "zone-placeholder";

// Resolve owner email: explicit flag > ACCESS_ALLOWED_EMAILS (first entry if single).
let ownerEmail = args.owner?.trim().toLowerCase() || undefined;
if (!ownerEmail) {
	const allowList = readDotEnvValue(".dev.vars", "ACCESS_ALLOWED_EMAILS") || process.env.ACCESS_ALLOWED_EMAILS;
	if (allowList) {
		const emails = allowList.split(",").map((e) => e.trim()).filter((e) => e.length > 0);
		if (emails.length === 1) {
			ownerEmail = emails[0]?.toLowerCase();
		}
	}
}
const ownerSql = ownerEmail ? q(ownerEmail) : "NULL";

// Resolve the secret: explicit flag > env > .dev.vars (local only).
const secret =
	(args.secret?.trim() || undefined) ??
	process.env.MAILBOX_ID_SECRET ??
	readDotEnvValue(".dev.vars", "MAILBOX_ID_SECRET");
if (!secret) {
	console.error(
		"setup:mailbox: no MAILBOX_ID_SECRET available.\n" +
			"  Local: run `pnpm dev` once to generate .dev.vars, or set MAILBOX_ID_SECRET.\n" +
			"  Remote: MAILBOX_ID_SECRET=<value> pnpm setup:mailbox ... (the exact secret you set on\n" +
			"  the Worker) — it is write-only in Cloudflare and the mailbox id must match what the\n" +
			"  Worker derives. Prefer the env var over --secret so it stays out of shell history.",
	);
	process.exit(1);
}

const mailboxId = await deriveMailboxId(secret, address);
const domainId = `dom_${domain.replace(/[^a-z0-9]+/g, "_")}`;
const now = new Date().toISOString();
const generatedConfigPath = `wrangler.generated.${envLabel}.json`;
const preferredConfigPath = existsSync(generatedConfigPath)
	? generatedConfigPath
	: "wrangler.jsonc";

const statements = [
	`INSERT INTO domains (id, domain, zone_id, status, created_at, updated_at)
VALUES (${q(domainId)}, ${q(domain)}, ${q(zoneId)}, 'active', ${q(now)}, ${q(now)})
ON CONFLICT(domain) DO NOTHING;`,
	`INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at)
VALUES (${q(mailboxId)}, ${q(address)}, ${q(displayName)}, 'active', ${ownerSql}, ${q(now)}, ${q(now)})
ON CONFLICT(primary_address) DO NOTHING;`,
	`INSERT INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at)
SELECT ${q(address)}, ${q(mailboxId)}, id, 'active', ${q(now)}, ${q(now)}
FROM domains
WHERE domain = ${q(domain)}
ON CONFLICT(alias_address) DO UPDATE SET
	mailbox_id = excluded.mailbox_id,
	domain_id = excluded.domain_id,
	status = excluded.status,
	updated_at = excluded.updated_at;`,
];
if (catchAll) {
	statements.push(
		`INSERT INTO routing_rules (id, domain_id, pattern, priority, action, mailbox_id, forward_to_json, reject_reason, enabled, created_at, updated_at)
SELECT ${q(`rule_${domainId}_catchall`)}, id, '*', 100, 'store', ${q(mailboxId)}, '[]', NULL, 1, ${q(now)}, ${q(now)}
FROM domains
WHERE domain = ${q(domain)}
ON CONFLICT(id) DO UPDATE SET
	domain_id = excluded.domain_id,
	pattern = excluded.pattern,
	priority = excluded.priority,
	action = excluded.action,
	mailbox_id = excluded.mailbox_id,
	forward_to_json = excluded.forward_to_json,
	reject_reason = excluded.reject_reason,
	enabled = excluded.enabled,
	updated_at = excluded.updated_at;`,
	);
}
const sql =
	`-- Reccado mailbox seed for ${address} (mailbox_id=${mailboxId}). Idempotent.\n` +
	`-- Domains are resolved by name at execution time, so an existing domains.id is reused.\n` +
	`${statements.join("\n")}\n`;

// Resolve the D1 execute target.
let execArgs: string[];
let targetLabel: string;
if (local) {
	execArgs = ["d1", "execute", "INDEX_DB", "--local"];
	targetLabel = "local D1 (INDEX_DB binding)";
} else {
	const config = JSON.parse(
		stripJsonc(readFileSync(preferredConfigPath, "utf8")),
	) as WranglerConfig;
	const block = targetEnv ? config.env?.[targetEnv] : config;
	const d1Name = block?.d1_databases?.find((d) => d.binding === "INDEX_DB")?.database_name;
	if (!d1Name) {
		console.error(
			`setup:mailbox: could not resolve the INDEX_DB name for env "${envLabel}" from ${preferredConfigPath}.`,
		);
		process.exit(1);
	}
	execArgs = [
		"d1",
		"execute",
		d1Name,
		"--remote",
		...(preferredConfigPath === "wrangler.jsonc" ? [] : ["--config", preferredConfigPath]),
		...(targetEnv ? ["--env", targetEnv] : []),
	];
	targetLabel = `remote D1 "${d1Name}"${targetEnv ? ` (env ${targetEnv})` : ""}`;
}

let existingDomainId: string | undefined;
if (apply) {
	const [domainLookup, mailboxLookup] = runD1Query(
		execArgs,
		`SELECT id FROM domains WHERE domain = ${q(domain)} LIMIT 1;
SELECT mailbox_id FROM mailboxes WHERE primary_address = ${q(address)} LIMIT 1;`,
	);
	existingDomainId =
		typeof domainLookup?.results?.[0]?.id === "string"
			? (domainLookup.results[0].id as string)
			: undefined;
	const existingMailboxId =
		typeof mailboxLookup?.results?.[0]?.mailbox_id === "string"
			? (mailboxLookup.results[0].mailbox_id as string)
			: undefined;
	if (existingMailboxId && existingMailboxId !== mailboxId) {
		console.error(
			"setup:mailbox: an existing mailbox row already owns this primary address with a different mailbox_id.\n" +
				`  address:              ${address}\n` +
				`  existing mailbox_id:  ${existingMailboxId}\n` +
				`  derived mailbox_id:   ${mailboxId}\n` +
				"  This usually means MAILBOX_ID_SECRET does not match the deployed Worker secret.\n" +
				"  Cloudflare secrets are write-only, so reuse the original secret value before seeding.",
		);
		process.exit(1);
	}
}

console.log(`\nReccado setup:mailbox\n`);
console.log(`  address:     ${address}`);
console.log(`  mailbox_id:  ${mailboxId}`);
console.log(
	`  domain:      ${domain} (${existingDomainId ?? domainId}${existingDomainId ? ", existing row" : ", preferred id"})`,
);
console.log(
	`  catch-all:   ${catchAll ? "yes (routing_rule pattern '*')" : "no (exact alias only)"}`,
);
console.log(`  target:      ${targetLabel}`);
if (!local && preferredConfigPath !== "wrangler.jsonc") {
	console.log(`  config:      ${preferredConfigPath}`);
}
console.log(`  mode:        ${apply ? "APPLY" : "dry run (no changes)"}\n`);
console.log(sql);

if (!apply) {
	console.log(
		`Command that would run:\n  $ pnpm wrangler ${execArgs.join(" ")} --file <tmp.sql>\n`,
	);
	console.log(
		"Reminder: MAILBOX_ID_SECRET must exactly match the deployed Worker secret. If this address was\n" +
			"seeded before and you no longer have that secret value, derive/reuse it before applying.\n",
	);
	console.log("Dry run only. Re-run with --apply to execute.\n");
	process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), "reccado-setup-mailbox-"));
const sqlPath = join(dir, "seed.sql");
writeFileSync(sqlPath, sql, "utf8");
execFileSync("pnpm", ["wrangler", ...execArgs, `--file=${sqlPath}`], { stdio: "inherit" });
console.log(`\nSeeded ${address} → ${mailboxId} into ${targetLabel}.`);
