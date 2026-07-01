#!/usr/bin/env tsx
/**
 * `pnpm setup:cloud` — provisions the Cloudflare resources a deployment needs, in the
 * right order, using the resource names already in `wrangler.jsonc` for the chosen env.
 *
 * SAFETY: dry-run by default. It prints the exact, personalized, idempotent command
 * sequence and changes nothing. Pass `--apply` to actually run it against the Cloudflare
 * account your local `wrangler` is logged into. Review the dry run first.
 *
 * What it covers (mechanical, automatable):
 *   - R2 bucket, inbound queue + DLQ, D1 database (idempotent; "already exists" is fine)
 *   - Resolves the real D1 `database_id` via `wrangler d1 list --json` and surfaces it
 *   - Remote D1 migrations
 *   - MAILBOX_ID_SECRET: generated once and set only if not already present (rotating it
 *     changes every mailbox id — so re-runs never touch an existing one)
 *   - Worker deploy
 *
 * What it deliberately does NOT do (domain / identity — see the printed "Still required"):
 *   - Cloudflare Access (no wrangler command; use `pnpm doctor --cloud` + dashboard/API)
 *   - Email Routing DNS/verification (MX/SPF/DKIM live on your zone)
 *
 * Usage:
 *   pnpm setup:cloud --env dev            # dry run for the dev env
 *   pnpm setup:cloud                      # dry run for the default (production) config
 *   pnpm setup:cloud --env dev --apply    # actually provision + deploy
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

type WranglerBlock = {
	name?: string;
	vars?: { MAIL_FROM_ADDRESS?: string };
	r2_buckets?: Array<{ binding: string; bucket_name: string }>;
	queues?: {
		producers?: Array<{ binding: string; queue: string }>;
		consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
	};
	d1_databases?: Array<{ binding: string; database_name: string }>;
};
type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

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

const args = parseArgs(process.argv.slice(2));
const targetEnv = args.env; // undefined => top-level (production)
const apply = args.apply === "true";
const envLabel = targetEnv ?? "production";
const envFlag = targetEnv ? ["--env", targetEnv] : [];

// Optional first-mailbox seed (item 5): seeded in the same run so it can use the
// freshly generated MAILBOX_ID_SECRET, which is write-only afterwards.
const seedDomain = args.domain?.trim().toLowerCase();
const seedAddress = args.address?.trim();
const seedCatchAll = args["catch-all"] === "true";

const { readFileSync } = await import("node:fs");
const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as WranglerConfig;
const block: WranglerBlock | undefined = targetEnv ? config.env?.[targetEnv] : config;
if (!block) {
	console.error(`setup:cloud: no config block for env "${targetEnv}" in wrangler.jsonc.`);
	process.exit(1);
}

const worker = block.name ?? config.name;
const r2 = block.r2_buckets?.find((b) => b.binding === "MAIL_OBJECTS")?.bucket_name;
const queue = block.queues?.producers?.[0]?.queue;
const dlq = block.queues?.consumers?.[0]?.dead_letter_queue;
const d1Name = block.d1_databases?.find((d) => d.binding === "INDEX_DB")?.database_name;
const mailFrom = block.vars?.MAIL_FROM_ADDRESS;

if (!worker || !r2 || !queue || !dlq || !d1Name) {
	console.error("setup:cloud: could not resolve all resource names from wrangler.jsonc.");
	console.error({ worker, r2, queue, dlq, d1Name });
	process.exit(1);
}

function wrangler(argv: string[], opts: { input?: string; capture?: boolean } = {}): string {
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		input: opts.input,
		stdio: opts.input
			? ["pipe", "pipe", "inherit"]
			: opts.capture
				? ["ignore", "pipe", "inherit"]
				: "inherit",
	});
}

/** Runs a step, treating an "already exists" failure as success (idempotency). */
function runIdempotent(title: string, argv: string[]): void {
	console.log(`\n▸ ${title}\n  $ pnpm wrangler ${argv.join(" ")}`);
	if (!apply) return;
	try {
		wrangler(argv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already exists|already created|duplicate/i.test(message)) {
			console.log("  (already exists — skipping)");
		} else {
			throw error;
		}
	}
}

console.log(
	`\nReccado setup:cloud — env: ${envLabel} · worker: ${worker}` +
		`\nmode: ${apply ? "APPLY (mutating Cloudflare)" : "dry run (no changes)"}\n`,
);

// 1–4. Provision resources (idempotent).
runIdempotent("Create R2 bucket", [
	"r2",
	"bucket",
	"create",
	r2,
	"--update-config",
	"--binding",
	"MAIL_OBJECTS",
]);
runIdempotent("Create inbound queue", ["queues", "create", queue]);
runIdempotent("Create dead-letter queue", ["queues", "create", dlq]);
runIdempotent("Create D1 database", [
	"d1",
	"create",
	d1Name,
	"--update-config",
	"--binding",
	"INDEX_DB",
]);

// 5. Resolve and surface the real D1 id (do not trust where --update-config wrote it).
console.log(`\n▸ Resolve D1 database_id (wrangler d1 list --json)`);
if (apply) {
	try {
		const list = JSON.parse(wrangler(["d1", "list", "--json"], { capture: true })) as Array<{
			name: string;
			uuid?: string;
			database_id?: string;
		}>;
		const found = list.find((d) => d.name === d1Name);
		const id = found?.uuid ?? found?.database_id;
		if (id) {
			console.log(`  ${d1Name} → ${id}`);
			console.log(
				`  Ensure this is the "database_id" of the INDEX_DB binding` +
					`${targetEnv ? ` under env.${targetEnv}` : ""} in wrangler.jsonc.`,
			);
		} else {
			console.log(`  Could not find ${d1Name} in the account's D1 list yet.`);
		}
	} catch {
		console.log("  (could not list D1 databases — check `wrangler whoami`)");
	}
} else {
	console.log(`  → would print ${d1Name}'s UUID for you to confirm in wrangler.jsonc`);
}

// 6. Remote migrations.
runIdempotent("Apply D1 migrations (remote)", [
	"d1",
	"migrations",
	"apply",
	d1Name,
	"--remote",
	...envFlag,
]);

// 7. MAILBOX_ID_SECRET: generate + set only if not already present.
// `generatedSecret` is captured so step 9 can seed the first mailbox with the same value
// in this run — it is write-only in Cloudflare and unreadable afterwards.
console.log(`\n▸ Ensure MAILBOX_ID_SECRET (generate once; never rotate an existing one)`);
let generatedSecret: string | undefined;
let secretAlreadySet = false;
if (apply) {
	try {
		const secrets = JSON.parse(
			wrangler(["secret", "list", "--format", "json", "--name", worker, ...envFlag], {
				capture: true,
			}),
		) as Array<{ name: string }>;
		secretAlreadySet = secrets.some((s) => s.name === "MAILBOX_ID_SECRET");
	} catch {
		// Worker not deployed yet → treat as not set.
	}
	if (secretAlreadySet) {
		console.log("  MAILBOX_ID_SECRET already set — leaving it untouched.");
	} else {
		generatedSecret = randomBytes(32).toString("hex");
		wrangler(["secret", "put", "MAILBOX_ID_SECRET", "--name", worker, ...envFlag], {
			input: generatedSecret,
		});
		console.log("  Generated and set a new MAILBOX_ID_SECRET.");
	}
} else {
	console.log(
		"  → would check `wrangler secret list` and only generate+set one if absent" +
			" (rotating it changes every mailbox id)",
	);
}

// 8. Deploy.
runIdempotent("Deploy the Worker", [
	"deploy",
	...envFlag,
	...(targetEnv ? ["--name", worker] : []),
]);

// 9. First mailbox seed (item 5). Delegates to setup-mailbox.ts so the derivation and
// SQL stay in one place; passes the secret explicitly since it is unreadable afterwards.
console.log(`\n▸ Seed the first mailbox`);
if (seedDomain && seedAddress) {
	const mailboxArgs = [
		"setup:mailbox",
		"--domain",
		seedDomain,
		"--address",
		seedAddress,
		...(targetEnv ? ["--env", targetEnv] : []),
		...(seedCatchAll ? ["--catch-all"] : []),
	];
	if (!apply) {
		console.log(
			`  → would run: pnpm ${mailboxArgs.join(" ")} --secret <the-generated-secret> --apply`,
		);
	} else if (generatedSecret) {
		console.log(`  Seeding ${seedAddress} with the secret just generated…`);
		execFileSync("pnpm", [...mailboxArgs, "--secret", generatedSecret, "--apply"], {
			stdio: "inherit",
		});
	} else {
		console.log(
			`  MAILBOX_ID_SECRET already existed, so its value is unknown to this run.\n` +
				`  Seed with the secret you set earlier:\n` +
				`    pnpm ${mailboxArgs.join(" ")} --secret <your-secret> --apply`,
		);
	}
} else if (apply && generatedSecret) {
	console.log(
		`  No --domain/--address given. A new MAILBOX_ID_SECRET was generated; you need its\n` +
			`  value to seed a mailbox later (it is write-only now). Seed one now instead with:\n` +
			`    pnpm setup:cloud${targetEnv ? ` --env ${targetEnv}` : ""} --domain <d> --address inbox@<d> --apply`,
	);
} else {
	console.log(
		`  → pass --domain <d> --address inbox@<d> to seed the first mailbox in the same run.`,
	);
}

// Manifest (apply only).
if (apply) {
	mkdirSync(".reccado", { recursive: true });
	const manifest = {
		env: envLabel,
		worker,
		r2,
		queue,
		dlq,
		d1Name,
		mailFrom,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(`.reccado/setup.${envLabel}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`\nWrote .reccado/setup.${envLabel}.json`);
}

// Still-required footer (the irreducible domain/identity steps).
console.log(`\n${"─".repeat(72)}`);
console.log("Still required (domain / identity — not automatable here):\n");
console.log("1. Cloudflare Access must protect the Worker's route before it is public.");
console.log("   Check:   pnpm doctor --cloud");
console.log(
	`   Then set ACCESS_JWT_AUDIENCE + ACCESS_TEAM_DOMAIN:` +
		`\n     pnpm wrangler secret put ACCESS_JWT_AUDIENCE --name ${worker}${targetEnv ? ` --env ${targetEnv}` : ""}` +
		`\n     pnpm wrangler secret put ACCESS_TEAM_DOMAIN --name ${worker}${targetEnv ? ` --env ${targetEnv}` : ""}`,
);
console.log("\n2. Email Routing must deliver to this Worker (DNS lives on your zone):");
if (mailFrom) {
	const domain = mailFrom.split("@")[1];
	console.log(`     pnpm wrangler email routing enable ${domain ?? "<your-domain>"}`);
	console.log(
		`     pnpm wrangler email routing rules create <your-domain> \\` +
			`\n       --match-type literal --match-field to --match-value inbox@<your-domain> \\` +
			`\n       --action-type worker --action-value ${worker}`,
	);
}
console.log(`\nRe-check anytime:  pnpm doctor --env ${targetEnv ?? "production"} --cloud\n`);

if (!apply) {
	console.log("Dry run only. Re-run with --apply to execute against Cloudflare.\n");
}
