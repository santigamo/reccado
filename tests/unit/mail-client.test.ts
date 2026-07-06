import { afterEach, describe, expect, it, vi } from "vitest";
import { searchThreads } from "#/lib/mail";

const timestamp = "2026-01-01T12:00:00.000Z";

describe("mail client search helpers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("hydrates thread rows from /search hits instead of filtering the loaded thread list", async () => {
		const calls: string[] = [];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);

			if (url.includes("/search?")) {
				return Response.json({ results: [{ message_id: "msg_body_match" }] });
			}

			if (url.endsWith("/messages/msg_body_match")) {
				return Response.json({
					message: {
						id: "msg_body_match",
						thread_id: "thr_body_match",
						rfc_message_id: "<msg_body_match@example.com>",
						in_reply_to: null,
						direction: "inbound",
						state: "inbox",
						from_addr: "sender@example.com",
						to_json: '["test@example.com"]',
						cc_json: "[]",
						bcc_json: "[]",
						subject: "Plain subject",
						snippet: "Snippet from the matching message",
						date_header: null,
						received_at: timestamp,
						body_text: "The hidden body token matched here.",
						has_attachments: 0,
						is_read: 0,
						created_at: timestamp,
						updated_at: timestamp,
						attachments: [],
					},
				});
			}

			if (url.endsWith("/threads/thr_body_match")) {
				return Response.json({
					thread: {
						id: "thr_body_match",
						subject_norm: "plain subject",
						last_message_at: timestamp,
						message_count: 2,
						unread_count: 1,
						created_at: timestamp,
						updated_at: timestamp,
					},
					messages: [],
				});
			}

			return Response.json({ error: "unexpected_url", url }, { status: 500 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const rows = await searchThreads("mbx_client_search", "hidden body token", { state: "inbox" });

		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe("thr_body_match");
		expect(rows[0]?.latest_from).toBe("sender@example.com");
		expect(calls[0]).toContain("/api/mailboxes/mbx_client_search/search?");
		expect(calls.some((url) => url.includes("/threads?"))).toBe(false);
	});
});
