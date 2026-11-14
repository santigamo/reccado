import type { Hono } from "hono";
import { insertOpsEvent } from "../db/d1";
import { requireMcpOwner } from "./auth";
import type { ApiBindings } from "./hono";

/**
 * Owner-gated cutoff for an MCP OAuth client.
 *
 * better-auth 1.7.20 does not declare ON DELETE CASCADE from
 * oauthAccessToken / oauthRefreshToken / oauthConsent to oauthClient, so
 * deleting a client that was ever authorized fails the foreign key. This route
 * removes those rows itself, in an order the keys allow, and does not touch
 * the upstream schema.
 *
 * Issued access tokens are JWTs. Deleting the client does not unsign them;
 * they stay valid until they expire. 3600 s is the provider default
 * (`accessTokenExpiresIn`) and the conservative bound we report.
 */
const ACCESS_TOKEN_VALIDITY_SECONDS = 3600;

/** Opaque client ids from dynamic registration. One URL path segment. */
export const OAUTH_CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{1,256}$/;

export type OAuthClientRevokeDeleted = {
	access_tokens: number;
	refresh_tokens: number;
	consents: number;
};

export type OAuthClientRevokeResult = {
	revoked: true;
	client_id: string;
	name: string | null;
	deleted: OAuthClientRevokeDeleted;
	access_tokens_valid_until: string;
	notice: string;
};

const REVOKE_NOTICE = "Already-issued access JWTs stay valid until they expire (3600 s).";

/**
 * `pnpm operator mcp revoke <client_id>` argument check, shared so the command
 * and its tests agree before any request is sent.
 */
export function parseMcpRevokeArgs(args: readonly string[]): string {
	if (args.length === 0) {
		throw new Error("mcp revoke requires a client_id");
	}
	if (args.length > 1) {
		throw new Error("mcp revoke takes exactly one client_id");
	}
	const clientId = args[0] ?? "";
	if (!OAUTH_CLIENT_ID_PATTERN.test(clientId)) {
		throw new Error("client_id must be 1-256 characters from letters, digits, and . _ ~ -");
	}
	return clientId;
}

type OwnedClient = {
	name: string | null;
};

/**
 * A client this user registered (`oauthClient.userId`) or consented to
 * (`oauthConsent.userId`). Anything else is indistinguishable from unknown:
 * the caller learns nothing about other owners' clients.
 */
async function readOwnedClient(
	db: D1Database,
	ownerUserId: string,
	clientId: string,
): Promise<OwnedClient | null> {
	const client = await db
		.prepare(`SELECT "name" AS name, "userId" AS userId FROM "oauthClient" WHERE "clientId" = ?`)
		.bind(clientId)
		.first<{ name: string | null; userId: string | null }>();
	if (!client) return null;
	if (client.userId === ownerUserId) return { name: client.name };
	const consent = await db
		.prepare(`SELECT 1 AS ok FROM "oauthConsent" WHERE "clientId" = ? AND "userId" = ? LIMIT 1`)
		.bind(clientId, ownerUserId)
		.first<{ ok: number }>();
	return consent ? { name: client.name } : null;
}

function changedRows(result: D1Result | undefined): number {
	return result?.meta?.changes ?? 0;
}

async function revokeOwnedOAuthClient(
	db: D1Database,
	ownerUserId: string,
	clientId: string,
): Promise<OAuthClientRevokeResult | null> {
	const owned = await readOwnedClient(db, ownerUserId, clientId);
	if (!owned) return null;

	const counts = await db
		.prepare(
			`SELECT
         (SELECT COUNT(*) FROM "oauthAccessToken" WHERE "clientId" = ?) AS access_tokens,
         (SELECT COUNT(*) FROM "oauthRefreshToken" WHERE "clientId" = ?) AS refresh_tokens,
         (SELECT COUNT(*) FROM "oauthConsent" WHERE "clientId" = ?) AS consents`,
		)
		.bind(clientId, clientId, clientId)
		.first<{ access_tokens: number; refresh_tokens: number; consents: number }>();
	const deleted: OAuthClientRevokeDeleted = {
		access_tokens: Number(counts?.access_tokens ?? 0),
		refresh_tokens: Number(counts?.refresh_tokens ?? 0),
		consents: Number(counts?.consents ?? 0),
	};
	const payload = JSON.stringify({
		client_id: clientId,
		name: owned.name,
		deleted,
	});
	const validUntil = new Date(Date.now() + ACCESS_TOKEN_VALIDITY_SECONDS * 1000).toISOString();

	// Access rows reference refresh rows (oauthAccessToken.refreshId →
	// oauthRefreshToken.id, no ON DELETE action — migrations/d1/0018). Refresh
	// and consent rows reference the client the same way. Delete children
	// before parents, in one batch so a constraint failure rolls every row
	// back. oauthClientResource cascades from the client delete.
	// The audit insert is in the same batch and only lands when the client
	// delete changed a row (`changes()` is the client DELETE). If that
	// connection-local count is not visible inside the batch, the fallback
	// below writes the same event.
	const eventId = crypto.randomUUID();
	const results = await db.batch([
		db.prepare(`DELETE FROM "oauthAccessToken" WHERE "clientId" = ?`).bind(clientId),
		db.prepare(`DELETE FROM "oauthRefreshToken" WHERE "clientId" = ?`).bind(clientId),
		db.prepare(`DELETE FROM "oauthConsent" WHERE "clientId" = ?`).bind(clientId),
		db.prepare(`DELETE FROM "oauthClient" WHERE "clientId" = ?`).bind(clientId),
		db
			.prepare(
				`INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at)
         SELECT ?, 'mcp.client_revoked', 'info', ?, ?, ?
         WHERE changes() > 0`,
			)
			.bind(eventId, clientId, payload, new Date().toISOString()),
	]);
	if (changedRows(results[3]) === 0) return null;
	// A delegation policy keyed to this client is dead weight once the client is gone. Best effort:
	// deployments that have not run migration 0029 have no such table.
	await db.prepare("DELETE FROM mcp_client_policies WHERE client_id = ?").bind(clientId).run().catch(() => undefined);
	if (changedRows(results[4]) === 0) {
		await insertOpsEvent(db, {
			id: eventId,
			event_type: "mcp.client_revoked",
			severity: "info",
			subject: clientId,
			payload_json: payload,
		});
	}
	return {
		revoked: true,
		client_id: clientId,
		name: owned.name,
		deleted,
		access_tokens_valid_until: validUntil,
		notice: REVOKE_NOTICE,
	};
}

export type ConnectedApp = {
	client_id: string;
	name: string | null;
	redirect_hosts: string[];
	/** Scopes the owner consented to; empty when they never did. */
	granted_scopes: string[];
	authorized: boolean;
	created_at: string | null;
	/** Newest access token issued to this client for this owner. */
	last_token_at: string | null;
};

/** better-auth stores scope lists as a JSON array or a space-separated string depending on the table. */
export function parseScopeList(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw.trim()) return [];
	try {
		const value: unknown = JSON.parse(raw);
		if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
	} catch {
		// not JSON: fall through to the space-separated form
	}
	return raw.split(/\s+/).filter(Boolean);
}

function redirectHosts(raw: unknown): string[] {
	const hosts = new Set<string>();
	for (const uri of parseScopeList(raw)) {
		try {
			hosts.add(new URL(uri).host);
		} catch {
			// ignore unparsable redirect URIs
		}
	}
	return [...hosts];
}

/** better-auth timestamps arrive as epoch ms, epoch seconds, or an ISO string depending on the adapter. */
function toIso(value: unknown): string | null {
	if (value === null || value === undefined || value === "") return null;
	const n = typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : NaN;
	const date = Number.isNaN(n) ? new Date(String(value)) : new Date(n < 1e11 ? n * 1000 : n);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function listOwnedClients(db: D1Database, ownerUserId: string): Promise<ConnectedApp[]> {
	const clients = await db
		.prepare(
			`SELECT c."clientId" AS clientId, c."name" AS name, c."redirectUris" AS redirectUris, c."createdAt" AS createdAt,
         (SELECT MAX(t."createdAt") FROM "oauthAccessToken" t WHERE t."clientId" = c."clientId" AND t."userId" = ?1) AS lastToken
       FROM "oauthClient" c
       WHERE c."userId" = ?1 OR EXISTS (SELECT 1 FROM "oauthConsent" k WHERE k."clientId" = c."clientId" AND k."userId" = ?1)
       ORDER BY c."createdAt" DESC`,
		)
		.bind(ownerUserId)
		.all<{ clientId: string; name: string | null; redirectUris: string | null; createdAt: unknown; lastToken: unknown }>();
	const consents = await db
		.prepare(`SELECT "clientId" AS clientId, "scopes" AS scopes FROM "oauthConsent" WHERE "userId" = ?`)
		.bind(ownerUserId)
		.all<{ clientId: string; scopes: string | null }>();
	const granted = new Map<string, Set<string>>();
	for (const consent of consents.results ?? []) {
		const set = granted.get(consent.clientId) ?? new Set<string>();
		for (const scope of parseScopeList(consent.scopes)) set.add(scope);
		granted.set(consent.clientId, set);
	}
	return (clients.results ?? []).map((row) => ({
		client_id: row.clientId,
		name: row.name,
		redirect_hosts: redirectHosts(row.redirectUris),
		granted_scopes: [...(granted.get(row.clientId) ?? [])],
		authorized: granted.has(row.clientId),
		created_at: toIso(row.createdAt),
		last_token_at: toIso(row.lastToken),
	}));
}

export function registerOAuthClientRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/oauth-clients", async (c) => {
		const auth = requireMcpOwner(c.get("auth")!, c.env);
		return c.json({ clients: await listOwnedClients(c.env.INDEX_DB, auth.userId) });
	});
	api.post("/api/oauth-clients/:clientId/revoke", async (c) => {
		const clientId = c.req.param("clientId");
		if (!OAUTH_CLIENT_ID_PATTERN.test(clientId)) {
			return c.json({ error: "invalid_client_id" }, 400);
		}
		const auth = c.get("auth");
		if (!auth) {
			return c.json({ error: "unauthorized" }, 401);
		}
		const result = await revokeOwnedOAuthClient(c.env.INDEX_DB, auth.userId, clientId);
		if (!result) {
			return c.json({ error: "client_not_found" }, 404);
		}
		return c.json(result);
	});
}
