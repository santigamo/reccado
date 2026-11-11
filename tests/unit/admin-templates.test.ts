import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listTemplates, syncTemplates } from "#/lib/admin/templates";
import { getMailboxForOwner } from "#/db/d1";

vi.mock("#/db/d1", () => ({ getMailboxForOwner: vi.fn() }));
vi.mock("#/lib/mailbox-stub", () => ({
	mailboxStub: () => ({ fetch: async () => Response.json({ templates: [] }) }),
}));
const actor = { userId: "1", email: "owner@example.test", owners: ["owner@example.test"] };
beforeEach(() => vi.mocked(getMailboxForOwner).mockResolvedValue({} as never));
describe("template admin service", () => {
	it("lists templates and validates sync", async () => {
		expect((await listTemplates(env, actor, { mailboxId: "m" })).status).toBe(200);
		await expect(syncTemplates(env, actor, { mailboxId: "m", body: {} })).rejects.toThrow();
	});
	it("denies a non-owner and an absent mailbox", async () => {
		await expect(
			listTemplates(env, { ...actor, email: "other@example.test" }, { mailboxId: "m" }),
		).rejects.toMatchObject({ code: "forbidden" });
		vi.mocked(getMailboxForOwner).mockResolvedValue(null);
		await expect(listTemplates(env, actor, { mailboxId: "missing" })).rejects.toMatchObject({
			code: "forbidden",
		});
	});
	it("checks ownership before reading a request body", async () => {
		vi.mocked(getMailboxForOwner).mockResolvedValue(null);
		const readBody = vi.fn(() => Promise.reject(new SyntaxError("invalid JSON")));
		await expect(
			syncTemplates(env, actor, {
				mailboxId: "missing",
				get body() {
					return readBody();
				},
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(readBody).not.toHaveBeenCalled();
	});
});
