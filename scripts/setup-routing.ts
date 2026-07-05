#!/usr/bin/env tsx
/**
 * `pnpm setup:routing` — wires Cloudflare Email Routing to deliver a recipient to this
 * Worker, using the parts Wrangler can automate and falling back to the Cloudflare REST API
 * for catch-all -> Worker because Wrangler currently rejects that rule shape client-side.
 * The irreducible part (MX/SPF/DKIM DNS + verification) is surfaced via `email routing dns get`,
 * not hidden.
 *
 * SAFETY: dry-run by default. Prints the exact commands and changes nothing. Pass `--apply`
 * to run them against the zone in the Cloudflare account your `wrangler` is logged into.
 *
 * Usage:
 *   pnpm setup:routing --domain example.com                          # dry run (address defaults to inbox@<domain>)
 *   pnpm setup:routing --domain example.com --address hi@example.com # dry run, explicit recipient
 *   pnpm setup:routing --domain example.com --catch-all              # dry run, catch-all *@example.com -> Worker
 *   pnpm setup:routing --domain example.com --env dev --apply        # enable + create rule -> reccado-dev
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalPrimaryAddress } from "../src/lib/mailbox-id";

type WranglerConfig = {
	name?: string;
	env?: Record<string, { name?: string }>;
};

type CloudflareEnvelope<T> = {
	success?: boolean;
	errors?: Array<{ code?: number; message?: string }>;
	messages?: Array<{ code?: number; message?: string }>;
	result?: T;
};

type ZoneResult = {
	id?: string;
	name?: string;
	account?: { id?: string; name?: string };
};

type CatchAllRule = {
	enabled?: boolean;
	name?: string;
	actions?: Array<{ type?: string; value?: string[] }>;
	matchers?: Array<{ type?: string }>;
	source?: string;
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

const args = parseArgs(process.argv.slice(2));
const apply = args.apply === "true";
const targetEnv = args.env;
const domain = args.domain?.trim().toLowerCase();
const catchAll = args["catch-all"] === "true";
if (!domain) {
	console.error("setup:routing: --domain is required (e.g. --domain example.com).");
	process.exit(1);
}
const resolvedDomain = domain;
let address: string;
try {
	address = canonicalPrimaryAddress(args.address?.trim() || `inbox@${resolvedDomain}`);
} catch {
	console.error(`setup:routing: invalid --address "${args.address}".`);
	process.exit(1);
}
if (!address.endsWith(`@${resolvedDomain}`)) {
	console.error(`setup:routing: --address ${address} is not on --domain ${resolvedDomain}.`);
	process.exit(1);
}

// Resolve the Worker name (the rule's action target) from wrangler.jsonc.
const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as WranglerConfig;
const worker = (targetEnv ? config.env?.[targetEnv]?.name : config.name) ?? config.name;
if (!worker) {
	console.error(
		`setup:routing: could not resolve the Worker name for env "${targetEnv ?? "production"}".`,
	);
	process.exit(1);
}

// stderr PIPED so error.stderr is populated for the idempotency check; printed on real failures.
function wrangler(argv: string[]): void {
	execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		stdio: ["ignore", "inherit", "pipe"],
	});
}

function wranglerCapture(argv: string[]): string {
	return execFileSync("pnpm", ["wrangler", ...argv], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function formatApiErrors(payload: {
	errors?: Array<{ code?: number; message?: string }>;
	messages?: Array<{ code?: number; message?: string }>;
}): string {
	const items = [...(payload.errors ?? []), ...(payload.messages ?? [])]
		.map((item) => {
			const code = item.code ? ` [${item.code}]` : "";
			return `${item.message ?? "unknown Cloudflare API error"}${code}`;
		})
		.filter(Boolean);
	return items.length > 0 ? items.join("; ") : "unknown Cloudflare API error";
}

async function cfApi<T>(token: string, path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	const payload = (await response.json()) as CloudflareEnvelope<T>;
	if (!response.ok || payload.success !== true || payload.result === undefined) {
		throw new Error(formatApiErrors(payload));
	}
	return payload.result;
}

function matchersAreCatchAll(matchers: CatchAllRule["matchers"]): boolean {
	return (matchers ?? []).some((matcher) => matcher.type === "all");
}

function actionsTargetWorker(actions: CatchAllRule["actions"], workerName: string): boolean {
	return (actions ?? []).some(
		(action) => action.type === "worker" && (action.value ?? []).includes(workerName),
	);
}

function parseWranglerAccountInfo(output: string): { id?: string; name?: string } | null {
	try {
		const payload = JSON.parse(output) as {
			account?: { id?: string; name?: string };
			accounts?: Array<{ id?: string; name?: string }>;
		};
		if (payload.account?.id || payload.account?.name) {
			return payload.account;
		}
		if ((payload.accounts?.length ?? 0) > 0) {
			return payload.accounts?.[0] ?? null;
		}
	} catch {
		return null;
	}
	return null;
}

async function ensureCatchAllRule(workerName: string): Promise<void> {
	const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
	if (!token) {
		console.error(
			"setup:routing: --catch-all --apply requires CLOUDFLARE_API_TOKEN.\n" +
				"Set a token with Zone Read + Email Routing Write on the target zone, then re-run.",
		);
		process.exit(1);
	}

	let wranglerAccount: { id?: string; name?: string } | null = null;
	try {
		wranglerAccount = parseWranglerAccountInfo(wranglerCapture(["whoami", "--json"]));
	} catch {
		console.error(
			"setup:routing: could not read Wrangler account context (`pnpm wrangler whoami --json`).\n" +
				"Log in with Wrangler before running --apply so Email Routing enable/DNS checks can run.",
		);
		process.exit(1);
	}
	if (!wranglerAccount?.id) {
		console.error(
			"setup:routing: Wrangler is logged in but no Cloudflare account id was available.\n" +
				"Re-authenticate with Wrangler, then re-run `pnpm wrangler whoami` to confirm account access.",
		);
		process.exit(1);
	}

	let zone: ZoneResult;
	try {
		const zones = await cfApi<ZoneResult[]>(
			token,
			`/zones?name=${encodeURIComponent(resolvedDomain)}&status=active&match=all`,
		);
		const exact = zones.filter((item) => item.name?.toLowerCase() === resolvedDomain);
		if (exact.length !== 1 || !exact[0]?.id) {
			console.error(
				`setup:routing: could not resolve zone "${resolvedDomain}" from the Cloudflare API.\n` +
					"Check that CLOUDFLARE_API_TOKEN can read the zone and that the domain is in this account.",
			);
			process.exit(1);
		}
		zone = exact[0];
	} catch (error) {
		console.error(
			`setup:routing: zone lookup failed for ${resolvedDomain}: ${error instanceof Error ? error.message : error}`,
		);
		process.exit(1);
	}

	const accountLabel = zone.account?.name
		? `${zone.account.name} (${zone.account.id ?? "unknown id"})`
		: (zone.account?.id ?? `wrangler account ${wranglerAccount.id}`);
	console.log(`  Cloudflare account: ${accountLabel}`);
	console.log(`  Zone: ${resolvedDomain} (${zone.id})`);

	let current: CatchAllRule | undefined;
	try {
		current = await cfApi<CatchAllRule>(token, `/zones/${zone.id}/email/routing/rules/catch_all`);
	} catch (error) {
		console.error(
			`setup:routing: failed to read the current catch-all rule for ${resolvedDomain}: ${
				error instanceof Error ? error.message : error
			}`,
		);
		process.exit(1);
	}

	if (
		current.enabled === true &&
		matchersAreCatchAll(current.matchers) &&
		actionsTargetWorker(current.actions, workerName)
	) {
		console.log("  (catch-all already routes to this Worker — skipping)");
		return;
	}

	const payload = {
		enabled: true,
		name: `Catch-all -> ${workerName}`,
		matchers: [{ type: "all" }],
		actions: [{ type: "worker", value: [workerName] }],
	};
	console.log("  Applying Cloudflare API update for catch-all routing");
	try {
		await cfApi<CatchAllRule>(token, `/zones/${zone.id}/email/routing/rules/catch_all`, {
			method: "PUT",
			body: JSON.stringify(payload),
		});
	} catch (error) {
		console.error(
			`setup:routing: failed to update the catch-all rule for ${resolvedDomain}: ${
				error instanceof Error ? error.message : error
			}`,
		);
		process.exit(1);
	}
}

/** Runs a step, treating an "already exists/enabled" failure as success (idempotency). */
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
		if (/already exists|already enabled|already created|duplicate|409/i.test(haystack)) {
			console.log("  (already in place — skipping)");
		} else {
			if (stderr) console.error(stderr);
			throw error;
		}
	}
}

console.log(
	`\nReccado setup:routing — domain: ${resolvedDomain} · target: ${
		catchAll ? `*@${resolvedDomain}` : address
	} · worker: ${worker}` +
		`\nmode: ${apply ? "APPLY (mutating Cloudflare)" : "dry run (no changes)"}\n`,
);

runIdempotent("Enable Email Routing on the zone", ["email", "routing", "enable", resolvedDomain]);

if (catchAll) {
	const payload = JSON.stringify(
		{
			enabled: true,
			name: `Catch-all -> ${worker}`,
			matchers: [{ type: "all" }],
			actions: [{ type: "worker", value: [worker] }],
		},
		null,
		2,
	);
	console.log(
		`\n▸ Configure catch-all *@${resolvedDomain} -> Worker via Cloudflare API\n` +
			"  Wrangler currently rejects catch-all worker rules client-side, so this path uses the\n" +
			"  documented REST endpoint instead of `wrangler email routing rules create`.\n" +
			`  PUT https://api.cloudflare.com/client/v4/zones/<zone-id>/email/routing/rules/catch_all\n` +
			`  payload:\n${payload
				.split("\n")
				.map((line) => `    ${line}`)
				.join("\n")}`,
	);
	if (apply) {
		await ensureCatchAllRule(worker);
	}
} else {
	runIdempotent("Create the send-to-Worker rule", [
		"email",
		"routing",
		"rules",
		"create",
		resolvedDomain,
		"--match-type",
		"literal",
		"--match-field",
		"to",
		"--match-value",
		address,
		"--action-type",
		"worker",
		"--action-value",
		worker,
	]);
}

// DNS is the irreducible part — show the records the user must add on their zone.
console.log(
	`\n▸ Show required DNS (MX/SPF/DKIM)\n  $ pnpm wrangler email routing dns get ${domain}`,
);
if (apply) {
	wrangler(["email", "routing", "dns", "get", resolvedDomain]);
}

console.log(`\n${"─".repeat(72)}`);
console.log("Still required (only DNS + verification — not automatable here):\n");
console.log(
	`- Add the MX/SPF/DKIM records above on ${resolvedDomain} and let Email Routing verify them.`,
);
console.log(`- Check status any time:  pnpm wrangler email routing settings ${resolvedDomain}`);
if (catchAll) {
	console.log(
		"- Catch-all note: Cloudflare supports catch-all -> Worker via API; Wrangler currently rejects that specific rule client-side, so this script uses the REST API for `--catch-all`.",
	);
}
console.log(
	`- Seed the mailbox that receives it (if not done); pass the secret via env, not argv:`,
);
console.log(
	`    MAILBOX_ID_SECRET=<your-secret> pnpm setup:mailbox --domain ${resolvedDomain} --address ${address}` +
		`${targetEnv ? ` --env ${targetEnv}` : ""} --apply`,
);
console.log(`\nRe-check anytime:  pnpm doctor --env ${targetEnv ?? "production"} --cloud\n`);

if (!apply) {
	console.log("Dry run only. Re-run with --apply to execute against Cloudflare.\n");
}
