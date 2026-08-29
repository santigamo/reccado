import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationInitial from "../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../migrations/d1/0002_message_index.sql?raw";
import worker from "../src/server";
import { applyMigrations } from "./helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };

const testEnv = env as unknown as TestEnv;

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
		await applyMigrations(
			testEnv.INDEX_DB,
			migrationInitial as string,
			migrationMessageIndex as string,
		);

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
				telegram: {
					ok: true,
					configured: false,
					mode: "off",
					reason: "Telegram bridge is disabled until TELEGRAM_BOT_TOKEN is set.",
					missing: [],
					webhookUrl: null,
					pendingUpdateCount: null,
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
