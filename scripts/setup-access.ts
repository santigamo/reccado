#!/usr/bin/env tsx
/**
 * `pnpm setup:access` — the guided path for putting Cloudflare Access in front of the Worker.
 *
 * Access is the auth perimeter (Reccado has no login screen), but creating the Access
 * application varies by identity provider / org, so this does NOT create the app by API.
 * It automates the mechanical half — setting ACCESS_JWT_AUDIENCE / ACCESS_TEAM_DOMAIN (and
 * optionally ACCESS_ALLOWED_EMAILS) as Worker secrets once you have them — and prints the
 * exact dashboard steps plus the verification command for the rest.
 *
 * SAFETY: dry-run by default. Pass `--apply` to set the secrets.
 *
 * Usage:
 *   pnpm setup:access --hostname inbox-dev.example.com                        # print guided steps
 *   pnpm setup:access --env dev --aud <access-aud-tag> \
 *     --team-domain https://<team>.cloudflareaccess.com --apply             # set the secrets
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
const apply = args.apply === "true";
const targetEnv = args.env;
const url = args.url?.trim();
const hostname = args.hostname?.trim().toLowerCase();
const aud = args.aud?.trim();
const teamDomain = args["team-domain"]?.trim();
const allowedEmails = args["allowed-emails"]?.trim();

const config = JSON.parse(stripJsonc(readFileSync("wrangler.jsonc", "utf8"))) as {
	name?: string;
	env?: Record<string, { name?: string }>;
};
const worker = (targetEnv ? config.env?.[targetEnv]?.name : config.name) ?? config.name;
const envFlag = targetEnv ? ["--env", targetEnv] : [];
const accessHost = hostname ?? (url ? new URL(url).hostname : undefined);

if (accessHost?.endsWith(".workers.dev")) {
	console.error(
		"setup:access: use your custom hostname, not a *.workers.dev URL.\n" +
			"Reccado's supported public path is custom domain + Cloudflare Access.",
	);
	process.exit(1);
}

function putSecret(name: string, value: string): void {
	console.log(
		`\n▸ Set ${name}\n  $ pnpm wrangler secret put ${name}${targetEnv ? ` --env ${targetEnv}` : ""}`,
	);
	if (!apply) return;
	execFileSync("pnpm", ["wrangler", "secret", "put", name, ...envFlag], {
		input: value,
		stdio: ["pipe", "inherit", "inherit"],
	});
}

console.log(
	`\nReccado setup:access — worker: ${worker}\nmode: ${apply ? "APPLY (setting secrets)" : "dry run / guide"}\n`,
);

if (!accessHost) {
	console.log(
		"Pass --hostname <app.example.com> (preferred) or --url https://app.example.com for the exact route.",
	);
}

console.log(
	"Create the Access application on your custom domain (varies by IdP — do this in the dashboard):",
);
console.log("  1. Zero Trust → Access → Applications → Add → Self-hosted.");
console.log(
	`  2. Application domain: ${accessHost ?? "<app.example.com>"}${url ? ` (${url})` : ""}.`,
);
console.log("  3. Add an allow policy for your email (or an IdP group).");
console.log("  4. Copy the application Audience (aud) tag, and note your team domain");
console.log("     (https://<team>.cloudflareaccess.com).\n");

if (aud && teamDomain) {
	putSecret("ACCESS_JWT_AUDIENCE", aud);
	putSecret("ACCESS_TEAM_DOMAIN", teamDomain);
	if (allowedEmails) {
		putSecret("ACCESS_ALLOWED_EMAILS", allowedEmails);
	}
	if (!apply) {
		console.log("\nDry run only. Re-run with --apply to set these secrets.");
	}
} else {
	console.log("Once you have them, set the secrets:");
	console.log(
		`  pnpm setup:access --env ${targetEnv ?? "production"} --aud <aud-tag> \\` +
			`\n    --team-domain https://<team>.cloudflareaccess.com [--allowed-emails you@example.com] --apply`,
	);
}

console.log(
	`\nThen verify Access is actually protecting the route:` +
		`\n  pnpm doctor --env ${targetEnv ?? "production"} --cloud --url ${url ?? (accessHost ? `https://${accessHost}` : "<deployed-url>")}\n`,
);
