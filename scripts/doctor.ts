#!/usr/bin/env tsx
/**
 * `pnpm doctor` — diagnoses a Reccado checkout and tells you the exact command to
 * fix whatever is incomplete, instead of failing opaquely at `pnpm dev` or deploy.
 *
 * Default run is offline and deterministic (toolchain + local dev + config placeholders).
 * Pass `--cloud` to add remote checks (auth, D1 exists + id match, required secrets, and — with
 * `--url` — that Cloudflare Access is protecting the route). Exhaustive R2/queue/Email-Routing
 * binding verification lives in `pnpm verify:cf`.
 *
 * Usage:
 *   pnpm doctor                       # local + config checks for the default (production) config
 *   pnpm doctor --env dev             # inspect the env.dev block instead
 *   pnpm doctor --env dev --cloud --url https://…   # remote: D1, secrets, Access redirect
 *   pnpm -s doctor:json               # machine-readable output (-s drops pnpm's banner; exit 1 on any fail)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

type Status = "pass" | "warn" | "fail" | "info";
type Check = { id: string; status: Status; message: string; fix?: string };

const SYMBOL: Record<Status, string> = { pass: "✓", warn: "!", fail: "✗", info: "·" };
const DEV_SEED_SECRET = "dev-mailbox-id-secret-v1";
const PROD_D1_PLACEHOLDER = "<your-prod-d1-database-id>";
const DEV_D1_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const EXAMPLE_FROM = "noreply@mail.example.com";

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

/** Compares dotted numeric versions. Returns -1/0/1 for a<b / a==b / a>b. */
function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

function parseDotEnv(content: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const sep = trimmed.indexOf("=");
		if (sep === -1) continue;
		map.set(trimmed.slice(0, sep).trim(), trimmed.slice(sep + 1).trim());
	}
	return map;
}

const checks: Check[] = [];
const add = (c: Check) => checks.push(c);

const args = parseArgs(process.argv.slice(2));
const targetEnv = args.env; // undefined => top-level (production) config
const asJson = args.json === "true";

// --- Toolchain ---------------------------------------------------------------

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
	engines?: { node?: string };
	packageManager?: string;
};

const requiredNode = (pkg.engines?.node ?? "").replace(/[^\d.]/g, "");
const currentNode = process.versions.node;
if (requiredNode && compareVersions(currentNode, requiredNode) < 0) {
	add({
		id: "node.version",
		status: "fail",
		message: `Node ${currentNode} is below required >=${requiredNode}.`,
		fix: `Install Node >=${requiredNode} (see .node-version / your version manager).`,
	});
} else {
	add({
		id: "node.version",
		status: "pass",
		message: `Node ${currentNode} satisfies engines.node.`,
	});
}

const pinnedPnpm = pkg.packageManager?.startsWith("pnpm@")
	? pkg.packageManager.slice("pnpm@".length)
	: undefined;
try {
	const pnpmVersion = execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
	if (pinnedPnpm && pnpmVersion !== pinnedPnpm) {
		add({
			id: "pnpm.version",
			status: "warn",
			message: `pnpm ${pnpmVersion} differs from pinned pnpm@${pinnedPnpm}.`,
			fix: "Run `corepack enable` so the repo-pinned pnpm is used automatically.",
		});
	} else {
		add({
			id: "pnpm.version",
			status: "pass",
			message: `pnpm ${pnpmVersion} matches packageManager.`,
		});
	}
} catch {
	add({
		id: "pnpm.version",
		status: "fail",
		message: "pnpm is not runnable.",
		fix: "Enable it with `corepack enable` or install pnpm.",
	});
}

try {
	const wranglerVersion = execFileSync("pnpm", ["wrangler", "--version"], { encoding: "utf8" })
		.trim()
		.split(/\s+/)
		.find((t) => /^\d+\.\d+/.test(t));
	if (wranglerVersion && compareVersions(wranglerVersion, "4.0.0") >= 0) {
		add({ id: "wrangler.version", status: "pass", message: `Wrangler ${wranglerVersion} (4.x).` });
	} else {
		add({
			id: "wrangler.version",
			status: "warn",
			message: `Wrangler ${wranglerVersion ?? "unknown"} — this repo assumes 4.x.`,
			fix: "Update the `wrangler` devDependency to ^4.x.",
		});
	}
} catch {
	add({
		id: "wrangler.version",
		status: "fail",
		message: "Wrangler is not runnable.",
		fix: "Run `pnpm install` to install the pinned wrangler.",
	});
}

// --- Local dev ---------------------------------------------------------------

if (!existsSync(".dev.vars")) {
	add({
		id: "devvars.present",
		status: "info",
		message: ".dev.vars is absent — `pnpm dev` will generate a minimal one automatically.",
	});
} else {
	const devVars = parseDotEnv(readFileSync(".dev.vars", "utf8"));
	add({ id: "devvars.present", status: "pass", message: ".dev.vars exists." });

	const aud = devVars.get("ACCESS_JWT_AUDIENCE")?.trim();
	const team = devVars.get("ACCESS_TEAM_DOMAIN")?.trim();
	if (aud && team) {
		add({
			id: "devvars.access-bypass",
			status: "fail",
			message:
				"Both Access vars are set in .dev.vars, so local /api/* leaves the local-dev bypass.",
			fix: "Comment out ACCESS_JWT_AUDIENCE and ACCESS_TEAM_DOMAIN in .dev.vars for local dev.",
		});
	} else if (aud || team) {
		add({
			id: "devvars.access-bypass",
			status: "warn",
			message: "Exactly one Access var is set — the runtime treats this as misconfigured Access.",
			fix: "Set both Access vars (real Access test) or neither (local bypass) in .dev.vars.",
		});
	} else {
		add({
			id: "devvars.access-bypass",
			status: "pass",
			message: "Access is unset locally — local-dev bypass is active.",
		});
	}

	const secret = devVars.get("MAILBOX_ID_SECRET")?.trim();
	if (!secret) {
		add({
			id: "devvars.mailbox-secret",
			status: "info",
			message: "MAILBOX_ID_SECRET not in .dev.vars — the seed falls back to its default.",
		});
	} else if (secret === DEV_SEED_SECRET) {
		add({
			id: "devvars.mailbox-secret",
			status: "pass",
			message: "MAILBOX_ID_SECRET matches the dev seed default.",
		});
	} else {
		add({
			id: "devvars.mailbox-secret",
			status: "warn",
			message:
				"MAILBOX_ID_SECRET differs from the dev seed default; seeded mailbox IDs won't match.",
			fix: `Set MAILBOX_ID_SECRET=${DEV_SEED_SECRET} in .dev.vars, or re-seed after changing it.`,
		});
	}
}

const migrationFiles = existsSync("migrations/d1")
	? readdirSync("migrations/d1").filter((f) => f.endsWith(".sql"))
	: [];
if (migrationFiles.length > 0) {
	add({
		id: "migrations.present",
		status: "pass",
		message: `${migrationFiles.length} D1 migration file(s) found.`,
	});
} else {
	add({
		id: "migrations.present",
		status: "fail",
		message: "No D1 migration files under migrations/d1.",
		fix: "Restore migrations/d1/*.sql (the schema source of truth).",
	});
}

// --- Config (wrangler.jsonc) -------------------------------------------------

type WranglerConfig = {
	name?: string;
	vars?: { MAIL_FROM_ADDRESS?: string };
	d1_databases?: Array<{ binding: string; database_name?: string; database_id: string }>;
	env?: Record<string, WranglerConfig>;
};
const wrangler = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as WranglerConfig;
const block: WranglerConfig | undefined = targetEnv ? wrangler.env?.[targetEnv] : wrangler;
const envLabel = targetEnv ?? "production (top-level)";

if (!block) {
	add({
		id: "config.env",
		status: "fail",
		message: `No config block for env "${targetEnv}" in wrangler.jsonc.`,
		fix: "Pass a valid --env (e.g. dev) or omit it for the default config.",
	});
} else {
	const d1Id = block.d1_databases?.find((d) => d.binding === "INDEX_DB")?.database_id ?? "";
	const isPlaceholder = d1Id === PROD_D1_PLACEHOLDER || d1Id === DEV_D1_PLACEHOLDER || d1Id === "";
	if (!isPlaceholder) {
		add({
			id: "config.d1-id",
			status: "pass",
			message: `INDEX_DB database_id is set for ${envLabel}.`,
		});
	} else if (targetEnv) {
		add({
			id: "config.d1-id",
			status: "warn",
			message: `INDEX_DB database_id is a placeholder for ${envLabel} — fine locally, not for a remote deploy.`,
			fix: `pnpm setup:cloud --env ${targetEnv} --domain <d> --address inbox@<d> --apply (writes a gitignored generated config; don't edit wrangler.jsonc)`,
		});
	} else {
		add({
			id: "config.d1-id",
			status: "warn",
			message: `INDEX_DB database_id is a placeholder for ${envLabel} — local dev is fine, but a remote deploy will fail until it is set.`,
			fix: "pnpm setup:cloud --domain <d> --address inbox@<d> --apply (writes a gitignored generated config; don't edit wrangler.jsonc)",
		});
	}

	const from = block.vars?.MAIL_FROM_ADDRESS;
	if (from && from !== EXAMPLE_FROM) {
		add({
			id: "config.mail-from",
			status: "pass",
			message: `MAIL_FROM_ADDRESS set for ${envLabel}.`,
		});
	} else {
		add({
			id: "config.mail-from",
			status: "warn",
			message: `MAIL_FROM_ADDRESS is still the ${EXAMPLE_FROM} example for ${envLabel}.`,
			fix: "Set vars.MAIL_FROM_ADDRESS to a verified Email Sending address.",
		});
	}
}

// --- Cloud (opt-in) ----------------------------------------------------------

if (args.cloud === "true") {
	try {
		const who = execFileSync("pnpm", ["wrangler", "whoami"], { encoding: "utf8" });
		const email = who.match(/[\w.+-]+@[\w.-]+/)?.[0];
		add({
			id: "cloud.auth",
			status: "pass",
			message: `Authenticated with Cloudflare${email ? ` as ${email}` : ""}.`,
		});
	} catch {
		add({
			id: "cloud.auth",
			status: "warn",
			message: "Not authenticated with Cloudflare (cloud checks skipped).",
			fix: "Run `pnpm wrangler login`, then re-run with --cloud.",
		});
	}
	addAll(checkD1Remote());
	addAll(checkSecretsRemote());
	if (args.url) {
		add(await checkAccessRedirect(args.url));
	} else {
		add({
			id: "cloud.access",
			status: "info",
			message: "Pass --url <deployed-url> to check that Cloudflare Access is protecting /api/*.",
		});
	}
	add({
		id: "cloud.bindings",
		status: "info",
		message: "Exhaustive binding verification (R2/queues/Email Routing) lives in `pnpm verify:cf`.",
	});
}

function addAll(items: Check[]): void {
	for (const c of items) add(c);
}

/** Confirms the target env's INDEX_DB database exists in the account and its id matches config. */
function checkD1Remote(): Check[] {
	const entry = block?.d1_databases?.find((d) => d.binding === "INDEX_DB");
	if (!entry?.database_name) return [];
	try {
		const list = JSON.parse(
			execFileSync("pnpm", ["wrangler", "d1", "list", "--json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		) as Array<{ name: string; uuid?: string; database_id?: string }>;
		const found = list.find((d) => d.name === entry.database_name);
		if (!found) {
			return [
				{
					id: "cloud.d1",
					status: "fail",
					message: `D1 "${entry.database_name}" not found in this account.`,
					fix: `pnpm setup:cloud${targetEnv ? ` --env ${targetEnv}` : ""} --domain <d> --address inbox@<d> --apply`,
				},
			];
		}
		const realId = found.uuid ?? found.database_id;
		const isPlaceholder =
			entry.database_id === PROD_D1_PLACEHOLDER || entry.database_id === DEV_D1_PLACEHOLDER;
		if (!isPlaceholder && realId && realId !== entry.database_id) {
			return [
				{
					id: "cloud.d1",
					status: "warn",
					message: `D1 "${entry.database_name}" exists but its id (${realId}) differs from wrangler.jsonc (${entry.database_id}).`,
					fix: "Update the INDEX_DB database_id, or deploy with the generated wrangler config.",
				},
			];
		}
		return [
			{
				id: "cloud.d1",
				status: "pass",
				message: `D1 "${entry.database_name}" exists in the account.`,
			},
		];
	} catch {
		return [{ id: "cloud.d1", status: "warn", message: "Could not list D1 databases (auth?)." }];
	}
}

/** Confirms the Worker's remote secrets: MAILBOX_ID_SECRET (required) and the Access pair. */
function checkSecretsRemote(): Check[] {
	const worker = block?.name ?? wrangler.name;
	if (!worker) return [];
	let names: Set<string>;
	try {
		const secrets = JSON.parse(
			execFileSync(
				"pnpm",
				[
					"wrangler",
					"secret",
					"list",
					"--format",
					"json",
					"--name",
					worker,
					...(targetEnv ? ["--env", targetEnv] : []),
				],
				{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
			),
		) as Array<{ name: string }>;
		names = new Set(secrets.map((s) => s.name));
	} catch {
		return [
			{
				id: "cloud.secrets",
				status: "warn",
				message: `Could not list secrets for "${worker}" (deployed?).`,
			},
		];
	}
	const out: Check[] = [];
	out.push(
		names.has("MAILBOX_ID_SECRET")
			? { id: "cloud.secret.mailbox", status: "pass", message: "MAILBOX_ID_SECRET is set." }
			: {
					id: "cloud.secret.mailbox",
					status: "fail",
					message: "MAILBOX_ID_SECRET is not set — mailbox id derivation will fail.",
					fix: `pnpm setup:cloud${targetEnv ? ` --env ${targetEnv}` : ""} --domain <d> --address inbox@<d> --apply`,
				},
	);
	const missingAccess = ["ACCESS_JWT_AUDIENCE", "ACCESS_TEAM_DOMAIN"].filter((n) => !names.has(n));
	out.push(
		missingAccess.length === 0
			? { id: "cloud.secret.access", status: "pass", message: "Access secrets are set." }
			: {
					id: "cloud.secret.access",
					status: "warn",
					message: `Access secret(s) missing: ${missingAccess.join(", ")} — /api/* is unprotected without them.`,
					fix: "pnpm setup:access --url <deployed-url> ... --apply",
				},
	);
	return out;
}

/**
 * An unauthenticated request to a Worker fronted by Cloudflare Access should be redirected to
 * the team's cloudflareaccess.com login. A 200 means Access is NOT protecting the route.
 */
async function checkAccessRedirect(rawUrl: string): Promise<Check> {
	const url = new URL("/api/health", rawUrl).toString();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8000);
	try {
		const res = await fetch(url, { redirect: "manual", signal: controller.signal });
		const location = res.headers.get("location") ?? "";
		if ((res.status === 302 || res.status === 303) && /cloudflareaccess\.com/i.test(location)) {
			return {
				id: "cloud.access",
				status: "pass",
				message: `Access redirects unauthenticated ${url} to login.`,
			};
		}
		if (res.status === 403 || res.status === 401) {
			return {
				id: "cloud.access",
				status: "warn",
				message: `Unauthenticated ${url} is blocked (${res.status}) but not confirmed as an Access login — a WAF/firewall/wrong route looks the same.`,
				fix: "Confirm it's a 302 to cloudflareaccess.com for the exact route.",
			};
		}
		if (res.status === 200) {
			return {
				id: "cloud.access",
				status: "fail",
				message: `Unauthenticated ${url} returned 200 — Cloudflare Access is NOT protecting it.`,
				fix: "Create a self-hosted Access app for the route and an allow policy (see `pnpm setup:access`).",
			};
		}
		return {
			id: "cloud.access",
			status: "warn",
			message: `Unauthenticated ${url} returned ${res.status} (expected a 302 to cloudflareaccess.com).`,
			fix: "Confirm the Access application covers this exact route.",
		};
	} catch {
		return {
			id: "cloud.access",
			status: "warn",
			message: `Could not reach ${url} to check Access.`,
			fix: "Check the URL and that the Worker is deployed.",
		};
	} finally {
		clearTimeout(timeout);
	}
}

// --- Report ------------------------------------------------------------------

const counts = { pass: 0, warn: 0, fail: 0, info: 0 } as Record<Status, number>;
for (const c of checks) counts[c.status] += 1;

if (asJson) {
	console.log(JSON.stringify({ env: envLabel, counts, checks }, null, 2));
} else {
	console.log(`\nReccado doctor — config: ${envLabel}\n`);
	for (const c of checks) {
		console.log(`  ${SYMBOL[c.status]} ${c.id.padEnd(24)} ${c.message}`);
		if (c.fix && (c.status === "warn" || c.status === "fail")) {
			console.log(`      → ${c.fix}`);
		}
	}
	console.log(
		`\n  ${counts.pass} pass · ${counts.warn} warn · ${counts.fail} fail · ${counts.info} info\n`,
	);
}

process.exit(counts.fail > 0 ? 1 : 0);
