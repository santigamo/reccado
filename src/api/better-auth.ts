/**
 * The web auth issuer: Better Auth 1.7.2 on the INDEX_DB D1 binding
 * (migrations/d1/0016_better_auth.sql), replacing the Cloudflare Access JWT
 * validator — see docs/plans/sending-streams-and-auth.md, Phase 2.
 *
 * The seam that keeps this migration small: authorization does not live here.
 * This module only answers "which email identity is holding the session"; the
 * owner registry (db/owners.ts, via isOwner/requireMcpOwner in api/auth.ts)
 * still decides whether that identity is the operator. A bug here yields at
 * most an authenticated stranger the registry rejects.
 *
 * Conventions follow the eccos auth-baseline (~/Code/eccos/packages/auth-
 * baseline/src/config.ts): fail-closed secret, canonical-origin allowlist,
 * database-backed rate limiting, email-OTP only (no passwords — there is no
 * credential to steal and no stuffing to attempt).
 */

import { betterAuth, type BetterAuthOptions } from "better-auth";
import { mcp } from "@better-auth/mcp";
import { emailOTP, jwt, twoFactor } from "better-auth/plugins";
import { insertOpsEvent } from "../db/d1";
import { consumePairingCode, type PairingClaim } from "../db/owners";
import { RUNTIME_CONFIG_KEYS, getRuntimeConfig } from "../db/runtime-config";
import {
	createAuthMailSender,
	renderOtpEmail,
	renderPasswordResetEmail,
	type AuthMailSender,
} from "../lib/better-auth";
import { resolveOwnerEmails } from "./auth";

/** The path better-auth mounts under in the worker (server.ts proxies /api/* to the Hono app). */
export const AUTH_BASE_PATH = "/api/auth";

/**
 * Floor for the first factor. High on purpose: this password is generated and
 * autofilled, so length costs nothing here and there is no human memory to
 * accommodate. Shared by the issuer config and the setter below so the two
 * cannot drift.
 */
export const MIN_PASSWORD_LENGTH = 16;

/** The endpoint an unauthenticated caller hits to spend a pairing code. */
export const PAIRING_PATH = `${AUTH_BASE_PATH}/pairing`;

/** The email-otp send endpoint whose request the owner gate intercepts. */
const SEND_OTP_PATH = `${AUTH_BASE_PATH}/email-otp/send-verification-otp`;

/**
 * The canonical MCP protected-resource identifier (RFC 8707 / RFC 9728) this
 * deployment serves /mcp at: the same canonical origin createAuth anchors
 * better-auth to, plus the fixed /mcp path. Tokens minted by the OAuth provider
 * are audience-bound to it, and /mcp rejects tokens whose audience differs
 * (mcp/handler.ts).
 */
export async function resolveMcpResource(env: AuthEnv, request: Request): Promise<string> {
	const origin = (await getDeploymentOriginForAuth(env.INDEX_DB)) ?? new URL(request.url).origin;
	return `${origin}/mcp`;
}

export type AuthEnv = {
	INDEX_DB: D1Database;
	EMAIL?: SendEmail;
	MAIL_FROM_ADDRESS?: string;
	BETTER_AUTH_SECRET?: string;
};

/** Thrown by createAuth when the issuer cannot run at all; handleAuthRequest maps it to 503. */
export class AuthConfigError extends Error {}

/**
 * Builds the better-auth instance for one request.
 *
 * Request-scoped because two inputs are request- or deployment-shaped: the D1
 * binding (identical in production, distinct in tests) and the canonical base
 * URL. baseURL prefers the origin the deployment observed from authenticated
 * traffic (runtime_config "deployment.origin"), and falls back to the origin
 * the request itself arrived on, so better-auth's origin checking and the
 * secure-cookie posture are always anchored to a real https origin — never to
 * "whatever Host header said".
 *
 * The instance is cheap enough to build per request (a single D1 read for the
 * origin), and caching one per isolate keyed on a D1Database object is not
 * sound: bindings differ per test, per environment and per deploy.
 */
export async function createAuth(
	env: AuthEnv,
	opts: { request?: Request; mailSender?: AuthMailSender } = {},
): Promise<ReturnType<typeof betterAuth>> {
	const secret = env.BETTER_AUTH_SECRET?.trim();
	if (!secret) {
		throw new AuthConfigError("BETTER_AUTH_SECRET is not set.");
	}
	if (secret.length < 32) {
		throw new AuthConfigError("BETTER_AUTH_SECRET is too short; generate at least 32 characters.");
	}

	const mail = opts.mailSender ?? createAuthMailSender(env);
	// The config value the system can observe (learned from authenticated traffic);
	// the request origin is the fallback, never an invention.
	const observedOrigin = await getDeploymentOriginForAuth(env.INDEX_DB);
	const baseURL = observedOrigin ?? (opts.request ? new URL(opts.request.url).origin : undefined);
	if (!baseURL) {
		// The MCP/OAuth plugins mint issuer- and audience-bound tokens: without a
		// canonical origin there is nothing to bind them to, and guessing (Host
		// header, defaults) would mint tokens for an origin nobody verified.
		throw new AuthConfigError("createAuth requires a request or an observed deployment origin.");
	}

	const options: BetterAuthOptions = {
		database: env.INDEX_DB as never,
		secret,
		baseURL,
		trustedOrigins: baseURL ? [baseURL] : undefined,
		// A password is the first factor, TOTP the second, and a password manager
		// fills both in one gesture. The original design had no password at all --
		// the argument being that there is then no credential to steal and no
		// stuffing to attempt. That argument was aimed at user-chosen passwords at
		// scale: here registration is closed, there is one account, the password is
		// generated rather than remembered, and a stolen hash is still short a TOTP
		// secret. What it bought in exchange -- waiting for mail on every sign-in --
		// was the whole cost of the perimeter, paid daily.
		emailAndPassword: {
			enabled: true,
			// Registration stays closed. A user row comes into existence only through
			// the OTP gate or a pairing code, both of which consult the owner registry;
			// password sign-up would be a second door around that check.
			disableSignUp: true,
			// Generated by a password manager, never typed from memory.
			minPasswordLength: MIN_PASSWORD_LENGTH,
			sendResetPassword: async ({ user, url }) => {
				const content = renderPasswordResetEmail(url);
				await mail.sendMail({ to: user.email, subject: content.subject, text: content.text });
			},
			// A reset proves control of the mailbox, which is not the same as proving
			// the operator asked for it -- so every other session goes with it.
			revokeSessionsOnPasswordReset: true,
		},
		session: {
			// A signed cookie answers "is this session alive" for 5 minutes without a
			// D1 read per request. The confirm-send path deliberately bypasses this
			// (see requireAuth's disableCookieCache) so a revoked session takes
			// effect the moment a send is about to happen.
			cookieCache: { enabled: true, maxAge: 5 * 60 },
		},
		rateLimit: {
			enabled: true,
			storage: "database",
		},
		plugins: [
			emailOTP({
				otpLength: 6,
				expiresIn: 300,
				sendVerificationOTP: async ({ email, otp }) => {
					// The owner gate ran before this endpoint was reached (handleAuthRequest),
					// so every code below is on its way to a vouched-for address only.
					const content = renderOtpEmail(otp);
					await mail.sendMail({ to: email, subject: content.subject, text: content.text });
				},
			}),
			// TOTP as the second factor. `trustDevice` on verification remembers the
			// browser for 30 days and skips the challenge there, so the steady state
			// on a known machine is a single autofill; the code is asked for on a new
			// device, which is when it is actually worth asking.
			//
			// Email OTP above is no longer the daily path -- it is what gets a brand
			// new deployment to its first session, and what recovers one whose second
			// factor is gone. Both doors still pass the same owner registry.
			twoFactor({
				issuer: "Reccado",
			}),
			// Stable signing keys + /jwks, shared by the session-JWT endpoint and the
			// OAuth provider's access tokens. Payload kept minimal: identity only.
			jwt({
				jwt: {
					definePayload: ({ user }) => ({ sub: user.id, email: user.email }),
				},
			}),
			// The OAuth 2.1 provider for /mcp (docs/plans/sending-streams-and-auth.md
			// Phase 2 item 5). Access tokens are JWTs signed with the jwt() keys,
			// audience-bound to the canonical /mcp resource; verification happens in
			// mcp/handler.ts via @better-auth/mcp's requireMcpAuth. Tables: 0017.
			mcp({
				resource: await resolveMcpResource(env, opts.request ?? new Request(baseURL)),
				loginPage: "/login",
				// No consent UI page exists yet; a dynamically registered client's
				// authorize redirect lands here after the owner logs in (the operator
				// path is documented in mcp/handler.ts).
				consentPage: "/consent",
				// Session-backed dynamic client registration (RFC 7591): a request with
				// no owner session is rejected (allowUnauthenticatedClientRegistration
				// stays false), so a stranger cannot mint client rows. The single
				// operator registers their MCP client while logged in to the dashboard.
				allowDynamicClientRegistration: true,
				// The owner gate consumes the token's email; the provider's fixed
				// access-token claims carry only sub/aud/scope, so add the identity here.
				customAccessTokenClaims: async ({ user }) => (user ? { email: user.email } : {}),
			}),
		],
		advanced: {
			defaultCookieAttributes: {
				httpOnly: true,
				sameSite: "lax",
				// Anchored to baseURL (observed origin or the real request origin), which
				// is https in every deployed topology, http only on localhost.
				secure: baseURL?.startsWith("https://") ?? false,
			},
			// Workers do not surface a socket address and better-auth would key every
			// rate-limit bucket on "no-trusted-ip" — collapse everyone into one bucket.
			// Cloudflare's edge-set header is the honest client address.
			ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
		},
	};
	return betterAuth(options);
}

/**
 * The gate that closes registration, placed BEFORE better-auth's endpoint runs.
 *
 * `sendVerificationOTP` is the only path that mints a sign-in code, and it is
 * the whole of registration: no code means no sign-in means no user row ever
 * exists for a stranger. The gate resolves owners exactly as every other
 * perimeter does (D1 registry ∪ OWNER_BOOTSTRAP_EMAILS bootstrap) and, for a
 * non-owner, returns the same `{ success: true }` a legitimate request would
 * get — no mail, no verification row (better-auth stores the OTP only after
 * this gate, so intercepting the request here is what makes the absence real),
 * and no way to tell which emails the deployment considers owners.
 */
async function gateSendOtp(request: Request, env: AuthEnv): Promise<Response | null> {
	let email: string | null = null;
	try {
		// Read a clone so the original body stays untouched for better-auth below.
		const body = (await request.clone().json()) as { email?: unknown };
		if (typeof body.email === "string") {
			email = body.email.trim().toLowerCase() || null;
		}
	} catch {
		// Malformed body: let better-auth produce its own validation error.
		return null;
	}
	const owners = await resolveOwnerEmails(env as Env);
	if (email && owners.includes(email)) {
		return null;
	}
	return Response.json({ success: true });
}

/**
 * Signs a cookie value exactly the way better-auth's own endpoints do (HMAC-
 * SHA256 over the value, base64, appended after a dot, URL-encoded) so the
 * pairing endpoint's cookie is byte-for-byte what `getSignedCookie` expects.
 *
 * Inlined rather than imported: the signer lives in better-call, which is a
 * transitive dependency and not a legal import from application code. The
 * algorithm is three lines of stable WebCrypto and is asserted against a real
 * getSession round-trip in tests/integration/better-auth.test.ts.
 */
async function signSessionCookieValue(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
	const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return encodeURIComponent(`${value}.${base64}`);
}

/**
 * Serializes the session Set-Cookie header from the attributes better-auth
 * computed (path/httpOnly/sameSite/secure/maxAge — including the __Secure-
 * name prefix on https deployments, which arrives on the name itself).
 */
function serializeSessionCookie(
	name: string,
	signedValue: string,
	attributes: Record<string, unknown>,
): string {
	const parts = [`${name}=${signedValue}`];
	if (typeof attributes.maxAge === "number") parts.push(`Max-Age=${Math.floor(attributes.maxAge)}`);
	if (attributes.domain) parts.push(`Domain=${String(attributes.domain)}`);
	if (attributes.path) parts.push(`Path=${String(attributes.path)}`);
	if (attributes.httpOnly) parts.push("HttpOnly");
	if (attributes.secure) parts.push("Secure");
	if (typeof attributes.sameSite === "string") {
		parts.push(`SameSite=${attributes.sameSite[0]!.toUpperCase()}${attributes.sameSite.slice(1)}`);
	}
	return parts.join("; ");
}

/**
 * The fetch-handler mounted at /api/auth/*.
 *
 * Order matters: the pairing endpoint is matched first (it is ours, not
 * better-auth's), then the OTP-send gate, then better-auth itself. A missing or
 * mis-sized BETTER_AUTH_SECRET fails closed here with the same 503 shape the
 * rest of the auth surface uses.
 */
export async function handleAuthRequest(
	request: Request,
	env: AuthEnv,
	opts: { mailSender?: AuthMailSender } = {},
): Promise<Response> {
	const url = new URL(request.url);
	try {
		if (url.pathname === PAIRING_PATH) {
			return await handlePairingRequest(request, env);
		}
		if (url.pathname === SEND_OTP_PATH && request.method === "POST") {
			const gated = await gateSendOtp(request, env);
			if (gated) return gated;
		}
		const auth = await createAuth(env, { request, mailSender: opts.mailSender });
		return await auth.handler(request);
	} catch (error) {
		if (error instanceof AuthConfigError) {
			return Response.json({ error: "auth_unavailable", reason: error.message }, { status: 503 });
		}
		throw error;
	}
}

export type PairingResponse =
	| { ok: true; claim: "linked" | "already_owner" }
	| { ok: false; claim: Exclude<PairingClaim, "linked" | "already_owner"> };

/**
 * The web half of the rescue ladder: a pairing code minted by a human via
 * `wrangler d1 execute` —
 *
 *   INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by)
 *   VALUES ('<code>', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
 *           strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 hours'), 'manual')
 *
 * — typed into /login together with an email, spent here (single-winner, see
 * consumePairingCode), the email linked as an owner identity (linked_via
 * "pairing_code"), the ops event written like claimTelegramPairing does, and a
 * better-auth session created directly through the internal adapter — no OTP,
 * because the code the human minted IS the proof. The response sets the session
 * cookie, so the browser walks out of this endpoint fully logged in.
 *
 * This is the rung that must not require the web perimeter to already work: the
 * endpoint is public, and its only credential is a code that lives in D1, which
 * is the same channel a forker with a broken perimeter has. Rejections use the
 * same claim vocabulary the Telegram ladder reports, and — like it — are written
 * to ops_events, because a stream of rejected attempts is somebody guessing.
 */
export async function handlePairingRequest(request: Request, env: AuthEnv): Promise<Response> {
	let email: string;
	let code: string;
	try {
		const body = (await request.json()) as { email?: unknown; code?: unknown };
		email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
		code = typeof body.code === "string" ? body.code.trim() : "";
	} catch {
		return Response.json({ ok: false, claim: "unknown" } satisfies PairingResponse, {
			status: 400,
		});
	}
	if (!email.includes("@") || !code) {
		return Response.json({ ok: false, claim: "unknown" } satisfies PairingResponse, {
			status: 400,
		});
	}

	const claim = await consumePairingCode(env.INDEX_DB, { code, kind: "email", identity: email });
	const success = claim === "linked" || claim === "already_owner";
	// Deliberately no code, not even a prefix — same rule as claimTelegramPairing:
	// a rejected attempt is evidence of guessing, and writing guesses into a table
	// read for other reasons would put live codes where they do not belong.
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: success ? "owner.email_linked" : "owner.pairing_rejected",
		severity: success ? "info" : "warning",
		subject: email,
		payload_json: JSON.stringify({ claim, surface: "web" }),
	}).catch(() => undefined);

	if (!success) {
		return Response.json({ ok: false, claim } satisfies PairingResponse, { status: 401 });
	}

	// Spend the authority the code carried: find or mint the better-auth user and
	// open a session directly. No OTP round-trip — the code already proved the human.
	const auth = await createAuth(env, { request });
	const ctx = await auth.$context;
	const existing = await ctx.internalAdapter.findUserByEmail(email);
	const user =
		existing?.user ??
		(await ctx.internalAdapter.createUser(
			{
				email,
				name: email.split("@")[0] ?? email,
				emailVerified: true,
			},
			// The pairing code is the provisioning source: the operator minted it in
			// D1 and typed it in, which is closer to "admin" than any OAuth method.
			{ method: "admin" },
		));
	const session = await ctx.internalAdapter.createSession(user.id, false);

	// Set the same signed session cookie better-auth's own endpoints would set,
	// using the names and attributes the auth context already computed (including
	// the __Secure- prefix on https deployments).
	const attributes = ctx.authCookies.sessionToken.attributes as Record<string, unknown>;
	const signedValue = await signSessionCookieValue(session.token, ctx.secret);
	const setCookie = serializeSessionCookie(
		ctx.authCookies.sessionToken.name,
		signedValue,
		attributes,
	);
	return Response.json({ ok: true, claim } satisfies PairingResponse, {
		status: 200,
		headers: { "set-cookie": setCookie },
	});
}

/**
 * The deployment's canonical origin, when one has been observed.
 *
 * Memoized per D1 binding with a short TTL: createAuth runs on every request
 * and the cookie cache exists precisely to remove a D1 read per request, so the
 * origin read must not add one back. A minute of staleness is harmless — the
 * value only moves when the operator re-points the domain, and a wrong guess
 * here fails closed (better-auth rejects cross-origin requests) rather than
 * open.
 */
const originCache = new WeakMap<D1Database, { origin: string | null; readAt: number }>();
const ORIGIN_CACHE_TTL_MS = 60_000;

/**
 * Sets the first factor for an owner who does not have one yet.
 *
 * better-auth exposes this server-side only, and only for a user with no
 * credential account -- which is exactly the shape of an owner whose row was
 * created by an email OTP or a pairing code. It is the bridge between the ladder
 * that bootstraps a deployment and the password that makes daily sign-in a single
 * autofill.
 *
 * Reachable only from behind requireAuth (hono.ts registers it under /api/*), so
 * the session it acts on is already an owner's. Changing an existing password is
 * deliberately NOT here: better-auth wants the current one for that, and the way
 * back from a forgotten password is the reset mail, not a second setter.
 */
export async function handleSetPasswordRequest(request: Request, env: AuthEnv): Promise<Response> {
	let newPassword: string | null = null;
	try {
		const body = (await request.json()) as { newPassword?: unknown };
		if (typeof body.newPassword === "string") newPassword = body.newPassword;
	} catch {
		return Response.json({ ok: false, reason: "invalid_body" }, { status: 400 });
	}
	if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
		return Response.json(
			{ ok: false, reason: "too_short", minLength: MIN_PASSWORD_LENGTH },
			{ status: 400 },
		);
	}
	const auth = await createAuth(env, { request });
	try {
		await auth.api.setPassword({ body: { newPassword }, headers: request.headers });
	} catch {
		// The common cause is a credential account that already exists; better-auth
		// refuses to overwrite one here, and the honest answer is the reset flow
		// rather than a second path that writes passwords.
		return Response.json({ ok: false, reason: "already_set" }, { status: 409 });
	}
	return Response.json({ ok: true });
}

export async function getDeploymentOriginForAuth(db: D1Database): Promise<string | null> {
	const cached = originCache.get(db);
	if (cached && Date.now() - cached.readAt < ORIGIN_CACHE_TTL_MS) {
		return cached.origin;
	}
	const origin = await getRuntimeConfig(db, RUNTIME_CONFIG_KEYS.deploymentOrigin).catch(() => null);
	originCache.set(db, { origin, readAt: Date.now() });
	return origin;
}
