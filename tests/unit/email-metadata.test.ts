import { describe, expect, it } from "vitest";
import { normalizeMessageId, readHeader, readReferences } from "#/lib/email-metadata";

describe("normalizeMessageId", () => {
	it("strips surrounding angle brackets", () => {
		expect(normalizeMessageId("<abc@example.com>")).toBe("abc@example.com");
	});

	it("trims surrounding whitespace", () => {
		expect(normalizeMessageId("  <abc@example.com>  ")).toBe("abc@example.com");
	});

	it("lowercases the value", () => {
		expect(normalizeMessageId("<ABC@Example.COM>")).toBe("abc@example.com");
	});

	it("strips a lone leading angle bracket without a matching trailing one", () => {
		expect(normalizeMessageId("<abc@example.com")).toBe("abc@example.com");
	});

	it("strips a lone trailing angle bracket without a matching leading one", () => {
		expect(normalizeMessageId("abc@example.com>")).toBe("abc@example.com");
	});

	it("leaves a value with no angle brackets unchanged apart from case", () => {
		expect(normalizeMessageId("ABC@example.com")).toBe("abc@example.com");
	});

	it("returns null for null input", () => {
		expect(normalizeMessageId(null)).toBeNull();
	});

	it("returns null for an empty string", () => {
		expect(normalizeMessageId("")).toBeNull();
	});

	it("returns null for a whitespace-only string", () => {
		expect(normalizeMessageId("   ")).toBeNull();
	});
});

describe("readHeader", () => {
	it("looks up headers case-insensitively", () => {
		const headers = new Headers({ "X-Custom-Header": "value-1" });
		expect(readHeader(headers, "x-custom-header")).toBe("value-1");
		expect(readHeader(headers, "X-CUSTOM-HEADER")).toBe("value-1");
	});

	it("returns null for a missing header", () => {
		const headers = new Headers();
		expect(readHeader(headers, "references")).toBeNull();
	});

	it("trims surrounding whitespace from the header value", () => {
		const headers = new Headers({ subject: "  padded subject  " });
		expect(readHeader(headers, "subject")).toBe("padded subject");
	});

	it("returns null for a header whose value is only whitespace", () => {
		const headers = new Headers({ "x-blank": "   " });
		expect(readHeader(headers, "x-blank")).toBeNull();
	});
});

describe("readReferences", () => {
	it("parses multiple message ids separated by whitespace", () => {
		const headers = new Headers({
			references: "<msg1@example.com> <msg2@example.com>\t<msg3@example.com>",
		});
		expect(readReferences(headers)).toEqual([
			"msg1@example.com",
			"msg2@example.com",
			"msg3@example.com",
		]);
	});

	it("normalizes each reference id (case + brackets)", () => {
		const headers = new Headers({ references: "<MSG1@Example.com> MSG2@example.com" });
		expect(readReferences(headers)).toEqual(["msg1@example.com", "msg2@example.com"]);
	});

	it("returns an empty array when the references header is missing", () => {
		expect(readReferences(new Headers())).toEqual([]);
	});

	it("returns an empty array when the references header is blank", () => {
		const headers = new Headers({ references: "   " });
		expect(readReferences(headers)).toEqual([]);
	});

	it("returns a single-element array for a single reference id", () => {
		const headers = new Headers({ references: "<only@example.com>" });
		expect(readReferences(headers)).toEqual(["only@example.com"]);
	});
});
