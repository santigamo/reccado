import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { confirmSendDraft } from "#/do/mailbox-do";

const testEnv = env as unknown as Env;
const identity = { mailboxAddress: "owner@example.com", displayName: "Original Name" };

async function draft() {
	const stub = testEnv.MAILBOX_DO.getByName(crypto.randomUUID());
	const response = await stub.fetch("https://mailbox-do/drafts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			to: ["recipient@example.net"],
			subject: "Hello",
			bodyText: "Original",
			bodyHtml: "<p>Original</p>",
		}),
	});
	const { id } = (await response.json()) as { id: string };
	const arm = () =>
		stub.fetch(`https://mailbox-do/drafts/${id}/request-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(identity),
		});
	return { stub, id, arm };
}

describe("frozen send intent", () => {
	it("never lets the agent claim an owner draft, keeps it the agent's otherwise, and refuses unapproved sends", async () => {
		const { stub, id, arm } = await draft();
		// The agent cannot turn an owner's draft into its own.
		const claimed = await stub.fetch(`https://mailbox-do/drafts/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ origin: "mcp", bodyText: "Agent draft" }),
		});
		expect(claimed.status).toBe(409);
		expect(await claimed.json()).toMatchObject({ error: "draft_not_agent_owned" });
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec("UPDATE outbound_drafts SET origin = 'mcp' WHERE id = ?", id);
		});
		// An internal edit with no origin (the Telegram bridge) never changes the owner.
		await stub.fetch(`https://mailbox-do/drafts/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bodyText: "Bridge edit" }),
		});
		await arm();
		const sent: unknown[] = [];
		const result = await runInDurableObject(stub, async (_instance, state) =>
			confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: {
						send: async (mail: unknown) => {
							sent.push(mail);
							return {};
						},
					} as unknown as Env["EMAIL"],
					fromAddress: "owner@example.com",
					replyToAddress: null,
				},
				id,
				"attempt",
			),
		);
		expect(result.error).toBe("approval_required");
		expect(sent).toHaveLength(0);
		// The owner saving it from the web takes it over, and voids the frozen intent.
		const takeover = await stub.fetch(`https://mailbox-do/drafts/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ origin: "web" }),
		});
		expect(await takeover.json()).toMatchObject({ takenOver: true });
		const after = await runInDurableObject(stub, async (_instance, state) => ({
			origin: state.storage.sql
				.exec<{ origin: string }>("SELECT origin FROM outbound_drafts WHERE id = ?", id)
				.toArray()[0]?.origin,
			stale: state.storage.sql
				.exec<{ value: string }>(
					"SELECT value FROM mailbox_meta WHERE key = ?",
					`intent_stale:${id}`,
				)
				.toArray()[0]?.value,
		}));
		expect(after).toEqual({ origin: "web", stale: "stale" });
	});
	it("hashes identical snapshots deterministically and keeps repeated requests stable", async () => {
		const a = await draft();
		const b = await draft();
		const first = (await (await a.arm()).json()) as { payload_hash: string };
		const repeat = (await (await a.arm()).json()) as { payload_hash: string };
		const other = (await (await b.arm()).json()) as { payload_hash: string };
		expect(first.payload_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(repeat.payload_hash).toBe(first.payload_hash);
		expect(other.payload_hash).toBe(first.payload_hash);
	});

	it("rejects an edited intent with intent_stale without sending", async () => {
		const { stub, id, arm } = await draft();
		await arm();
		await stub.fetch(`https://mailbox-do/drafts/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bodyText: "Changed" }),
		});
		const sent: unknown[] = [];
		const result = await runInDurableObject(stub, async (_instance, state) =>
			confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: {
						send: async (mail: unknown) => {
							sent.push(mail);
							return {};
						},
					} as unknown as Env["EMAIL"],
					fromAddress: "changed@example.com",
					replyToAddress: null,
				},
				id,
				"attempt",
			),
		);
		expect(result.error).toBe("intent_stale");
		expect(sent).toHaveLength(0);
	});

	it("sends once under concurrent and repeated confirmations using frozen identity", async () => {
		const { stub, id, arm } = await draft();
		await arm();
		const sent: Array<Record<string, unknown>> = [];
		const results = await runInDurableObject(stub, async (_instance, state) => {
			const ctx = {
				sql: state.storage.sql,
				transactionSync: (fn: () => void) => state.storage.transactionSync(fn),
				email: {
					send: async (mail: Record<string, unknown>) => {
						sent.push(mail);
						await Promise.resolve();
						return {};
					},
				} as unknown as Env["EMAIL"],
				fromAddress: "changed@example.com",
				fromName: "Changed",
				replyToAddress: "changed@example.com",
			};
			const simultaneous = await Promise.all([
				confirmSendDraft(ctx, id, "same-key"),
				confirmSendDraft(ctx, id, "same-key"),
			]);
			return [...simultaneous, await confirmSendDraft(ctx, id, "same-key")];
		});
		expect(sent).toHaveLength(1);
		expect(sent[0]?.from).toMatchObject({ name: "Original Name" });
		expect(results.filter((r) => r.sent === true)).toHaveLength(1);
		expect(results[2]?.duplicate).toBe(true);
	});
});
