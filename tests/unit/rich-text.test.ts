import { describe, expect, it } from "vitest";
import { sanitizeOwnerHtml } from "#/lib/html-sanitize";
import { splitQuotedText, stripQuotedText } from "#/lib/quoted-text";
import {
	htmlToPlainText,
	linkifySegments,
	plainTextToEditorHtml,
	safeHref,
	sanitizeStyle,
} from "#/lib/rich-text";
import { buildParticipants, participantLabel, recipientsLabel } from "#/lib/thread-summary";

describe("sanitizeOwnerHtml (server, HTMLRewriter)", () => {
	it("keeps the formatting the editor produces", async () => {
		const html =
			'<div><b>Bold</b> <i>it</i> <u>u</u> <s>s</s></div><ul><li>One</li></ul><ol start="3"><li>Two</li></ol><blockquote style="margin: 0 0 0 0.8ex; border-left: 1px solid #cccccc; padding-left: 1ex">quoted</blockquote><a href="https://example.org/x?a=1&amp;b=2">link</a>';
		const clean = await sanitizeOwnerHtml(html);
		expect(clean).toContain("<b>Bold</b>");
		expect(clean).toContain("<i>it</i>");
		expect(clean).toContain("<u>u</u>");
		expect(clean).toContain('<ol start="3">');
		expect(clean).toContain("border-left: 1px solid #cccccc");
		expect(clean).toContain('href="https://example.org/x?a=1&amp;b=2"');
		expect(clean).toContain('rel="noopener noreferrer"');
	});

	it("drops scripts, event handlers, dangerous URLs and anything that loads", async () => {
		const html = [
			"<script>alert(1)</script>",
			'<img src="https://tracker.example/p.gif" onerror="alert(2)">',
			'<p onclick="alert(3)" class="x" id="y">text</p>',
			'<a href="javascript:alert(4)">js</a>',
			'<a href="java\tscript:alert(5)">tab</a>',
			'<a href="data:text/html,<script>alert(6)</script>">data</a>',
			'<iframe src="https://evil.example"></iframe>',
			"<svg><script>alert(7)</script></svg>",
			'<link rel="stylesheet" href="https://evil.example/x.css">',
			"<style>body{background:url(https://evil.example/bg)}</style>",
			'<div style="background-image: url(https://evil.example/i.png); color: red">styled</div>',
			'<span style="width: expression(alert(8))">expr</span>',
			'<form action="https://evil.example"><input name=a><button>go</button></form>',
			"<!-- secret comment -->",
			'<object data="x.swf"></object><embed src="x.swf">',
			'<meta http-equiv="refresh" content="0;url=https://evil.example">',
			'<base href="https://evil.example/">',
		].join("");
		const clean = await sanitizeOwnerHtml(html);
		expect(clean).not.toMatch(
			/script|onerror|onclick|javascript|iframe|svg|<img|<link|<style|url\(|expression|<form|<input|<button|comment|<object|<embed|<meta|<base|class=|id=|data:/i,
		);
		expect(clean).toContain("<p>text</p>");
		expect(clean).toContain('<div style="color: red">styled</div>');
		expect(clean).toContain("<a>js</a>");
		expect(clean).toContain("<span>expr</span>");
	});

	it("unwraps unknown tags but keeps their text", async () => {
		const clean = await sanitizeOwnerHtml(
			"<table><tr><td>cell</td></tr></table><font color=red>font</font><custom-el>x</custom-el>",
		);
		expect(clean).toBe("cellfontx");
	});
});

describe("sanitizeStyle / safeHref", () => {
	it("keeps inert properties only", () => {
		expect(sanitizeStyle("color: #333; position: fixed; font-weight: bold")).toBe(
			"color: #333; font-weight: bold",
		);
		expect(sanitizeStyle("color: red; background-color: url(x)")).toBe("color: red");
		expect(sanitizeStyle("color: var(--x)")).toBeNull();
		expect(sanitizeStyle("color: \\72 ed")).toBeNull();
		expect(sanitizeStyle("")).toBeNull();
	});

	it("allows http(s) and mailto only", () => {
		expect(safeHref("https://a.example")).toBe("https://a.example");
		expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
		expect(safeHref("javascript:alert(1)")).toBeNull();
		expect(safeHref(" JaVa\nScRiPt:alert(1)")).toBeNull();
		expect(safeHref("data:text/html,x")).toBeNull();
		expect(safeHref("/relative")).toBeNull();
		expect(safeHref("vbscript:x")).toBeNull();
	});
});

describe("htmlToPlainText (the text/plain alternative)", () => {
	it("turns structure into readable text", () => {
		const text = htmlToPlainText(
			'<div><b>Thanks</b> Rico,</div><div><br></div><div>see <a href="https://example.org/p">the proposal</a>.</div><ul><li>One</li><li>Two</li></ul><ol><li>First</li><li>Second</li></ol><div>On Mon, Rico &lt;rico@example.org&gt; wrote:</div><blockquote><p>Hi&nbsp;Santi,</p><p>Line two</p></blockquote>',
		);
		expect(text).toBe(
			[
				"Thanks Rico,",
				"",
				"see the proposal <https://example.org/p>.",
				"- One",
				"- Two",
				"",
				"1. First",
				"2. Second",
				"",
				"On Mon, Rico <rico@example.org> wrote:",
				"",
				"> Hi Santi,",
				">",
				"> Line two",
			].join("\n"),
		);
	});

	it("does not repeat a link whose text is the address, and ignores unsafe ones", () => {
		expect(htmlToPlainText('<a href="https://x.example">https://x.example</a>')).toBe(
			"https://x.example",
		);
		expect(htmlToPlainText('<a href="javascript:alert(1)">click</a>')).toBe("click");
	});

	it("drops script and style content", () => {
		expect(htmlToPlainText("<style>p{}</style><p>Hi</p><script>x()</script>")).toBe("Hi");
	});

	it("round-trips plain text through the editor format", () => {
		const text = "Line one\n\nLine <three> & more";
		expect(htmlToPlainText(plainTextToEditorHtml(text))).toBe(text);
	});
});

describe("linkifySegments", () => {
	it("finds URLs and addresses and leaves punctuation outside", () => {
		const segments = linkifySegments(
			"See https://example.org/a_(b). Mail ana@example.net, or www.x.io!",
		);
		expect(segments.filter((s) => s.href)).toEqual([
			{ text: "https://example.org/a_(b)", href: "https://example.org/a_(b)" },
			{ text: "ana@example.net", href: "mailto:ana@example.net" },
			{ text: "www.x.io", href: "https://www.x.io" },
		]);
		expect(segments.map((s) => s.text).join("")).toBe(
			"See https://example.org/a_(b). Mail ana@example.net, or www.x.io!",
		);
	});

	it("never turns a javascript: string into a link", () => {
		expect(linkifySegments("javascript:alert(1)").some((s) => s.href)).toBe(false);
	});
});

describe("quoted text", () => {
	it("splits a trailing quote with its attribution", () => {
		const text =
			"Sounds good.\n\nOn Mon, 16 Nov 2026 at 10:00, Rico <rico@example.org> wrote:\n> Plan?\n>\n> More\n";
		expect(splitQuotedText(text)).toEqual({
			body: "Sounds good.",
			quoted: "On Mon, 16 Nov 2026 at 10:00, Rico <rico@example.org> wrote:\n> Plan?\n>\n> More\n",
		});
		expect(stripQuotedText(text)).toBe("Sounds good.");
	});

	it("handles a wrapped attribution and Spanish clients", () => {
		expect(
			splitQuotedText(
				"Vale.\n\nEl lun, 16 nov 2026 a las 10:00, Rico (<rico@example.org>)\nescribió:\n> Hola",
			).body,
		).toBe("Vale.");
	});

	it("leaves interleaved replies and all-quote messages whole", () => {
		const interleaved = "> question one\nanswer one\n> question two\nanswer two";
		expect(splitQuotedText(interleaved).quoted).toBeNull();
		expect(splitQuotedText("> only a quote").quoted).toBeNull();
		expect(splitQuotedText("no quote here").quoted).toBeNull();
	});
});

describe("thread participants", () => {
	const msg = (
		from: string,
		direction: "inbound" | "outbound",
		isRead = 1,
		name: string | null = null,
	) => ({
		from_addr: from,
		from_name: name,
		direction,
		is_read: isRead,
	});

	it("lists senders oldest first, once each, with one 'me'", () => {
		const participants = buildParticipants([
			msg("rico@example.org", "inbound", 1, "Rico Alvarez"),
			msg("hello@imsanti.dev", "outbound"),
			msg("RICO@example.org", "inbound", 0),
			msg("shop@imsanti.dev", "outbound"),
		]);
		expect(participants).toEqual([
			{ address: "rico@example.org", name: "Rico Alvarez", me: false, unread: true },
			{ address: "hello@imsanti.dev", name: null, me: true, unread: false },
		]);
		expect(
			participantLabel(participants)
				.map((p) => p.separator + p.text)
				.join(""),
		).toBe("Rico, me");
	});

	it("uses the full name alone and elides long lists", () => {
		expect(
			participantLabel(buildParticipants([msg("a@x.io", "inbound", 1, "Ana Ruiz")]))[0]?.text,
		).toBe("Ana Ruiz");
		const many = buildParticipants([
			msg("a@x.io", "inbound", 1, "Ana Ruiz"),
			msg("b@x.io", "inbound", 1, "Bo Lind"),
			msg("c@x.io", "inbound", 1, "Cy Doe"),
			msg("me@x.io", "outbound"),
		]);
		expect(
			participantLabel(many)
				.map((p) => p.separator + p.text)
				.join(""),
		).toBe("Ana .. Cy, me");
	});

	it("names the recipients of an outbound-only conversation", () => {
		expect(recipientsLabel(["noor@haddad.dev"], { "noor@haddad.dev": "Noor Haddad" })).toBe(
			"To: Noor Haddad",
		);
		expect(
			recipientsLabel(["noor@haddad.dev", "rico@example.org"], {
				"noor@haddad.dev": "Noor Haddad",
			}),
		).toBe("To: Noor, rico");
	});
});
