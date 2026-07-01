#!/usr/bin/env node
/**
 * create-reccado — thin scaffolder that clones Reccado into a new directory and gets you to a
 * running local dev inbox. Intentionally a wrapper over the repo's own primitives (it does not
 * duplicate setup logic): after cloning it runs `pnpm install`, then points you at `pnpm dev`
 * and `pnpm doctor`.
 *
 * Usage:
 *   node scripts/create-reccado.mjs <target-dir>
 *   # once published:  npx create-reccado my-inbox
 *   # or with degit:   npx degit santigamo/reccado my-inbox
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const REPO = "https://github.com/santigamo/reccado.git";

const target = process.argv[2];
if (!target || target.startsWith("-")) {
	console.error("Usage: npx create-reccado <target-dir>");
	process.exit(1);
}
if (existsSync(target)) {
	console.error(`create-reccado: "${target}" already exists — choose an empty path.`);
	process.exit(1);
}

function run(cmd, args, opts = {}) {
	execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

console.log(`\nCloning Reccado into ${target}…`);
run("git", ["clone", "--depth", "1", REPO, target]);
run("rm", ["-rf", `${target}/.git`]);

try {
	console.log("\nEnabling corepack (repo-pinned pnpm)…");
	run("corepack", ["enable"]);
} catch {
	console.log("  (corepack not available — install pnpm manually if needed)");
}

try {
	console.log("\nInstalling dependencies…");
	run("pnpm", ["install"], { cwd: target });
} catch {
	console.log("  (pnpm install failed — run it yourself in the new directory)");
}

console.log(`
Done. Next:

  cd ${target}
  pnpm dev                 # local inbox, no Cloudflare account needed
  pnpm doctor              # check your setup, with an exact fix per issue

To deploy your own (dry-run first):
  pnpm wrangler login
  pnpm setup:cloud --env dev --domain <you.com> --address inbox@<you.com>
`);
