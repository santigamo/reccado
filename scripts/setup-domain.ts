#!/usr/bin/env tsx
/**
 * `pnpm setup:domain` — attaches a custom domain to the chosen Worker env without editing the
 * tracked Wrangler config. It renders a gitignored `wrangler.generated.<env>.json`, then deploys
 * with a `routes[].custom_domain=true` entry so the Worker becomes reachable on a real hostname.
 *
 * SAFETY: dry-run by default. Review the exact hostname + deploy command first, then re-run with
 * `--apply` once you are ready to mutate Cloudflare.
 *
 * Usage:
 *   pnpm setup:domain --env dev --hostname inbox-dev.example.com
 *   pnpm setup:domain --env dev --hostname inbox-dev.example.com --apply
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Route = {
	pattern: string;
	custom_domain?: boolean;
};

type WranglerBlock = {
	name?: string;
	vars?: Record<string, unknown>;
	workers_dev?: boolean;
	routes?: Route[];
	triggers?: { crons?: string[] };
	send_email?: Array<Record<string, unknown>>;
	durable_objects?: Record<string, unknown>;
	r2_buckets?: Array<Record<string, unknown>>;
	queues?: Record<string, unknown>;
	d1_databases?: Array<{
		binding: string;
		database_name?: string;
		database_id?: string;
		migrations_dir?: string;
	}>;
	migrations?: Array<Record<string, unknown>>;
	compatibility_date?: string;
	compatibility_flags?: string[];
	observability?: Record<string, unknown>;
	upload_source_maps?: boolean;
	configPath?: string;
	userConfigPath?: string;
	[k: string]: unknown;
};

type WranglerConfig = WranglerBlock & { env?: Record<string, WranglerBlock> };

// Workers Custom Domains API record — see GET /accounts/{account_id}/workers/domains.
type WorkersCustomDomainRecord = {
	id?: string;
	zone_name?: string;
	hostname?: string;
	service?: string;
	environment?: string;
};

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

function wrangler(argv: string[], opts: { capture?: boolean } = {}): string {
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		stdio: opts.capture ? ["ignore", "pipe", "pipe"] : ["ignore", "inherit", "pipe"],
	});
}

async function cfApi<T>(token: string, path: string): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	});
	const payload = (await response.json()) as {
		success?: boolean;
		result?: T;
		errors?: Array<{ code?: number; message?: string }>;
	};
	if (!response.ok || payload.success !== true || payload.result === undefined) {
		const detail = (payload.errors ?? [])
			.map((item) => `${item.message ?? "unknown error"}${item.code ? ` [${item.code}]` : ""}`)
			.join("; ");
		throw new Error(detail || `Cloudflare API request failed (${response.status})`);
	}
	return payload.result;
}

/** Best-effort account id lookup: env var first, then `wrangler whoami --json`. */
function resolveAccountId(): string | undefined {
	const fromEnv = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
	if (fromEnv) return fromEnv;
	try {
		const payload = JSON.parse(wrangler(["whoami", "--json"], { capture: true })) as {
			account?: { id?: string };
			accounts?: Array<{ id?: string }>;
		};
		return payload.account?.id ?? payload.accounts?.[0]?.id;
	} catch {
		return undefined;
	}
}

/**
 * Looks up whether `hostname` is already attached as a Workers Custom Domain, and to which
 * Worker. Returns undefined when the check can't be performed (no CLOUDFLARE_API_TOKEN, or no
 * resolvable account id) — the caller then falls back to the error-string guard around the
 * `wrangler deploy` call, since re-attaching the same hostname to the same Worker is the common
 * case that call already tolerates.
 */
async function findExistingCustomDomain(
	targetHostname: string,
): Promise<WorkersCustomDomainRecord | undefined> {
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!token) return undefined;
	const accountId = resolveAccountId();
	if (!accountId) return undefined;
	try {
		const records = await cfApi<WorkersCustomDomainRecord[]>(
			token,
			`/accounts/${accountId}/workers/domains?hostname=${encodeURIComponent(targetHostname)}`,
		);
		return records.find((record) => record.hostname?.toLowerCase() === targetHostname);
	} catch {
		return undefined;
	}
}

const args = parseArgs(process.argv.slice(2));
const targetEnv = args.env;
const apply = args.apply === "true";
const envLabel = targetEnv ?? "production";
const hostname = args.hostname?.trim().toLowerCase();

if (!hostname) {
	console.error("setup:domain: pass --hostname <app.example.com>.");
	process.exit(1);
}

if (hostname.endsWith(".workers.dev")) {
	console.error(
		"setup:domain: pass a custom hostname on a zone you control, not a *.workers.dev URL.\n" +
			"Reccado's supported public path is custom domain + Cloudflare Access.",
	);
	process.exit(1);
}

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as WranglerConfig;
const block = targetEnv ? config.env?.[targetEnv] : config;
if (!block) {
	console.error(`setup:domain: no config block for env "${targetEnv}" in wrangler.jsonc.`);
	process.exit(1);
}

const worker = block.name ?? config.name;
const d1Name = block.d1_databases?.find((entry) => entry.binding === "INDEX_DB")?.database_name;
if (!worker || !d1Name) {
	console.error("setup:domain: could not resolve worker or INDEX_DB from wrangler.jsonc.");
	process.exit(1);
}

const generatedConfigPath = `wrangler.generated.${envLabel}.json`;
const sourceConfigPath = existsSync(generatedConfigPath) ? generatedConfigPath : "wrangler.jsonc";
const builtConfigPath = "dist/server/wrangler.json";

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function buildEffectiveWranglerBlock(
	config: WranglerConfig,
	env: string | undefined,
): WranglerBlock {
	if (!env) return config;
	const envBlock = config.env?.[env];
	if (!envBlock) {
		throw new Error(`No config block for env "${env}" in ${generatedConfigPath}.`);
	}
	return {
		...config,
		...envBlock,
		vars: envBlock.vars ?? config.vars,
		workers_dev: envBlock.workers_dev ?? config.workers_dev,
		routes: envBlock.routes ?? config.routes,
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

function patchD1Databases(builtConfig: WranglerBlock, generatedBlock: WranglerBlock): void {
	if (!generatedBlock.d1_databases) return;
	const builtDbs = builtConfig.d1_databases ?? [];
	builtConfig.d1_databases = generatedBlock.d1_databases.map((generatedDb) => {
		const builtDb = builtDbs.find((db) => db.binding === generatedDb.binding);
		return {
			...generatedDb,
			migrations_dir: builtDb?.migrations_dir ?? generatedDb.migrations_dir,
		};
	});
}

function buildAppForDeploy(): void {
	const displayPrefix = targetEnv ? `CLOUDFLARE_ENV=${targetEnv} ` : "";
	console.log(`\n▸ Build app for custom-domain deploy\n  $ ${displayPrefix}pnpm run build`);
	if (!apply) return;
	execFileSync("pnpm", ["run", "build"], {
		stdio: "inherit",
		env: targetEnv ? { ...process.env, CLOUDFLARE_ENV: targetEnv } : process.env,
	});
}

function patchBuiltWranglerConfig(): void {
	console.log(
		`\n▸ Patch built Wrangler config\n  source: ${generatedConfigPath}\n  target: ${builtConfigPath}`,
	);
	if (!apply) {
		console.log("  → would copy the custom-domain route into the built Worker config");
		return;
	}
	const generatedConfig = readJson<WranglerConfig>(generatedConfigPath);
	const generatedBlock = buildEffectiveWranglerBlock(generatedConfig, targetEnv);
	const builtConfig = readJson<WranglerBlock>(builtConfigPath);
	for (const key of [
		"name",
		"vars",
		"workers_dev",
		"routes",
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
	builtConfig.configPath = generatedConfigPath;
	builtConfig.userConfigPath = generatedConfigPath;
	writeFileSync(builtConfigPath, `${JSON.stringify(builtConfig, null, 2)}\n`);
}

console.log(
	`\nReccado setup:domain — env: ${envLabel} · worker: ${worker}` +
		`\nmode: ${apply ? "APPLY (mutating Cloudflare)" : "dry run (no changes)"}` +
		`\nhostname: ${hostname}\n`,
);

console.log("▸ Check current custom-domain attachment");
if (apply) {
	const existing = await findExistingCustomDomain(hostname);
	if (!existing) {
		console.log("  (no existing attachment found, or the check was skipped — see below)");
	} else if (existing.service === worker) {
		console.log(`  (custom domain already attached to worker "${worker}" — continuing)`);
	} else {
		console.error(
			`setup:domain: hostname "${hostname}" is already attached to a different Worker` +
				` ("${existing.service ?? "unknown"}").\n` +
				"Refusing to silently steal it. Detach it first (Cloudflare dashboard → Workers & Pages →" +
				` Custom Domains, or run \`wrangler deploy\` for "${existing.service ?? "that worker"}"` +
				" without this route), or choose a different hostname.",
		);
		process.exit(1);
	}
	if (!process.env.CLOUDFLARE_API_TOKEN?.trim()) {
		console.log(
			"  (set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to check this up front next time;" +
				" falling back to a post-deploy idempotency guard)",
		);
	}
} else {
	console.log("  → would check via the Cloudflare API whether this hostname is attached elsewhere");
}

console.log("▸ Render generated Wrangler config with a custom-domain route");
console.log(`  source: ${sourceConfigPath}`);
console.log(`  target: ${generatedConfigPath}`);

let resolvedD1Id: string | undefined;
if (apply) {
	try {
		const list = JSON.parse(wrangler(["d1", "list", "--json"], { capture: true })) as Array<{
			name: string;
			uuid?: string;
			database_id?: string;
		}>;
		const found = list.find((entry) => entry.name === d1Name);
		resolvedD1Id = found?.uuid ?? found?.database_id;
	} catch {
		// handled by guard below
	}
	if (!resolvedD1Id) {
		console.error(
			`  Could not resolve the id for D1 "${d1Name}" (check \`wrangler whoami\`). Aborting before deploy.`,
		);
		process.exit(1);
	}

	const full = JSON.parse(stripJsonc(readFileSync(sourceConfigPath, "utf8"))) as WranglerConfig;
	const targetBlock = targetEnv ? full.env?.[targetEnv] : full;
	if (!targetBlock) {
		console.error(`  Missing target env "${targetEnv}" while rendering ${generatedConfigPath}.`);
		process.exit(1);
	}

	if (targetEnv) {
		// Avoid inherited top-level routes/custom domains being re-attached to the env worker.
		full.routes = [];
	}
	targetBlock.workers_dev = false;
	targetBlock.routes = [{ pattern: hostname, custom_domain: true }];
	const d1Entry = targetBlock.d1_databases?.find((entry) => entry.binding === "INDEX_DB");
	if (d1Entry) d1Entry.database_id = resolvedD1Id;
	writeFileSync(generatedConfigPath, `${JSON.stringify(full, null, 2)}\n`);
	console.log(`  Wrote ${generatedConfigPath} with routes=[${hostname}] and workers_dev=false.`);
} else {
	console.log(
		`  → would write ${generatedConfigPath} with routes=[${hostname}] and workers_dev=false`,
	);
	if (targetEnv) {
		console.log("  → would also clear inherited top-level routes in that generated config");
	}
}

console.log(`\n▸ Deploy the Worker with the custom domain`);
buildAppForDeploy();
patchBuiltWranglerConfig();
console.log(`  $ pnpm wrangler deploy --config ${builtConfigPath}`);
if (apply) {
	try {
		wrangler(["deploy", "--config", builtConfigPath]);
	} catch (error) {
		const stderr =
			typeof (error as { stderr?: unknown })?.stderr === "string"
				? (error as { stderr: string }).stderr
				: "";
		const haystack = `${error instanceof Error ? error.message : String(error)}\n${stderr}`;
		if (/already exists|already attached|already created|duplicate|409/i.test(haystack)) {
			console.log("  (custom domain already attached — continuing)");
		} else {
			if (stderr) console.error(stderr);
			throw error;
		}
	}
}

console.log(`\n${"─".repeat(72)}`);
console.log("Next:");
console.log(`1. Protect https://${hostname} with Cloudflare Access:`);
console.log(`   pnpm setup:access${targetEnv ? ` --env ${targetEnv}` : ""} --hostname ${hostname}`);
console.log(`2. Verify the route is protected and the Worker is reachable:`);
console.log(
	`   pnpm doctor${targetEnv ? ` --env ${targetEnv}` : ""} --cloud --url https://${hostname}`,
);
console.log(`3. If Email Routing should deliver to this same install, wire the zone too:`);
console.log(
	`   pnpm setup:routing --domain <your-zone>${targetEnv ? ` --env ${targetEnv}` : ""}${apply ? "" : " [--apply]"}`,
);

if (!apply) {
	console.log("\nDry run only. Re-run with --apply to create/update the custom domain route.\n");
}
