import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAuthRequest, handleSetPasswordRequest, PASSKEY_STEPUP_HEADER } from "#/api/better-auth";
import type { AuthMailSender } from "#/lib/better-auth";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationPasskey from "../../migrations/d1/0024_passkey.sql?raw";
import { applyMigrations } from "../helpers/migrations";
import { SoftAuthenticator } from "../helpers/soft-authenticator";

const db = env.INDEX_DB;
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const ORIGIN = "https://example.com";

beforeAll(async () => {
	await applyMigrations(
		db,
		migrationMessageIndex,
		migrationRuntimeConfig,
		migrationOwnerRegistry,
		migrationBetterAuth,
		migrationBetterAuthMcp,
		migrationTwoFactor,
		migrationAuthUpgrade,
		migrationPasskey,
	);
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.bind(ORIGIN, now)
		.run();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function authEnv(overrides: Partial<Env> = {}): Env {
	return { ...env, BETTER_AUTH_SECRET: TEST_SECRET, ...overrides } as Env;
}

function stubMail(): AuthMailSender & { calls: Array<{ to: string; text: string }> } {
	const calls: Array<{ to: string; text: string }> = [];
	return {
		calls,
		async sendMail(message: { to: string; text: string }) {
			calls.push({ to: message.to, text: message.text });
		},
	} as AuthMailSender & { calls: Array<{ to: string; text: string }> };
}

class Jar {
	private readonly cookies = new Map<string, string>();

	absorb(response: Response): void {
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(";")[0] ?? "";
			const eq = pair.indexOf("=");
			if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}

	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

async function authFetch(
	jar: Jar,
	path: string,
	init: RequestInit = {},
	mail?: AuthMailSender,
	overrides: Partial<Env> = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (!headers.has("origin")) headers.set("origin", ORIGIN);
	const cookie = jar.header();
	if (cookie) headers.set("cookie", cookie);
	const response = await handleAuthRequest(new Request(`${ORIGIN}${path}`, { ...init, headers }), authEnv(overrides), {
		mailSender: mail,
	});
	jar.absorb(response);
	return response;
}

async function pair(email: string): Promise<Jar> {
	const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
		)
		.bind(code, now, new Date(Date.now() + 60 * 60 * 1000).toISOString())
		.run();
	const jar = new Jar();
	const response = await authFetch(jar, "/api/auth/pairing", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, code }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
	return jar;
}

function jsonInit(body: unknown, extra?: HeadersInit): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(extra)) },
		body: JSON.stringify(body),
	};
}

async function registerWithProof(jar: Jar, proof: string, overrides: Partial<Env> = {}): Promise<Response> {
	const optionsResponse = await authFetch(
		jar,
		"/api/auth/passkey/generate-register-options",
		{ headers: { [PASSKEY_STEPUP_HEADER]: proof } },
		undefined,
		overrides,
	);
	expect(optionsResponse.status, await optionsResponse.clone().text()).toBe(200);
	const options = (await optionsResponse.json()) as { challenge: string; rp: { id: string } };
	const authenticator = new SoftAuthenticator(options.rp.id, ORIGIN);
	const credential = await authenticator.registration(options.challenge);
	return authFetch(
		jar,
		"/api/auth/passkey/verify-registration",
		jsonInit({ response: credential, name: "Test key" }, { [PASSKEY_STEPUP_HEADER]: proof }),
		undefined,
		overrides,
	);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array {
	const clean = input.replace(/=+$/, "").toUpperCase();
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of clean) {
		const index = BASE32.indexOf(char);
		if (index < 0) throw new Error(`bad base32 ${char}`);
		value = (value << 5) | index;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			out.push((value >>> bits) & 0xff);
		}
	}
	const buffer = new ArrayBuffer(out.length);
	new Uint8Array(buffer).set(out);
	return new Uint8Array(buffer);
}

async function totp(secret: Uint8Array, at = Date.now()): Promise<string> {
	const counter = Math.floor(at / 30_000);
	const buffer = new ArrayBuffer(8);
	new DataView(buffer).setBigUint64(0, BigInt(counter), false);
	const raw = new ArrayBuffer(secret.byteLength);
	const view = new Uint8Array(raw);
	for (let i = 0; i < secret.length; i++) view[i] = secret[i] ?? 0;
	const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, buffer));
	const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
	const binary =
		(((mac[offset] ?? 0) & 0x7f) << 24) |
		((mac[offset + 1] ?? 0) << 16) |
		((mac[offset + 2] ?? 0) << 8) |
		(mac[offset + 3] ?? 0);
	return String(binary % 1_000_000).padStart(6, "0");
}

describe("passkey registration step-up", () => {
	it("refuses both registration endpoints without a proof, including right after pairing", async () => {
		const anonOptions = await authFetch(new Jar(), "/api/auth/passkey/generate-register-options");
		expect(anonOptions.status).toBe(401);
		const anonVerify = await authFetch(
			new Jar(),
			"/api/auth/passkey/verify-registration",
			jsonInit({ response: {} }),
		);
		expect(anonVerify.status).toBe(401);

		const jar = await pair("paired-only@example.com");
		const options = await authFetch(jar, "/api/auth/passkey/generate-register-options");
		expect(options.status).toBe(403);
		expect(await options.json()).toEqual({ error: "passkey_stepup_required" });
		const verify = await authFetch(jar, "/api/auth/passkey/verify-registration", jsonInit({ response: {} }));
		expect(verify.status).toBe(403);
		expect(await verify.json()).toEqual({ error: "passkey_stepup_required" });
	});

	it("accepts one email-OTP proof and refuses a replay", async () => {
		const jar = await pair("email-stepup@example.com");
		const mail = stubMail();
		const started = await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({}), mail);
		expect(started.status, await started.clone().text()).toBe(200);
		expect(await started.json()).toEqual({ method: "email" });
		expect(mail.calls).toHaveLength(1);
		expect(mail.calls[0]?.to).toBe("email-stepup@example.com");
		const code = mail.calls[0]?.text.match(/\b(\d{6})\b/)?.[1];
		expect(code).toMatch(/^\d{6}$/);

		const issued = await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({ code }));
		expect(issued.status, await issued.clone().text()).toBe(200);
		const { proof } = (await issued.json()) as { proof: string };
		expect(proof.length).toBeGreaterThan(20);

		const spentCode = await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({ code }));
		expect(spentCode.status).toBe(401);

		const registered = await registerWithProof(jar, proof);
		expect(registered.status, await registered.clone().text()).toBe(200);
		const added = await db
			.prepare("SELECT event_type FROM ops_events WHERE event_type = 'passkey.added' AND subject = ?")
			.bind("email-stepup@example.com")
			.all();
		expect(added.results.length).toBeGreaterThan(0);

		const replay = await authFetch(
			jar,
			"/api/auth/passkey/verify-registration",
			jsonInit({ response: {} }, { [PASSKEY_STEPUP_HEADER]: proof }),
		);
		expect(replay.status).toBe(403);
		expect(await replay.json()).toEqual({ error: "passkey_stepup_required" });
	});

	it("refuses an expired proof and a proof from another session", async () => {
		const jar = await pair("expiry-stepup@example.com");
		const mail = stubMail();
		await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({}), mail);
		const code = mail.calls[0]?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
		const issued = await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({ code }));
		const { proof } = (await issued.json()) as { proof: string };
		const session = await db
			.prepare('SELECT id FROM "session" ORDER BY createdAt DESC LIMIT 1')
			.first<{ id: string }>();
		await db
			.prepare('UPDATE "verification" SET expiresAt = ? WHERE identifier = ?')
			.bind(Date.now() - 1000, `passkey-stepup:${session?.id}`)
			.run();
		const expired = await authFetch(jar, "/api/auth/passkey/generate-register-options", {
			headers: { [PASSKEY_STEPUP_HEADER]: proof },
		});
		expect(expired.status).toBe(403);

		const other = await pair("other-session@example.com");
		const otherMail = stubMail();
		await authFetch(other, "/api/auth/passkey/step-up", jsonInit({}), otherMail);
		const otherCode = otherMail.calls[0]?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
		const proper = await authFetch(other, "/api/auth/passkey/step-up", jsonInit({ code: otherCode }));
		expect(proper.status, await proper.clone().text()).toBe(200);
		const { proof: otherProof } = (await proper.json()) as { proof: string };
		const crossed = await authFetch(jar, "/api/auth/passkey/generate-register-options", {
			headers: { [PASSKEY_STEPUP_HEADER]: otherProof },
		});
		expect(crossed.status).toBe(403);
	});

	it("accepts one TOTP proof when two-factor is on, then notifies on add and on removal", async () => {
		const email = "totp-stepup@example.com";
		const jar = await pair(email);
		const password = await handleSetPasswordRequest(
			new Request(`${ORIGIN}/api/account/password`, jsonInit({ newPassword: "correct-horse-battery" }, { cookie: jar.header(), origin: ORIGIN })),
			authEnv(),
		);
		expect(password.status, await password.clone().text()).toBe(200);

		const enabled = await authFetch(jar, "/api/auth/two-factor/enable", jsonInit({ password: "correct-horse-battery" }));
		expect(enabled.status, await enabled.clone().text()).toBe(200);
		const { totpURI } = (await enabled.json()) as { totpURI: string };
		const secret = new URL(totpURI).searchParams.get("secret");
		expect(secret).toBeTruthy();
		const enrolCode = await totp(base32Decode(secret ?? ""));
		const enrolled = await authFetch(jar, "/api/auth/two-factor/verify-totp", jsonInit({ code: enrolCode, trustDevice: false }));
		expect(enrolled.status, await enrolled.clone().text()).toBe(200);

		const method = await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({}));
		expect(await method.json()).toEqual({ method: "totp" });
		const stepCode = await totp(base32Decode(secret ?? ""));
		const issued = await authFetch(jar, "/api/auth/passkey/step-up", jsonInit({ code: stepCode }));
		expect(issued.status, await issued.clone().text()).toBe(200);
		const { proof } = (await issued.json()) as { proof: string };

		const calls: Array<{ method: string; body: { text?: string } }> = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (!url.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
			calls.push({ method: url.split("/").pop() ?? "", body: JSON.parse(String(init?.body ?? "{}")) });
			return Response.json({ ok: true, result: { message_id: calls.length, chat: { id: 4242, type: "private" } } });
		});
		const now = new Date().toISOString();
		await db
			.prepare(
				"INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', '4242', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.bind(now)
			.run();
		const telegram = { TELEGRAM_BOT_TOKEN: "123:fake-token" } as Partial<Env>;

		const registered = await registerWithProof(jar, proof, telegram);
		expect(registered.status, await registered.clone().text()).toBe(200);
		expect(calls.some((call) => call.method === "sendMessage" && call.body.text?.includes("registrado"))).toBe(true);
		const replay = await authFetch(jar, "/api/auth/passkey/generate-register-options", {
			headers: { [PASSKEY_STEPUP_HEADER]: proof },
		});
		expect(replay.status).toBe(403);

		const listed = await authFetch(jar, "/api/auth/passkey/list-user-passkeys");
		expect(listed.status, await listed.clone().text()).toBe(200);
		const passkeys = (await listed.json()) as Array<{ id: string }>;
		expect(passkeys.length).toBeGreaterThan(0);
		const removed = await authFetch(
			jar,
			"/api/auth/passkey/delete-passkey",
			jsonInit({ id: passkeys[0]?.id }),
			undefined,
			telegram,
		);
		expect(removed.status, await removed.clone().text()).toBe(200);
		expect(calls.some((call) => call.method === "sendMessage" && call.body.text?.includes("eliminado"))).toBe(true);
		const removedEvent = await db
			.prepare("SELECT event_type FROM ops_events WHERE event_type = 'passkey.removed' AND subject = ?")
			.bind(email)
			.all();
		expect(removedEvent.results.length).toBeGreaterThan(0);
	});
});

describe("passkey step-up attempt limits", () => {
	async function stepUp(jar: Jar, body: unknown, mail?: AuthMailSender, overrides: Partial<Env> = {}) {
		return authFetch(jar, "/api/auth/passkey/step-up", jsonInit(body), mail, overrides);
	}

	it("locks the e-mail OTP after 5 bad codes, invalidates the pending code and notifies", async () => {
		const email = "lock-email@example.com";
		const jar = await pair(email);
		const mail = stubMail();
		await stepUp(jar, {}, mail);
		const goodCode = mail.calls[0]?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
		const bad = goodCode === "000000" ? "111111" : "000000";

		const calls: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			const url = String(input);
			if (!url.startsWith("https://api.telegram.org/")) throw new Error(`unexpected fetch ${url}`);
			calls.push(url.split("/").pop() ?? "");
			return Response.json({ ok: true, result: { message_id: 1, chat: { id: 4242, type: "private" } } });
		});
		await db
			.prepare(
				"INSERT INTO runtime_config (key, value, updated_at) VALUES ('telegram.chat_id', '4242', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.bind(new Date().toISOString())
			.run();
		const telegram = { TELEGRAM_BOT_TOKEN: "123:fake-token" } as Partial<Env>;

		for (let i = 0; i < 5; i++) {
			const failed = await stepUp(jar, { code: bad }, mail, telegram);
			expect(failed.status).toBe(401);
		}
		expect(calls).toContain("sendMessage");
		const event = await db
			.prepare("SELECT event_type FROM ops_events WHERE event_type = 'passkey.stepup_locked' AND subject = ?")
			.bind(email)
			.all();
		expect(event.results).toHaveLength(1);

		// Even the right code is refused now, and the pending OTP is gone.
		const locked = await stepUp(jar, { code: goodCode }, mail, telegram);
		expect(locked.status).toBe(429);
		expect(await locked.json()).toMatchObject({ error: "stepup_locked" });
		const refreshed = await stepUp(jar, {}, mail, telegram);
		expect(refreshed.status).toBe(429);
		expect(mail.calls).toHaveLength(1);
	});

	it("locks TOTP step-up after 5 bad codes", async () => {
		const jar = await pair("lock-totp@example.com");
		await handleSetPasswordRequest(
			new Request(`${ORIGIN}/api/account/password`, jsonInit({ newPassword: "correct-horse-battery" }, { cookie: jar.header(), origin: ORIGIN })),
			authEnv(),
		);
		const enabled = await authFetch(jar, "/api/auth/two-factor/enable", jsonInit({ password: "correct-horse-battery" }));
		const { totpURI } = (await enabled.json()) as { totpURI: string };
		const secret = base32Decode(new URL(totpURI).searchParams.get("secret") ?? "");
		await authFetch(jar, "/api/auth/two-factor/verify-totp", jsonInit({ code: await totp(secret), trustDevice: false }));

		const good = await totp(secret);
		const bad = good === "000000" ? "111111" : "000000";
		for (let i = 0; i < 5; i++) {
			expect((await stepUp(jar, { code: bad })).status).toBe(401);
		}
		const locked = await stepUp(jar, { code: good });
		expect(locked.status).toBe(429);
	});

	it("allows 3 OTP e-mail requests per session per window, then rate limits", async () => {
		const jar = await pair("rate-otp@example.com");
		const mail = stubMail();
		for (let i = 0; i < 3; i++) expect((await stepUp(jar, {}, mail)).status).toBe(200);
		const limited = await stepUp(jar, {}, mail);
		expect(limited.status).toBe(429);
		expect(await limited.json()).toMatchObject({ error: "stepup_rate_limited" });
		expect(mail.calls).toHaveLength(3);
	});

	it("a correct code resets the failure counter", async () => {
		const jar = await pair("reset-count@example.com");
		const mail = stubMail();
		await stepUp(jar, {}, mail);
		const code = mail.calls[0]?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
		const bad = code === "000000" ? "111111" : "000000";
		for (let i = 0; i < 4; i++) expect((await stepUp(jar, { code: bad }, mail)).status).toBe(401);
		expect((await stepUp(jar, { code }, mail)).status).toBe(200);
	});
});
