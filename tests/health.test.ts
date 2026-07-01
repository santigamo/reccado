import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/server";

describe("health route", () => {
	it("responds through the Worker entrypoint", async () => {
		const request = new Request("http://localhost/api/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

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
		const request = new Request("https://example.com/api/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

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
