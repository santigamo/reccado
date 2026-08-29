import { readOwnerRegistry } from "../db/owners";
import {
	fetchWithTimeout,
	getAccessConfigStatus,
	isAbortTimeoutError,
	isLocalRequest,
} from "../lib/runtime-config";

export type AuthContext = {
	userId: string;
	email: string;
	/**
	 * The owner emails in force for this request: the D1 registry unioned with the
	 * ACCESS_ALLOWED_EMAILS bootstrap, resolved once here so the synchronous checks
	 * downstream (assertMailboxAccess, requireMcpAuth) never need a database.
	 *
	 * Empty means nobody is declared owner, which denies. Absent means the context
	 * was built by hand rather than by getAuthContext, and the decision falls back
	 * to the bootstrap variable alone -- which also denies when it is unset.
	 */
	owners?: string[];
	/**
	 * True only for the localhost dev-bypass identity. getAuthContext refuses to
	 * mint it for a non-local request, so it is not a claim a caller can make.
	 */
	local?: boolean;
};

export type AccessJwtPayload = {
	sub?: string;
	email?: string;
	aud?: string[];
	exp?: number;
	iss?: string;
};

type AccessCertResponse = {
	keys: Array<{ kid: string; kty: string; n: string; e: string; alg: string }>;
};

let cachedCerts: AccessCertResponse | null = null;
let cachedCertsAt = 0;

function decodeBase64Url(input: string): Uint8Array {
	const padded = input.replace(/-/g, "+").replace(/_/g, "/");
	const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
	const binary = atob(padded + pad);
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function parseJwt(token: string): {
	header: Record<string, unknown>;
	payload: AccessJwtPayload;
	signature: Uint8Array;
	signed: Uint8Array;
} {
	const parts = token.split(".");
	if (parts.length !== 3) {
		throw new Error("Invalid JWT");
	}
	const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
	const header = JSON.parse(new TextDecoder().decode(decodeBase64Url(headerPart))) as Record<
		string,
		unknown
	>;
	const payload = JSON.parse(
		new TextDecoder().decode(decodeBase64Url(payloadPart)),
	) as AccessJwtPayload;
	return {
		header,
		payload,
		signature: decodeBase64Url(signaturePart),
		signed: new TextEncoder().encode(`${headerPart}.${payloadPart}`),
	};
}

async function getAccessCerts(teamDomain: string): Promise<AccessCertResponse> {
	const now = Date.now();
	if (cachedCerts && now - cachedCertsAt < 60_000) {
		return cachedCerts;
	}
	const response = await fetchWithTimeout(`${teamDomain.replace(/\/$/, "")}/cdn-cgi/access/certs`, {
		timeoutMs: 5_000,
	});
	if (!response.ok) {
		throw new Error(`Failed to fetch Access certs: ${response.status}`);
	}
	cachedCerts = (await response.json()) as AccessCertResponse;
	cachedCertsAt = now;
	return cachedCerts;
}

export async function verifyAccessJwt(token: string, env: Env): Promise<AccessJwtPayload> {
	const accessConfig = getAccessConfigStatus(env);
	if (!accessConfig.configured || accessConfig.mode !== "access-jwt") {
		throw new Error(accessConfig.reason ?? "Access validation is not configured");
	}
	const audience = env.ACCESS_JWT_AUDIENCE!;
	const teamDomain = env.ACCESS_TEAM_DOMAIN!;

	const { header, payload, signature, signed } = parseJwt(token);
	const kid = header.kid;
	if (typeof kid !== "string") {
		throw new Error("JWT missing kid");
	}

	const certs = await getAccessCerts(teamDomain);
	const jwk = certs.keys.find((key) => key.kid === kid);
	if (!jwk) {
		throw new Error("Unknown JWT kid");
	}

	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		key,
		new Uint8Array(signature),
		new Uint8Array(signed),
	);
	if (!valid) {
		throw new Error("Invalid JWT signature");
	}

	// Issuer validation: must match the team domain's Access issuer URL.
	const expectedIssuer = `${teamDomain.replace(/\/$/, "")}`;
	if (!payload.iss) {
		throw new Error("JWT missing iss");
	}
	if (payload.iss !== expectedIssuer && payload.iss !== `${expectedIssuer}/`) {
		throw new Error("JWT issuer mismatch");
	}

	// Required exp: reject tokens without exp or with expired exp.
	if (!payload.exp) {
		throw new Error("JWT missing exp");
	}
	if (payload.exp * 1000 < Date.now()) {
		throw new Error("JWT expired");
	}

	// Required email: reject tokens without a usable email claim.
	if (!payload.email?.trim()) {
		throw new Error("JWT missing email");
	}

	const aud = payload.aud ?? [];
	if (!aud.includes(audience)) {
		throw new Error("JWT audience mismatch");
	}

	return payload;
}

export async function getAuthContext(request: Request, env: Env): Promise<AuthContext | null> {
	const accessConfig = getAccessConfigStatus(env);
	if (accessConfig.mode === "local-dev-bypass") {
		if (!isLocalRequest(request)) {
			return null;
		}
		return {
			userId: "dev-local",
			email: "dev@local",
			owners: await resolveOwnerEmails(env),
			local: true,
		};
	}
	if (!accessConfig.ok) {
		throw new Error(accessConfig.reason ?? "Access validation is misconfigured");
	}

	const token = request.headers.get("CF-Access-JWT-Assertion");
	if (!token) {
		return null;
	}

	try {
		const payload = await verifyAccessJwt(token, env);
		const email = payload.email ?? payload.sub ?? "unknown";
		return { userId: payload.sub ?? email, email, owners: await resolveOwnerEmails(env) };
	} catch (error) {
		if (
			isAbortTimeoutError(error) ||
			(error instanceof Error && error.message.startsWith("Failed to fetch Access certs:"))
		) {
			throw error;
		}
		if (
			error instanceof Error &&
			(error.message.includes("misconfigured") || error.message.includes("not configured"))
		) {
			throw error;
		}
		return null;
	}
}

/**
 * The bootstrap variable, parsed. Null when unset.
 *
 * This is no longer the owner record -- owner_identities is (see db/owners.ts) --
 * but it stays readable for the same reason a hotel keeps a master key: an
 * operator whose database says nobody owns this deployment needs a way in that
 * does not go through the database.
 */
export function parseAllowedEmails(env: Env): string[] | null {
	const raw = env.ACCESS_ALLOWED_EMAILS;
	if (!raw?.trim()) {
		return null;
	}
	const emails = raw
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter((email) => email.length > 0);
	return emails.length > 0 ? emails : null;
}

/** Registry plus bootstrap: one answer to "who owns this deployment", web-side. */
export async function resolveOwnerEmails(env: Env): Promise<string[]> {
	const registry = await readOwnerRegistry(env.INDEX_DB);
	return [...new Set([...registry.emails, ...(parseAllowedEmails(env) ?? [])])];
}

let warnedNoOwner = false;

function warnNoOwnerOnce(): void {
	if (warnedNoOwner) {
		return;
	}
	warnedNoOwner = true;
	console.warn(
		"auth.no_owner: no owner is registered for this deployment, so /api/* and /mcp deny every identity. Insert a row into owner_identities (see migrations/d1/0012_owner_registry.sql) or set the ACCESS_ALLOWED_EMAILS bootstrap.",
	);
}

/**
 * The allowlist governing this request.
 *
 * Falls back to the bootstrap variable only for an AuthContext nothing resolved
 * owners for -- a hand-built one. Either way the empty case is an empty array,
 * never "no opinion": there is no configuration of this system that means
 * "everyone".
 */
function ownersFor(auth: AuthContext, env: Env): string[] {
	return auth.owners ?? parseAllowedEmails(env) ?? [];
}

/**
 * Is this identity an owner?
 *
 * The check is deliberately NOT redundant with the Cloudflare Access policy. The
 * failure this defends against is the one the README documents: an Access app
 * created for the wrong hostname, where Access does not deny -- it simply is not
 * there. getAccessConfigStatus catches the half of that where the worker knows it
 * is unprotected; this list is what still stands when the perimeter is missing
 * and the worker cannot tell.
 *
 * With no owner at all it denies, with one exception: the localhost dev-bypass
 * identity, which getAuthContext only mints for a local request, so it is the
 * developer's own machine rather than an open door. Once any owner exists, even
 * that identity has to be one.
 */
function isOwner(auth: AuthContext, env: Env): boolean {
	const owners = ownersFor(auth, env);
	if (owners.length === 0) {
		return auth.local === true;
	}
	return owners.includes(auth.email.trim().toLowerCase());
}

export async function requireAuth(request: Request, env: Env): Promise<AuthContext> {
	let auth: AuthContext | null;
	try {
		auth = await getAuthContext(request, env);
	} catch (error) {
		const message =
			error instanceof Error
				? isAbortTimeoutError(error)
					? "Cloudflare Access validation timed out."
					: error.message
				: "Cloudflare Access validation failed.";
		throw new Response(JSON.stringify({ error: "auth_unavailable", reason: message }), {
			status: 503,
			headers: { "content-type": "application/json" },
		});
	}
	if (!auth) {
		throw new Response(JSON.stringify({ error: "unauthorized" }), {
			status: 401,
			headers: { "content-type": "application/json" },
		});
	}
	if (!isOwner(auth, env)) {
		// 503 rather than 403 when nobody owns the deployment: the caller did nothing
		// wrong, the install is unfinished, and saying "forbidden" would send an
		// operator hunting for a policy that does not exist. The distinction is the
		// same one /mcp has always drawn.
		if (ownersFor(auth, env).length === 0) {
			warnNoOwnerOnce();
			throw new Response(
				JSON.stringify({
					error: "owner_not_configured",
					reason: "No owner is registered for this deployment.",
				}),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		}
		throw new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
	return auth;
}

// TODO: per-mailbox ACL — today every owner can access every mailbox; there is no
// per-mailbox ownership table yet, so this only enforces the global owner registry.
export function assertMailboxAccess(auth: AuthContext, _mailboxId: string, env: Env): void {
	if (!isOwner(auth, env)) {
		throw new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
}

/**
 * MCP-specific gate: fails closed when no owner is registered and no bootstrap
 * variable is set. Stricter than the UI in one respect on purpose -- the
 * localhost dev-bypass identity gets no exemption here, because an MCP client is
 * a program acting unattended and "it is only my laptop" is not a property of the
 * request it makes.
 */
export function isMcpAllowed(auth: AuthContext, env: Env): boolean {
	const owners = ownersFor(auth, env);
	return owners.includes(auth.email.trim().toLowerCase());
}

/**
 * Returns 503 when this deployment has no owner (MCP unconfigured),
 * 403 when the authenticated identity is not one,
 * or the AuthContext if allowed. Throws a Response for the Hono middleware to return.
 */
export function requireMcpAuth(auth: AuthContext, env: Env): AuthContext {
	const owners = ownersFor(auth, env);
	if (owners.length === 0) {
		throw new Response(
			JSON.stringify({
				error: "mcp_not_configured",
				reason: "No owner is registered for this deployment.",
			}),
			{ status: 503, headers: { "content-type": "application/json" } },
		);
	}
	if (!owners.includes(auth.email.trim().toLowerCase())) {
		throw new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
	return auth;
}
