import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest, type PairingResponse } from "#/api/better-auth";
import type { AuthMailSender } from "#/lib/better-auth";
import worker from "../../src/server";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
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
