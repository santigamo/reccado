import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveAllowedHostnames } from "#/mcp/handler";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import { applyMigrations } from "../helpers/migrations";

beforeAll(async () => {
	await applyMigrations(env.INDEX_DB, migrationRuntimeConfig);
	await env.INDEX_DB.prepare(
		"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', 'https://mail.self-host.test', ?)",
	)
		.bind(new Date().toISOString())
		.run();
});

describe("mcp host allow-list", () => {
	it("allows localhost and the configured public origin, and refuses unknown hosts", async () => {
		const hosts = await resolveAllowedHostnames(
			{ ...env, MCP_ALLOWED_HOSTS: "" } as Env,
			"evil.example",
		);
		expect(hosts).toEqual(
			expect.arrayContaining(["localhost", "127.0.0.1", "[::1]", "mail.self-host.test"]),
		);
		expect(hosts).not.toContain("evil.example");
		expect(hosts).not.toContain("inbox.imsanti.dev");
	});

	it("adds MCP_ALLOWED_HOSTS entries and the request's own workers.dev host", async () => {
		const hosts = await resolveAllowedHostnames(
			{ ...env, MCP_ALLOWED_HOSTS: " Inbox.Example.com , other.test," } as Env,
			"reccado-dev.me.workers.dev",
		);
		expect(hosts).toEqual(
			expect.arrayContaining(["inbox.example.com", "other.test", "reccado-dev.me.workers.dev"]),
		);
	});
});
