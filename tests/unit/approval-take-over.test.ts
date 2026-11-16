import { afterEach, describe, expect, it, vi } from "vitest";
import { type PendingApproval, TakeOverError, takeOverAsOwnDraft } from "#/lib/use-approvals";

/**
 * "Edit as my draft" on an agent's send request: deny first, copy second (with
 * the HTML body), retire the agent's draft last; and what each failure leaves.
 */

const approval: PendingApproval = {
	id: "intent-1",
	kind: "send",
	status: "pending",
	createdAt: "2026-11-16T10:00:00.000Z",
	expiresAt: "2026-11-16T10:10:00.000Z",
	decidedAt: null,
	requestedBy: "Claude",
	approveUrl: "/approve/intent-1",
	revealsSecret: false,
	title: "Revisar envío",
	fields: [],
	warnings: [],
	payloadHash: "a".repeat(64),
	send: {
		mailboxId: "mbx_1",
		draftId: "agent-draft",
		threadId: "thr_1",
		parentMessageId: "msg_1",
		from: "me@example.com",
		fromName: null,
		to: ["rico@example.net"],
		cc: [],
		bcc: [],
		subject: "Re: Review",
		text: "Hello in bold",
		html: "<p>Hello <strong>in bold</strong></p>",
		snippet: "Hello in bold",
		attachments: 1,
	},
	mailboxId: "mbx_1",
	threadId: "thr_1",
};

type Call = { method: string; path: string; body: unknown };

function stub(answers: { deny: () => Response; create: () => Response }): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const path = new URL(String(input), "http://localhost").pathname;
		const method = init?.method ?? "GET";
		calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		if (path === "/api/approvals/intent-1/deny") return answers.deny();
		if (path === "/api/mailboxes/mbx_1/drafts" && method === "POST") return answers.create();
		if (path === "/api/mailboxes/mbx_1/drafts/agent-draft/cancel") return Response.json({});
		return new Response("unexpected", { status: 599 });
	});
	return calls;
}

const deniedOk = () => Response.json({ status: "denied" });
const created = () => Response.json({ id: "owner-draft" }, { status: 201 });

describe("Edit as my draft", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("denies first, then copies the HTML body, then retires the agent's draft", async () => {
		const calls = stub({ deny: deniedOk, create: created });
		const result = await takeOverAsOwnDraft(approval);
		expect(result).toEqual({ draftId: "owner-draft", mailboxId: "mbx_1", attachmentsLeftOut: 1 });
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /api/approvals/intent-1/deny",
			"POST /api/mailboxes/mbx_1/drafts",
			"POST /api/mailboxes/mbx_1/drafts/agent-draft/cancel",
		]);
		expect(calls[1]?.body).toEqual({
			to: ["rico@example.net"],
			subject: "Re: Review",
			bodyText: "Hello in bold",
			bodyHtml: "<p>Hello <strong>in bold</strong></p>",
			threadId: "thr_1",
			parentMessageId: "msg_1",
		});
	});

	it("makes no copy when the deny fails, so nothing can be sent twice", async () => {
		const calls = stub({ deny: () => new Response("{}", { status: 500 }), create: created });
		const error = await takeOverAsOwnDraft(approval).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(TakeOverError);
		expect((error as TakeOverError).code).toBe("deny_failed");
		expect((error as TakeOverError).ownerMessage).toMatch(/still waiting/);
		expect(calls.map((c) => c.path)).toEqual(["/api/approvals/intent-1/deny"]);
	});

	it("makes no copy of a request already decided elsewhere", async () => {
		const calls = stub({
			deny: () => Response.json({ status: "sent", resolved: true }),
			create: created,
		});
		const error = (await takeOverAsOwnDraft(approval).catch((e: unknown) => e)) as TakeOverError;
		expect(error.code).toBe("already_decided");
		expect(error.ownerMessage).toMatch(/already sent/);
		expect(calls.map((c) => c.path)).toEqual(["/api/approvals/intent-1/deny"]);
	});

	it("keeps the agent's draft and says so when the copy fails after the deny", async () => {
		const calls = stub({ deny: deniedOk, create: () => new Response("{}", { status: 500 }) });
		const error = (await takeOverAsOwnDraft(approval).catch((e: unknown) => e)) as TakeOverError;
		expect(error.code).toBe("copy_failed");
		expect(error.ownerMessage).toMatch(/Nothing was sent/);
		expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
	});
});
