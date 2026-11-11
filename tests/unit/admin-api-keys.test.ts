import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createKey, listKeys } from "#/lib/admin/api-keys";
import { getMailbox, getMailboxForOwner } from "#/db/d1";

vi.mock("#/db/d1", () => ({
	getMailboxForOwner: vi.fn(),
	getMailbox: vi.fn(),
	upsertApiKeyProjection: vi.fn(),
}));
vi.mock("#/lib/mailbox-stub", () => ({
	mailboxStub: () => ({ fetch: async () => Response.json({ keys: [] }) }),
}));
const actor = { userId: "1", email: "owner@example.test", owners: ["owner@example.test"] };
beforeEach(() => {
	vi.mocked(getMailboxForOwner).mockResolvedValue({} as never);
	vi.mocked(getMailbox).mockResolvedValue({} as never);
});
describe("API key admin service", () => {
	it("lists keys and rejects invalid creation", async () => {
		expect((await listKeys(env, actor, { mailboxId: "m" })).status).toBe(200);
		await expect(createKey(env, actor, { mailboxId: "m", body: {} })).rejects.toThrow();
	});
	it("denies a non-owner and an absent mailbox", async () => {
		await expect(
			listKeys(env, { ...actor, email: "other@example.test" }, { mailboxId: "m" }),
		).rejects.toMatchObject({ code: "forbidden" });
		vi.mocked(getMailboxForOwner).mockResolvedValue(null);
		await expect(listKeys(env, actor, { mailboxId: "missing" })).rejects.toMatchObject({
			code: "forbidden",
		});
	});
});
