import { describe, expect, it } from "vitest";
import { normalizeSubject, parseMimeBytes, snippetFromText } from "#/lib/mime";
import attachmentSmallFixture from "../../fixtures/mime/attachment-small.eml?raw";
import cloudflareSendRawFixture from "../../fixtures/mime/cloudflare-send-raw.eml?raw";
import htmlOnlyFixture from "../../fixtures/mime/html-only.eml?raw";
import missingMessageIdFixture from "../../fixtures/mime/missing-message-id.eml?raw";
import multipartAlternativeFixture from "../../fixtures/mime/multipart-alternative.eml?raw";
import simpleTextFixture from "../../fixtures/mime/simple-text.eml?raw";

const simpleText = `From: sender@example.com
To: test@example.com
Subject: Test
Message-ID: <test@example.com>

Hello plain text body.
`;

function parse(raw: string) {
	return parseMimeBytes(new TextEncoder().encode(raw));
}

describe("mime parser", () => {
	it("parses simple text", async () => {
		const parsed = await parse(simpleText);
		expect(parsed.subject).toBe("Test");
		expect(parsed.text).toContain("plain text");
		expect(snippetFromText(parsed.text, parsed.html)).toContain("plain text");
	});

	it("parses fixtures/mime/html-only.eml (html body, no text part, no attachments)", async () => {
		const parsed = await parse(htmlOnlyFixture);
		expect(parsed.subject).toBe("HTML only fixture");
		expect(parsed.messageId).toBe("<html-only-fixture@example.com>");
		expect(parsed.text).toBeNull();
		expect(parsed.html).toContain("<p>HTML body only</p>");
		expect(parsed.attachments).toHaveLength(0);
	});

	it("parses fixtures/mime/multipart-alternative.eml (both text and html parts)", async () => {
		const parsed = await parse(multipartAlternativeFixture);
		expect(parsed.subject).toBe("Multipart alternative");
		expect(parsed.messageId).toBe("<multipart-alternative-fixture@example.com>");
		expect(parsed.text).toContain("Plain part of multipart alternative.");
		expect(parsed.html).toContain("<p>HTML part of multipart alternative.</p>");
		expect(parsed.attachments).toHaveLength(0);
	});

	it("parses fixtures/mime/attachment-small.eml (attachment present, has_attachments)", async () => {
		const parsed = await parse(attachmentSmallFixture);
		expect(parsed.subject).toBe("Attachment small");
		expect(parsed.text).toContain("See attached file.");
		expect(parsed.attachments).toHaveLength(1);
		expect(parsed.attachments[0]?.filename).toBe("note.txt");
		expect(parsed.attachments[0]?.mimeType).toBe("text/plain");
		expect(parsed.attachments[0]?.disposition).toBe("attachment");
		expect(parsed.attachments[0]?.content.length).toBeGreaterThan(0);
		expect(new TextDecoder().decode(parsed.attachments[0]?.content)).toContain(
			"Hello attachment content.",
		);
		// has_attachments is derived elsewhere from `attachments.length > 0`.
		const hasAttachments = parsed.attachments.length > 0;
		expect(hasAttachments).toBe(true);
	});

	it("parses fixtures/mime/missing-message-id.eml (no Message-ID header)", async () => {
		const parsed = await parse(missingMessageIdFixture);
		expect(parsed.subject).toBe("Missing Message-ID");
		expect(parsed.messageId).toBeNull();
		expect(parsed.text).toContain("No Message-ID header in this fixture.");
		expect(parsed.attachments).toHaveLength(0);
	});

	it("parses fixtures/mime/cloudflare-send-raw.eml (Cloudflare Email Routing smoke fixture)", async () => {
		const parsed = await parse(cloudflareSendRawFixture);
		expect(parsed.from).toBe("smoke@mail.example.com");
		expect(parsed.subject).toBe("Phase 0.3 Cloudflare routing smoke");
		expect(parsed.messageId).toBe("<phase-0.3-cloudflare-routing@example.com>");
		expect(parsed.text).toContain("Cloudflare Email Sending");
	});

	it("parses fixtures/mime/simple-text.eml", async () => {
		const parsed = await parse(simpleTextFixture);
		expect(parsed.from).toBe("sender@example.com");
		expect(parsed.to).toEqual(["test@example.com"]);
		expect(parsed.subject).toBe("Phase 0.3 smoke");
		expect(parsed.messageId).toBe("<phase-0.3-smoke@example.com>");
		expect(parsed.text).toContain("small plain text fixture");
		expect(parsed.attachments).toHaveLength(0);
	});
});

describe("normalizeSubject", () => {
	it("returns null for null input", () => {
		expect(normalizeSubject(null)).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(normalizeSubject("")).toBeNull();
	});

	it("returns null for a whitespace-only subject", () => {
		expect(normalizeSubject("   ")).toBeNull();
	});

	it("strips a leading 'Re:' prefix case-insensitively and lowercases the result", () => {
		expect(normalizeSubject("Re: Hello World")).toBe("hello world");
		expect(normalizeSubject("RE:Hello World")).toBe("hello world");
	});

	it("strips a leading 'Fwd:' prefix case-insensitively", () => {
		expect(normalizeSubject("Fwd: Hello World")).toBe("hello world");
		expect(normalizeSubject("FWD:Hello World")).toBe("hello world");
	});

	it("strips repeated leading reply/forward prefixes", () => {
		expect(normalizeSubject("Re: Re: Hello")).toBe("hello");
		expect(normalizeSubject("Fwd: Re: Hello")).toBe("hello");
	});

	it("does not strip words that merely start with 're' but aren't the 're:' prefix", () => {
		expect(normalizeSubject("Refund alert")).toBe("refund alert");
	});

	it("strips the prefix even with leading whitespace", () => {
		expect(normalizeSubject("Re:   Hello  ")).toBe("hello");
		// Leading whitespace before "Re:" is tolerated; the prefix is still stripped.
		expect(normalizeSubject("  Re:   Hello  ")).toBe("hello");
	});
});

describe("snippetFromText", () => {
	it("prefers the html body over text when both are present (matches what the client renders)", () => {
		// multipart/alternative: html is the canonical, rendered representation, so the
		// preview must reflect it — a near-empty text/plain part must not win.
		expect(snippetFromText("plain body", "<p>html body</p>")).toBe("html body");
	});

	it("derives the snippet from html even when text/plain omits the real content", () => {
		// The LabsMobile 2FA regression: text/plain is present but only carries logo +
		// footer, while the verification code lives solely in the html part.
		const text = "LabsMobile (https://www.labsmobile.com/es)\n\n\n© 2022 LabsMobile.";
		const html = "<h1>Código de verificación</h1><p>Tu código es: <b>653865</b></p>";
		expect(snippetFromText(text, html)).toContain("653865");
	});

	it("falls back to stripped html when text is null", () => {
		expect(snippetFromText(null, "<p>Hello <b>World</b></p>")).toBe("Hello World");
	});

	it("drops head/style/script blocks when flattening html", () => {
		const html =
			"<head><style>.x{color:red}</style></head><body><p>Visible copy</p><script>alert(1)</script></body>";
		expect(snippetFromText(null, html)).toBe("Visible copy");
	});

	it("falls back to the text part when html flattens to nothing (image-only email)", () => {
		expect(snippetFromText("text fallback", '<img src="https://x/y.png">')).toBe("text fallback");
	});

	it("returns an empty string when both text and html are null", () => {
		expect(snippetFromText(null, null)).toBe("");
	});

	it("collapses runs of whitespace (newlines/tabs) into single spaces", () => {
		expect(snippetFromText("line one\n\nline\ttwo", null)).toBe("line one line two");
	});

	it("trims leading/trailing whitespace", () => {
		expect(snippetFromText("   padded text   ", null)).toBe("padded text");
	});

	it("truncates to the default max of 200 characters", () => {
		const longText = "x".repeat(300);
		const snippet = snippetFromText(longText, null);
		expect(snippet).toHaveLength(200);
	});

	it("truncates to a custom max length", () => {
		expect(snippetFromText("0123456789", null, 5)).toBe("01234");
	});
});
