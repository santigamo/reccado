import type { Hono } from "hono";
import { domainOverview, listAvailableZones } from "../lib/admin/cloudflare-reads";
import { REFUSAL_STATUS, routeAddress } from "../lib/admin/cloudflare-routing";
import type { ApiBindings } from "./hono";

/**
 * Cloudflare views and the one Cloudflare write for the settings UI. Behind the
 * same `/api/*` owner web-session perimeter as the rest of the control plane
 * (an MCP bearer token is not a session and gets 401 here).
 *
 * Reads: a missing token or permission is a 200 with `{ ok: false, reason }`,
 * because the UI's fallback is the useful answer, not an error page.
 *
 * Write (`POST .../routing`): `{ ok: true }` with 201 (created) or 200 (already
 * routed); every refusal is `{ ok: false, reason, message, remedy }` with a
 * status from REFUSAL_STATUS.
 */
export function registerCloudflareReadRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/cloudflare/zones", async (c) =>
		c.json(await listAvailableZones(c.env, c.get("auth")!)),
	);
	api.get("/api/cloudflare/domains/:domain/overview", async (c) =>
		c.json(await domainOverview(c.env, c.get("auth")!, { domain: c.req.param("domain") })),
	);
	api.post("/api/cloudflare/domains/:domain/routing", async (c) => {
		const result = await routeAddress(c.env, c.get("auth")!, {
			domain: c.req.param("domain"),
			body: await c.req.json(),
		});
		if (result.ok) return c.json(result, result.status === "created" ? 201 : 200);
		return c.json(result, REFUSAL_STATUS[result.reason] as 400);
	});
}
