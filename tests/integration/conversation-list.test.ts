import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import { confirmSendDraft } from "../helpers/armed-confirm";

/**
 * The conversation list, Gmail style: newest activity first in every folder
 * (your own replies count), a conversation is unread while any message is,
 * participants in order, folder moves that act on a conversation without
 * dragging your sent mail around, and a new reply that brings an archived
 * conversation back to the inbox.
 */

type TestEnv = Env & { MAIL_OBJECTS: R2Bucket };
const testEnv = env as unknown as TestEnv;

type Row = {
	id: string;
	message_count: number;
	unread_count: number;
	latest_received_at: string;
	latest_direction: string;
	latest_snippet: string | null;
	latest_to_json: string | null;
	participants: Array<{ address: string; name: string | null; me: boolean; unread: boolean }>;
};

function mime(input: {
	from: string;
	subject: string;
	messageId: string;
	inReplyTo?: string;
	body?: string;
}): string {
	return [
		`From: ${input.from}`,
		"To: Inbox Owner <test@example.com>",
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
		"Date: Mon, 16 Nov 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		input.body ?? "Hello there.",
		"",
	].join("\r\n");
}

async function ingest(
	mailboxId: string,
	raw: string,
	messageId: string,
	receivedAt: string,
): Promise<{ status: string; messageLocalId: string; threadId: string }> {
	const rawBytes = new TextEncoder().encode(raw);
	const rawSha256 = await sha256Hex(rawBytes);
	const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(receivedAt), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: receivedAt,
		receivedAt,
		mailboxId,
		domain: "example.com",
		recipient: "test@example.com",
		sender: "envelope@example.com",
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId,
		headers: { subject: null, date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
		idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
	};
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		"https://mailbox-do/ingest",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		},
	);
	expect(response.status).toBe(200);
	return (await response.json()) as { status: string; messageLocalId: string; threadId: string };
}

async function list(mailboxId: string, query = ""): Promise<Row[]> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/threads?limit=50${query}`,
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { threads: Row[] }).threads;
}

async function act(mailboxId: string, messageId: string, action: string): Promise<void> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/messages/${messageId}/actions`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action }),
		},
	);
	expect(response.status).toBe(200);
}

async function messageStates(mailboxId: string, threadId: string) {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/threads/${threadId}`,
	);
	const body = (await response.json()) as {
		messages: Array<{ id: string; direction: string; state: string; received_at: string }>;
	};
	return body.messages;
}

/** A reply sent from the web, through the real request-send -> confirm-send path. */
async function sendReply(
	mailboxId: string,
	threadId: string,
	parentMessageId: string,
	bodyText: string,
): Promise<string> {
	return runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (_i, state) => {
		const now = new Date().toISOString();
		const draftId = crypto.randomUUID();
		state.storage.sql.exec(
			`INSERT INTO outbound_drafts
       (id, thread_id, parent_message_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, '["rico@example.org"]', '[]', '[]', 'Re: Plan', ?, NULL, 'draft', 'owner', ?, ?)`,
			draftId,
			threadId,
			parentMessageId,
			bodyText,
			now,
			now,
		);
		const outcome = await confirmSendDraft(
			{
				sql: state.storage.sql,
				transactionSync: (fn) => state.storage.transactionSync(fn),
				email: {
					send: async () => ({ messageId: `<${draftId}@cloudflare.email>` }),
				} as unknown as Env["EMAIL"],
				fromAddress: "test@example.com",
				replyToAddress: null,
			},
			draftId,
			`attempt-${draftId}`,
		);
		expect(outcome.sent).toBe(true);
		expect(outcome.threadId).toBe(threadId);
		return String(outcome.messageLocalId);
	});
}

describe("conversation list order", () => {
	it("is newest activity first in every folder, and your reply moves its thread to the top", async () => {
		const mbx = "mbx-conv-order";
		const old = await ingest(
			mbx,
			mime({ from: "Rico <rico@example.org>", subject: "Plan", messageId: "plan-1@example.org" }),
			"plan-1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		const newer = await ingest(
			mbx,
			mime({ from: "Ana <ana@example.net>", subject: "Lunch", messageId: "lunch-1@example.net" }),
			"lunch-1@example.net",
			"2026-11-12T09:00:00.000Z",
		);
		for (const query of ["", "&state=inbox"]) {
			expect((await list(mbx, query)).map((r) => r.id)).toEqual([newer.threadId, old.threadId]);
		}

		// Replying to the older conversation is the newest activity in the mailbox.
		await sendReply(
			mbx,
			old.threadId,
			old.messageLocalId,
			"Sounds good.\n\nOn Mon, Rico wrote:\n> Plan?",
		);
		for (const query of ["", "&state=inbox", "&state=sent"]) {
			const rows = await list(mbx, query);
			expect(rows[0]?.id).toBe(old.threadId);
		}
		const inbox = await list(mbx, "&state=inbox");
		const top = inbox[0]!;
		expect(top.latest_direction).toBe("outbound");
		// The row previews what you wrote, not the quote below it.
		expect(top.latest_snippet).toBe("Sounds good.");
		expect(top.message_count).toBe(2);
		expect(JSON.parse(String(top.latest_to_json))).toEqual(["rico@example.org"]);
		expect(top.participants.map((p) => (p.me ? "me" : p.address))).toEqual([
			"rico@example.org",
			"me",
		]);
		// Sent shows only conversations you wrote in.
		expect((await list(mbx, "&state=sent")).map((r) => r.id)).toEqual([old.threadId]);
	});

	it("does not move a thread backwards when an older message arrives late", async () => {
		const mbx = "mbx-conv-late";
		const first = await ingest(
			mbx,
			mime({ from: "rico@example.org", subject: "Late", messageId: "late-2@example.org" }),
			"late-2@example.org",
			"2026-11-14T09:00:00.000Z",
		);
		await ingest(
			mbx,
			mime({
				from: "rico@example.org",
				subject: "Re: Late",
				messageId: "late-1@example.org",
				inReplyTo: "late-2@example.org",
			}),
			"late-1@example.org",
			"2026-11-01T09:00:00.000Z",
		);
		const row = (await list(mbx))[0]!;
		expect(row.id).toBe(first.threadId);
		expect(row.latest_received_at).toBe("2026-11-14T09:00:00.000Z");
		const lastMessageAt = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mbx),
			async (_i, state) =>
				state.storage.sql
					.exec<{ last_message_at: string }>(
						"SELECT last_message_at FROM threads WHERE id = ?",
						first.threadId,
					)
					.one().last_message_at,
		);
		expect(lastMessageAt).toBe("2026-11-14T09:00:00.000Z");
	});
});

describe("conversation read state and participants", () => {
	it("is unread while any message is, and names everyone in order", async () => {
		const mbx = "mbx-conv-unread";
		const a = await ingest(
			mbx,
			mime({ from: '"Rico Alvarez" <rico@example.org>', subject: "Trip", messageId: "trip-1@x" }),
			"trip-1@x",
			"2026-11-10T09:00:00.000Z",
		);
		const b = await ingest(
			mbx,
			mime({
				from: '"Ana Ruiz" <ana@example.net>',
				subject: "Re: Trip",
				messageId: "trip-2@x",
				inReplyTo: "trip-1@x",
			}),
			"trip-2@x",
			"2026-11-11T09:00:00.000Z",
		);
		expect(b.threadId).toBe(a.threadId);
		// Read the newest; the older one is still unread, so the conversation is.
		await act(mbx, b.messageLocalId, "mark_read");
		let row = (await list(mbx, "&state=inbox"))[0]!;
		expect(row.unread_count).toBe(1);
		expect(row.participants).toEqual([
			{ address: "rico@example.org", name: "Rico Alvarez", me: false, unread: true },
			{ address: "ana@example.net", name: "Ana Ruiz", me: false, unread: false },
		]);
		await act(mbx, a.messageLocalId, "mark_read");
		row = (await list(mbx, "&state=inbox"))[0]!;
		expect(row.unread_count).toBe(0);
		expect((await list(mbx, "&unread=true")).length).toBe(0);
	});
});

describe("folder moves act on the conversation", () => {
	it("archive and restore leave your replies in Sent; a new reply brings it back to the inbox", async () => {
		const mbx = "mbx-conv-archive";
		const first = await ingest(
			mbx,
			mime({ from: "rico@example.org", subject: "Plan", messageId: "arch-1@example.org" }),
			"arch-1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		const sentId = await sendReply(mbx, first.threadId, first.messageLocalId, "On it.");

		// Archive the whole conversation, the way the UI does: every message.
		for (const m of await messageStates(mbx, first.threadId)) await act(mbx, m.id, "archive");
		let states = await messageStates(mbx, first.threadId);
		expect(states.find((m) => m.id === first.messageLocalId)?.state).toBe("archive");
		expect(states.find((m) => m.id === sentId)?.state).toBe("sent");
		expect((await list(mbx, "&state=inbox")).length).toBe(0);
		expect((await list(mbx, "&state=archive")).map((r) => r.id)).toEqual([first.threadId]);
		expect((await list(mbx, "&state=sent")).map((r) => r.id)).toEqual([first.threadId]);

		// Restoring never files your own reply in the inbox.
		for (const m of await messageStates(mbx, first.threadId)) await act(mbx, m.id, "restore_inbox");
		states = await messageStates(mbx, first.threadId);
		expect(states.find((m) => m.id === sentId)?.state).toBe("sent");
		expect(states.find((m) => m.id === first.messageLocalId)?.state).toBe("inbox");

		// Archive again, then Rico answers: the conversation is back, whole.
		for (const m of await messageStates(mbx, first.threadId)) await act(mbx, m.id, "archive");
		const answer = await ingest(
			mbx,
			mime({
				from: "rico@example.org",
				subject: "Re: Plan",
				messageId: "arch-2@example.org",
				inReplyTo: "arch-1@example.org",
			}),
			"arch-2@example.org",
			"2026-11-12T09:00:00.000Z",
		);
		expect(answer.threadId).toBe(first.threadId);
		states = await messageStates(mbx, first.threadId);
		expect(states.filter((m) => m.direction === "inbound").map((m) => m.state)).toEqual([
			"inbox",
			"inbox",
		]);
		expect(states.find((m) => m.id === sentId)?.state).toBe("sent");
		expect((await list(mbx, "&state=archive")).length).toBe(0);
		expect((await list(mbx, "&state=inbox"))[0]?.id).toBe(first.threadId);
	});

	it("Trash shows trashed messages only; other folders ignore them", async () => {
		const mbx = "mbx-conv-trash";
		const first = await ingest(
			mbx,
			mime({ from: "rico@example.org", subject: "Bin", messageId: "bin-1@example.org" }),
			"bin-1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		const second = await ingest(
			mbx,
			mime({
				from: "rico@example.org",
				subject: "Re: Bin",
				messageId: "bin-2@example.org",
				inReplyTo: "bin-1@example.org",
				body: "Second one",
			}),
			"bin-2@example.org",
			"2026-11-11T09:00:00.000Z",
		);
		await act(mbx, second.messageLocalId, "trash");
		const inbox = (await list(mbx, "&state=inbox"))[0]!;
		expect(inbox.message_count).toBe(1);
		expect(inbox.latest_received_at).toBe("2026-11-10T09:00:00.000Z");
		const trash = (await list(mbx, "&state=trash"))[0]!;
		expect(trash.id).toBe(first.threadId);
		expect(trash.message_count).toBe(1);
		expect(trash.latest_snippet).toContain("Second one");
	});
});
