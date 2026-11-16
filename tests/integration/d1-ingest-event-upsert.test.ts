import { beforeAll, describe, expect, it } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { upsertIngestEvent } from "#/db/d1";
import { splitSqlStatements } from "../helpers/migrations";

const env = testEnv as unknown as Env & { INDEX_DB: D1Database };

beforeAll(async () => {
	const m1 = await import("../../migrations/d1/0001_initial.sql?raw");
	const m2 = await import("../../migrations/d1/0002_message_index.sql?raw");
	for (const raw of [m1.default, m2.default]) {
		for (const statement of splitSqlStatements(raw as string)) {
			await env.INDEX_DB.prepare(statement).run();
		}
	}
});

// Regression: the ON CONFLICT branch once referenced a column ingest_events does not have,
// so every second write for the same key (queued → processed) failed and inbound mail
// went to the DLQ. Only the conflict path exercises that SQL.
describe("upsertIngestEvent", () => {
	it("updates an existing row on the conflict path", async () => {
		const key = `ingest-${crypto.randomUUID()}`;
		const base = { idempotency_key: key, mailbox_id: "mbx_t", raw_r2_key: "raw/t.eml" };
		await upsertIngestEvent(env.INDEX_DB, { ...base, message_local_id: null, status: "queued" });
		await upsertIngestEvent(env.INDEX_DB, {
			...base,
			message_local_id: "msg_1",
			status: "processed",
		});
		const row = await env.INDEX_DB.prepare(
			"SELECT status, message_local_id FROM ingest_events WHERE idempotency_key = ?",
		)
			.bind(key)
			.first<{ status: string; message_local_id: string }>();
		expect(row).toEqual({ status: "processed", message_local_id: "msg_1" });
	});
});
