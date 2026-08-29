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
 *   - R2 bucket, every Queue the env declares (producers, consumers and their DLQs), D1 database
 *     (idempotent; "already exists" is fine)
 *   - Resolves the real D1 id via `wrangler d1 list --json` and writes it into a gitignored
 *     `wrangler.generated.<env>.json` (never edits the tracked wrangler.jsonc)
 *   - Builds the TanStack Start app for the chosen env, patches `dist/server/wrangler.json`
 *     with the real Cloudflare bindings from the generated config, then migrates + deploys
 *     from that built Worker config
 *   - Seeds the first mailbox via `pnpm setup:mailbox` (random `mailbox_id` assigned by the
 *     INSERT; re-running is a no-op because primary_address is UNIQUE)
 *
 * A Worker with no mailbox row silently drops every inbound message, so `--apply` requires
 * --domain/--address unless you explicitly opt out with --skip-seed.
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
 */
import { execFileSync } from "node:child_process";
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
// Non-sensitive record of what this env was provisioned with — written near the end of the run.
const manifestPath = `.reccado/setup.${envLabel}.json`;

const seedDomain = args.domain?.trim().toLowerCase();
const seedAddress = args.address?.trim();
const seedCatchAll = args["catch-all"] === "true";
// Advanced opt-out for re-provisioning an env whose mailbox rows already exist.
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
const d1Name = block.d1_databases?.find((d) => d.binding === "INDEX_DB")?.database_name;
const mailFrom = block.vars?.MAIL_FROM_ADDRESS;

// Every queue named anywhere in the env's block has to exist in the account before deploy —
// wrangler creates none of them. Derived as the deduplicated union of producers, consumers and
// their dead-letter queues rather than a hand-picked pair, so the next queue added to
// wrangler.jsonc provisions itself and a self-hoster never hits a deploy that fails on a
// queue nobody remembered to add here.
const producerQueues = block.queues?.producers?.map((p) => p.queue) ?? [];
const consumerQueues = block.queues?.consumers?.map((c) => c.queue) ?? [];
const dlqNames = (block.queues?.consumers ?? [])
	.map((c) => c.dead_letter_queue)
	.filter((name): name is string => Boolean(name));
const allQueues = [...new Set([...producerQueues, ...consumerQueues, ...dlqNames].filter(Boolean))];

// Kept for the consumer-ownership check and the manifest: the inbound queue is the one whose
// consumer a rename can strand, and the pair is what earlier manifests recorded.
const queue = producerQueues[0];
const dlq = dlqNames[0];

// A deployment with no queue or no DLQ is not a shape this project has — a missing name means
// the config was misread, not that the operator meant to run without ingest.
if (!worker || !r2 || !queue || !dlq || !d1Name) {
	console.error("setup:cloud: could not resolve all resource names from wrangler.jsonc.");
	console.error({ worker, r2, queue, dlq, d1Name, queues: allQueues });
	process.exit(1);
}
const workerName: string = worker;
const queueName: string = queue;

// Inbound mail is resolved against D1, so a deployed Worker with no mailbox row accepts nothing.
// --apply therefore insists on seed args unless you explicitly opt out.
if (apply && !skipSeed && !(seedDomain && seedAddress)) {
	console.error(
		"setup:cloud --apply needs --domain <d> --address inbox@<d> so the first mailbox is seeded\n" +
			"in the same run — until one exists the deployed Worker has nothing to deliver to.\n" +
			"Pass --skip-seed only if this env's mailbox rows are already seeded.",
	);
	process.exit(1);
}

// stderr is PIPED (not inherited) so that error.stderr is populated for the idempotency check
// below; on real failures we print it before rethrowing so nothing is swallowed.
function wrangler(argv: string[], opts: { capture?: boolean } = {}): string {
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
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
for (const queueToCreate of allQueues) {
	runIdempotent(`Create queue ${queueToCreate}`, ["queues", "create", queueToCreate]);
}
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

// 10. Deploy the Worker from the patched build.
runIdempotent("Deploy the Worker", ["deploy", ...builtConfigFlag]);

// 11. First mailbox seed. Delegates to setup-mailbox.ts, which assigns a random mailbox_id on
// insert and no-ops on an address that is already seeded — so this is safe to re-run.
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
		console.log(`  → would run: pnpm ${mailboxArgs.join(" ")} --apply`);
	} else {
		console.log(`  Seeding ${seedAddress}…`);
		execFileSync("pnpm", [...mailboxArgs, "--apply"], { stdio: "inherit" });
	}
} else if (skipSeed) {
	console.log("  → (skipped via --skip-seed) seed later with setup:mailbox.");
} else {
	console.log(
		"  → no --domain/--address given; --apply would require them (or --skip-seed). Seed later with setup:mailbox.",
	);
}

// Manifest (apply only): a non-sensitive record of what this env was provisioned with, so a later
// run or `pnpm doctor` can compare intent against the live account.
if (apply) {
	mkdirSync(".reccado", { recursive: true });
	const manifest = {
		env: envLabel,
		worker,
		r2,
		queue,
		dlq,
		queues: allQueues,
		d1Name,
		d1Id: resolvedD1Id ?? null,
		mailFrom,
		mailbox: seedDomain && seedAddress ? { domain: seedDomain, address: seedAddress } : null,
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
