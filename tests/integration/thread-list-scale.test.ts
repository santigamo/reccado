import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { listThreads } from "#/do/mailbox-do";

/**
 * The thread list's page query must not count every message of every
 * conversation before ORDER BY/LIMIT: message_count and unread_count are
 * computed for the page's rows only. Measured with the SQLite cursor's own
 * rowsRead, which is deterministic (no timing), on a mailbox seeded directly.
 */

type TestEnv = Env & { MAILBOX_DO: DurableObjectNamespace };
const testEnv = env as unknown as TestEnv;
const NOW = "2026-01-01T00:00:00.000Z";

/** `threads` conversations of three messages; every third one has its first message trashed. */
function seed(sql: SqlStorage, threads: number): void {
	for (let t = 0; t < threads; t++) {
		const tid = `thr_${String(t).padStart(6, "0")}`;
		sql.exec(
			"INSERT INTO threads (id, subject_norm, last_message_at, created_at, updated_at) VALUES (?, 's', ?, ?, ?)",
			tid,
			NOW,
			NOW,
			NOW,
		);
		for (let m = 0; m < 3; m++) {
			const id = `${tid}_m${m}`;
			sql.exec(
				`INSERT INTO messages (id, idempotency_key, thread_id, direction, state, from_addr, to_json,
           received_at, raw_r2_key, raw_sha256, raw_size, parse_status, is_read, created_at, updated_at)
         VALUES (?, ?, ?, 'inbound', ?, 'a@example.org', '[]', ?, 'k', 'h', 1, 'parsed', ?, ?, ?)`,
				id,
				id,
				tid,
				m === 0 && t % 3 === 0 ? "trash" : "inbox",
				new Date(Date.UTC(2026, 0, 1) + t * 60_000 + m * 1000).toISOString(),
				m === 1 ? 1 : 0,
				NOW,
				NOW,
			);
		}
	}
}

/** Rows SQLite read for everything `fn` executed. */
function rowsRead(sql: SqlStorage, fn: (sql: SqlStorage) => unknown): number {
	const cursors: Array<{ rowsRead: number }> = [];
	const counting = {
		exec: (query: string, ...bindings: SqlStorageValue[]) => {
			const cursor = sql.exec(query, ...bindings);
			cursors.push(cursor);
			return cursor;
		},
	} as unknown as SqlStorage;
	fn(counting);
	return cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
}

async function pageCost(threads: number): Promise<{ all: number; inbox: number }> {
	return runInDurableObject(
		testEnv.MAILBOX_DO.getByName(`mbx-scale-${threads}`),
		async (_instance, state) => {
			const sql = state.storage.sql;
			seed(sql, threads);
			return {
				all: rowsRead(sql, (s) => listThreads(s, 50, undefined, undefined, "exclude")),
				inbox: rowsRead(sql, (s) => listThreads(s, 50, "inbox", undefined, "exclude")),
			};
		},
	);
}

describe("thread list page cost", () => {
	it("grows by one representative-message probe per conversation, not by its counts", async () => {
		const small = await pageCost(1000);
		const large = await pageCost(3000);
		const perThread = (large.all - small.all) / 2000;
		// Two correlated COUNT(*) subqueries per conversation cost ~12 rows read per
		// conversation here; what is left is the probe for the representative
		// message the order needs (~4).
		expect(perThread).toBeLessThan(6);
		expect((large.inbox - small.inbox) / 2000).toBeLessThan(7);
	}, 120_000);

	it("counts the page's rows from the folder's visible messages only", async () => {
		await runInDurableObject(
			testEnv.MAILBOX_DO.getByName("mbx-scale-counts"),
			async (_i, state) => {
				const sql = state.storage.sql;
				seed(sql, 6);
				const inbox = listThreads(sql, 50, "inbox", undefined, "exclude");
				// Newest first; thr_000003 and thr_000000 have their first message in the Trash.
				expect(inbox.map((r) => [r.id, r.message_count, r.unread_count])).toEqual([
					["thr_000005", 3, 2],
					["thr_000004", 3, 2],
					["thr_000003", 2, 1],
					["thr_000002", 3, 2],
					["thr_000001", 3, 2],
					["thr_000000", 2, 1],
				]);
				const trash = listThreads(sql, 50, "trash", undefined, "exclude");
				expect(trash.map((r) => [r.id, r.message_count, r.unread_count])).toEqual([
					["thr_000003", 1, 1],
					["thr_000000", 1, 1],
				]);
				// Unread filter and keyset paging still decide on the visible messages.
				sql.exec(
					"UPDATE messages SET is_read = 1 WHERE thread_id = 'thr_000004' AND state != 'trash'",
				);
				sql.exec(
					"UPDATE messages SET is_read = 1 WHERE thread_id = 'thr_000003' AND state != 'trash'",
				);
				const unread = listThreads(sql, 50, "inbox", true, "exclude");
				expect(unread.map((r) => r.id)).toEqual([
					"thr_000005",
					"thr_000002",
					"thr_000001",
					"thr_000000",
				]);
				const read = listThreads(sql, 50, "inbox", false, "exclude");
				expect(read.map((r) => r.id)).toEqual(["thr_000004", "thr_000003"]);
				const first = listThreads(sql, 2, "inbox", true, "exclude");
				const last = first.at(-1)!;
				const next = listThreads(sql, 2, "inbox", true, "exclude", {
					receivedAt: String(last.latest_received_at),
					id: last.id,
				});
				expect([...first, ...next].map((r) => r.id)).toEqual(unread.map((r) => r.id));
			},
		);
	});
});
