#!/usr/bin/env tsx
/**
 * `pnpm smoke:routing --domain <d>` — post-deploy assertion that an Email Routing rule on the
 * zone targets this Worker, so inbound mail actually reaches it. Uses
 * `wrangler email routing rules list` (which has no --json) and checks the Worker name appears
 * in the output. Needs a Cloudflare login. Exits non-zero on failure.
 *
 * Usage:
 *   pnpm smoke:routing --domain example.com
 *   pnpm smoke:routing --domain example.com --env dev
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
const targetEnv = args.env;
const domain = args.domain?.trim().toLowerCase();
if (!domain) {
	console.error("Usage: pnpm smoke:routing --domain <domain> [--env <env>]");
	process.exit(1);
}

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
	name?: string;
	env?: Record<string, { name?: string }>;
};
const worker = (targetEnv ? config.env?.[targetEnv]?.name : config.name) ?? config.name;
if (!worker) {
	console.error(
		`smoke:routing: could not resolve the Worker name for env "${targetEnv ?? "production"}".`,
	);
	process.exit(1);
}

let output: string;
try {
	output = execFileSync("pnpm", ["wrangler", "email", "routing", "rules", "list", domain], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	});
} catch (error) {
	console.error(
		`FAIL: could not list Email Routing rules for ${domain}: ${error instanceof Error ? error.message : error}`,
	);
	process.exit(1);
}

if (output.includes(worker)) {
	console.log(`PASS: an Email Routing rule on ${domain} targets ${worker}.`);
	process.exit(0);
}
console.error(
	`FAIL: no Email Routing rule on ${domain} appears to target ${worker}.\n` +
		`Create one:  pnpm setup:routing --domain ${domain}${targetEnv ? ` --env ${targetEnv}` : ""} --apply`,
);
process.exit(1);
