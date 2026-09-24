import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: "./wrangler.jsonc",
				environment: "dev",
			},
		}),
	],
	test: {
		pool: "@cloudflare/vitest-pool-workers",
		// Agent worktrees live under .claude/worktrees/ and carry a full copy of the
		// suite; without this a run in the main checkout picks all of them up too.
		exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
		coverage: {
			provider: "istanbul",
			reporter: ["text", "html", "lcov"],
			include: ["src/**"],
			exclude: [
				"src/routeTree.gen.ts",
				"src/env.d.ts",
				"**/*.test.ts",
				"**/*.test.tsx",
				"tests/**",
			],
		},
	},
});
