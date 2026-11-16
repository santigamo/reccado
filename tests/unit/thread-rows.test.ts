import { describe, expect, it } from "vitest";
import { byLatestActivity, type Message, summarizeThread } from "#/lib/mail";
import { rowIsUnread, withReadState } from "#/lib/use-read-state";
import type { UnifiedThreadRow } from "#/lib/use-unified-mail";

function message(over: Partial<Message>): Message {
	return {
		id: "m",
		thread_id: "t1",
		rfc_message_id: null,
		in_reply_to: null,
		direction: "inbound",
		state: "inbox",
		from_addr: "rico@example.org",
		from_name: "Rico",
		to_json: '["hello@imsanti.dev"]',
		cc_json: "[]",
		bcc_json: "[]",
		subject: "Plan",
		snippet: "snippet",
		date_header: null,
		received_at: "2026-11-10T09:00:00.000Z",
		body_text: "x",
		body_html_r2_key: null,
		has_attachments: 0,
		is_read: 1,
		created_at: "2026-11-10T09:00:00.000Z",
		updated_at: "2026-11-10T09:00:00.000Z",
		...over,
	};
}

describe("search rows (summarizeThread)", () => {
	const detail = {
		thread: null,
		messages: [
			message({ id: "a", is_read: 0 }),
			message({
				id: "b",
				direction: "outbound",
				state: "sent",
				from_addr: "hello@imsanti.dev",
				to_json: '["rico@example.org"]',
				received_at: "2026-11-11T09:00:00.000Z",
				snippet: "my reply",
			}),
			message({
				id: "c",
				state: "trash",
				received_at: "2026-11-12T09:00:00.000Z",
				snippet: "binned",
			}),
		],
	};

	it("represents a conversation by its newest message outside the trash", () => {
		const row = summarizeThread(detail, "inbox")!;
		expect(row.latest_snippet).toBe("my reply");
		expect(row.latest_direction).toBe("outbound");
		expect(row.message_count).toBe(2);
		expect(row.unread_count).toBe(1);
		expect(row.participants?.map((p) => (p.me ? "me" : p.address))).toEqual([
			"rico@example.org",
			"me",
		]);
	});

	it("shows only trashed messages in Trash, and everything in All mail", () => {
		expect(summarizeThread(detail, "trash")?.latest_snippet).toBe("binned");
		expect(summarizeThread(detail, null)?.message_count).toBe(3);
	});
});

describe("search rows and automated reports", () => {
	const report = message({
		id: "r",
		from_addr: "noreply-dmarc-support@google.com",
		received_at: "2026-11-13T09:00:00.000Z",
		snippet: "aggregate report",
		automated_kind: "dmarc_report",
	});

	it("a conversation made only of reports has no row in the people's folders", () => {
		expect(summarizeThread({ thread: null, messages: [report] }, "inbox")).toBeNull();
		expect(summarizeThread({ thread: null, messages: [report] }, null)).toBeNull();
		expect(
			summarizeThread({ thread: null, messages: [report] }, null, "reports")?.latest_snippet,
		).toBe("aggregate report");
	});

	it("a report in a person's conversation neither hides it nor represents it", () => {
		const row = summarizeThread(
			{ thread: null, messages: [message({ id: "a", is_read: 0 }), report] },
			"inbox",
		)!;
		expect(row.latest_snippet).toBe("snippet");
		expect(row.message_count).toBe(1);
	});
});

describe("optimistic read state (withReadState)", () => {
	const row = {
		...summarizeThread({ thread: null, messages: [message({ id: "a", is_read: 0 })] }, "inbox")!,
		mailbox_id: "mbx",
	} satisfies UnifiedThreadRow;

	it("reads and unreads a row, participants included", () => {
		expect(rowIsUnread(row)).toBe(true);
		const read = withReadState(row, true);
		expect(rowIsUnread(read)).toBe(false);
		expect(read.participants?.every((p) => !p.unread)).toBe(true);
		expect(rowIsUnread(withReadState(read, false))).toBe(true);
	});

	it("returns the same row when nothing changes", () => {
		expect(withReadState(row, false)).toBe(row);
	});
});

describe("byLatestActivity", () => {
	it("sorts newest first with a stable tie-breaker", () => {
		const rows = [
			{ id: "a", latest_received_at: "2026-11-10T09:00:00.000Z" },
			{ id: "c", latest_received_at: "2026-11-12T09:00:00.000Z" },
			{ id: "b", latest_received_at: "2026-11-10T09:00:00.000Z" },
		];
		expect([...rows].sort(byLatestActivity).map((r) => r.id)).toEqual(["c", "b", "a"]);
		expect(
			[...rows]
				.reverse()
				.sort(byLatestActivity)
				.map((r) => r.id),
		).toEqual(["c", "b", "a"]);
	});
});
