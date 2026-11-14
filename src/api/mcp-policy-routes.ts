import type { Hono } from "hono";
import { z } from "zod";
import { insertOpsEvent } from "../db/d1";
import {
	deleteClientPolicy,
	getClientPolicy,
	listClientPolicies,
	PolicyError,
	upsertClientPolicy,
} from "../lib/mcp-client-policy";
import { requireMcpOwner } from "./auth";
import { OAUTH_CLIENT_ID_PATTERN } from "./oauth-client-routes";
import type { ApiBindings } from "./hono";

const bodySchema = z
	.object({
		mailboxIds: z.array(z.string()).max(50),
		kinds: z.array(z.string()).max(20),
		linkDomains: z.array(z.string()).max(50),
		allowVariableLinks: z.boolean().optional(),
		maxAutoPerHour: z.number().int().optional(),
	})
	.strict();

/** Owner-session control of per-client auto-apply policies (`pnpm operator mcp policy`). */
export function registerMcpPolicyRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/mcp-client-policies", async (c) => {
		const auth = requireMcpOwner(c.get("auth")!, c.env);
		return c.json({ policies: await listClientPolicies(c.env.INDEX_DB, auth.email) });
	});
	api.get("/api/mcp-client-policies/:clientId", async (c) => {
		const auth = requireMcpOwner(c.get("auth")!, c.env);
		const policy = await getClientPolicy(c.env.INDEX_DB, c.req.param("clientId"));
		if (!policy || policy.ownerEmail !== auth.email.trim().toLowerCase()) return c.json({ error: "policy_not_found" }, 404);
		return c.json(policy);
	});
	api.put("/api/mcp-client-policies/:clientId", async (c) => {
		const auth = requireMcpOwner(c.get("auth")!, c.env);
		const clientId = c.req.param("clientId");
		if (!OAUTH_CLIENT_ID_PATTERN.test(clientId)) return c.json({ error: "invalid_client_id" }, 400);
		const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
		if (!parsed.success) return c.json({ error: "validation_error" }, 400);
		try {
			const policy = await upsertClientPolicy(c.env.INDEX_DB, auth.email, {
				clientId,
				mailboxIds: parsed.data.mailboxIds,
				autoKinds: parsed.data.kinds,
				linkDomains: parsed.data.linkDomains,
				allowVariableLinks: parsed.data.allowVariableLinks,
				maxAutoPerHour: parsed.data.maxAutoPerHour,
			});
			await insertOpsEvent(c.env.INDEX_DB, {
				id: crypto.randomUUID(), event_type: "mcp.client_policy_set", severity: "info", subject: clientId,
				payload_json: JSON.stringify({ by: auth.email, kinds: policy.autoKinds, mailboxes: policy.mailboxIds, link_domains: policy.linkDomains, allow_variable_links: policy.allowVariableLinks, max_per_hour: policy.maxAutoPerHour }),
			}).catch(() => undefined);
			return c.json(policy);
		} catch (error) {
			if (error instanceof PolicyError) return c.json({ error: "validation_error", message: error.message }, 400);
			throw error;
		}
	});
	api.delete("/api/mcp-client-policies/:clientId", async (c) => {
		const auth = requireMcpOwner(c.get("auth")!, c.env);
		const clientId = c.req.param("clientId");
		if (!(await deleteClientPolicy(c.env.INDEX_DB, auth.email, clientId))) return c.json({ error: "policy_not_found" }, 404);
		await insertOpsEvent(c.env.INDEX_DB, {
			id: crypto.randomUUID(), event_type: "mcp.client_policy_removed", severity: "info", subject: clientId,
			payload_json: JSON.stringify({ by: auth.email }),
		}).catch(() => undefined);
		return c.json({ removed: true, client_id: clientId });
	});
}
