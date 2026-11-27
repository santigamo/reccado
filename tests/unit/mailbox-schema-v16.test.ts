import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { API_KEY_EVENT_TYPES } from "#/do/mailbox-schema-content";
import keyOpsSource from "../../src/do/transactional-key-ops.ts?raw";
import {
	apiKeyEventsDdl,
	revertApiKeyEventsToV15,
	schemaVersion,
} from "../helpers/api-key-events-legacy";

const testEnv = env as unknown as Env;

/**
 * v16, tested the way production meets it: a mailbox already past v6 whose
 * `api_key_events` CHECK lacks 'template_allowlist_updated', restarted so the
 * constructor (not a direct call to the migration) decides what runs.
 *
 * The v6 tests could not catch the original bug: they called the rebuild
 * directly on a pre-v6 table, so they never exercised the version gate that kept
 * it from running on mailboxes already past v6.
 */
function insertEvent(sql: SqlStorage, id: string, type: string): void {
	sql.exec(
		`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
     VALUES (?, 'k1', ?, '{}', '2026-01-01T00:00:00Z')`,
		id,
		type,
	);
}

describe("v16 migration on a mailbox past v6", () => {
	it("rebuilds the CHECK on restart, keeps every row, and admits every event type", async () => {
		const name = "mbx-v16-migrate";
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(name), async (_i, state) => {
			const sql = state.storage.sql;
			insertEvent(sql, "old-created", "created");
			insertEvent(sql, "old-renamed", "sender_name_updated");
			revertApiKeyEventsToV15(sql);
			// Sanity: this is the production failure, or the test proves nothing.
			expect(() => insertEvent(sql, "too-early", "template_allowlist_updated")).toThrow(
				/CHECK constraint failed/,
			);
		});

		await abortAllDurableObjects();
		const after = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(name),
			async (_i, state) => {
				const sql = state.storage.sql;
				const version = schemaVersion(sql);
				const ddl = apiKeyEventsDdl(sql);
				const kept = sql.exec("SELECT id, event_type FROM api_key_events ORDER BY id").toArray();
				for (const type of API_KEY_EVENT_TYPES) insertEvent(sql, `new-${type}`, type);
				const index = sql
					.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ake_key'")
					.toArray().length;
				const leftover = sql
					.exec("SELECT name FROM sqlite_master WHERE name = 'api_key_events_old'")
					.toArray().length;
				return { version, ddl, kept, index, leftover };
			},
		);
		expect(after.version).toBe(16);
		for (const type of API_KEY_EVENT_TYPES) expect(after.ddl).toContain(`'${type}'`);
		expect(after.kept).toEqual([
			{ id: "old-created", event_type: "created" },
			{ id: "old-renamed", event_type: "sender_name_updated" },
		]);
		expect(after.index).toBe(1);
		expect(after.leftover).toBe(0);
	});

	it("leaves a table that already admits every type untouched, and is safe to rerun", async () => {
		const name = "mbx-v16-noop";
		const before = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(name),
			async (_i, state) => {
				const sql = state.storage.sql;
				insertEvent(sql, "e1", "template_allowlist_updated");
				// At v15 with the current CHECK: what a mailbox created after the
				// schema text was widened looks like.
				sql.exec("DELETE FROM schema_migrations WHERE version >= 16");
				sql.exec(
					"INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (15, '2026-11-14T00:00:00Z')",
				);
				return apiKeyEventsDdl(sql);
			},
		);
		await abortAllDurableObjects();
		// A second restart with the version rolled back again runs the gate twice.
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(name), async (_i, state) => {
			state.storage.sql.exec("DELETE FROM schema_migrations WHERE version >= 16");
			state.storage.sql.exec(
				"INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (15, '2026-11-14T00:00:00Z')",
			);
		});
		await abortAllDurableObjects();
		const after = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(name),
			async (_i, state) => ({
				ddl: apiKeyEventsDdl(state.storage.sql),
				rows: state.storage.sql.exec("SELECT id FROM api_key_events").toArray(),
				version: schemaVersion(state.storage.sql),
			}),
		);
		expect(after.ddl).toBe(before);
		expect(after.rows).toEqual([{ id: "e1" }]);
		expect(after.version).toBe(16);
	});

	it("admits every event type the key operations write", () => {
		// The drift that caused the bug, caught statically: a new audit row type in
		// the code with no matching entry in the CHECK the migration enforces.
		const written = new Set(
			[
				...keyOpsSource.matchAll(/INSERT INTO api_key_events[^`]*?VALUES \(\?, \?, '([a-z_]+)'/g),
			].map((match) => match[1]),
		);
		expect(written.size).toBeGreaterThanOrEqual(5);
		for (const type of written) expect(API_KEY_EVENT_TYPES).toContain(type);
	});
});
