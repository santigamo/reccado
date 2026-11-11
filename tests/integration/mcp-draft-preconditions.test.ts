import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("atomic draft status preconditions", () => {
	it("rejects editing and cancelling a sent draft while preserving its content", async () => {
		const stub = (env as unknown as Env).MAILBOX_DO.getByName(
			`draft-precondition-${crypto.randomUUID()}`,
		);
		const created = await stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: ["a@example.com"],
				subject: "before",
				bodyText: "body",
				idempotencyKey: crypto.randomUUID(),
			}),
		});
		const { id } = (await created.json()) as { id: string };
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec("UPDATE outbound_drafts SET status = 'sent' WHERE id = ?", id);
		});
		const edit = await stub.fetch(`https://mailbox-do/drafts/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subject: "after", allowedStatuses: ["draft"] }),
		});
		expect(edit.status).toBe(409);
		expect(await edit.json()).toMatchObject({ error: "draft_not_editable", currentStatus: "sent" });
		const cancel = await stub.fetch(`https://mailbox-do/drafts/${id}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ allowedStatuses: ["draft", "pending_confirmation"] }),
		});
		expect(cancel.status).toBe(409);
		const read = await stub.fetch(`https://mailbox-do/drafts/${id}`);
		expect(await read.json()).toMatchObject({ draft: { status: "sent", subject: "before" } });
	});

	it("allows editing and cancelling a draft", async () => {
		const stub = (env as unknown as Env).MAILBOX_DO.getByName(
			`draft-precondition-${crypto.randomUUID()}`,
		);
		const created = await stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ to: ["a@example.com"], subject: "before", bodyText: "body" }),
		});
		const { id } = (await created.json()) as { id: string };
		const edit = await stub.fetch(`https://mailbox-do/drafts/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ subject: "after", allowedStatuses: ["draft"] }),
		});
		expect(edit.status).toBe(200);
		const cancel = await stub.fetch(`https://mailbox-do/drafts/${id}/cancel`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ allowedStatuses: ["draft", "pending_confirmation"] }),
		});
		expect(cancel.status).toBe(200);
	});
});
