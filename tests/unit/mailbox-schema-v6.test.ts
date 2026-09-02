import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const testEnv = env as unknown as Env;

/**
 * The v6 migration, tested against the schema it actually has to fix.
 *
 * Every mailbox already in production predates display names, so the population
 * this migration exists for is precisely the one a fresh-DO test does NOT cover.
 * These tests put the OLD shape back — a table with no `sender_name`, and an
 * `api_key_events` CHECK that admits only three event types — and then run the
 * migration over it.
 *
 * The event-type constraint is the sharp edge: SQLite cannot ALTER a CHECK, and
 * the audit insert happens in the same call as the rename, so an unmigrated table
 * does not skip the audit row quietly — it fails the whole rename with a
 * constraint error.
 */
async function withMailbox<T>(
	name: string,
	fn: (instance: unknown, state: DurableObjectState) => Promise<T>,
): Promise<T> {
	const stub = testEnv.MAILBOX_DO.getByName(name);
	return runInDurableObject(stub, async (instance, state) => fn(instance, state));
}

/** Puts the pre-v6 shape back on a DO that booted with the current one. */
function revertToPreV6(sql: SqlStorage): void {
	sql.exec("DROP TABLE IF EXISTS api_keys");
	sql.exec(`CREATE TABLE api_keys (
  key_id TEXT PRIMARY KEY,
  hash_version INTEGER NOT NULL DEFAULT 1,
  key_hash TEXT NOT NULL,
  display_suffix TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  mailbox_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  template_allowlist_json TEXT,
  recipient_policy TEXT,
  quota_max INTEGER,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
)`);
	sql.exec("DROP TABLE IF EXISTS api_key_events");
	sql.exec(`CREATE TABLE api_key_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'revoked', 'rotated')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
)`);
}

function columnNames(sql: SqlStorage, table: string): Set<string> {
	const rows = sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{ name: string }>;
	return new Set(rows.map((row) => row.name));
}

describe("v6 migration on a pre-display-name mailbox", () => {
	it("adds sender_name and widens the event-type constraint", async () => {
		const result = await withMailbox("mbx-v6-migrate", async (instance, state) => {
			const sql = state.storage.sql;
			revertToPreV6(sql);
			// Sanity: the old shape really is in place, or this test proves nothing.
			expect(columnNames(sql, "api_keys").has("sender_name")).toBe(false);

			const migrator = instance as {
				migrateApiKeySenderName: () => void;
				migrateApiKeyEventTypes: () => void;
			};
			migrator.migrateApiKeySenderName();
			migrator.migrateApiKeyEventTypes();

			// The audit row an unmigrated table would have rejected.
			sql.exec(
				`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
         VALUES ('e1', 'k1', 'sender_name_updated', '{}', '2026-01-01T00:00:00Z')`,
			);
			return {
				hasColumn: columnNames(sql, "api_keys").has("sender_name"),
				events: sql.exec("SELECT COUNT(*) AS n FROM api_key_events").toArray() as Array<{
					n: number;
				}>,
			};
		});
		expect(result.hasColumn).toBe(true);
		expect(result.events[0]?.n).toBe(1);
	});

	it("preserves the audit rows it rebuilds around", async () => {
		const rows = await withMailbox("mbx-v6-preserve", async (instance, state) => {
			const sql = state.storage.sql;
			revertToPreV6(sql);
			sql.exec(
				`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
         VALUES ('old1', 'k1', 'created', '{"a":1}', '2026-01-01T00:00:00Z')`,
			);
			(instance as { migrateApiKeyEventTypes: () => void }).migrateApiKeyEventTypes();
			return sql.exec("SELECT * FROM api_key_events ORDER BY id").toArray() as Array<{
				id: string;
				event_type: string;
				metadata_json: string;
			}>;
		});
		// A rebuild that loses history would be worse than no rebuild at all.
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "old1",
			event_type: "created",
			metadata_json: '{"a":1}',
		});
	});

	it("is a no-op when run twice", async () => {
		const rows = await withMailbox("mbx-v6-idempotent", async (instance, state) => {
			const sql = state.storage.sql;
			revertToPreV6(sql);
			sql.exec(
				`INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at)
         VALUES ('old1', 'k1', 'created', '{}', '2026-01-01T00:00:00Z')`,
			);
			const migrator = instance as {
				migrateApiKeySenderName: () => void;
				migrateApiKeyEventTypes: () => void;
			};
			migrator.migrateApiKeySenderName();
			migrator.migrateApiKeyEventTypes();
			// A cold start re-runs the constructor; the second pass must not rebuild
			// again, and must not drop the row it already carried across.
			migrator.migrateApiKeySenderName();
			migrator.migrateApiKeyEventTypes();
			return sql.exec("SELECT * FROM api_key_events").toArray();
		});
		expect(rows).toHaveLength(1);
	});
});
