/**
 * Hygiene around open RFC 7591 dynamic client registration on /api/auth/oauth2/register.
 *
 * Registration is unauthenticated so a standard MCP client can connect from just the
 * server URL. Nothing is granted by registering: the owner must still log in (owner
 * registry + e-mail OTP) and consent. What lives here keeps strangers from filling the
 * table with junk or smuggling hostile redirect targets / display names into the
 * consent screen:
 *   - redirect URIs: https, or http on loopback only;
 *   - client_name: control characters stripped, length capped;
 *   - never-consented clients are swept after 24 h (sweepStaleOAuthClients, hourly cron).
 * The per-IP rate limit is better-auth's D1-backed limiter (see REGISTRATION_RATE_LIMIT).
 */

export const REGISTRATION_PATH_SUFFIX = "/oauth2/register";
/** Per-IP: 10 registrations per hour, counted in D1 (shared across isolates). */
export const REGISTRATION_RATE_LIMIT = { window: 3600, max: 10 } as const;
export const MAX_CLIENT_NAME_LENGTH = 100;
export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 2048;
export const STALE_CLIENT_AGE_MS = 24 * 60 * 60 * 1000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isAllowedRedirectUri(value: unknown): boolean {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH)
		return false;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.username || url.password || url.hash) return false;
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/** Strips control / bidi-override / zero-width characters and caps the length. */
export function sanitizeClientName(value: string): string {
	return value
		.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, "")
		.trim()
		.slice(0, MAX_CLIENT_NAME_LENGTH);
}

export type RegistrationCheck =
	| { ok: true; body: Record<string, unknown>; redirectHosts: string[] }
	| { ok: false; error: "invalid_redirect_uri" | "invalid_client_metadata"; description: string };

/** Validates and normalises a registration body before it reaches the OAuth provider. */
export function checkRegistrationBody(raw: unknown): RegistrationCheck {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		return { ok: false, error: "invalid_client_metadata", description: "Body must be a JSON object" };
	const body = { ...(raw as Record<string, unknown>) };
	const uris = body.redirect_uris;
	if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
		return {
			ok: false,
			error: "invalid_redirect_uri",
			description: `redirect_uris must list 1-${MAX_REDIRECT_URIS} URIs`,
		};
	for (const uri of uris) {
		if (!isAllowedRedirectUri(uri))
			return {
				ok: false,
				error: "invalid_redirect_uri",
				description: "redirect_uris must be https, or http on a loopback host (127.0.0.1, localhost, [::1])",
			};
	}
	if (body.client_name !== undefined) {
		if (typeof body.client_name !== "string")
			return { ok: false, error: "invalid_client_metadata", description: "client_name must be a string" };
		body.client_name = sanitizeClientName(body.client_name);
	}
	// The provider treats dynamic clients as "web" unless told otherwise and then refuses
	// http redirects even on loopback. Loopback http is the native-app pattern (RFC 8252),
	// which is exactly what CLI clients such as Claude Code use.
	if ((uris as string[]).some((uri) => uri.startsWith("http:"))) body.application_type = "native";
	const redirectHosts = [...new Set((uris as string[]).map((uri) => new URL(uri).host))];
	return { ok: true, body, redirectHosts };
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Deletes dynamically registered clients that never got a consent or a token and are
 * older than 24 h, along with anything that points at them. Clients with an owner
 * (registered from a session), a consent, or any token are kept.
 * Returns the number of clients removed.
 */
export async function sweepStaleOAuthClients(db: D1Database, now: number): Promise<number> {
	const cutoff = now - STALE_CLIENT_AGE_MS;
	const stale = await db
		.prepare(
			`SELECT c."clientId" AS client_id FROM "oauthClient" c
			 WHERE c."createdAt" IS NOT NULL AND c."createdAt" < ?
			   AND c."userId" IS NULL AND c."referenceId" IS NULL
			   AND NOT EXISTS (SELECT 1 FROM "oauthConsent" x WHERE x."clientId" = c."clientId")
			   AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" t WHERE t."clientId" = c."clientId")
			   AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" r WHERE r."clientId" = c."clientId")
			 LIMIT 200`,
		)
		.bind(cutoff)
		.all<{ client_id: string }>();
	const ids = (stale.results ?? []).map((row) => row.client_id);
	if (ids.length === 0) return 0;
	await db.batch(
		ids.flatMap((id) => [
			db.prepare(`DELETE FROM "oauthClientResource" WHERE "clientId" = ?`).bind(id),
			db.prepare(`DELETE FROM "oauthClient" WHERE "clientId" = ?`).bind(id),
		]),
	);
	return ids.length;
}
