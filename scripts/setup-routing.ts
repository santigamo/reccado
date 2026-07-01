#!/usr/bin/env tsx
/**
 * `pnpm setup:routing` — wires Cloudflare Email Routing to deliver a recipient to this
 * Worker, using the parts Wrangler can automate: enabling routing on the zone and creating
 * the "send to worker" rule. The irreducible part (MX/SPF/DKIM DNS + verification) is
 * surfaced via `email routing dns get`, not hidden.
 *
 * SAFETY: dry-run by default. Prints the exact commands and changes nothing. Pass `--apply`
 * to run them against the zone in the Cloudflare account your `wrangler` is logged into.
 *
 * Usage:
 *   pnpm setup:routing --domain example.com                          # dry run (address defaults to inbox@<domain>)
 *   pnpm setup:routing --domain example.com --address hi@example.com # dry run, explicit recipient
 *   pnpm setup:routing --domain example.com --env dev --apply        # enable + create rule -> reccado-dev
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { canonicalPrimaryAddress } from "../src/lib/mailbox-id";

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
if (!domain) {
	console.error("setup:routing: --domain is required (e.g. --domain example.com).");
	process.exit(1);
}
let address: string;
try {
	address = canonicalPrimaryAddress(args.address?.trim() || `inbox@${domain}`);
} catch {
	console.error(`setup:routing: invalid --address "${args.address}".`);
	process.exit(1);
}
if (!address.endsWith(`@${domain}`)) {
	console.error(`setup:routing: --address ${address} is not on --domain ${domain}.`);
	process.exit(1);
}

// Resolve the Worker name (the rule's action target) from wrangler.jsonc.
const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
	name?: string;
	env?: Record<string, { name?: string }>;
};
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
	`\nReccado setup:routing — domain: ${domain} · recipient: ${address} · worker: ${worker}` +
		`\nmode: ${apply ? "APPLY (mutating Cloudflare)" : "dry run (no changes)"}\n`,
);

runIdempotent("Enable Email Routing on the zone", ["email", "routing", "enable", domain]);

runIdempotent("Create the send-to-Worker rule", [
	"email",
	"routing",
	"rules",
	"create",
	domain,
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

// DNS is the irreducible part — show the records the user must add on their zone.
console.log(
	`\n▸ Show required DNS (MX/SPF/DKIM)\n  $ pnpm wrangler email routing dns get ${domain}`,
);
if (apply) {
	wrangler(["email", "routing", "dns", "get", domain]);
}

console.log(`\n${"─".repeat(72)}`);
console.log("Still required (only DNS + verification — not automatable here):\n");
console.log(`- Add the MX/SPF/DKIM records above on ${domain} and let Email Routing verify them.`);
console.log(`- Check status any time:  pnpm wrangler email routing settings ${domain}`);
console.log(`- Seed the mailbox that receives it (if not done):`);
console.log(
	`    pnpm setup:mailbox --domain ${domain} --address ${address}` +
		`${targetEnv ? ` --env ${targetEnv}` : ""} --secret <your-secret> --apply`,
);
console.log(`\nRe-check anytime:  pnpm doctor --env ${targetEnv ?? "production"} --cloud\n`);

if (!apply) {
	console.log("Dry run only. Re-run with --apply to execute against Cloudflare.\n");
}
