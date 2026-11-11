import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { dlq, opsEvents, reindex } from "#/lib/admin/ops";

vi.mock("#/db/d1", () => ({ listOpsEvents: async () => [], listIngestFailures: async () => [] }));
const actor = { userId: "1", email: "owner@example.test", owners: ["owner@example.test"] };
describe("operations admin service", () => {
	it("lists events and DLQ metadata", async () => {
		expect(await opsEvents(env, actor)).toEqual({ events: [] });
		expect((await dlq(env, actor)).ingestFailures).toEqual([]);
	});
	it("denies a non-owner and validates mailbox input", async () => {
		await expect(opsEvents(env, { ...actor, email: "other@example.test" })).rejects.toMatchObject({
			code: "forbidden",
		});
		await expect(reindex(env, actor, {})).rejects.toThrow();
	});
});
