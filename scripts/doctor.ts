#!/usr/bin/env tsx
/**
 * `pnpm doctor` — diagnoses a Reccado checkout and tells you the exact command to
 * fix whatever is incomplete, instead of failing opaquely at `pnpm dev` or deploy.
 *
 * Default run is offline and deterministic (toolchain + local dev + config placeholders).
 * Pass `--cloud` to add remote checks (auth, D1 exists + id match, every declared Queue exists and
 * its DLQs are consumed, required secrets, and — with `--url` — that Cloudflare Access is protecting
 * the route). Exhaustive R2/queue/Email-Routing *binding* wiring lives in `pnpm verify:cf`.
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
	workers_dev?: boolean;
	routes?: Array<{ pattern: string; custom_domain?: boolean }>;
	vars?: { MAIL_FROM_ADDRESS?: string };
	queues?: {
		producers?: Array<{ binding: string; queue: string }>;
		consumers?: Array<{ queue: string; dead_letter_queue?: string }>;
	};
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

	if (block.workers_dev === false) {
		add({
			id: "config.public-host",
			status: "pass",
			message: `${envLabel} disables workers.dev; use a custom domain for the deployed UI/API.`,
		});
	} else if (targetEnv === "dev") {
		add({
			id: "config.public-host",
			status: "info",
			message:
				"dev keeps workers.dev available for remote smoke tests; use a custom domain for Access-protected UI/API checks.",
			fix: `Attach a custom domain with pnpm setup:domain --env dev --hostname app.<your-domain>`,
		});
	} else {
		add({
			id: "config.public-host",
			status: "warn",
			message: `${envLabel} still exposes workers.dev.`,
			fix: `Set workers_dev=false and attach a custom domain with pnpm setup:domain${targetEnv ? ` --env ${targetEnv}` : ""} --hostname app.<your-domain>`,
		});
	}

	const customDomainRoutes =
		block.routes?.filter((route) => route.custom_domain).map((route) => route.pattern) ?? [];
	if (customDomainRoutes.length > 0) {
		add({
			id: "config.custom-domain",
			status: "pass",
			message: `Custom domain route configured: ${customDomainRoutes.join(", ")}.`,
		});
	} else {
		add({
			id: "config.custom-domain",
			status: targetEnv ? "info" : "warn",
			message: "No custom domain route is configured in tracked wrangler.jsonc.",
			fix: `Use pnpm setup:domain${targetEnv ? ` --env ${targetEnv}` : ""} --hostname app.<your-domain> (writes a gitignored generated config; doesn't edit wrangler.jsonc).`,
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
	addAll(checkQueuesRemote());
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
		message:
			"Exhaustive binding verification (R2/queues/Email Routing wiring) lives in `pnpm verify:cf`.",
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

type AccountQueue = { name: string; consumers: number };

// `queues list` grew a --json flag after the wrangler this repo pins, so the first
// page decides which surface to read and the rest follow it: no repeated failures.
let queueListJson = true;

function runQueueList(page: number): string | null {
	const argv = ["wrangler", "queues", "list", "--page", String(page)];
	if (queueListJson) {
		try {
			return execFileSync("pnpm", [...argv, "--json"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch {
			queueListJson = false;
		}
	}
	try {
		return execFileSync("pnpm", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch {
		return null;
	}
}

function parseQueueListJson(raw: string): AccountQueue[] | null {
	const start = raw.indexOf("[");
	if (start === -1) return null;
	try {
		const parsed = JSON.parse(raw.slice(start)) as unknown;
		if (!Array.isArray(parsed)) return null;
		return parsed.map((entry: Record<string, unknown>) => ({
			name: String(entry.queue_name ?? entry.name ?? ""),
			consumers: Array.isArray(entry.consumers)
				? entry.consumers.length
				: Number(entry.consumers_total_count ?? 0),
		}));
	} catch {
		return null;
	}
}

/** Wrangler's box-drawn table: │ id │ name │ created_on │ modified_on │ producers │ consumers │. */
function parseQueueListTable(raw: string): AccountQueue[] {
	const rows: AccountQueue[] = [];
	for (const line of raw.split("\n")) {
		if (!line.startsWith("│")) continue;
		const cells = line
			.split("│")
			.slice(1, -1)
			.map((cell) => cell.trim());
		const name = cells[1];
		if (cells.length < 6 || !name || name === "name") continue;
		rows.push({ name, consumers: Number.parseInt(cells[5] ?? "", 10) || 0 });
	}
	return rows;
}

/** Queue name → consumer count for the whole account, or null if it can't be read. */
function listAccountQueues(): Map<string, number> | null {
	const byName = new Map<string, number>();
	// Paginated: a queue that merely sits on page 2 would otherwise be reported as
	// a missing one, which is a deploy-breaking verdict.
	for (let page = 1; page <= 10; page += 1) {
		const raw = runQueueList(page);
		if (raw === null) return page === 1 ? null : byName;
		const rows = parseQueueListJson(raw) ?? parseQueueListTable(raw);
		if (rows.length === 0) break;
		for (const row of rows) {
			if (row.name) byName.set(row.name, row.consumers);
		}
	}
	return byName;
}

/**
 * Queues are the one binding wrangler never creates for you: deploy fails outright
 * on a queue the config names and the account lacks, and `pnpm doctor` existed
 * precisely so that failure arrives here instead. The declared set is the same
 * union setup:cloud provisions — producers, consumers and their dead-letter queues,
 * deduplicated — read the same way so the two cannot drift.
 *
 * A DLQ with no consumer is not a deploy failure but is worse in production: dead
 * messages sit there unread until Queues retention drops them (~4 days) and the
 * evidence of what broke is gone.
 */
function checkQueuesRemote(): Check[] {
	const dlqs = (block?.queues?.consumers ?? [])
		.map((consumer) => consumer.dead_letter_queue)
		.filter((name): name is string => Boolean(name));
	const declared = [
		...new Set([
			...(block?.queues?.producers ?? []).map((producer) => producer.queue),
			...(block?.queues?.consumers ?? []).map((consumer) => consumer.queue),
			...dlqs,
		]),
	].filter(Boolean);
	if (declared.length === 0) return [];

	const account = listAccountQueues();
	if (!account) {
		return [
			{
				id: "cloud.queues",
				status: "warn",
				message: "Could not list Queues (auth?).",
				fix: "Run `pnpm wrangler login`, then re-run with --cloud.",
			},
		];
	}

	const out: Check[] = [];
	const missing = declared.filter((name) => !account.has(name));
	if (missing.length > 0) {
		out.push({
			id: "cloud.queues",
			status: "fail",
			message: `Queue(s) declared for ${envLabel} but absent from this account: ${missing.join(", ")} — deploy will fail.`,
			fix: `pnpm setup:cloud${targetEnv ? ` --env ${targetEnv}` : ""} --domain <d> --address inbox@<d> --apply (or pnpm wrangler queues create ${missing[0]})`,
		});
	} else {
		out.push({
			id: "cloud.queues",
			status: "pass",
			message: `All ${declared.length} queue(s) declared for ${envLabel} exist in the account.`,
		});
	}

	// Only DLQs that exist can be judged on their consumers; the missing ones are
	// already a fail above, and saying "all DLQs have a consumer" about queues that
	// are not there would be the false reassurance this check exists to remove.
	const existingDlqs = dlqs.filter((name) => account.has(name));
	const orphanDlqs = existingDlqs.filter((name) => account.get(name) === 0);
	if (orphanDlqs.length > 0) {
		out.push({
			id: "cloud.queues.dlq",
			status: "warn",
			message: `Dead-letter queue(s) with no consumer: ${orphanDlqs.join(", ")} — dead messages expire unread (~4 days) and leave no tombstone.`,
			fix: `Declare each DLQ under queues.consumers (the tombstone handler), then deploy — a consumer declared but never deployed looks exactly like this from the account side.`,
		});
	} else if (existingDlqs.length > 0) {
		out.push({
			id: "cloud.queues.dlq",
			status: "pass",
			message: `All ${existingDlqs.length} dead-letter queue(s) have a consumer.`,
		});
	}
	return out;
}

/** Mirrors src/telegram/registration.ts: two minutes of clock-skew tolerance. */
const TELEGRAM_CLOCK_SKEW_MS = 120_000;

/**
 * Reads the four facts that decide whether the Telegram bridge actually delivers:
 * the chat it adopted, the origin it learned to register its webhook on, the
 * registration it performed, and what Telegram last observed about it. All live
 * in runtime_config because the worker observes them -- so a bridge that is
 * configured but mute has somewhere to say so, which is exactly what it lacked
 * when it sat dead in production for days.
 *
 * The last pair catches the mute case the first pair cannot see: a webhook on the
 * right URL registered with a secret Telegram's updates no longer match, which
 * answers 401 on every delivery while every other signal reads healthy.
 */
function checkTelegramBridge(): Check {
	let rows: Array<{ key: string; value: string }>;
	try {
		const raw = execFileSync(
			"pnpm",
			[
				"wrangler",
				"d1",
				"execute",
				"INDEX_DB",
				"--remote",
				"--json",
				"--command",
				"SELECT key, value FROM runtime_config WHERE key IN ('telegram.chat_id', 'deployment.origin', 'telegram.webhook_registration', 'telegram.webhook_observation')",
				...(targetEnv ? ["--env", targetEnv] : []),
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		const parsed = JSON.parse(raw.slice(raw.indexOf("["))) as Array<{
			results: Array<{ key: string; value: string }>;
		}>;
		rows = parsed[0]?.results ?? [];
	} catch {
		return {
			id: "cloud.telegram",
			status: "warn",
			message: "TELEGRAM_BOT_TOKEN is set but runtime_config could not be read.",
			fix: `pnpm d1:migrate:${targetEnv ?? "prod"} — the runtime_config table may be missing.`,
		};
	}
	const byKey = new Map(rows.map((row) => [row.key, row.value]));

	// The live pairing code, if the bridge is still waiting for its first operator.
	// `strftime` and not `datetime('now')`: expires_at is written as toISOString(), and
	// the two formats differ at character 11 (T vs space) where the space sorts lower —
	// with datetime() every code would look unexpired forever.
	let pairingCode: string | null = null;
	let operatorCount = 0;
	try {
		const rawOwners = execFileSync(
			"pnpm",
			[
				"wrangler",
				"d1",
				"execute",
				"INDEX_DB",
				"--remote",
				"--json",
				"--command",
				"SELECT (SELECT COUNT(*) FROM owner_identities WHERE kind = 'telegram') AS operators, (SELECT code FROM owner_pairing_codes WHERE consumed_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY created_at DESC LIMIT 1) AS code",
				...(targetEnv ? ["--env", targetEnv] : []),
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
		);
		const parsedOwners = JSON.parse(rawOwners.slice(rawOwners.indexOf("["))) as Array<{
			results: Array<{ operators: number; code: string | null }>;
		}>;
		const row = parsedOwners[0]?.results?.[0];
		operatorCount = row?.operators ?? 0;
		pairingCode = row?.code ?? null;
	} catch {
		// Registry unreadable (migration 0012 not applied yet); the checks below still
		// report what they can rather than failing the whole doctor run.
	}

	const missing: string[] = [];
	if (!byKey.get("deployment.origin")) {
		missing.push("no deployment origin recorded (load the authenticated UI once)");
	}
	if (operatorCount === 0) {
		missing.push(
			pairingCode
				? `no operator linked — send /start ${pairingCode} to the bot`
				: "no operator linked (the hourly cron mints a pairing code; re-run once it has)",
		);
	} else if (!byKey.get("telegram.chat_id")) {
		missing.push("no chat adopted (send /start to the bot from a linked account)");
	}
	if (missing.length > 0) {
		return {
			id: "cloud.telegram",
			status: "warn",
			message: `Telegram bridge is on but not delivering: ${missing.join("; ")}.`,
			fix: "Both are one-time actions; the hourly cron registers the webhook afterwards.",
		};
	}
	const registration = parseJsonValue(byKey.get("telegram.webhook_registration"));
	const observation = parseJsonValue(byKey.get("telegram.webhook_observation"));
	const registeredAt = Date.parse(String(registration?.registeredAt ?? ""));
	const lastErrorAt = Date.parse(String(observation?.lastErrorAt ?? ""));
	// Only the dates are compared; the message is quoted, never parsed -- Telegram
	// owns that wording and may reword it whenever it likes.
	if (
		Number.isFinite(registeredAt) &&
		Number.isFinite(lastErrorAt) &&
		lastErrorAt > registeredAt + TELEGRAM_CLOCK_SKEW_MS
	) {
		return {
			id: "cloud.telegram",
			status: "warn",
			message: `Telegram is failing to deliver webhook updates since ${observation?.lastErrorAt}: ${observation?.lastErrorMessage ?? "no message reported"} (${observation?.pendingUpdateCount ?? 0} update(s) pending).`,
			fix: "The hourly cron re-registers the webhook; if the error persists, check that Cloudflare Access has a Bypass policy for /telegram/webhook.",
		};
	}
	return {
		id: "cloud.telegram",
		status: "pass",
		message: `Telegram bridge delivers to chat ${byKey.get("telegram.chat_id")} via ${byKey.get("deployment.origin")}.`,
	};
}

/** Runtime-config JSON values, read leniently: a malformed row is not a diagnosis. */
function parseJsonValue(raw: string | undefined): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Confirms the Worker's remote Access secrets. */
function checkSecretsRemote(): Check[] {
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
				message: `Could not list secrets for ${targetEnv ? `env "${targetEnv}"` : "the default Worker"} (deployed?).`,
			},
		];
	}
	const out: Check[] = [];
	// The bridge is optional, so its absence is a pass, not a warning. What used to
	// be invisible -- a bot token set but nothing ever delivered -- is what this
	// reports, by reading the state the worker records about itself.
	if (names.has("TELEGRAM_BOT_TOKEN")) {
		out.push(checkTelegramBridge());
	}
	const missingAccess = ["ACCESS_JWT_AUDIENCE", "ACCESS_TEAM_DOMAIN"].filter((n) => !names.has(n));
	out.push(
		missingAccess.length === 0
			? { id: "cloud.secret.access", status: "pass", message: "Access secrets are set." }
			: {
					id: "cloud.secret.access",
					status: "warn",
					message: `Access secret(s) missing: ${missingAccess.join(", ")} — /api/* is unprotected without them.`,
					fix: "pnpm setup:access --hostname <app.your-domain> ... --apply",
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
	if (url.includes(".workers.dev/")) {
		return {
			id: "cloud.access",
			status: "warn",
			message: `Access check skipped for ${url}: Reccado's supported public path is a custom domain, not workers.dev.`,
			fix: `Attach a custom domain first with pnpm setup:domain${targetEnv ? ` --env ${targetEnv}` : ""} --hostname app.<your-domain>`,
		};
	}
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
