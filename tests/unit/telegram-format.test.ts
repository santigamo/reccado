import { describe, expect, it } from "vitest";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "#/telegram/api";
import {
	entitiesToHtml,
	renderDraftPreview,
	renderInboundNotification,
	telegramEscape,
} from "#/telegram/format";

describe("entitiesToHtml", () => {
	it("converts basic styling", () => {
		const html = entitiesToHtml("hola mundo", [{ type: "bold", offset: 5, length: 5 }]);
		expect(html).toBe("<p>hola <strong>mundo</strong></p>");
	});

	it("uses UTF-16 offsets, so emoji before an entity do not shift it", () => {
		// "👋" is a surrogate pair: length 2 in UTF-16, 1 code point. Telegram counts 2,
		// and so does String#slice — iterating code points would corrupt this.
		const text = "👋 hola";
		const html = entitiesToHtml(text, [{ type: "bold", offset: 3, length: 4 }]);
		expect(html).toBe("<p>👋 <strong>hola</strong></p>");
	});

	it("nests entities", () => {
		const html = entitiesToHtml("abc", [
			{ type: "bold", offset: 0, length: 3 },
			{ type: "italic", offset: 1, length: 1 },
		]);
		expect(html).toBe("<p><strong>a<em>b</em>c</strong></p>");
	});

	it("renders text links and escapes the href", () => {
		const html = entitiesToHtml("docs", [
			{ type: "text_link", offset: 0, length: 4, url: "https://example.com/?a=1&b=2" },
		]);
		expect(html).toBe('<p><a href="https://example.com/?a=1&amp;b=2">docs</a></p>');
	});

	it("drops links with a non-web scheme", () => {
		const html = entitiesToHtml("click", [
			{ type: "text_link", offset: 0, length: 5, url: "javascript:alert(1)" },
		]);
		expect(html).toBe("<p>click</p>");
	});

	it("escapes HTML in the message text", () => {
		expect(entitiesToHtml("<b>raw</b>", [])).toBe("<p>&lt;b&gt;raw&lt;/b&gt;</p>");
	});

	it("keeps paragraphs and single line breaks apart", () => {
		expect(entitiesToHtml("uno\ndos\n\ntres", [])).toBe("<p>uno<br>dos</p>\n<p>tres</p>");
	});

	it("passes through text of entity types with no email equivalent", () => {
		const html = entitiesToHtml("secreto", [{ type: "spoiler", offset: 0, length: 7 }]);
		expect(html).toBe("<p>secreto</p>");
	});

	it("renders code blocks", () => {
		const html = entitiesToHtml("x = 1", [{ type: "pre", offset: 0, length: 5 }]);
		expect(html).toBe("<p><pre><code>x = 1</code></pre></p>");
	});
});

describe("telegramEscape", () => {
	it("escapes only what Telegram HTML needs", () => {
		expect(telegramEscape('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d "e"');
	});
});

describe("renderInboundNotification", () => {
	const base = {
		fromAddr: "cliente@example.com",
		mailboxAddress: "hello@imsanti.dev",
		subject: "Factura de junio",
		snippet: "Hola Santi, ¿me pasas la factura?",
		hasAttachments: false,
	};

	it("shows sender, subject and snippet", () => {
		const text = renderInboundNotification(base);
		expect(text).toContain("<b>Factura de junio</b>");
		expect(text).toContain("cliente@example.com");
		expect(text).toContain("hello@imsanti.dev");
		expect(text).toContain("¿me pasas la factura?");
	});

	it("flags attachments", () => {
		expect(renderInboundNotification({ ...base, hasAttachments: true })).toContain("📎");
	});

	it("handles a missing subject", () => {
		expect(renderInboundNotification({ ...base, subject: null })).toContain("(sin asunto)");
	});

	it("escapes markup coming from the sender", () => {
		const text = renderInboundNotification({ ...base, subject: "<b>spoof</b>" });
		expect(text).toContain("&lt;b&gt;spoof&lt;/b&gt;");
	});

	it("stays under the Telegram message limit for a huge mail", () => {
		const text = renderInboundNotification({
			...base,
			subject: "s".repeat(5000),
			snippet: "x".repeat(50_000),
		});
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
	});

	it("stays under the limit when escaping expands the text 5x", () => {
		// Every "&" becomes "&amp;": clipping before escaping would bound the wrong
		// string and Telegram would reject the message.
		const text = renderInboundNotification({
			...base,
			subject: "&".repeat(2000),
			snippet: "&".repeat(50_000),
		});
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
	});

	it("never cuts inside an HTML entity", () => {
		const text = renderInboundNotification({ ...base, snippet: "&".repeat(50_000) });
		expect(text).not.toMatch(/&[a-z]*…/i);
		expect(text).not.toMatch(/&[a-z]*$/i);
	});

	it("falls back to a terse card rather than exceeding the limit", () => {
		const text = renderDraftPreview({
			to: ["cliente@example.com"],
			subject: "<".repeat(3000),
			bodyText: "<".repeat(50_000),
		});
		expect(text.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
		expect(text).toContain("cliente@example.com");
	});
});

describe("renderDraftPreview", () => {
	it("shows the recipient, subject and body", () => {
		const text = renderDraftPreview({
			to: ["cliente@example.com"],
			subject: "Re: Factura de junio",
			bodyText: "Te la mando mañana.",
		});
		expect(text).toContain("cliente@example.com");
		expect(text).toContain("Re: Factura de junio");
		expect(text).toContain("Te la mando mañana.");
	});
});
