import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listSuppressions, removeSuppression } from "#/lib/admin/suppressions";
import { getMailboxForOwner } from "#/db/d1";

vi.mock("#/db/d1", () => ({ getMailboxForOwner: vi.fn() }));
vi.mock("#/lib/mailbox-stub", () => ({
	mailboxStub: () => ({ fetch: async () => Response.json({ suppressions: [] }) }),
}));
const actor = { userId: "1", email: "owner@example.test", owners: ["owner@example.test"] };
beforeEach(() => vi.mocked(getMailboxForOwner).mockResolvedValue({} as never));
describe("suppression admin service", () => {
	it("lists and validates removal", async () => {
		expect((await listSuppressions(env, actor, { mailboxId: "m" })).status).toBe(200);
		await expect(
			removeSuppression(env, actor, { mailboxId: "m", body: { email: "" } }),
		).rejects.toMatchObject({ code: "email_required" });
	});
	it("denies a non-owner and an absent mailbox", async () => {
		await expect(
			listSuppressions(env, { ...actor, email: "other@example.test" }, { mailboxId: "m" }),
		).rejects.toMatchObject({ code: "forbidden" });
		vi.mocked(getMailboxForOwner).mockResolvedValue(null);
		await expect(listSuppressions(env, actor, { mailboxId: "missing" })).rejects.toMatchObject({
			code: "forbidden",
		});
	});
});
