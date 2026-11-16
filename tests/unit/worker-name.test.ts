import { describe, expect, it } from "vitest";
import { stripJsonc, type WranglerConfig } from "../../scripts/lib/deploy-config";
import wranglerSource from "../../wrangler.jsonc?raw";

/**
 * A Worker cannot read its own script name at runtime, and "Route it" creates
 * Email Routing rules that deliver to it. So every deployable block declares
 * `vars.WORKER_NAME`, and it must equal that block's `name` — a mismatch would
 * create rules pointing at a Worker that is not this one.
 */
describe("wrangler.jsonc WORKER_NAME", () => {
	const config = JSON.parse(stripJsonc(wranglerSource as string)) as WranglerConfig;
	const blocks: Array<[string, { name?: string; vars?: Record<string, unknown> }]> = [
		["top level", config],
		...Object.entries(config.env ?? {}).map(
			([env, block]) => [`env.${env}`, block] as [string, typeof block],
		),
	];

	it.each(blocks)("%s declares WORKER_NAME equal to its name", (_label, block) => {
		expect(block.name).toBeTruthy();
		expect(block.vars?.WORKER_NAME).toBe(block.name);
	});

	it("the test env sees the dev Worker's name", async () => {
		const { env } = await import("cloudflare:workers");
		expect((env as unknown as { WORKER_NAME?: string }).WORKER_NAME).toBe(config.env?.dev?.name);
	});
});
