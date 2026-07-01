import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationInitial from "../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../migrations/d1/0002_message_index.sql?raw";
import worker from "../src/server";

type TestEnv = Env & { INDEX_DB: D1Database };

const testEnv = env as unknown as TestEnv;

// The vitest-pool-workers D1 binding starts schema-less: it does not auto-apply
// migrations/d1/*.sql. D1Database#exec() only accepts one statement per line, so
// the multi-line CREATE TABLE statements in the migration files are split and run
// individually via prepare().run() instead. Mirrors tests/integration/api-security.test.ts.
async function applyMigration(sql: string): Promise<void> {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	for (const statement of statements) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

async function fetchHealth(url: string): Promise<Response> {
	const request = new Request(url);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

// D1 storage in this pool is NOT rolled back between individual `it()`s within a
// file (only across files) -- tables created by one test remain visible to later
// tests in this same describe block. So the "schema missing" case must run BEFORE
// the migrations are applied, and the "schema present" case (which applies the
// migrations) must run after it, permanently establishing the schema for the rest
// of this file's tests (the last test below only asserts on `auth`, which is
// unaffected by indexDb's state either way).
describe("health route", () => {
	// This is the regression test for the false-confidence bug: previously
	// `indexDb: { ok: true, configured: true }` was hardcoded and never queried D1,
	// so a missing migration (e.g. no "aliases" table) was invisible to /api/health
	// even while email ingest was 500ing with "D1_ERROR: no such table: aliases".
	it("reports indexDb.ok:false with a reason and degrades readiness when the D1 schema is missing", async () => {
		const response = await fetchHealth("http://localhost/api/health");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			readiness: { ok: boolean; status: string };
			dependencies: { indexDb: { ok: boolean; configured: boolean; reason: string | null } };
		};
		expect(body.dependencies.indexDb.ok).toBe(false);
		expect(body.dependencies.indexDb.configured).toBe(true);
		expect(body.dependencies.indexDb.reason).toBeTruthy();
		expect(body.dependencies.indexDb.reason).toContain("aliases");
		expect(body.readiness).toEqual({ ok: false, status: "degraded" });
	});

	it("reports indexDb.ok:true and overall readiness ready when the D1 schema is present", async () => {
		await applyMigration(migrationInitial as string);
		await applyMigration(migrationMessageIndex as string);

		const response = await fetchHealth("http://localhost/api/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			readiness: {
				ok: true,
				status: "ready",
			},
			dependencies: {
				auth: {
					ok: true,
					configured: false,
					mode: "local-dev-bypass",
					reason:
						"Cloudflare Access validation is disabled until ACCESS_JWT_AUDIENCE is configured.",
					missing: ["ACCESS_JWT_AUDIENCE", "ACCESS_TEAM_DOMAIN"],
				},
				indexDb: {
					ok: true,
					configured: true,
					reason: null,
				},
				cloudflareApi: {
					ok: true,
					configured: false,
					reason: "CLOUDFLARE_API_TOKEN is not set.",
				},
			},
		});
	});

	it("reports degraded auth readiness on non-localhost when Access is not configured", async () => {
		const response = await fetchHealth("https://example.com/api/health");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			readiness: { ok: boolean; status: string };
			dependencies: { auth: { ok: boolean; reason: string } };
		};
		expect(body.readiness).toEqual({ ok: false, status: "degraded" });
		expect(body.dependencies.auth.ok).toBe(false);
		expect(body.dependencies.auth.reason).toBe(
			"Cloudflare Access validation is not configured for non-localhost requests.",
		);
	});
});
