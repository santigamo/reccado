import type { Hono } from "hono";
import { insertOpsEvent } from "../db/d1";
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

export function registerOAuthClientRoutes(api: Hono<ApiBindings>): void {
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
