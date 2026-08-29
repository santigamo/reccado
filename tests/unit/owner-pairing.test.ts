import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { consumePairingCode, linkOwnerIdentity, readOwnerRegistry } from "#/db/owners";
import { ensureOwnerPairingCode, resolveTelegramOperators } from "#/telegram/operators";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

const testEnv = env as unknown as Env;

async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

beforeAll(async () => {
	// ops_events lives in 0001 and every pairing decision writes one.
	await applyMigration(migrationInitial as string);
	await applyMigration(migrationOwnerRegistry as string);
});

beforeEach(async () => {
	await testEnv.INDEX_DB.prepare("DELETE FROM owner_identities").run();
	await testEnv.INDEX_DB.prepare("DELETE FROM owner_pairing_codes").run();
});

function buildEnv(overrides: Partial<Env> = {}): Env {
	return { ...testEnv, TELEGRAM_BOT_TOKEN: "123:token", ...overrides } as Env;
}

/**
 * The exact statement an operator (or `pnpm doctor`) runs to read the live code.
 *
 * strftime rather than datetime: expires_at is stored as `new Date().toISOString()`
 * and the two formats differ in the eleventh character, where a space sorts below
 * a "T" -- so comparing against datetime('now') would report every code unexpired,
 * forever, which is the kind of bug that only shows up the day it matters.
 */
const DOCTOR_QUERY = `SELECT code, expires_at FROM owner_pairing_codes
   WHERE consumed_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
   ORDER BY created_at DESC LIMIT 1`;

describe("owner pairing bootstrap", () => {
	it("keeps a code alive while the bridge has no operator", async () => {
		const first = await ensureOwnerPairingCode(buildEnv());
		expect(first).toMatchObject({ status: "available", minted: true });

		// Idempotent per pass: the hourly cron must not stack up invitations.
		const second = await ensureOwnerPairingCode(buildEnv());
		expect(second).toMatchObject({ status: "available", minted: false });
		if (first.status !== "available" || second.status !== "available") return;
		expect(second.pairing.code).toBe(first.pairing.code);
	});

	it("mints nothing once an operator is declared", async () => {
		await linkOwnerIdentity(testEnv.INDEX_DB, {
			kind: "telegram",
			identity: "424242",
			linkedVia: "manual",
		});
		expect(await ensureOwnerPairingCode(buildEnv())).toEqual({ status: "not_needed" });

		const open = await testEnv.INDEX_DB.prepare(DOCTOR_QUERY).first();
		expect(open).toBeNull();
	});

	it("treats the bootstrap variable as an operator, so it mints nothing either", async () => {
		const state = await ensureOwnerPairingCode(buildEnv({ TELEGRAM_ALLOWED_USER_IDS: "424242" }));
		expect(state).toEqual({ status: "not_needed" });
	});

	// The bootstrap path this whole design turns on: the operator cannot reach the
	// authenticated UI, so the code has to be readable over `wrangler d1 execute`.
	it("exposes the live code to the one query an operator can actually run", async () => {
		const state = await ensureOwnerPairingCode(buildEnv());
		if (state.status !== "available") throw new Error("expected a minted code");

		const row = await testEnv.INDEX_DB.prepare(DOCTOR_QUERY).first<{
			code: string;
			expires_at: string;
		}>();
		expect(row?.code).toBe(state.pairing.code);
		expect(Date.parse(row?.expires_at ?? "")).toBeGreaterThan(Date.now());
	});

	it("hides a code the moment it is spent", async () => {
		const state = await ensureOwnerPairingCode(buildEnv());
		if (state.status !== "available") throw new Error("expected a minted code");

		expect(
			await consumePairingCode(testEnv.INDEX_DB, {
				code: state.pairing.code,
				kind: "telegram",
				identity: "999",
			}),
		).toBe("linked");
		expect(await testEnv.INDEX_DB.prepare(DOCTOR_QUERY).first()).toBeNull();
		expect((await readOwnerRegistry(testEnv.INDEX_DB)).telegramUserIds).toEqual(["999"]);
	});

	it("reports why a code did not work, so the bot can say something true", async () => {
		expect(
			await consumePairingCode(testEnv.INDEX_DB, {
				code: "nothinglikethis",
				kind: "telegram",
				identity: "999",
			}),
		).toBe("unknown");

		await testEnv.INDEX_DB.prepare(
			`INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by)
       VALUES ('stale', ?, ?, 'manual')`,
		)
			.bind(
				new Date(Date.now() - 7_200_000).toISOString(),
				new Date(Date.now() - 60_000).toISOString(),
			)
			.run();
		expect(
			await consumePairingCode(testEnv.INDEX_DB, {
				code: "stale",
				kind: "telegram",
				identity: "999",
			}),
		).toBe("expired");
		expect((await readOwnerRegistry(testEnv.INDEX_DB)).telegramUserIds).toEqual([]);
	});

	it("unions the registry with the bootstrap variable", async () => {
		await linkOwnerIdentity(testEnv.INDEX_DB, {
			kind: "telegram",
			identity: "111",
			linkedVia: "pairing_code",
		});
		const operators = await resolveTelegramOperators(
			buildEnv({ TELEGRAM_ALLOWED_USER_IDS: "222" }),
		);
		expect([...operators].sort()).toEqual(["111", "222"]);
	});

	// A worker deployed before the migration ran must still obey its variable rather
	// than locking the operator out of the deployment that would fix it.
	it("falls back to the bootstrap variable when the registry cannot be read", async () => {
		const brokenDb = {
			prepare: () => {
				throw new Error("no such table: owner_identities");
			},
		} as unknown as D1Database;
		expect(await readOwnerRegistry(brokenDb)).toEqual({ emails: [], telegramUserIds: [] });

		const operators = await resolveTelegramOperators({
			INDEX_DB: brokenDb,
			TELEGRAM_ALLOWED_USER_IDS: "424242",
		} as unknown as Env);
		expect([...operators]).toEqual(["424242"]);
	});
});
