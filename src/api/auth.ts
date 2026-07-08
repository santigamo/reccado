import {
	fetchWithTimeout,
	getAccessConfigStatus,
	isAbortTimeoutError,
	isLocalRequest,
} from "../lib/runtime-config";

export type AuthContext = {
	userId: string;
	email: string;
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
		return { userId: "dev-local", email: "dev@local" };
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
		return { userId: payload.sub ?? email, email };
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

let warnedOpenAccess = false;

function warnOpenAccessOnce(): void {
	if (warnedOpenAccess) {
		return;
	}
	warnedOpenAccess = true;
	console.warn(
		"auth.open_access: ACCESS_ALLOWED_EMAILS is not set; every authenticated Access identity is treated as the single operator. Set ACCESS_ALLOWED_EMAILS to a comma-separated owner allowlist to restrict access.",
	);
}

function isAllowedOwner(auth: AuthContext, env: Env): boolean {
	const allowed = parseAllowedEmails(env);
	if (!allowed) {
		// Single-user private inbox v0: no allowlist configured, so any authenticated Access
		// identity may access all mailboxes (open single-operator mode).
		warnOpenAccessOnce();
		return true;
	}
	return allowed.includes(auth.email.trim().toLowerCase());
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
	const allowed = parseAllowedEmails(env);
	if (allowed) {
		if (!allowed.includes(auth.email.trim().toLowerCase())) {
			throw new Response(JSON.stringify({ error: "forbidden" }), {
				status: 403,
				headers: { "content-type": "application/json" },
			});
		}
	} else {
		warnOpenAccessOnce();
	}
	return auth;
}

// TODO: per-mailbox ACL — today every allowed owner can access every mailbox; there is no
// per-mailbox ownership table yet, so this only enforces the global owner allowlist.
export function assertMailboxAccess(auth: AuthContext, _mailboxId: string, env: Env): void {
	if (!isAllowedOwner(auth, env)) {
		throw new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
}

/**
 * MCP-specific auth gate: fails closed if ACCESS_ALLOWED_EMAILS is unset or empty.
 * Unlike the UI (which allows open single-operator mode), the MCP endpoint refuses
 * to serve any tool call without an explicit allowlist. Returns true if the
 * authenticated identity is allowed to use MCP tools.
 */
export function isMcpAllowed(auth: AuthContext, env: Env): boolean {
	const allowed = parseAllowedEmails(env);
	if (!allowed) {
		return false;
	}
	return allowed.includes(auth.email.trim().toLowerCase());
}

/**
 * Returns 503 if ACCESS_ALLOWED_EMAILS is unset/empty (MCP misconfigured),
 * 403 if the authenticated identity is not in the allowlist,
 * or the AuthContext if allowed. Throws a Response for the Hono middleware to return.
 */
export function requireMcpAuth(auth: AuthContext, env: Env): AuthContext {
	const allowed = parseAllowedEmails(env);
	if (!allowed) {
		throw new Response(
			JSON.stringify({ error: "mcp_not_configured", reason: "ACCESS_ALLOWED_EMAILS is not set" }),
			{ status: 503, headers: { "content-type": "application/json" } },
		);
	}
	if (!allowed.includes(auth.email.trim().toLowerCase())) {
		throw new Response(JSON.stringify({ error: "forbidden" }), {
			status: 403,
			headers: { "content-type": "application/json" },
		});
	}
	return auth;
}
