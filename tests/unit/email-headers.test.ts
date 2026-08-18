import { describe, expect, it } from "vitest";
import {
	buildReferences,
	domainFromAddress,
	messageIdHeader,
	plainTextToHtml,
	quoteHtmlForReply,
	quoteTextForReply,
	referencesHeader,
	replySubject,
} from "#/lib/email-headers";

describe("domainFromAddress", () => {
	it("extracts and lowercases the domain", () => {
		expect(domainFromAddress("Hello@Example.COM")).toBe("example.com");
	});

	it("returns null for malformed addresses", () => {
		expect(domainFromAddress("no-at-sign")).toBeNull();
		expect(domainFromAddress("@leading")).toBeNull();
		expect(domainFromAddress("trailing@")).toBeNull();
	});
});

describe("replySubject", () => {
	it("prefixes a bare subject", () => {
		expect(replySubject("Factura de junio")).toBe("Re: Factura de junio");
	});

	it("does not stack prefixes", () => {
		expect(replySubject("Re: Factura")).toBe("Re: Factura");
		expect(replySubject("RE: Factura")).toBe("RE: Factura");
	});

	it("handles a missing subject", () => {
		expect(replySubject(null)).toBe("Re:");
		expect(replySubject("   ")).toBe("Re:");
	});
});

describe("buildReferences", () => {
	it("appends the parent message id to the parent chain", () => {
		expect(buildReferences(["root@x"], "parent@x")).toEqual(["root@x", "parent@x"]);
	});

	it("starts a chain when the parent has none", () => {
		expect(buildReferences([], "parent@x")).toEqual(["parent@x"]);
	});

	it("does not duplicate an id already in the chain", () => {
		expect(buildReferences(["root@x", "parent@x"], "parent@x")).toEqual(["root@x", "parent@x"]);
	});

	it("keeps the thread root when trimming a long chain", () => {
		const chain = Array.from({ length: 40 }, (_, i) => `m${i}@x`);
		const result = buildReferences(chain, "newest@x");
		expect(result).toHaveLength(20);
		expect(result[0]).toBe("m0@x");
		expect(result.at(-1)).toBe("newest@x");
	});

	it("formats the header with angle brackets", () => {
		expect(referencesHeader(["a@x", "b@x"])).toBe("<a@x> <b@x>");
		expect(messageIdHeader("a@x")).toBe("<a@x>");
	});
});

describe("reply quoting", () => {
	const parent = {
		fromAddr: "cliente@example.com",
		date: "2026-06-24T10:32:00.000Z",
		bodyText: "Hola Santi\n\n¿Me pasas la factura?",
	};

	it("quotes the parent under the reply in plain text", () => {
		const result = quoteTextForReply("Te la mando mañana.", parent);
		expect(result).toContain("Te la mando mañana.");
		expect(result).toContain("cliente@example.com wrote:");
		expect(result).toContain("> Hola Santi");
		expect(result).toContain("> ¿Me pasas la factura?");
		// Blank lines inside the quote stay quoted, not dropped.
		expect(result).toContain("\n>\n");
	});

	it("puts the reply above the quote", () => {
		const result = quoteTextForReply("Respuesta", parent);
		expect(result.indexOf("Respuesta")).toBeLessThan(result.indexOf("> Hola Santi"));
	});

	it("escapes HTML from the parent body", () => {
		const result = quoteHtmlForReply(plainTextToHtml("ok"), {
			...parent,
			bodyText: '<script>alert("x")</script>',
		});
		expect(result).toContain("&lt;script&gt;");
		expect(result).not.toContain("<script>");
	});

	it("keeps already-rendered HTML bodies intact", () => {
		const result = quoteHtmlForReply("<p><strong>Hecho</strong></p>", parent);
		expect(result).toContain("<p><strong>Hecho</strong></p>");
		expect(result).toContain("<blockquote");
	});

	it("truncates a very long parent instead of quoting megabytes", () => {
		const result = quoteTextForReply("ok", { ...parent, bodyText: "x".repeat(10_000) });
		expect(result).toContain("[…]");
		expect(result.length).toBeLessThan(6000);
	});
});
