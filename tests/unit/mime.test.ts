import { describe, expect, it } from "vitest";
import { parseMimeBytes, snippetFromText } from "#/lib/mime";

const simpleText = `From: sender@example.com
To: test@example.com
Subject: Test
Message-ID: <test@example.com>

Hello plain text body.
`;

describe("mime parser", () => {
	it("parses simple text", async () => {
		const parsed = await parseMimeBytes(new TextEncoder().encode(simpleText));
		expect(parsed.subject).toBe("Test");
		expect(parsed.text).toContain("plain text");
		expect(snippetFromText(parsed.text, parsed.html)).toContain("plain text");
	});
});
