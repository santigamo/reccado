import { readOwnerRegistry } from "../db/owners";
import { getAuthConfigStatus, isLocalRequest } from "../lib/runtime-config";

// Imported dynamically (inside getAuthContext) rather than statically: this
// module is imported by api/better-auth.ts (for resolveOwnerEmails, the owner
// gate), and a static cycle between the two would run their module initialisers
// in a fragile order.
import type { AuthEnv } from "./better-auth";
export type { AuthEnv };

export type AuthContext = {
	userId: string;
	email: string;
	/**
	 * The owner emails in force for this request: the D1 registry unioned with the
	 * OWNER_BOOTSTRAP_EMAILS bootstrap, resolved once here so the synchronous checks
	 * downstream (assertMailboxAccess, requireMcpOwner) never need a database.
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

export type AuthVerificationOptions = {
	/**
	 * Skip better-auth's session cookie cache and verify against D1.
	 *
	 * The cookie cache trades freshness for a D1 read: a session revoked up to
	 * `session.cookieCache.maxAge` (5 minutes) ago can still pass. Paths where a
	 * revoked session must take effect IMMEDIATELY — confirm-send, where the
	 * very next act is sending mail as the operator's mailboxes — verify against
	 * the database instead. Used only there; the cache is safe everywhere else.
	 */
	disableCookieCache?: boolean;
};

export async function getAuthContext(
	request: Request,
	env: Env,
	opts: AuthVerificationOptions = {},
): Promise<AuthContext | null> {
	const authConfig = getAuthConfigStatus(env);
	if (authConfig.mode === "local-dev-bypass") {
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
	if (!authConfig.ok) {
		throw new Error(authConfig.reason ?? "Auth validation is misconfigured");
	}

	const { createAuth } = await import("./better-auth");
	const auth = await createAuth(env as unknown as AuthEnv, { request });
	const session = await auth.api.getSession({
		headers: request.headers,
		query: opts.disableCookieCache ? { disableCookieCache: true } : undefined,
	});
	if (!session) {
		return null;
	}
	return {
		userId: session.user.id,
		email: session.user.email,
		owners: await resolveOwnerEmails(env),
	};
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
	const raw = env.OWNER_BOOTSTRAP_EMAILS;
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
		"auth.no_owner: no owner is registered for this deployment, so /api/* and /mcp deny every identity. Insert a row into owner_identities (see migrations/d1/0012_owner_registry.sql) or set the OWNER_BOOTSTRAP_EMAILS bootstrap.",
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
 * The check is deliberately NOT redundant with the login flow. The failure this
 * defends against is the one the README documents: a perimeter configured for
 * the wrong hostname, where the gate does not deny -- it simply is not there.
 * getAuthConfigStatus catches the half of that where the worker knows it is
 * unprotected; this list is what still stands when the perimeter is missing
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

export async function requireAuth(
	request: Request,
	env: Env,
	opts: AuthVerificationOptions = {},
): Promise<AuthContext> {
	let auth: AuthContext | null;
	try {
		auth = await getAuthContext(request, env, opts);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Session validation failed.";
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
 * or the AuthContext if allowed. Throws a Response for the caller to return.
 *
 * Renamed from requireMcpAuth (docs/plans/sending-streams-and-auth.md Phase 2
 * item 5): the name `requireMcpAuth` now belongs to @better-auth/mcp, which owns
 * bearer-token verification. This is the owner gate that runs AFTER that
 * verification, once the token's identity is established.
 */
export function requireMcpOwner(auth: AuthContext, env: Env): AuthContext {
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
