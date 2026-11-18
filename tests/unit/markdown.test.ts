import { describe, expect, it } from "vitest";
import { sanitizeOwnerHtml } from "#/lib/html-sanitize";
import { renderMarkdown } from "#/lib/markdown";
import { ALLOWED_TAGS } from "#/lib/rich-text";

/**
 * Markdown an agent writes, rendered into the two parts of a mail. The HTML and
 * the text come from the same parse; the HTML holds only allowlisted tags and
 * never anything the Markdown author typed as markup.
 */

const html = (md: string) => renderMarkdown(md).html;
const text = (md: string) => renderMarkdown(md).text;

describe("renderMarkdown: the supported subset", () => {
	it("paragraphs, with a single newline as a line break", () => {
		const out = renderMarkdown("Hi Ana,\n\nThanks for the reply.\nTalk soon.\n\nBest,\nSanti");
		expect(out.html).toBe(
			"<p>Hi Ana,</p>\n<p>Thanks for the reply.<br>\nTalk soon.</p>\n<p>Best,<br>\nSanti</p>",
		);
		expect(out.text).toBe("Hi Ana,\n\nThanks for the reply.\nTalk soon.\n\nBest,\nSanti");
	});

	it("bold, italic and inline code, with no markers left in the text part", () => {
		const out = renderMarkdown("**bold** __also__ *it* _it2_ `a < b`");
		expect(out.html).toBe(
			"<p><strong>bold</strong> <strong>also</strong> <em>it</em> <em>it2</em> <code>a &lt; b</code></p>",
		);
		expect(out.text).toBe("bold also it it2 a < b");
		expect(out.text).not.toMatch(/[*_`]/);
	});

	it("nested emphasis", () => {
		expect(html("***both***")).toBe("<p><strong><em>both</em></strong></p>");
		expect(html("*a **b** c*")).toBe("<p><em>a <strong>b</strong> c</em></p>");
		expect(html("**a *b* c**")).toBe("<p><strong>a <em>b</em> c</strong></p>");
		expect(text("***both*** *a **b** c*")).toBe("both a b c");
	});

	it("leaves snake_case, lone stars and unclosed markers as written", () => {
		expect(html("call snake_case_name and 2 * 3")).toBe("<p>call snake_case_name and 2 * 3</p>");
		expect(html("**not closed")).toBe("<p>**not closed</p>");
		expect(html("\\*escaped\\*")).toBe("<p>*escaped*</p>");
	});

	it("links: [text](url), <url>, bare URLs and mailto; text part as 'text (url)'", () => {
		const out = renderMarkdown(
			"See [the doc](https://example.com/doc), <https://example.com/a> and https://example.com/b. Mail [me](mailto:me@example.com).",
		);
		expect(out.html).toBe(
			'<p>See <a href="https://example.com/doc">the doc</a>, <a href="https://example.com/a">https://example.com/a</a> and <a href="https://example.com/b">https://example.com/b</a>. Mail <a href="mailto:me@example.com">me</a>.</p>',
		);
		expect(out.text).toBe(
			"See the doc (https://example.com/doc), https://example.com/a and https://example.com/b. Mail me (me@example.com).",
		);
	});

	it("keeps a balanced parenthesis in a link target", () => {
		expect(html("[wiki](https://en.wikipedia.org/wiki/Foo_(bar))")).toBe(
			'<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">wiki</a></p>',
		);
	});

	it("lists, ordered and unordered, with one level of nesting", () => {
		const md = "- one\n- two **b**\n  - nested\n  - nested 2\n- three\n\n3. c\n4. d";
		const out = renderMarkdown(md);
		expect(out.html).toBe(
			"<ul>\n<li>one</li>\n<li>two <strong>b</strong><ul>\n<li>nested</li>\n<li>nested 2</li>\n</ul></li>\n<li>three</li>\n</ul>\n" +
				'<ol start="3">\n<li>c</li>\n<li>d</li>\n</ol>',
		);
		expect(out.text).toBe("- one\n- two b\n  - nested\n  - nested 2\n- three\n\n3. c\n4. d");
	});

	it("headings become a modest bold line", () => {
		const out = renderMarkdown("# Big title\n\n### Small\nbody");
		expect(out.html).toBe(
			"<p><strong>Big title</strong></p>\n<p><strong>Small</strong></p>\n<p>body</p>",
		);
		expect(out.html).not.toMatch(/<h\d/);
		expect(out.text).toBe("Big title\n\nSmall\n\nbody");
	});

	it("quotes, rules and fenced code", () => {
		const out = renderMarkdown(
			"> quoted *text*\n> more\n\n---\n\n```\nif (a < b) {\n  go();\n}\n```",
		);
		expect(out.html).toContain(
			'<blockquote style="margin: 0 0 0 0.8ex; border-left: 2px solid #cccccc; padding-left: 1ex"><p>quoted <em>text</em><br>\nmore</p></blockquote>',
		);
		expect(out.html).toContain("<hr>");
		expect(out.html).toContain("<code>if (a &lt; b) {\n  go();\n}</code></pre>");
		expect(out.text).toBe("> quoted text\n> more\n\n---\n\nif (a < b) {\n  go();\n}");
	});

	it("emits only allowlisted tags", () => {
		const out = html(
			"# h\n\ntext **b** *i* `c` [l](https://x.example)\n\n- a\n  1. b\n\n> q\n\n---\n\n```\ncode\n```",
		);
		const tags = new Set([...out.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]!));
		for (const tag of tags) expect(ALLOWED_TAGS.has(tag), tag).toBe(true);
	});
});

describe("renderMarkdown: hostile input", () => {
	it("escapes raw HTML instead of passing it through", () => {
		const out = renderMarkdown(
			'<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>',
		);
		expect(out.html).not.toMatch(/<script|<img|<a /);
		expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
		// The text part says exactly what was written, as text.
		expect(out.text).toContain("<script>alert(1)</script>");
	});

	it("never links javascript:, data:, vbscript: or relative targets: the source shows as text", () => {
		for (const target of [
			"javascript:alert(1)",
			"JaVaScRiPt:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
			"vbscript:msgbox",
			"/relative",
			"//evil.example",
		]) {
			const out = renderMarkdown(`[click](${target})`);
			expect(out.html, target).not.toContain("<a");
			expect(out.html, target).not.toMatch(/href=/);
			expect(out.text, target).toContain("[click]");
		}
		expect(html("<javascript:alert(1)>")).toBe("<p>&lt;javascript:alert(1)&gt;</p>");
	});

	it("escapes HTML in link text and in link targets", () => {
		const out = html('[<img src=x onerror=alert(1)>](https://example.com/"onmouseover="x)');
		expect(out).not.toContain("<img");
		expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
		expect(out).not.toMatch(/href="[^"]*"onmouseover/);
		expect(out).toContain('href="https://example.com/&quot;onmouseover=&quot;x"');
	});

	it("does not nest a link inside a link", () => {
		const out = html("[see https://inner.example](https://outer.example)");
		expect(out.match(/<a /g)).toHaveLength(1);
		expect(out).toContain('href="https://outer.example"');
	});

	it("survives the owner sanitiser unchanged apart from link target/rel", async () => {
		const md =
			"Hi **there**,\n\n- [docs](https://example.com) `x`\n- <script>bad()</script>\n\n> quote\n\n```\n<b>\n```";
		const rendered = html(md);
		const clean = await sanitizeOwnerHtml(rendered);
		expect(clean.replace(/ target="_blank" rel="noopener noreferrer"/g, "")).toBe(rendered);
	});

	it("stays fast on pathological input", () => {
		const big = `${"**a ".repeat(20_000)}${"[x".repeat(20_000)}${"` ``".repeat(10_000)}${"_a ".repeat(20_000)}`;
		const start = Date.now();
		renderMarkdown(big);
		expect(Date.now() - start).toBeLessThan(2_000);
	});
});
