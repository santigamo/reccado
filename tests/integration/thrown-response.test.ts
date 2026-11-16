import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../../src/api/hono";

/**
 * Auth helpers (requireAuth, assertMailboxAccess, requireMcpOwner) deny by
 * throwing a ready-made Response. Hono's onError ignores anything that is not an
 * Error, so before the central middleware in createApiApp such a throw escaped
 * as a 500. Every route on the app — including routes added after
 * createApiApp() returns, as server.ts does — must answer with the thrown
 * Response's own status, body and headers.
 */

function deny(status: number, error: string): never {
	throw new Response(JSON.stringify({ error }), {
		status,
		headers: { "content-type": "application/json", "x-denied-by": "helper" },
	});
}

async function nestedHelper(): Promise<void> {
	await Promise.resolve();
	deny(403, "forbidden");
}

describe("thrown Response from a route helper", () => {
	const api = createApiApp();
	api.get("/test/sync-denial", () => deny(503, "owner_not_configured"));
	api.get("/test/async-denial", async (c) => {
		await nestedHelper();
		return c.json({ unreachable: true });
	});
	api.get("/test/plain-error", () => {
		throw new Error("boom");
	});

	it("returns a synchronously thrown Response as-is (not a 500)", async () => {
		const response = await api.request("/test/sync-denial", {}, env);
		expect(response.status).toBe(503);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("x-denied-by")).toBe("helper");
		expect(await response.json()).toEqual({ error: "owner_not_configured" });
	});

	it("returns a Response thrown from an awaited helper, with the security headers", async () => {
		const response = await api.request("/test/async-denial", {}, env);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "forbidden" });
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
	});

	it("still routes real Errors through onError as a JSON 500", async () => {
		const response = await api.request("/test/plain-error", {}, env);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "internal_error" });
	});
});
