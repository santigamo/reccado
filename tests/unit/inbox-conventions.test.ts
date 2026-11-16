import { describe, expect, it } from "vitest";
import { bulkActionSchema, threadListQuerySchema } from "#/api/schemas";
import { leavesFolder } from "#/components/inbox/use-thread-actions";
import { invalidAddresses } from "#/components/mail/ComposeModal";
import { formatDayTime, formatListDate } from "#/lib/dates";
import { inboxFolderByKey, listSearch, parseInboxSearch } from "#/lib/inbox-search";
import { headerBlock, parseHeaderFields, replyToAddresses } from "#/lib/mime";
import { forwardSubject, replyRecipients, replySubject, replyTarget } from "#/lib/reply";
import { compareRows, mergePages, pageCursor } from "#/lib/thread-paging";
import { actionToast, undoSteps } from "#/lib/undo";
import { documentTitle, faviconHref } from "#/lib/use-document-badge";
import { parseInboxLayout } from "#/lib/use-inbox-layout";

const OWN = ["hello@imsanti.dev", "billing@imsanti.dev", "Alias@ImSanti.dev"];

function msg(overrides: Partial<Parameters<typeof replyRecipients>[0]> = {}) {
	return {
		id: "m1",
		direction: "inbound" as const,
		from_addr: "ruben@example.org",
		to_json: JSON.stringify(["hello@imsanti.dev"]),
		cc_json: "[]",
		subject: "Quote",
		reply_to_json: "[]",
		...overrides,
	};
}

describe("reply recipients", () => {
	it("replies to the sender", () => {
		expect(replyRecipients(msg(), "reply", OWN)).toEqual({ to: ["ruben@example.org"], cc: [] });
	});

	it("replies to Reply-To when the sender set one", () => {
		const m = msg({ from_addr: "noreply@forms.example", reply_to_json: '["visitor@example.net"]' });
		expect(replyRecipients(m, "reply", OWN).to).toEqual(["visitor@example.net"]);
		// Reply all still includes whoever sent it.
		expect(replyRecipients(m, "reply_all", OWN)).toEqual({
			to: ["visitor@example.net"],
			cc: ["noreply@forms.example"],
		});
	});

	it("reply all adds the other To and Cc, never any of your own addresses, never twice", () => {
		const m = msg({
			to_json: JSON.stringify(["hello@imsanti.dev", "Ana <ana@example.org>", "alias@imsanti.dev"]),
			cc_json: JSON.stringify([
				"BILLING@imsanti.dev",
				"ana@example.org",
				"luis@example.org",
				"ruben@example.org",
			]),
		});
		expect(replyRecipients(m, "reply_all", OWN)).toEqual({
			to: ["ruben@example.org"],
			cc: ["ana@example.org", "luis@example.org"],
		});
	});

	it("following up on your own message writes to the same people", () => {
		const m = msg({
			direction: "outbound",
			from_addr: "hello@imsanti.dev",
			to_json: JSON.stringify(["ruben@example.org"]),
			cc_json: JSON.stringify(["ana@example.org", "hello@imsanti.dev"]),
		});
		expect(replyRecipients(m, "reply", OWN)).toEqual({ to: ["ruben@example.org"], cc: [] });
		expect(replyRecipients(m, "reply_all", OWN)).toEqual({
			to: ["ruben@example.org"],
			cc: ["ana@example.org"],
		});
	});

	it("a note to yourself still has a recipient", () => {
		const m = msg({ from_addr: "hello@imsanti.dev" });
		expect(replyRecipients(m, "reply", OWN).to).toEqual(["hello@imsanti.dev"]);
	});

	it("targets the newest message someone else sent", () => {
		const a = { id: "a", direction: "inbound" as const };
		const b = { id: "b", direction: "inbound" as const };
		const mine = { id: "c", direction: "outbound" as const };
		expect(replyTarget([a, b, mine])?.id).toBe("b");
		expect(replyTarget([mine])?.id).toBe("c");
		expect(replyTarget([])).toBeUndefined();
	});
});

describe("reply and forward subjects", () => {
	it("never doubles the prefix", () => {
		expect(replySubject("Quote")).toBe("Re: Quote");
		expect(replySubject("Re: Quote")).toBe("Re: Quote");
		expect(replySubject("RE: re: Re:Quote")).toBe("Re: Quote");
		expect(replySubject("AW: Angebot")).toBe("Re: Angebot");
		expect(replySubject("Fwd: Quote")).toBe("Re: Fwd: Quote");
		expect(replySubject(null)).toBe("Re:");
		expect(forwardSubject("Quote")).toBe("Fwd: Quote");
		expect(forwardSubject("Fw: FWD: Quote")).toBe("Fwd: Quote");
		expect(forwardSubject("Re: Quote")).toBe("Fwd: Re: Quote");
	});
});

describe("merged paging across mailboxes", () => {
	const row = (id: string, at: string) => ({ id, latest_received_at: at });

	it("shows only rows no mailbox can still precede, and names the mailbox to load next", () => {
		const merged = mergePages([
			{
				mailboxId: "a",
				items: [row("a1", "2026-11-16T10:00:00Z"), row("a2", "2026-11-14T10:00:00Z")],
				hasMore: true,
			},
			{
				mailboxId: "b",
				items: [
					row("b1", "2026-11-15T10:00:00Z"),
					row("b2", "2026-11-13T10:00:00Z"),
					row("b3", "2026-11-12T10:00:00Z"),
				],
				hasMore: false,
			},
		]);
		// a may have more mail between Nov 14 and Nov 12: b2 and b3 wait.
		expect(merged.items.map((r) => r.id)).toEqual(["a1", "b1", "a2"]);
		expect(merged.items[1]?.mailbox_id).toBe("b");
		expect(merged.hasMore).toBe(true);
		expect(merged.next).toBe("a");
	});

	it("the newest frontier wins when several mailboxes have more", () => {
		const merged = mergePages([
			{ mailboxId: "a", items: [row("a1", "2026-11-10T00:00:00Z")], hasMore: true },
			{ mailboxId: "b", items: [row("b1", "2026-11-12T00:00:00Z")], hasMore: true },
		]);
		expect(merged.items.map((r) => r.id)).toEqual(["b1"]);
		expect(merged.next).toBe("b");
	});

	it("shows everything at the end of every mailbox", () => {
		const merged = mergePages([
			{ mailboxId: "a", items: [row("a1", "2026-11-10T00:00:00Z")], hasMore: false },
			{ mailboxId: "b", items: [row("b1", "2026-11-12T00:00:00Z")], hasMore: false },
		]);
		expect(merged).toMatchObject({ hasMore: false, next: null });
		expect(merged.items.map((r) => r.id)).toEqual(["b1", "a1"]);
	});

	it("orders ties by thread id and builds the cursor from the last row", () => {
		const x = row("x", "2026-11-10T00:00:00Z");
		const y = row("y", "2026-11-10T00:00:00Z");
		expect([x, y].sort(compareRows).map((r) => r.id)).toEqual(["y", "x"]);
		expect(pageCursor(x)).toBe("2026-11-10T00:00:00Z|x");
	});
});

describe("undo", () => {
	const changed = [
		{ id: "1", thread_id: "t", state: "inbox", is_read: 0 },
		{ id: "2", thread_id: "t", state: "archive", is_read: 1 },
		{ id: "3", thread_id: "t", state: "sent", is_read: 1 },
	];

	it("puts every moved message back where it was", () => {
		expect(undoSteps("trash", changed)).toEqual([
			{ action: "restore_inbox", messageIds: ["1", "3"] },
			{ action: "archive", messageIds: ["2"] },
		]);
	});

	it("flips read state back for exactly the messages that changed", () => {
		expect(undoSteps("mark_read", changed.slice(0, 1))).toEqual([
			{ action: "mark_unread", messageIds: ["1"] },
		]);
		expect(undoSteps("archive", [])).toEqual([]);
	});

	it("says what happened", () => {
		expect(actionToast("archive", 1)).toBe("Conversation archived");
		expect(actionToast("trash", 3)).toBe("3 conversations moved to Trash");
		expect(actionToast("mark_unread", 1)).toBe("Marked as unread");
	});

	it("knows which actions take a row out of the folder", () => {
		const inbox = inboxFolderByKey("inbox");
		expect(leavesFolder(inbox, "archive")).toBe(true);
		expect(leavesFolder(inbox, "restore_inbox")).toBe(false);
		expect(leavesFolder(inbox, "mark_read")).toBe(false);
		expect(leavesFolder(inboxFolderByKey("archive"), "restore_inbox")).toBe(true);
		expect(leavesFolder(inboxFolderByKey("sent"), "archive")).toBe(false);
		expect(leavesFolder(inboxFolderByKey("sent"), "trash")).toBe(true);
		expect(leavesFolder(inboxFolderByKey("all"), "trash")).toBe(false);
		expect(leavesFolder(inboxFolderByKey("trash"), "trash")).toBe(false);
	});
});

describe("dates", () => {
	const now = new Date(2026, 10, 16, 15, 0);
	it("today is a time, this year a day, older with the year", () => {
		expect(formatListDate(new Date(2026, 10, 16, 9, 5), now)).toBe("09:05");
		expect(formatListDate(new Date(2026, 10, 15, 9, 5), now)).toBe("Yesterday");
		expect(formatListDate(new Date(2026, 1, 3, 9, 5), now)).toBe("Feb 3");
		expect(formatListDate(new Date(2025, 10, 15, 9, 5), now)).toBe("Nov 15, 2025");
		expect(formatDayTime(new Date(2026, 10, 16, 9, 5), now)).toBe("Today, 09:05");
	});
});

describe("browser tab", () => {
	it("says the folder and what is unread", () => {
		expect(documentTitle("Inbox", 3)).toBe("(3) Inbox — Reccado");
		expect(documentTitle("Inbox", 0)).toBe("Inbox — Reccado");
		expect(documentTitle("Inbox", 4200)).toBe("(999+) Inbox — Reccado");
		expect(decodeURIComponent(faviconHref(true))).toContain("<circle");
		expect(decodeURIComponent(faviconHref(false))).not.toContain("<circle");
	});
});

describe("URL state", () => {
	it("keeps the unread filter in list links and drops compose fields", () => {
		const search = parseInboxSearch({
			folder: "archive",
			unread: "true",
			compose: "true",
			cc: "a@b.co",
		});
		expect(search.unread).toBe(true);
		expect(search.cc).toBe("a@b.co");
		expect(listSearch(search)).toEqual({
			mailbox: undefined,
			folder: "archive",
			q: undefined,
			unread: true,
		});
	});
});

describe("compose validation", () => {
	it("names the addresses that would not be accepted", () => {
		expect(invalidAddresses(["ok@example.org", "nope", "a@b", "x@y.co"])).toEqual(["nope", "a@b"]);
	});
});

describe("Reply-To and header-only parsing", () => {
	it("keeps plain addresses, flattens groups, drops junk", () => {
		expect(
			replyToAddresses([
				{ address: "A@Example.org" },
				{ address: "a@example.org" },
				{ address: "not an address" },
				{ group: [{ address: "b@example.org" }] },
			]),
		).toEqual(["a@example.org", "b@example.org"]);
	});

	it("reads the name and Reply-To from the header block alone", async () => {
		const raw = new TextEncoder().encode(
			'From: "=?UTF-8?Q?Rub=C3=A9n?=" <ruben@example.org>\r\nReply-To: sales@example.org\r\nSubject: x\r\n\r\nbody that is never parsed',
		);
		const head = headerBlock(raw);
		expect(new TextDecoder().decode(head)).not.toContain("body");
		expect(await parseHeaderFields(head)).toEqual({
			fromAddress: "ruben@example.org",
			fromName: "Rubén",
			replyTo: ["sales@example.org"],
		});
	});
});

describe("API schemas", () => {
	it("bulk actions take exactly one target, and a folder only for mark_read", () => {
		expect(bulkActionSchema.safeParse({ action: "archive", threadIds: ["t1"] }).success).toBe(true);
		expect(
			bulkActionSchema.safeParse({ action: "archive", threadIds: ["t1"], messageIds: ["m"] })
				.success,
		).toBe(false);
		expect(bulkActionSchema.safeParse({ action: "archive" }).success).toBe(false);
		expect(
			bulkActionSchema.safeParse({ action: "mark_read", folder: { state: "inbox" } }).success,
		).toBe(true);
		expect(
			bulkActionSchema.safeParse({ action: "trash", folder: { state: "inbox" } }).success,
		).toBe(false);
		expect(
			bulkActionSchema.safeParse({ action: "archive", threadIds: Array(101).fill("t") }).success,
		).toBe(false);
	});

	it("the thread list accepts a cursor and the unread filter", () => {
		const q = threadListQuerySchema.parse({ cursor: "2026-11-16T00:00:00Z|t1", unread: "true" });
		expect(q).toMatchObject({ cursor: "2026-11-16T00:00:00Z|t1", unread: "true" });
	});
});

describe("folded columns", () => {
	it("reads the remembered layout safely", () => {
		expect(parseInboxLayout(null)).toEqual({ mailboxesFolded: false, listFolded: false });
		expect(parseInboxLayout("not json")).toEqual({ mailboxesFolded: false, listFolded: false });
		expect(parseInboxLayout('{"mailboxesFolded":true,"listFolded":"yes"}')).toEqual({
			mailboxesFolded: true,
			listFolded: false,
		});
	});
});
