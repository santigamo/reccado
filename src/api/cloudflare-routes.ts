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
 * status from REFUSAL_STATUS (a missing or unreadable body is
 * `invalid_address`). An address whose mailbox has another owner is a 403
 * `forbidden`, the same authority the MCP `address_route` kind enforces.
 */
export function registerCloudflareReadRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/cloudflare/zones", async (c) =>
		c.json(await listAvailableZones(c.env, c.get("auth")!)),
	);
	api.get("/api/cloudflare/domains/:domain/overview", async (c) =>
		c.json(await domainOverview(c.env, c.get("auth")!, { domain: c.req.param("domain") })),
	);
	api.post("/api/cloudflare/domains/:domain/routing", async (c) => {
		// An empty or non-JSON body names no address: the documented
		// `invalid_address` refusal, not a generic JSON error.
		const body: unknown = await c.req.json().catch(() => null);
		const result = await routeAddress(c.env, c.get("auth")!, {
			domain: c.req.param("domain"),
			body,
		});
		if (result.ok) return c.json(result, result.status === "created" ? 201 : 200);
		return c.json(result, REFUSAL_STATUS[result.reason] as 400);
	});
}
