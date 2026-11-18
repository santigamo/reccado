import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { EMAIL_BASE_STYLE } from "#/lib/email-html";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import worker, { withHtmlSecurityHeaders } from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

/**
 * Rich text in the web inbox, end to end at the HTTP edge:
 *  - a message's HTML is framable by the app itself and by nothing else, while
 *    every other response (and the approval/login/consent pages) stays DENY;
 *  - links in it open in a new tab without opener or referrer, cid: images
 *    resolve to the message's own attachments;
 *  - HTML the owner writes is sanitised before the mailbox DO stores it, and its
 *    text/plain alternative is derived from the clean markup.
 */

type TestEnv = Env & { INDEX_DB: D1Database; MAIL_OBJECTS: R2Bucket };
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	for (const sql of [migrationInitial, migrationMessageIndex, migrationMailboxOwner]) {
		for (const statement of splitSqlStatements(sql as string)) {
			await testEnv.INDEX_DB.prepare(statement).run();
		}
	}
});

async function fetchWorker(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function createMailbox(mailboxId: string, address: string): Promise<void> {
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(mailboxId, address, null, "active", "dev@local", now, now)
		.run();
}

async function ingestRaw(mailboxId: string, raw: string, messageId: string): Promise<string> {
	const rawBytes = new TextEncoder().encode(raw);
	const rawSha256 = await sha256Hex(rawBytes);
	const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: new Date().toISOString(),
		receivedAt: new Date().toISOString(),
		mailboxId,
		domain: "example.com",
		recipient: "html-route@example.com",
		sender: "rico@example.org",
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId,
		headers: { subject: null, date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: "html-route@example.com" },
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
	return ((await response.json()) as { messageLocalId: string }).messageLocalId;
}

// A newsletter-shaped mail: multipart/related HTML with an inline (cid:) logo.
const RELATED = [
	"From: Rico <rico@example.org>",
	"To: html-route@example.com",
	"Subject: Inline image",
	"Message-ID: <inline-image@example.org>",
	"MIME-Version: 1.0",
	'Content-Type: multipart/related; boundary="rel"',
	"",
	"--rel",
	"Content-Type: text/html; charset=utf-8",
	"",
	'<html><head></head><body><p>Hi <a href="https://example.org/x">there</a></p><img src="cid:logo@example.org"><img src="cid:missing@example.org"><img src="https://example.org/remote.png"></body></html>',
	"--rel",
	"Content-Type: image/png",
	"Content-Transfer-Encoding: base64",
	"Content-ID: <logo@example.org>",
	'Content-Disposition: inline; filename="logo.png"',
	"",
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"--rel--",
	"",
].join("\r\n");

describe("GET /messages/:id/html framing", () => {
	it("is framable by the app only, links open safely, cid images resolve", async () => {
		const mailboxId = "mbx_html_route_frame";
		await createMailbox(mailboxId, "html-route@example.com");
		const messageId = await ingestRaw(mailboxId, RELATED, "inline-image@example.org");

		const response = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/messages/${messageId}/html`),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("frame-ancestors 'self'");
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).not.toContain("script-src");
		// Remote images are a read receipt: blocked until the reader asks.
		expect(csp).toContain("img-src 'self' data:;");
		// Fonts: this origin's own copy of Inter, inline data:, nothing remote.
		expect(csp).toContain("font-src 'self' data:;");
		expect(csp).not.toMatch(/https?:/);
		const shown = await fetchWorker(
			new Request(
				`http://localhost/api/mailboxes/${mailboxId}/messages/${messageId}/html?images=1`,
			),
		);
		expect(shown.headers.get("content-security-policy")).toContain(
			"img-src 'self' data: https: http:",
		);
		expect(shown.headers.get("content-security-policy")).toContain("font-src 'self' data: https:");
		expect(await shown.text()).toContain('src="https://example.org/remote.png"');

		const html = await response.text();
		expect(html).toContain('target="_blank"');
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toMatch(
			new RegExp(
				`src="/api/mailboxes/${mailboxId}/messages/${messageId}/attachments/[^"]+\\?inline=1"`,
			),
		);
		// An unresolvable cid: is dropped rather than left as a broken request.
		expect(html).not.toContain("cid:");
		// With images off the remote source is not even in the markup.
		expect(html).toContain('data-blocked-src="https://example.org/remote.png"');
		expect(html).not.toContain(' src="https://example.org/remote.png"');
	});

	it("never serves a meta refresh, a sender <base> or a referrer override, in either mode", async () => {
		const mailboxId = "mbx_html_route_refresh";
		await createMailbox(mailboxId, "html-route-refresh@example.com");
		const raw = [
			"From: Rico <rico@example.org>",
			"To: html-route@example.com",
			"Subject: Beacon",
			"Message-ID: <refresh@example.org>",
			"MIME-Version: 1.0",
			"Content-Type: text/html; charset=utf-8",
			"",
			`<html><head><META HTTP-EQUIV='Refresh' content='0;url=https://t.example/r'><base href="https://t.example/"><meta name=referrer content=unsafe-url><link rel=dns-prefetch href="//t.example"></head><body><p style="background:url(https://t.example/c)">Hi</p></body></html>`,
			"",
		].join("\r\n");
		const messageId = await ingestRaw(mailboxId, raw, "refresh@example.org");
		for (const query of ["", "?images=1"]) {
			const response = await fetchWorker(
				new Request(
					`http://localhost/api/mailboxes/${mailboxId}/messages/${messageId}/html${query}`,
				),
			);
			expect(response.status).toBe(200);
			const html = await response.text();
			expect(html).not.toMatch(/refresh|unsafe-url|<link|<base href/i);
			expect(html).toContain('<base target="_blank" rel="noopener noreferrer">');
			// Typography defaults come first, at zero specificity, so the mail's own CSS wins.
			expect(html).toContain(EMAIL_BASE_STYLE);
			expect(html).toContain(":where(html){font-family:Inter");
			// Inter is this origin's own copy, never a remote one.
			expect(html).toContain("src:url(/fonts/inter/inter-latin-wght-normal.woff2)");
			expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
			if (!query) expect(html).not.toContain("t.example");
		}
	});

	it("answers markup the parser refuses with an error the client falls back from", async () => {
		const mailboxId = "mbx_html_route_unparsable";
		await createMailbox(mailboxId, "html-route-unparsable@example.com");
		const raw = [
			"From: Rico <rico@example.org>",
			"To: html-route@example.com",
			"Subject: Frames",
			"Message-ID: <frameset@example.org>",
			"MIME-Version: 1.0",
			"Content-Type: text/html; charset=utf-8",
			"",
			"<body><frameset></frameset><style>a{}</style></body>",
			"",
		].join("\r\n");
		const messageId = await ingestRaw(mailboxId, raw, "frameset@example.org");
		const response = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/messages/${messageId}/html`),
		);
		expect(response.status).toBe(422);
		expect(response.headers.get("content-type")).toContain("application/json");
	});

	it("every other API response keeps DENY", async () => {
		const mailboxId = "mbx_html_route_frame";
		const threads = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/threads`),
		);
		expect(threads.headers.get("x-frame-options")).toBe("DENY");
		// The raw message is not the framed HTML body, even though it carries the id.
		const raw = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/messages/x/raw`),
		);
		expect(raw.headers.get("x-frame-options")).toBe("DENY");
	});

	it("approval, login and consent pages are never framable", () => {
		for (const path of ["/approve/abc", "/login", "/consent", "/inbox"]) {
			const response = withHtmlSecurityHeaders(
				new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
				path,
			);
			expect(response.headers.get("x-frame-options")).toBe("DENY");
			expect(response.headers.get("content-security-policy")).toBe(
				"frame-ancestors 'none'; frame-src 'self'",
			);
		}
	});
});

describe("owner HTML drafts", () => {
	it("are sanitised before storage, with a derived text alternative", async () => {
		const mailboxId = "mbx_html_route_drafts";
		await createMailbox(mailboxId, "drafts-route@example.com");
		const created = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/drafts`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: ["rico@example.org"],
					subject: "Rich",
					bodyText: "client text that must not win",
					bodyHtml:
						'<div><b>Hello</b> <a href="javascript:alert(1)" onclick="x()">x</a></div><script>alert(1)</script><img src="https://t.example/p.gif"><ul><li>One</li></ul>',
				}),
			}),
		);
		expect(created.status).toBe(201);
		const { id } = (await created.json()) as { id: string };

		const read = async () => {
			const response = await fetchWorker(
				new Request(`http://localhost/api/mailboxes/${mailboxId}/drafts/${id}`),
			);
			return ((await response.json()) as { draft: { body_html: string; body_text: string } }).draft;
		};
		let draft = await read();
		expect(draft.body_html).toBe("<div><b>Hello</b> <a>x</a></div><ul><li>One</li></ul>");
		expect(draft.body_text).toBe("Hello x\n- One");

		const patched = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/drafts/${id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					bodyHtml: '<p style="color: red; background: url(x)">Bye</p><iframe></iframe>',
				}),
			}),
		);
		expect(patched.status).toBe(200);
		draft = await read();
		expect(draft.body_html).toBe('<p style="color: red">Bye</p>');
		expect(draft.body_text).toBe("Bye");

		// A text-only draft (no bodyHtml) is untouched.
		const plain = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/drafts`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					to: ["rico@example.org"],
					subject: "Plain",
					bodyText: "<b>literal</b>",
				}),
			}),
		);
		const plainId = ((await plain.json()) as { id: string }).id;
		const plainDraft = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/drafts/${plainId}`),
		);
		const body = (await plainDraft.json()) as {
			draft: { body_html: string | null; body_text: string };
		};
		expect(body.draft.body_html).toBeNull();
		expect(body.draft.body_text).toBe("<b>literal</b>");
	});
});
