/**
 * The `api_key_events` CHECK as the v6 rebuild wrote it, which is what every mailbox
 * that passed v6 before 'template_allowlist_updated' existed still has: the v6 gate
 * was edited afterwards, and a gate a mailbox has already passed never runs again.
 */
export const V6_API_KEY_EVENT_TYPES = ["created", "revoked", "rotated", "sender_name_updated"];

/**
 * Puts the production shape back on a mailbox that booted with the current schema:
 * `api_key_events` rebuilt with `types` as its CHECK (rows kept), and the mailbox
 * recorded at schema version 15, the last version before the fix. The live instance
 * keeps running on that table; only a restart (`abortAllDurableObjects`) runs the
 * constructor's migrations.
 */
export function revertApiKeyEventsToV15(
	sql: SqlStorage,
	types: readonly string[] = V6_API_KEY_EVENT_TYPES,
): void {
	sql.exec("ALTER TABLE api_key_events RENAME TO api_key_events_current");
	sql.exec(`CREATE TABLE api_key_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN (${types.map((type) => `'${type}'`).join(", ")})),
  metadata_json TEXT,
  created_at TEXT NOT NULL
)`);
	sql.exec(
		"INSERT INTO api_key_events (id, key_id, event_type, metadata_json, created_at) SELECT id, key_id, event_type, metadata_json, created_at FROM api_key_events_current",
	);
	sql.exec("DROP TABLE api_key_events_current");
	sql.exec("CREATE INDEX IF NOT EXISTS idx_ake_key ON api_key_events(key_id)");
	// A fresh mailbox records only the version it booted at, so deleting it alone
	// would send the restart through every migration from v1; pin it at 15 instead.
	sql.exec("DELETE FROM schema_migrations WHERE version >= 16");
	sql.exec(
		"INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (15, '2026-11-14T00:00:00Z')",
	);
}

export function schemaVersion(sql: SqlStorage): number | undefined {
	return sql.exec<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations").toArray()[0]?.v;
}

export function apiKeyEventsDdl(sql: SqlStorage): string {
	const row = sql
		.exec<{ sql: string }>(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'api_key_events'",
		)
		.toArray()[0];
	return row?.sql ?? "";
}
