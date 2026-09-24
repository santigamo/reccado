#!/usr/bin/env tsx
/**
 * `pnpm run deploy` / `pnpm run deploy:dev` — the one deploy path.
 *
 * 1. Build the app for the env (`CLOUDFLARE_ENV=<env> pnpm run build`), which
 *    renders `dist/server/wrangler.json` from the tracked `wrangler.jsonc`.
 * 2. If `wrangler.generated.<env>.json` exists, overlay the fields it owns (vars,
 *    D1 id, sender allow-list, custom-domain route) onto that built config, print
 *    every value it changed and every structural field it was NOT allowed to
 *    change, then re-read the file and fail if it does not carry them.
 * 3. `wrangler deploy --config dist/server/wrangler.json`.
 *
 * Before this, `deploy:dev` ran `wrangler deploy --env dev` against the tracked
 * config and never read the generated file, so a value `setup:sending` wrote
 * there (MAIL_SENDING_DOMAINS) never reached the Worker — silently.
 *
 * `--dry-run` does steps 1–2 for real (local files only) and passes `--dry-run`
 * to wrangler, which bundles and prints the bindings without uploading.
 *
 * Usage:
 *   pnpm run deploy:dev              # env dev
 *   pnpm run deploy:dev --dry-run
 *   pnpm run deploy                  # top-level (production) config
 */
import { execFileSync } from "node:child_process";
import { BUILT_CONFIG_PATH, patchBuiltConfig } from "./lib/built-config";

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

const args = parseArgs(process.argv.slice(2));
const targetEnv = args.env;
const dryRun = args["dry-run"] === "true";

console.log(
	`\nReccado deploy — env: ${targetEnv ?? "production (top-level)"}` +
		`\nmode: ${dryRun ? "dry run (build + overlay locally, wrangler deploy --dry-run)" : "DEPLOY"}\n`,
);

console.log(`▸ Build\n  $ ${targetEnv ? `CLOUDFLARE_ENV=${targetEnv} ` : ""}pnpm run build`);
execFileSync("pnpm", ["run", "build"], {
	stdio: "inherit",
	env: targetEnv ? { ...process.env, CLOUDFLARE_ENV: targetEnv } : process.env,
});

try {
	patchBuiltConfig(targetEnv);
} catch (error) {
	console.error(`\ndeploy: refusing to deploy — ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}

const deployArgs = [
	"wrangler",
	"deploy",
	"--config",
	BUILT_CONFIG_PATH,
	...(dryRun ? ["--dry-run"] : []),
];
console.log(`\n▸ Deploy\n  $ pnpm ${deployArgs.join(" ")}`);
execFileSync("pnpm", deployArgs, { stdio: "inherit" });
