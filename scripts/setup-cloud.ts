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
 *   - Resolves the real D1 id via `wrangler d1 list --json` and writes it into a gitignored
 *     `wrangler.generated.<env>.json` (never edits the tracked wrangler.jsonc)
 *   - Remote D1 migrations + Worker deploy, both using that generated config
 *   - MAILBOX_ID_SECRET: generated once and set only if absent, then used in this same run to
 *     seed the first mailbox (it is write-only in Cloudflare afterwards); a non-sensitive HMAC
 *     fingerprint is recorded in .reccado/setup.<env>.json
 *
 * Because a freshly generated secret is unusable without a mailbox to derive, `--apply` requires
 * --domain/--address (or --skip-seed when the secret already exists).
 *
 * What it deliberately does NOT do (domain / identity — see the printed "Still required"):
 *   - Cloudflare Access (no wrangler command; use `pnpm setup:access` + `pnpm doctor --cloud`)
 *   - Email Routing DNS/verification (use `pnpm setup:routing`; MX/SPF/DKIM live on your zone)
 *
 * Usage:
 *   pnpm setup:cloud --env dev --domain you.com --address inbox@you.com          # dry run
 *   pnpm setup:cloud --env dev --domain you.com --address inbox@you.com --apply  # provision + deploy + seed
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
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
// Advanced opt-out for re-provisioning an env whose MAILBOX_ID_SECRET is already set.
const skipSeed = args["skip-seed"] === "true";

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

// First-time setup generates MAILBOX_ID_SECRET, which is unreadable after this run. To avoid
// generating a secret with no mailbox to use it, --apply requires seed args unless you explicitly
// opt out (only sensible when the secret is already set and you just want to re-provision).
if (apply && !skipSeed && !(seedDomain && seedAddress)) {
	console.error(
		"setup:cloud --apply needs --domain <d> --address inbox@<d> so the first mailbox is seeded\n" +
			"in the same run that MAILBOX_ID_SECRET is generated (it becomes write-only afterwards).\n" +
			"Pass --skip-seed only if MAILBOX_ID_SECRET is already set and you just want to re-provision.",
	);
	process.exit(1);
}

// stderr is PIPED (not inherited) so that error.stderr is populated for the idempotency check
// below; on real failures we print it before rethrowing so nothing is swallowed.
function wrangler(argv: string[], opts: { input?: string; capture?: boolean } = {}): string {
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		input: opts.input,
		stdio: opts.input
			? ["pipe", "inherit", "pipe"]
			: opts.capture
				? ["ignore", "pipe", "pipe"]
				: ["ignore", "inherit", "pipe"],
	});
}

/** Runs a step, treating an "already exists" failure as success (idempotency). */
function runIdempotent(title: string, argv: string[]): void {
	console.log(`\n▸ ${title}\n  $ pnpm wrangler ${argv.join(" ")}`);
	if (!apply) return;
	try {
		wrangler(argv);
	} catch (error) {
		const stderr =
			typeof (error as { stderr?: unknown })?.stderr === "string"
				? (error as { stderr: string }).stderr
				: "";
		const haystack = `${error instanceof Error ? error.message : String(error)}\n${stderr}`;
		if (/already exists|already created|already enabled|duplicate|409/i.test(haystack)) {
			console.log("  (already exists — skipping)");
		} else {
			if (stderr) console.error(stderr);
			throw error;
		}
	}
}

console.log(
	`\nReccado setup:cloud — env: ${envLabel} · worker: ${worker}` +
		`\nmode: ${apply ? "APPLY (mutating Cloudflare)" : "dry run (no changes)"}\n`,
);

// 1–4. Provision resources (idempotent). We do NOT use --update-config: the D1 id is written
// into a generated, gitignored config (step 5) instead of editing the tracked wrangler.jsonc.
runIdempotent("Create R2 bucket", ["r2", "bucket", "create", r2]);
runIdempotent("Create inbound queue", ["queues", "create", queue]);
runIdempotent("Create dead-letter queue", ["queues", "create", dlq]);
runIdempotent("Create D1 database", ["d1", "create", d1Name]);

// 5. Resolve the real D1 id and render a gitignored deploy config with it — we never edit the
// tracked wrangler.jsonc, and the env-scoped binding gets the real id (not a placeholder).
type MutableBlock = {
	name?: string;
	d1_databases?: Array<{ binding?: string; database_id?: string }>;
	[k: string]: unknown;
};
type MutableConfig = MutableBlock & { env?: Record<string, MutableBlock> };

let resolvedD1Id: string | undefined;
let generatedConfigPath: string | undefined;
console.log(`\n▸ Resolve D1 database_id + render deploy config`);
if (apply) {
	try {
		const list = JSON.parse(wrangler(["d1", "list", "--json"], { capture: true })) as Array<{
			name: string;
			uuid?: string;
			database_id?: string;
		}>;
		const found = list.find((d) => d.name === d1Name);
		resolvedD1Id = found?.uuid ?? found?.database_id;
	} catch {
		// fall through to the guard below
	}
	if (!resolvedD1Id) {
		console.error(
			`  Could not resolve the id for D1 "${d1Name}" (check \`wrangler whoami\`). Aborting before deploy.`,
		);
		process.exit(1);
	}
	const full = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as MutableConfig;
	const targetBlock: MutableBlock | undefined = targetEnv ? full.env?.[targetEnv] : full;
	const d1Entry = targetBlock?.d1_databases?.find((d) => d.binding === "INDEX_DB");
	if (d1Entry) d1Entry.database_id = resolvedD1Id;
	// Written at the repo ROOT (gitignored) so wrangler resolves `main`/`migrations_dir` — which are
	// relative to the config file's directory — exactly as the tracked config would.
	generatedConfigPath = `wrangler.generated.${envLabel}.json`;
	writeFileSync(generatedConfigPath, `${JSON.stringify(full, null, 2)}\n`);
	console.log(`  ${d1Name} → ${resolvedD1Id}`);
	console.log(`  Wrote ${generatedConfigPath} (used for migrations + deploy; gitignored).`);
} else {
	console.log(
		`  → would resolve ${d1Name}'s id and write wrangler.generated.${envLabel}.json for --config deploy`,
	);
}
const configFlag = generatedConfigPath ? ["--config", generatedConfigPath] : [];

// 6. Remote migrations (against the generated config, so the real id/binding is used).
runIdempotent("Apply D1 migrations (remote)", [
	"d1",
	"migrations",
	"apply",
	d1Name,
	"--remote",
	...configFlag,
	...envFlag,
]);

// 7. Deploy FIRST — `secret put` requires an already-deployed Worker.
runIdempotent("Deploy the Worker", [
	"deploy",
	...configFlag,
	...envFlag,
	...(targetEnv ? ["--name", worker] : []),
]);

// 8. MAILBOX_ID_SECRET: set only if absent (rotating it changes every mailbox id). Captured so
// step 9 seeds with the same value — it is write-only in Cloudflare afterwards. The early guard
// guaranteed seed args are present whenever we might generate one.
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
		// treat as not set
	}
	if (secretAlreadySet) {
		console.log("  MAILBOX_ID_SECRET already set — leaving it untouched.");
	} else if (seedDomain && seedAddress) {
		generatedSecret = randomBytes(32).toString("hex");
		wrangler(["secret", "put", "MAILBOX_ID_SECRET", "--name", worker, ...envFlag], {
			input: generatedSecret,
		});
		console.log("  Generated and set a new MAILBOX_ID_SECRET.");
	} else {
		// --skip-seed with no existing secret: don't leave an orphan secret nobody can use.
		console.log(
			"  Not set. Skipping generation because --skip-seed was given and a new secret must be\n" +
				"  paired with a mailbox seed. Re-run with --domain/--address to set it.",
		);
	}
} else {
	console.log("  → would generate+set one only if absent, paired with the mailbox seed below");
}

// 9. First mailbox seed. Delegates to setup-mailbox.ts; the secret is passed via the child's ENV
// (never argv) so it never lands in process listings or shell history.
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
			`  → would run: MAILBOX_ID_SECRET=<generated> pnpm ${mailboxArgs.join(" ")} --apply`,
		);
	} else if (generatedSecret) {
		console.log(`  Seeding ${seedAddress} with the secret just generated…`);
		execFileSync("pnpm", [...mailboxArgs, "--apply"], {
			stdio: "inherit",
			env: { ...process.env, MAILBOX_ID_SECRET: generatedSecret },
		});
	} else {
		console.log(
			`  MAILBOX_ID_SECRET already existed, so this run cannot derive the mailbox id.\n` +
				`  Seed with the value you set, passed via env (not argv):\n` +
				`    MAILBOX_ID_SECRET=<your-secret> pnpm ${mailboxArgs.join(" ")} --apply`,
		);
	}
} else {
	console.log("  → (skipped via --skip-seed) seed later with setup:mailbox.");
}

// Manifest (apply only): records a NON-sensitive fingerprint of the secret so a later run/tool can
// detect a secret/index mismatch without ever storing the secret itself.
if (apply) {
	mkdirSync(".reccado", { recursive: true });
	const manifestPath = `.reccado/setup.${envLabel}.json`;
	let priorFingerprint: string | null = null;
	try {
		priorFingerprint =
			(JSON.parse(readFileSync(manifestPath, "utf8")) as { mailboxSecretFingerprint?: string })
				.mailboxSecretFingerprint ?? null;
	} catch {
		// no prior manifest
	}
	const manifest = {
		env: envLabel,
		worker,
		r2,
		queue,
		dlq,
		d1Name,
		d1Id: resolvedD1Id ?? null,
		mailFrom,
		mailbox: seedDomain && seedAddress ? { domain: seedDomain, address: seedAddress } : null,
		// HMAC(secret, fixed label) — reveals nothing about the secret, but lets a future check
		// confirm the Worker's secret still matches the one this setup used.
		mailboxSecretFingerprint: generatedSecret
			? createHmac("sha256", generatedSecret)
					.update("reccado:mailbox-secret-check:v1")
					.digest("hex")
			: priorFingerprint,
		updatedAt: new Date().toISOString(),
	};
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(`\nWrote ${manifestPath}`);
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
