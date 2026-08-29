import { afterEach, describe, expect, it, vi } from "vitest";
import { recordDeploymentOrigin } from "#/db/runtime-config";
import { deriveWebhookSecret, deriveWebhookSecretFingerprint } from "#/telegram/api";
import { TELEGRAM_COMMANDS } from "#/telegram/commands";
import { reconcileTelegramWebhook } from "#/telegram/registration";
import { getTelegramStatus } from "#/telegram/status";

type RecordedCall = { sql: string; args: unknown[] };

/**
 * D1 stand-in that answers runtime_config reads from a plain map, so a test can
 * say "this deployment knows its origin" without a real database.
 */
function createMockDb(rows: Record<string, string> = {}): {
	prepare: ReturnType<typeof vi.fn>;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const prepare = vi.fn((sql: string) => ({
		bind: (...args: unknown[]) => {
			calls.push({ sql, args });
			return {
				run: vi.fn().mockResolvedValue(undefined),
				first: vi
					.fn()
					.mockResolvedValue(
						sql.includes("SELECT value FROM runtime_config")
							? rows[String(args[0])] !== undefined
								? { value: rows[String(args[0])] }
								: null
							: null,
					),
			};
		},
	}));
	return { prepare, calls };
}

function buildEnv(db: { prepare: ReturnType<typeof vi.fn> }, overrides: Partial<Env> = {}): Env {
	return {
		INDEX_DB: { prepare: db.prepare },
		TELEGRAM_BOT_TOKEN: "123:bot-token",
		TELEGRAM_ALLOWED_USER_IDS: "1",
		...overrides,
	} as unknown as Env;
}

type WebhookInfoStub = {
	url: string;
	last_error_date?: number;
	last_error_message?: string;
	pending_update_count?: number;
	allowed_updates?: string[];
};

/**
 * Captures Bot API calls and answers getWebhookInfo with a chosen WebhookInfo.
 *
 * getMyCommands answers with the menu this build wants unless a test says
 * otherwise, so "nothing to do" stays the default and a test about the webhook is
 * not also a test about the menu.
 */
function stubTelegram(
	info: WebhookInfoStub,
	options: { setWebhookFails?: boolean; liveCommands?: unknown } = {},
): Array<{ method: string; body: Record<string, unknown> }> {
	const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const method = String(input).split("/").pop() ?? "";
		calls.push({ method, body: JSON.parse(String(init?.body ?? "{}")) });
		if (method === "getWebhookInfo") {
			return Response.json({ ok: true, result: info });
		}
		if (method === "getMyCommands") {
			return Response.json({ ok: true, result: options.liveCommands ?? TELEGRAM_COMMANDS });
		}
		if (method === "setWebhook" && options.setWebhookFails) {
			return Response.json({ ok: false, error_code: 400, description: "bad webhook" });
		}
		return Response.json({ ok: true, result: true });
	});
	return calls;
}

const WEBHOOK_URL = "https://reccado.example/telegram/webhook";
const REGISTERED_AT = "2026-01-01T00:00:00.000Z";
/** Telegram reports error dates in epoch seconds, so the fixtures do too. */
const ERROR_BEFORE_REGISTRATION = Date.parse(REGISTERED_AT) / 1000 - 3600;
const ERROR_AFTER_REGISTRATION = Date.parse(REGISTERED_AT) / 1000 + 3600;

async function registrationRow(
	overrides: Partial<{ fingerprint: string; registeredAt: string; url: string }> = {},
): Promise<string> {
	return JSON.stringify({
		fingerprint: await deriveWebhookSecretFingerprint("123:bot-token"),
		registeredAt: REGISTERED_AT,
		url: WEBHOOK_URL,
		...overrides,
	});
}

/** The JSON values written to one runtime_config key, in write order. */
function writesFor(db: { calls: RecordedCall[] }, key: string): string[] {
	return db.calls
		.filter((call) => call.sql.includes("INSERT INTO runtime_config") && call.args[0] === key)
		.map((call) => String(call.args[1]));
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("telegram webhook reconciliation", () => {
	it("stays out of the way when the bridge is off", async () => {
		const db = createMockDb();
		const result = await reconcileTelegramWebhook(buildEnv(db, { TELEGRAM_BOT_TOKEN: undefined }));
		expect(result).toEqual({ status: "skipped", reason: "bridge_disabled" });
	});

	// It used to skip with "config_invalid" here, which was self-defeating once
	// pairing moved into the bot: /start is how an account becomes an operator, and
	// /start only arrives through a registered webhook. Refusing to register until
	// somebody is linked meant nobody ever could be.
	it("reconciles a bridge that has no operator yet, because that is how one is linked", async () => {
		const db = createMockDb({ "deployment.origin": "https://reccado.example" });
		const calls = stubTelegram({ url: "https://stale.example/telegram/webhook" });
		const result = await reconcileTelegramWebhook(buildEnv(db, { TELEGRAM_ALLOWED_USER_IDS: "" }));
		expect(result).toMatchObject({ status: "registered", url: WEBHOOK_URL });
		expect(calls.map((call) => call.method)).toContain("setWebhook");
	});

	it("waits rather than guessing when the origin has never been observed", async () => {
		const db = createMockDb();
		const result = await reconcileTelegramWebhook(buildEnv(db));
		expect(result).toEqual({ status: "skipped", reason: "origin_unknown" });
	});

	it("leaves a correctly registered webhook alone", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		const calls = stubTelegram({ url: WEBHOOK_URL });
		const result = await reconcileTelegramWebhook(buildEnv(db));
		expect(result).toEqual({ status: "ok", url: WEBHOOK_URL });
		expect(calls.map((call) => call.method)).toEqual(["getMyCommands", "getWebhookInfo"]);
	});

	// The blind spot this closes: allowed_updates is not part of the secret and not
	// part of the URL, so a build that starts handling a new update kind leaves every
	// existing deployment subscribed to the old list — right URL, right secret,
	// "ok" forever, and updates Telegram simply never sends.
	it("re-registers when the live subscription is missing an update kind", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		const calls = stubTelegram({
			url: WEBHOOK_URL,
			allowed_updates: ["message", "callback_query"],
		});
		const result = await reconcileTelegramWebhook(buildEnv(db));
		expect(result).toMatchObject({ status: "registered", cause: "allowed_updates_drift" });
		expect(calls.find((call) => call.method === "setWebhook")?.body.allowed_updates).toContain(
			"edited_message",
		);
	});

	// Absent means Telegram's own default, which already covers everything we ask
	// for. Reading that as drift would re-register on every single hourly pass.
	it("reads an absent allowed_updates as agreement, not as drift", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		stubTelegram({ url: WEBHOOK_URL });
		expect(await reconcileTelegramWebhook(buildEnv(db))).toEqual({
			status: "ok",
			url: WEBHOOK_URL,
		});
	});

	it("repairs the / menu when Telegram is showing an older vocabulary", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		const calls = stubTelegram({ url: WEBHOOK_URL }, { liveCommands: [] });
		await reconcileTelegramWebhook(buildEnv(db));
		const commands = calls.find((call) => call.method === "setMyCommands")?.body.commands;
		expect(JSON.stringify(commands)).toContain("buscar");
	});

	it("re-registers a drifted webhook with the derived secret", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow({
				url: "https://stale.example/telegram/webhook",
			}),
		});
		const calls = stubTelegram({ url: "https://stale.example/telegram/webhook" });
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toMatchObject({
			status: "registered",
			url: WEBHOOK_URL,
			previousUrl: "https://stale.example/telegram/webhook",
			cause: "url_drift",
		});
		const setCall = calls.find((call) => call.method === "setWebhook");
		expect(setCall?.body.url).toBe(WEBHOOK_URL);
		// Nobody configured this value; it is recomputable from the bot token alone,
		// which is what lets the cron heal a registration with no stored state.
		expect(setCall?.body.secret_token).toBe(await deriveWebhookSecret("123:bot-token"));
	});

	// The blind spot itself: the URL matched, so the old cron reported ok forever
	// while every update was answered 401 by a webhook registered with a secret
	// nobody could still derive. Any deployment already in that state has no
	// registration record, which is exactly what makes it repairable.
	it("re-registers when the url matches but no registration was ever recorded", async () => {
		const db = createMockDb({ "deployment.origin": "https://reccado.example" });
		const calls = stubTelegram({ url: WEBHOOK_URL });
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toMatchObject({
			status: "registered",
			url: WEBHOOK_URL,
			cause: "registration_unrecorded",
		});
		expect(calls.map((call) => call.method)).toContain("setWebhook");
		expect(JSON.parse(writesFor(db, "telegram.webhook_registration")[0] ?? "{}")).toMatchObject({
			fingerprint: await deriveWebhookSecretFingerprint("123:bot-token"),
			url: WEBHOOK_URL,
		});
	});

	it("re-registers when the recorded fingerprint no longer matches the bot token", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow({
				fingerprint: await deriveWebhookSecretFingerprint("999:rotated-token"),
			}),
		});
		const calls = stubTelegram({ url: WEBHOOK_URL });
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toMatchObject({ status: "registered", cause: "secret_rotated" });
		const setCall = calls.find((call) => call.method === "setWebhook");
		expect(setCall?.body.secret_token).toBe(await deriveWebhookSecret("123:bot-token"));
	});

	it("ignores a delivery error that predates the registration that fixed it", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		const calls = stubTelegram({
			url: WEBHOOK_URL,
			last_error_date: ERROR_BEFORE_REGISTRATION,
			last_error_message: "Wrong response from the webhook: 401 Unauthorized",
		});
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toEqual({ status: "ok", url: WEBHOOK_URL });
		expect(calls.map((call) => call.method)).toEqual(["getMyCommands", "getWebhookInfo"]);
	});

	// The message is deliberately nonsense: only the date is compared, so a
	// reworded Telegram error can never turn self-healing off.
	it("re-registers on a delivery error newer than the registration, whatever it says", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		stubTelegram({
			url: WEBHOOK_URL,
			last_error_date: ERROR_AFTER_REGISTRATION,
			last_error_message: "banana",
		});
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toMatchObject({ status: "registered", cause: "delivery_errors" });
	});

	// Recording a registration that never happened would recreate the blind spot
	// with our own hands, so the write only follows a setWebhook that succeeded.
	it("does not record a registration when setWebhook fails", async () => {
		const db = createMockDb({ "deployment.origin": "https://reccado.example" });
		stubTelegram({ url: "https://stale.example/telegram/webhook" }, { setWebhookFails: true });
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toMatchObject({ status: "failed" });
		expect(writesFor(db, "telegram.webhook_registration")).toEqual([]);
	});

	it("records what Telegram observed even on a pass where nothing was wrong", async () => {
		const db = createMockDb({
			"deployment.origin": "https://reccado.example",
			"telegram.webhook_registration": await registrationRow(),
		});
		stubTelegram({ url: WEBHOOK_URL, pending_update_count: 7 });
		const result = await reconcileTelegramWebhook(buildEnv(db));

		expect(result).toEqual({ status: "ok", url: WEBHOOK_URL });
		const observations = writesFor(db, "telegram.webhook_observation");
		expect(observations).toHaveLength(1);
		expect(JSON.parse(observations[0] ?? "{}")).toMatchObject({
			url: WEBHOOK_URL,
			lastErrorAt: null,
			lastErrorMessage: null,
			pendingUpdateCount: 7,
		});
	});

	it("reports a Telegram failure instead of aborting the rest of the sweep", async () => {
		const db = createMockDb({ "deployment.origin": "https://reccado.example" });
		vi.stubGlobal("fetch", async () =>
			Response.json({ ok: false, error_code: 401, description: "Unauthorized" }),
		);
		const result = await reconcileTelegramWebhook(buildEnv(db));
		expect(result).toMatchObject({ status: "failed" });
	});
});

describe("telegram status", () => {
	function observationRow(
		overrides: Partial<{
			url: string;
			lastErrorAt: string | null;
			lastErrorMessage: string | null;
			pendingUpdateCount: number;
			observedAt: string;
		}> = {},
	): string {
		return JSON.stringify({
			url: WEBHOOK_URL,
			lastErrorAt: null,
			lastErrorMessage: null,
			pendingUpdateCount: 0,
			observedAt: "2026-01-02T00:00:00.000Z",
			...overrides,
		});
	}

	const configuredRows = {
		"deployment.origin": "https://reccado.example",
		"telegram.chat_id": "-1001",
	};

	it("reports failing when Telegram's last error is newer than the registration", async () => {
		const db = createMockDb({
			...configuredRows,
			"telegram.webhook_registration": await registrationRow(),
			"telegram.webhook_observation": observationRow({
				lastErrorAt: new Date(ERROR_AFTER_REGISTRATION * 1000).toISOString(),
				lastErrorMessage: "banana",
				pendingUpdateCount: 42,
			}),
		});
		const status = await getTelegramStatus(buildEnv(db));

		expect(status.mode).toBe("failing");
		expect(status.ok).toBe(false);
		expect(status.pendingUpdateCount).toBe(42);
		expect(status.reason).toContain("banana");
		expect(status.reason).toContain(new Date(ERROR_AFTER_REGISTRATION * 1000).toISOString());
	});

	it("stays on when the observed error predates the registration that fixed it", async () => {
		const db = createMockDb({
			...configuredRows,
			"telegram.webhook_registration": await registrationRow(),
			"telegram.webhook_observation": observationRow({
				lastErrorAt: new Date(ERROR_BEFORE_REGISTRATION * 1000).toISOString(),
				lastErrorMessage: "Wrong response from the webhook: 401 Unauthorized",
			}),
		});
		const status = await getTelegramStatus(buildEnv(db));

		expect(status.mode).toBe("on");
		expect(status.ok).toBe(true);
		expect(status.reason).toBeNull();
	});

	// A deployment whose cron has not run yet knows nothing, which is not the same
	// as knowing something is wrong.
	it("stays on when no observation has been recorded yet", async () => {
		const db = createMockDb({
			...configuredRows,
			"telegram.webhook_registration": await registrationRow(),
		});
		const status = await getTelegramStatus(buildEnv(db));

		expect(status).toMatchObject({ mode: "on", ok: true, pendingUpdateCount: null });
	});

	it("never calls Telegram, so a Bot API outage cannot degrade /api/health", async () => {
		const fetchSpy = vi.fn(async () => Response.json({ ok: true, result: {} }));
		vi.stubGlobal("fetch", fetchSpy);
		const db = createMockDb({
			...configuredRows,
			"telegram.webhook_registration": await registrationRow(),
			"telegram.webhook_observation": observationRow(),
		});
		await getTelegramStatus(buildEnv(db));
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("deployment origin", () => {
	it("records the origin of an authenticated https request", async () => {
		const db = createMockDb();
		await recordDeploymentOrigin(
			{ prepare: db.prepare } as unknown as D1Database,
			"https://reccado.example/api/mailboxes",
		);
		const write = db.calls.find((call) => call.sql.includes("INSERT INTO runtime_config"));
		expect(write?.args.slice(0, 2)).toEqual(["deployment.origin", "https://reccado.example"]);
	});

	it("ignores localhost, so a dev session cannot point production at itself", async () => {
		const db = createMockDb();
		await recordDeploymentOrigin(
			{ prepare: db.prepare } as unknown as D1Database,
			"https://localhost:3000/api/mailboxes",
		);
		expect(db.calls.filter((call) => call.sql.includes("INSERT INTO runtime_config"))).toHaveLength(
			0,
		);
	});

	it("ignores plain http", async () => {
		const db = createMockDb();
		await recordDeploymentOrigin(
			{ prepare: db.prepare } as unknown as D1Database,
			"http://reccado.example/api/mailboxes",
		);
		expect(db.calls.filter((call) => call.sql.includes("INSERT INTO runtime_config"))).toHaveLength(
			0,
		);
	});
});
