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
 *   - Builds the TanStack Start app for the chosen env, patches `dist/server/wrangler.json`
 *     with the real Cloudflare bindings from the generated config, then migrates + deploys
 *     from that built Worker config
 *   - MAILBOX_ID_SECRET: generated once and set only if absent, then used in this same run to
 *     seed the first mailbox (it is write-only in Cloudflare afterwards); a non-sensitive HMAC
 *     fingerprint is recorded in .reccado/setup.<env>.json
 *   - `--reset-secret`: recovers an ORPHANED MAILBOX_ID_SECRET — one a prior `--apply` run set but
 *     then failed before seeding a mailbox with (e.g. the deploy step failed). Overwrites it with a
 *     fresh value and reseeds atomically in this same run. Without this flag, an already-set secret
 *     is never rotated; if it also looks orphaned (no fingerprint recorded), the run explains the
 *     situation and points here instead of silently doing nothing.
 *
 * Because a freshly generated secret is unusable without a mailbox to derive, `--apply` requires
 * --domain/--address (or --skip-seed when the secret already exists). `--reset-secret` always needs
 * --domain/--address too, since it always reseeds.
 *
 * What it deliberately does NOT do (domain / identity — see the printed "Still required"):
 *   - Custom domain attachment (use `pnpm setup:domain`)
 *   - Cloudflare Access app creation (use `pnpm setup:access` + `pnpm doctor --cloud --url`)
 *   - Email Routing DNS/verification (use `pnpm setup:routing`; MX/SPF/DKIM live on your zone)
 *   - Outbound sender identity (use `pnpm setup:sending`)
 *
 * Usage:
 *   pnpm setup:cloud --env dev --domain you.com --address inbox@you.com          # dry run
 *   pnpm setup:cloud --env dev --domain you.com --address inbox@you.com --apply  # provision + deploy + seed
 *   pnpm setup:cloud --env dev --domain you.com --address inbox@you.com --reset-secret --apply
 *     # recover an orphaned MAILBOX_ID_SECRET (overwrite + reseed atomically)
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type WranglerBlock = {
	name?: string;
	vars?: { MAIL_FROM_ADDRESS?: string };
	workers_dev?: boolean;
	triggers?: { crons?: string[] };
	send_email?: Array<{ name: string }>;
	durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
	r2_buckets?: Array<{ binding: string; bucket_name: string }>;
	queues?: {
		producers?: Array<{ binding: string; queue: string }>;
		consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
	};
	d1_databases?: Array<{ binding: string; database_name: string; database_id?: string }>;
	migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
	compatibility_date?: string;
	compatibility_flags?: string[];
	observability?: { enabled?: boolean };
	upload_source_maps?: boolean;
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
// Non-sensitive manifest recording whether a seed ever succeeded for this env — see the
// orphaned-secret check below and the manifest write near the end of the run.
const manifestPath = `.reccado/setup.${envLabel}.json`;

// Optional first-mailbox seed (item 5): seeded in the same run so it can use the
// freshly generated MAILBOX_ID_SECRET, which is write-only afterwards.
const seedDomain = args.domain?.trim().toLowerCase();
const seedAddress = args.address?.trim();
const seedCatchAll = args["catch-all"] === "true";
// Advanced opt-out for re-provisioning an env whose MAILBOX_ID_SECRET is already set.
const skipSeed = args["skip-seed"] === "true";
// Recovery for an ORPHANED MAILBOX_ID_SECRET (set on the Worker, but no successful seed was ever
// recorded for it — e.g. a prior --apply run failed after `secret put` but before seeding). Always
// overwrites + reseeds atomically in this same run; see the guard and orphan check below.
const resetSecret = args["reset-secret"] === "true";
if (resetSecret && skipSeed) {
	console.error(
		"setup:cloud: --reset-secret and --skip-seed conflict — resetting the secret always needs to\n" +
			"reseed the mailbox in the same run. Drop --skip-seed and pass --domain/--address instead.",
	);
	process.exit(1);
}

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
const workerName: string = worker;
const queueName: string = queue;

// First-time setup generates MAILBOX_ID_SECRET, which is unreadable after this run. To avoid
// generating a secret with no mailbox to use it, --apply requires seed args unless you explicitly
// opt out (only sensible when the secret is already set and you just want to re-provision).
if (apply && !skipSeed && !(seedDomain && seedAddress)) {
	console.error(
		"setup:cloud --apply needs --domain <d> --address inbox@<d> so the first mailbox is seeded\n" +
			"in the same run that MAILBOX_ID_SECRET is generated or reset (it becomes write-only afterwards).\n" +
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
		if (
			/already exists|already created|already enabled|already taken|already in use|duplicate|409|11009/i.test(
				haystack,
			)
		) {
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
	vars?: WranglerBlock["vars"];
	workers_dev?: WranglerBlock["workers_dev"];
	triggers?: WranglerBlock["triggers"];
	send_email?: WranglerBlock["send_email"];
	durable_objects?: WranglerBlock["durable_objects"];
	r2_buckets?: WranglerBlock["r2_buckets"];
	queues?: WranglerBlock["queues"];
	d1_databases?: Array<{
		binding?: string;
		database_name?: string;
		database_id?: string;
		migrations_dir?: string;
	}>;
	migrations?: WranglerBlock["migrations"];
	compatibility_date?: WranglerBlock["compatibility_date"];
	compatibility_flags?: WranglerBlock["compatibility_flags"];
	observability?: WranglerBlock["observability"];
	upload_source_maps?: WranglerBlock["upload_source_maps"];
	configPath?: string;
	userConfigPath?: string;
	[k: string]: unknown;
};
type MutableConfig = MutableBlock & { env?: Record<string, MutableBlock> };

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function buildEffectiveWranglerBlock(config: MutableConfig, env: string | undefined): MutableBlock {
	if (!env) return config;
	const envBlock = config.env?.[env];
	if (!envBlock) {
		throw new Error(`No config block for env "${env}" in generated Wrangler config.`);
	}
	return {
		...config,
		...envBlock,
		vars: envBlock.vars ?? config.vars,
		workers_dev: envBlock.workers_dev ?? config.workers_dev,
		triggers: envBlock.triggers ?? config.triggers,
		send_email: envBlock.send_email ?? config.send_email,
		durable_objects: envBlock.durable_objects ?? config.durable_objects,
		r2_buckets: envBlock.r2_buckets ?? config.r2_buckets,
		queues: envBlock.queues ?? config.queues,
		d1_databases: envBlock.d1_databases ?? config.d1_databases,
		migrations: envBlock.migrations ?? config.migrations,
		compatibility_date: envBlock.compatibility_date ?? config.compatibility_date,
		compatibility_flags: envBlock.compatibility_flags ?? config.compatibility_flags,
		observability: envBlock.observability ?? config.observability,
		upload_source_maps: envBlock.upload_source_maps ?? config.upload_source_maps,
	};
}

function patchD1Databases(builtConfig: MutableBlock, generatedBlock: MutableBlock): void {
	if (!generatedBlock.d1_databases) return;
	const builtDbs = builtConfig.d1_databases ?? [];
	builtConfig.d1_databases = generatedBlock.d1_databases.map((generatedDb) => {
		const builtDb = builtDbs.find((db) => db.binding === generatedDb.binding);
		return {
			...generatedDb,
			// Vite rewrites this path for dist/server/wrangler.json. Keep that relative path,
			// otherwise `wrangler d1 migrations apply --config dist/server/wrangler.json`
			// looks under dist/server/migrations instead of the repo's migrations directory.
			migrations_dir: builtDb?.migrations_dir ?? generatedDb.migrations_dir,
		};
	});
}

function buildAppForDeploy(): void {
	const displayPrefix = targetEnv ? `CLOUDFLARE_ENV=${targetEnv} ` : "";
	console.log(`\n▸ Build app for deploy\n  $ ${displayPrefix}pnpm run build`);
	if (!apply) return;
	execFileSync("pnpm", ["run", "build"], {
		stdio: "inherit",
		env: targetEnv ? { ...process.env, CLOUDFLARE_ENV: targetEnv } : process.env,
	});
}

function patchBuiltWranglerConfig(generatedConfigPath: string): void {
	const builtConfigPath = "dist/server/wrangler.json";
	console.log(
		`\n▸ Patch built Wrangler config\n  source: ${generatedConfigPath}\n  target: ${builtConfigPath}`,
	);
	if (!apply) {
		console.log(
			"  → would copy real bindings + ids into the built Worker config before migrate/deploy",
		);
		return;
	}
	const generatedConfig = readJson<MutableConfig>(generatedConfigPath);
	const generatedBlock = buildEffectiveWranglerBlock(generatedConfig, targetEnv);
	const builtConfig = readJson<MutableBlock>(builtConfigPath);
	for (const key of [
		"name",
		"vars",
		"workers_dev",
		"triggers",
		"send_email",
		"durable_objects",
		"r2_buckets",
		"queues",
		"migrations",
		"compatibility_date",
		"compatibility_flags",
		"observability",
		"upload_source_maps",
	] as const) {
		const nextValue = generatedBlock[key];
		if (nextValue !== undefined) {
			(builtConfig as Record<string, unknown>)[key] = nextValue;
		}
	}
	patchD1Databases(builtConfig, generatedBlock);
	builtConfig.configPath = resolve(generatedConfigPath);
	builtConfig.userConfigPath = resolve(generatedConfigPath);
	writeFileSync(builtConfigPath, `${JSON.stringify(builtConfig, null, 2)}\n`);
}

function collectConsumerWorkerNames(value: unknown, names = new Set<string>()): Set<string> {
	if (!value || typeof value !== "object") return names;
	if (Array.isArray(value)) {
		for (const item of value) collectConsumerWorkerNames(item, names);
		return names;
	}
	for (const [key, nested] of Object.entries(value)) {
		const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
		if (
			typeof nested === "string" &&
			["script", "scriptname", "service", "servicename", "worker", "workername"].includes(
				normalizedKey,
			)
		) {
			names.add(nested);
		} else {
			collectConsumerWorkerNames(nested, names);
		}
	}
	return names;
}

function assertQueueConsumerMatchesWorker(): void {
	console.log(
		`\n▸ Check Queue consumer ownership\n  $ pnpm wrangler queues consumer list ${queueName} --json`,
	);
	if (!apply) {
		console.log(
			`  → would abort if ${queueName} is already consumed by a Worker other than ${workerName}`,
		);
		return;
	}
	const raw = wrangler(["queues", "consumer", "list", queueName, "--json"], { capture: true });
	const consumerNames = [...collectConsumerWorkerNames(JSON.parse(raw))].filter(
		(name) => name !== queueName,
	);
	const staleConsumers = consumerNames.filter((name) => name !== workerName);
	if (staleConsumers.length === 0) return;

	console.error(
		`  ${queueName} already has a consumer that is not ${workerName}: ${staleConsumers.join(", ")}\n` +
			"  Cloudflare Queues support one Worker consumer per queue, so deploy would fail.\n" +
			"  Remove the stale consumer, then rerun setup:cloud:\n" +
			staleConsumers
				.map((name) => `    pnpm wrangler queues consumer remove ${queueName} ${name}`)
				.join("\n"),
	);
	process.exit(1);
}

let resolvedD1Id: string | undefined;
// Computed unconditionally so the dry-run prints the same `--config` the apply path uses; the file
// itself is only written in apply. At the repo ROOT (gitignored) so downstream scripts can still
// use the same relative paths the tracked config would.
const generatedConfigPath = `wrangler.generated.${envLabel}.json`;
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
	const targetBlock = targetEnv ? full.env?.[targetEnv] : full;
	const d1Entry = targetBlock?.d1_databases?.find((d) => d.binding === "INDEX_DB");
	if (d1Entry) d1Entry.database_id = resolvedD1Id;
	writeFileSync(generatedConfigPath, `${JSON.stringify(full, null, 2)}\n`);
	console.log(`  ${d1Name} → ${resolvedD1Id}`);
	console.log(`  Wrote ${generatedConfigPath} (source of truth for build patching; gitignored).`);
} else {
	console.log(
		`  → would resolve ${d1Name}'s id and write ${generatedConfigPath}, then patch dist/server/wrangler.json from it`,
	);
}

const builtConfigPath = "dist/server/wrangler.json";
const builtConfigFlag = ["--config", builtConfigPath];

// 6. Build the app for the chosen env so deploy targets the TanStack/Vite output.
buildAppForDeploy();

// 7. Patch the built worker config with the real Cloudflare bindings from the generated config.
patchBuiltWranglerConfig(generatedConfigPath);

// 8. Remote migrations (against the built config, now patched with the real id/bindings).
runIdempotent("Apply D1 migrations (remote)", [
	"d1",
	"migrations",
	"apply",
	d1Name,
	"--remote",
	...builtConfigFlag,
]);

// 9. Renames can leave a Queue wired to the old Worker name. Catch that before deploy's
// trigger-registration step fails with a generic consumer-conflict error.
assertQueueConsumerMatchesWorker();

// 10. Deploy FIRST — `secret put` requires an already-deployed Worker.
runIdempotent("Deploy the Worker", ["deploy", ...builtConfigFlag]);

// 11. MAILBOX_ID_SECRET: set only if absent (rotating it changes every mailbox id). Captured so
// step 12 seeds with the same value — it is write-only in Cloudflare afterwards. The early guard
// guaranteed seed args are present whenever we might generate one.
console.log(`\n▸ Ensure MAILBOX_ID_SECRET (generate once; never rotate an existing one)`);
let generatedSecret: string | undefined;
let secretAlreadySet = false;
if (apply) {
	try {
		const secrets = JSON.parse(
			wrangler(["secret", "list", "--format", "json", ...envFlag], {
				capture: true,
			}),
		) as Array<{ name: string }>;
		secretAlreadySet = secrets.some((s) => s.name === "MAILBOX_ID_SECRET");
	} catch {
		// treat as not set
	}
	// A recorded fingerprint means a previous run both set the secret AND seeded a mailbox with
	// it — the "healthy" signal. No fingerprint (no manifest, or an older one without a seed) means
	// the secret — if set — is ORPHANED: write-only, and no mailbox exists that can use it.
	let priorFingerprint: string | null = null;
	try {
		priorFingerprint =
			(JSON.parse(readFileSync(manifestPath, "utf8")) as { mailboxSecretFingerprint?: string })
				.mailboxSecretFingerprint ?? null;
	} catch {
		// no prior manifest — treat as no recorded seed
	}
	if (secretAlreadySet && resetSecret) {
		if (priorFingerprint) {
			console.log(
				"  WARNING: MAILBOX_ID_SECRET looks HEALTHY (a matching seed is recorded in the manifest).\n" +
					"  --reset-secret overwrites it anyway. This changes the derived id of EVERY mailbox\n" +
					"  already seeded with the current secret — do not do this after go-live unless you are\n" +
					"  prepared to re-seed/migrate every existing mailbox.",
			);
		} else {
			console.log(
				"  MAILBOX_ID_SECRET is set but no successful seed is recorded for this env — it is\n" +
					"  orphaned. Overwriting it now via --reset-secret and reseeding in this same run.",
			);
		}
		generatedSecret = randomBytes(32).toString("hex");
		wrangler(["secret", "put", "MAILBOX_ID_SECRET", ...envFlag], {
			input: generatedSecret,
		});
		console.log("  Overwrote MAILBOX_ID_SECRET with a freshly generated value (--reset-secret).");
	} else if (secretAlreadySet) {
		console.log("  MAILBOX_ID_SECRET already set — leaving it untouched.");
		if (!priorFingerprint) {
			console.log(
				"  No successful mailbox seed is recorded for this env (no fingerprint in\n" +
					`  ${manifestPath}). If a prior --apply run set this secret but then failed before\n` +
					"  seeding the first mailbox (e.g. the deploy step failed), it is orphaned — unreadable,\n" +
					"  and no mailbox exists that uses it. Recover with:\n" +
					`    pnpm setup:cloud${targetEnv ? ` --env ${targetEnv}` : ""} --domain <d> --address inbox@<d> --reset-secret --apply`,
			);
		}
	} else if (seedDomain && seedAddress) {
		generatedSecret = randomBytes(32).toString("hex");
		wrangler(["secret", "put", "MAILBOX_ID_SECRET", ...envFlag], {
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
} else if (resetSecret) {
	console.log(
		"  → would OVERWRITE MAILBOX_ID_SECRET with a fresh value (--reset-secret) and reseed the\n" +
			"  mailbox below, whether the current secret is healthy or orphaned — this changes every\n" +
			"  mailbox id derived from the current secret",
	);
} else {
	console.log("  → would generate+set one only if absent, paired with the mailbox seed below");
}

// 12. First mailbox seed. Delegates to setup-mailbox.ts; the secret is passed via the child's ENV
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
		console.log(
			`  Seeding ${seedAddress} with the ${resetSecret ? "freshly reset" : "secret just generated"}…`,
		);
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
} else if (skipSeed) {
	console.log("  → (skipped via --skip-seed) seed later with setup:mailbox.");
} else {
	console.log(
		"  → no --domain/--address given; --apply would require them (or --skip-seed). Seed later with setup:mailbox.",
	);
}

// Manifest (apply only): records a NON-sensitive fingerprint of the secret so a later run/tool can
// detect a secret/index mismatch without ever storing the secret itself.
if (apply) {
	mkdirSync(".reccado", { recursive: true });
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
console.log("1. Attach a custom domain before using the UI/API as a real inbox:");
console.log(
	`     pnpm setup:domain${targetEnv ? ` --env ${targetEnv}` : ""} --hostname app.<your-domain> --apply`,
);
console.log("\n2. Cloudflare Access must protect that custom domain.");
console.log(
	`   Then set ACCESS_JWT_AUDIENCE + ACCESS_TEAM_DOMAIN:` +
		`\n     pnpm setup:access${targetEnv ? ` --env ${targetEnv}` : ""} --hostname app.<your-domain> --aud <aud-tag> \\` +
		`\n       --team-domain https://<team>.cloudflareaccess.com --apply`,
);
console.log("\n3. Email Routing must deliver to this Worker (DNS lives on your zone):");
if (mailFrom) {
	const domain = mailFrom.split("@")[1];
	console.log(
		`     pnpm setup:routing --domain ${domain ?? "<your-domain>"}${targetEnv ? ` --env ${targetEnv}` : ""} --apply`,
	);
}
console.log(
	`\nRe-check anytime:  pnpm doctor --env ${targetEnv ?? "production"} --cloud --url https://app.<your-domain>\n`,
);

if (!apply) {
	console.log("Dry run only. Re-run with --apply to execute against Cloudflare.\n");
}
