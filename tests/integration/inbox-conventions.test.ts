import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";

/**
 * The mailbox side of the web inbox's mail-client conventions: paging through a
 * long list without repeats or gaps, the Unread filter, bulk moves that report
 * what they changed (so Undo restores exactly that), "Mark all as read", undoing
 * a discarded draft, Reply-To kept at ingest, and the lazy, once-only backfill
 * of sender names and Reply-To for mail stored before they were kept.
 */

type TestEnv = Env & { MAIL_OBJECTS: R2Bucket };
const testEnv = env as unknown as TestEnv;

type Row = { id: string; latest_received_at: string; unread_count: number };
type Change = { id: string; thread_id: string; state: string; is_read: number };
type Msg = {
	id: string;
	direction: string;
	state: string;
	is_read: number;
	from_name: string | null;
	reply_to_json: string | null;
	raw_r2_key: string;
};

function mime(input: {
	from: string;
	subject: string;
	messageId: string;
	inReplyTo?: string;
	replyTo?: string;
}): string {
	return [
		`From: ${input.from}`,
		"To: Inbox Owner <test@example.com>",
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
		...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
		"Date: Mon, 16 Nov 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"Hello there.",
		"",
	].join("\r\n");
}

async function ingest(
	mailboxId: string,
	raw: string,
	messageId: string,
	receivedAt: string,
): Promise<{ messageLocalId: string; threadId: string }> {
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
	return (await response.json()) as { messageLocalId: string; threadId: string };
}

async function list(mailboxId: string, query: string): Promise<Row[]> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/threads?${query}`,
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { threads: Row[] }).threads;
}

async function bulk(
	mailboxId: string,
	action: string,
	target: unknown,
): Promise<{ action: string; changed: Change[] }> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		"https://mailbox-do/bulk-actions",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, target }),
		},
	);
	expect(response.status).toBe(200);
	return (await response.json()) as { action: string; changed: Change[] };
}

async function thread(mailboxId: string, threadId: string): Promise<Msg[]> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/threads/${threadId}`,
	);
	expect(response.status).toBe(200);
	return ((await response.json()) as { messages: Msg[] }).messages;
}

/** Ten conversations, one a minute apart, oldest first. */
async function seed(mailboxId: string): Promise<string[]> {
	const ids: string[] = [];
	for (let i = 0; i < 10; i++) {
		const at = new Date(Date.UTC(2026, 10, 10, 9, i)).toISOString();
		const { threadId } = await ingest(
			mailboxId,
			mime({ from: `p${i}@example.org`, subject: `Topic ${i}`, messageId: `t${i}@example.org` }),
			`t${i}@example.org`,
			at,
		);
		ids.push(threadId);
	}
	return ids;
}

describe("thread list paging", () => {
	it("walks the whole list page by page, with no repeat and no gap", async () => {
		const mbx = "mbx-paging";
		const ids = await seed(mbx);
		const seen: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 5; page++) {
			const rows = await list(
				mbx,
				`limit=4&state=inbox${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`,
			);
			seen.push(...rows.map((r) => r.id));
			const last = rows.at(-1);
			if (!last || rows.length < 4) break;
			cursor = `${last.latest_received_at}|${last.id}`;
		}
		expect(seen).toEqual([...ids].reverse());
	});

	it("filters to unread conversations", async () => {
		const mbx = "mbx-unread-filter";
		const ids = await seed(mbx);
		await bulk(mbx, "mark_read", { threadIds: ids.slice(0, 7) });
		const rows = await list(mbx, "limit=50&state=inbox&unread=true");
		expect(rows.map((r) => r.id)).toEqual(ids.slice(7).reverse());
	});
});

describe("bulk actions", () => {
	it("moves whole conversations and reports what each message was, so undo is exact", async () => {
		const mbx = "mbx-bulk-undo";
		const a = await ingest(
			mbx,
			mime({ from: "a@example.org", subject: "A", messageId: "a1@example.org" }),
			"a1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		const a2 = await ingest(
			mbx,
			mime({
				from: "a@example.org",
				subject: "Re: A",
				messageId: "a2@example.org",
				inReplyTo: "a1@example.org",
			}),
			"a2@example.org",
			"2026-11-10T10:00:00.000Z",
		);
		expect(a2.threadId).toBe(a.threadId);
		const b = await ingest(
			mbx,
			mime({ from: "b@example.org", subject: "B", messageId: "b1@example.org" }),
			"b1@example.org",
			"2026-11-10T11:00:00.000Z",
		);
		// One message of A already archived, so undo must not drop it in the inbox.
		await bulk(mbx, "archive", { messageIds: [a.messageLocalId] });

		const trashed = await bulk(mbx, "trash", { threadIds: [a.threadId, b.threadId] });
		const before = Object.fromEntries(trashed.changed.map((c) => [c.id, c.state]));
		expect(before).toEqual({
			[a.messageLocalId]: "archive",
			[a2.messageLocalId]: "inbox",
			[b.messageLocalId]: "inbox",
		});
		expect((await list(mbx, "limit=50&state=inbox")).length).toBe(0);

		// Undo, as the client does it: each message back to where it was.
		await bulk(mbx, "archive", { messageIds: [a.messageLocalId] });
		await bulk(mbx, "restore_inbox", { messageIds: [a2.messageLocalId, b.messageLocalId] });
		const states = Object.fromEntries((await thread(mbx, a.threadId)).map((m) => [m.id, m.state]));
		expect(states).toEqual({ [a.messageLocalId]: "archive", [a2.messageLocalId]: "inbox" });
		expect((await thread(mbx, b.threadId))[0]?.state).toBe("inbox");

		// An action that changes nothing reports nothing.
		expect((await bulk(mbx, "restore_inbox", { threadIds: [b.threadId] })).changed).toEqual([]);
	});

	it("marks every unread conversation of a folder read, and only that folder", async () => {
		const mbx = "mbx-mark-all";
		const ids = await seed(mbx);
		await bulk(mbx, "archive", { threadIds: ids.slice(0, 3) });
		const result = await bulk(mbx, "mark_read", { folder: { state: "inbox", reports: "exclude" } });
		expect(result.changed).toHaveLength(7);
		expect(result.changed.every((c) => c.is_read === 0)).toBe(true);
		expect(await list(mbx, "limit=50&state=inbox&unread=true")).toEqual([]);
		expect((await list(mbx, "limit=50&state=archive&unread=true")).length).toBe(3);
	});
});

describe("discarded drafts", () => {
	async function draft(mailboxId: string, origin?: string): Promise<string> {
		const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			"https://mailbox-do/drafts",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ to: ["x@example.org"], subject: "Hi", bodyText: "Hello", origin }),
			},
		);
		return ((await response.json()) as { id: string }).id;
	}
	async function post(mailboxId: string, path: string): Promise<Response> {
		return testEnv.MAILBOX_DO.getByName(mailboxId).fetch(`https://mailbox-do${path}`, {
			method: "POST",
		});
	}

	it("come back on undo; an agent's draft does not", async () => {
		const mbx = "mbx-draft-restore";
		const mine = await draft(mbx);
		expect((await post(mbx, `/drafts/${mine}/cancel`)).status).toBe(200);
		expect((await post(mbx, `/drafts/${mine}/restore`)).status).toBe(200);
		const restored = await testEnv.MAILBOX_DO.getByName(mbx).fetch(
			`https://mailbox-do/drafts/${mine}`,
		);
		expect(((await restored.json()) as { draft: { status: string } }).draft.status).toBe("draft");
		// Not cancelled: nothing to restore.
		expect((await post(mbx, `/drafts/${mine}/restore`)).status).toBe(409);

		const agents = await draft(mbx, "mcp");
		await post(mbx, `/drafts/${agents}/cancel`);
		expect((await post(mbx, `/drafts/${agents}/restore`)).status).toBe(409);
	});
});

describe("sender names and Reply-To", () => {
	it("keeps Reply-To at ingest", async () => {
		const mbx = "mbx-reply-to";
		const { threadId } = await ingest(
			mbx,
			mime({
				from: "Form <noreply@example.org>",
				subject: "Contact",
				messageId: "rt1@example.org",
				replyTo: "Visitor <Visitor@Example.net>",
			}),
			"rt1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		const [message] = await thread(mbx, threadId);
		expect(JSON.parse(String(message?.reply_to_json))).toEqual(["visitor@example.net"]);
	});

	it("fills an older row's name and Reply-To from its raw headers on first open, once", async () => {
		const mbx = "mbx-name-backfill";
		const { threadId, messageLocalId } = await ingest(
			mbx,
			mime({
				from: "=?UTF-8?Q?Rub=C3=A9n_Garc=C3=ADa?= <info@example.org>",
				subject: "Quote",
				messageId: "nb1@example.org",
				replyTo: "sales@example.org",
			}),
			"nb1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		// As stored before names and Reply-To were kept.
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(mbx), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE messages SET from_name = NULL, reply_to_json = NULL WHERE id = ?",
				messageLocalId,
			);
		});
		const [opened] = await thread(mbx, threadId);
		expect(opened?.from_name).toBe("Rubén García");
		expect(JSON.parse(String(opened?.reply_to_json))).toEqual(["sales@example.org"]);

		// Done once: with the raw object gone, a later open keeps what was stored.
		await testEnv.MAIL_OBJECTS.delete(String(opened?.raw_r2_key));
		const [again] = await thread(mbx, threadId);
		expect(again?.from_name).toBe("Rubén García");
	});

	it("never takes a name that claims another address", async () => {
		const mbx = "mbx-name-spoof";
		const { threadId, messageLocalId } = await ingest(
			mbx,
			mime({
				from: '"ceo@bank.example" <attacker@example.org>',
				subject: "Urgent",
				messageId: "sp1@example.org",
			}),
			"sp1@example.org",
			"2026-11-10T09:00:00.000Z",
		);
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(mbx), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE messages SET from_name = NULL, reply_to_json = NULL WHERE id = ?",
				messageLocalId,
			);
		});
		const [opened] = await thread(mbx, threadId);
		expect(opened?.from_name).toBeNull();
		expect(opened?.reply_to_json).toBe("[]");
	});
});
