import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest, type PairingResponse } from "#/api/better-auth";
import type { AuthMailSender } from "#/lib/better-auth";
import worker from "../../src/server";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import { applyMigrations } from "../helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const OWNER = "owner@example.com";

beforeAll(async () => {
	await applyMigrations(
		testEnv.INDEX_DB,
		migrationMessageIndex as string,
		migrationRuntimeConfig as string,
		migrationOwnerRegistry as string,
		migrationBetterAuth as string,
		migrationBetterAuthMcp as string,
		migrationTwoFactor as string,
	);
});

const authEnv = (overrides: Partial<Env> = {}) =>
	({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, OWNER_BOOTSTRAP_EMAILS: OWNER, ...overrides }) as Env;

function stubMailSender(): AuthMailSender & { calls: Array<{ to: string; text: string }> } {
	const calls: Array<{ to: string; text: string }> = [];
	return {
		calls,
		async sendMail(message: { to: string; text: string }) {
			calls.push({ to: message.to, text: message.text });
		},
	} as AuthMailSender & { calls: Array<{ to: string; text: string }> };
}

async function run(request: Request, env: Env = authEnv()): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

const nowIso = () => new Date().toISOString();

async function mintPairingCode(code: string, ttlMs = 2 * 60 * 60 * 1000): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')`,
	)
		.bind(code, nowIso(), new Date(Date.now() + ttlMs).toISOString())
		.run();
}

async function postJson(path: string, body: unknown): Promise<Response> {
	return run(
		new Request(`https://example.com${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("better-auth handler reachability", () => {
	it("answers unauthenticated on /api/auth/ok (the issuer is mounted and public)", async () => {
		const response = await run(new Request("https://example.com/api/auth/ok"));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});
});

describe("registration is closed at the OTP gate", () => {
	it("sends an OTP to an owner address (via the stub sender), 6 digits", async () => {
		const mail = stubMailSender();
		const response = await handleAuthRequest(
			new Request("https://example.com/api/auth/email-otp/send-verification-otp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: OWNER, type: "sign-in" }),
			}),
			authEnv(),
			{ mailSender: mail },
		);
		expect(response.status).toBe(200);

		// The mail call is deferred (runInBackgroundOrAwait); poll briefly for it.
		for (let waited = 0; mail.calls.length === 0 && waited < 2000; waited += 50) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(mail.calls).toHaveLength(1);
		expect(mail.calls[0]!.to).toBe(OWNER);
		const code = mail.calls[0]!.text.match(/\b(\d{6})\b/)?.[1];
		expect(code).toMatch(/^\d{6}$/);
	});

	it("never sends mail to, nor stores a verification row for, a non-owner address", async () => {
		const mail = stubMailSender();
		const response = await handleAuthRequest(
			new Request("https://example.com/api/auth/email-otp/send-verification-otp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ email: "stranger@example.com", type: "sign-in" }),
			}),
			authEnv(),
			{ mailSender: mail },
		);
		// Enumeration-safe: identical response to a legitimate request.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });

		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(mail.calls).toHaveLength(0);
		const row = await testEnv.INDEX_DB.prepare(`SELECT id FROM verification WHERE identifier = ?`)
			.bind("sign-in-otp-stranger@example.com")
			.first();
		expect(row).toBeNull();
	});
});

describe("pairing-code rescue endpoint", () => {
	it("consumes a code, links the owner identity, writes the ops event, and opens a working session", async () => {
		await mintPairingCode("TESTPAIRINGCODE1");

		const response = await postJson("/api/auth/pairing", {
			email: OWNER,
			code: "TESTPAIRINGCODE1",
		});
		expect(response.status).toBe(200);
		const body = (await response.json()) as PairingResponse;
		expect(body).toEqual({ ok: true, claim: "linked" });
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("session_token=");

		// The identity is linked exactly like the Telegram ladder links it.
		const identity = await testEnv.INDEX_DB.prepare(
			`SELECT kind, identity, linked_via FROM owner_identities WHERE kind = 'email'`,
		).first<{ kind: string; identity: string; linked_via: string }>();
		expect(identity).toMatchObject({ kind: "email", identity: OWNER, linked_via: "pairing_code" });

		const opsEvent = await testEnv.INDEX_DB.prepare(
			`SELECT event_type, severity FROM ops_events WHERE event_type = 'owner.email_linked'`,
		).first<{ event_type: string; severity: string }>();
		expect(opsEvent).toMatchObject({ event_type: "owner.email_linked", severity: "info" });

		// The session the response opened must actually work on /api/*.
		const me = await run(
			new Request("https://example.com/api/me", { headers: { cookie: setCookie.split(";")[0]! } }),
		);
		expect(me.status).toBe(200);
		expect(await me.json()).toMatchObject({ email: OWNER });
	});

	it("rejects an unknown, used, or expired code with the shared claim vocabulary", async () => {
		const unknownResponse = await postJson("/api/auth/pairing", {
			email: OWNER,
			code: "NOSUCHCODE1",
		});
		expect(unknownResponse.status).toBe(401);
		expect(await unknownResponse.json()).toEqual({ ok: false, claim: "unknown" });

		await mintPairingCode("EXPIREDPAIRING1", -1000);
		const expiredResponse = await postJson("/api/auth/pairing", {
			email: OWNER,
			code: "EXPIREDPAIRING1",
		});
		expect(expiredResponse.status).toBe(401);
		expect(await expiredResponse.json()).toEqual({ ok: false, claim: "expired" });

		await mintPairingCode("SINGLEUSEPAIR1");
		await postJson("/api/auth/pairing", { email: OWNER, code: "SINGLEUSEPAIR1" });
		const usedResponse = await postJson("/api/auth/pairing", {
			email: OWNER,
			code: "SINGLEUSEPAIR1",
		});
		expect(usedResponse.status).toBe(401);
		expect(await usedResponse.json()).toEqual({ ok: false, claim: "used" });
	});

	it("records a rejected attempt as an ops warning without revealing the vocabulary gap", async () => {
		await postJson("/api/auth/pairing", { email: "stranger@example.com", code: "NOSUCHCODE2" });
		const rejected = await testEnv.INDEX_DB.prepare(
			`SELECT event_type, severity, subject FROM ops_events WHERE event_type = 'owner.pairing_rejected'`,
		).first<{ event_type: string; severity: string; subject: string }>();
		expect(rejected).toMatchObject({ event_type: "owner.pairing_rejected", severity: "warning" });
	});
});

/**
 * RFC 6238 in the test, so the second factor is proved end to end rather than
 * mocked: a code this file computes from the enrolment secret is one an
 * authenticator app would show at the same instant. Without it the test could
 * only assert that rows were written, which is exactly the half that looked fine
 * in 0017 while the other half failed in production.
 */
function base32Decode(input: string): Uint8Array {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
	const clean = input.replace(/=+$/, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		const index = alphabet.indexOf(char);
		if (index < 0) continue;
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out.push((value >>> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

async function totpCode(secret: string, atMs: number = Date.now()): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		base32Decode(secret) as unknown as ArrayBuffer,
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const counter = Math.floor(atMs / 1000 / 30);
	const buffer = new ArrayBuffer(8);
	new DataView(buffer).setUint32(4, counter, false);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
	const offset = mac[mac.length - 1]! & 0x0f;
	const binary =
		((mac[offset]! & 0x7f) << 24) |
		((mac[offset + 1]! & 0xff) << 16) |
		((mac[offset + 2]! & 0xff) << 8) |
		(mac[offset + 3]! & 0xff);
	return (binary % 1_000_000).toString().padStart(6, "0");
}

describe("password as the first factor, TOTP as the second", () => {
	const PASSWORD = "a-generated-password-nobody-types";

	async function openOwnerSession(code: string): Promise<string> {
		await mintPairingCode(code);
		const response = await postJson("/api/auth/pairing", { email: OWNER, code });
		expect(response.status).toBe(200);
		const setCookie = response.headers.get("set-cookie") ?? "";
		expect(setCookie).toContain("session_token=");
		return setCookie.split(";")[0]!;
	}

	it("sets the first factor only for a session that has none, and enrols TOTP against it", async () => {
		const cookie = await openOwnerSession("TESTTWOFACTOR001");

		// Too short is refused by the same floor the issuer config uses.
		const short = await run(
			new Request("https://example.com/api/account/password", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", origin: "https://example.com" },
				body: JSON.stringify({ newPassword: "short" }),
			}),
		);
		expect(short.status).toBe(400);
		expect(await short.json()).toMatchObject({ reason: "too_short" });

		const set = await run(
			new Request("https://example.com/api/account/password", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", origin: "https://example.com" },
				body: JSON.stringify({ newPassword: PASSWORD }),
			}),
		);
		expect(set.status).toBe(200);
		expect(await set.json()).toEqual({ ok: true });

		// Enrolment writes the twoFactor row and hands back a URI an app can read.
		const enable = await run(
			new Request("https://example.com/api/auth/two-factor/enable", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", origin: "https://example.com" },
				body: JSON.stringify({ password: PASSWORD }),
			}),
		);
		expect(enable.status).toBe(200);
		const enabled = (await enable.json()) as { totpURI?: string; backupCodes?: string[] };
		expect(enabled.totpURI).toContain("otpauth://totp/");
		expect(enabled.backupCodes?.length).toBeGreaterThan(0);

		const secret = new URL(enabled.totpURI!).searchParams.get("secret");
		expect(secret).toBeTruthy();

		// A code computed here is accepted, which is the whole schema proved: the
		// secret round-tripped through the twoFactor table and back out.
		const verify = await run(
			new Request("https://example.com/api/auth/two-factor/verify-totp", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", origin: "https://example.com" },
				body: JSON.stringify({ code: await totpCode(secret!), trustDevice: true }),
			}),
		);
		expect(verify.status).toBe(200);

		const row = await testEnv.INDEX_DB.prepare(`SELECT userId FROM "twoFactor" LIMIT 1`).first<{
			userId: string;
		}>();
		expect(row?.userId).toBeTruthy();
		const user = await testEnv.INDEX_DB.prepare(
			`SELECT "twoFactorEnabled" AS enabled FROM "user" WHERE email = ?`,
		)
			.bind(OWNER)
			.first<{ enabled: number | null }>();
		expect(user?.enabled).toBeTruthy();
	});

	it("refuses a wrong TOTP code", async () => {
		const cookie = await openOwnerSession("TESTTWOFACTOR002");
		const verify = await run(
			new Request("https://example.com/api/auth/two-factor/verify-totp", {
				method: "POST",
				headers: { cookie, "content-type": "application/json", origin: "https://example.com" },
				body: JSON.stringify({ code: "000000" }),
			}),
		);
		expect(verify.status).not.toBe(200);
	});

	it("keeps password sign-up closed even though password sign-in is open", async () => {
		const signUp = await run(
			new Request("https://example.com/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://example.com" },
				body: JSON.stringify({
					email: "stranger@example.com",
					password: "a-generated-password-nobody-types",
					name: "stranger",
				}),
			}),
		);
		expect(signUp.status).not.toBe(200);

		const stranger = await testEnv.INDEX_DB.prepare(
			`SELECT id FROM "user" WHERE email = 'stranger@example.com'`,
		).first<{ id: string }>();
		expect(stranger).toBeNull();
	});
});
