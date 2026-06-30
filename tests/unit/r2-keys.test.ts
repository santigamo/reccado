import { describe, expect, it } from "vitest";
import { attachmentR2Key, rawEmailR2Key, sanitizeFilename } from "#/lib/r2-keys";

describe("sanitizeFilename", () => {
	it("neutralizes path-traversal sequences by replacing slashes (no '/' survives)", () => {
		const sanitized = sanitizeFilename("../../etc/passwd");
		expect(sanitized).not.toContain("/");
		expect(sanitized).not.toContain("\\");
		expect(sanitized).toBe(".._.._etc_passwd");
	});

	it("falls back to a default name for an empty string", () => {
		expect(sanitizeFilename("")).toBe("attachment.bin");
	});

	it("falls back to a default name for null/undefined", () => {
		expect(sanitizeFilename(null)).toBe("attachment.bin");
		expect(sanitizeFilename(undefined)).toBe("attachment.bin");
	});

	it("falls back to a default name for a whitespace-only string", () => {
		expect(sanitizeFilename("   ")).toBe("attachment.bin");
	});

	it("replaces unicode characters with underscores while preserving ascii separators", () => {
		expect(sanitizeFilename("héllo wörld.txt")).toBe("h_llo_w_rld.txt");
	});

	it("collapses a fully non-ascii filename down to its extension", () => {
		expect(sanitizeFilename("файл.txt")).toBe("_.txt");
	});

	it("truncates filenames longer than 120 characters", () => {
		const long = `${"a".repeat(150)}.txt`;
		const sanitized = sanitizeFilename(long);
		expect(sanitized.length).toBe(120);
		expect(sanitized.startsWith("aaaa")).toBe(true);
	});

	it("strips control characters (collapsing runs into a single underscore)", () => {
		const withControlChars = "control\x00char\x1Fname\ttab\nnewline.txt";
		const sanitized = sanitizeFilename(withControlChars);
		expect(sanitized).not.toMatch(/[\x00-\x1f]/);
		expect(sanitized).toBe("control_char_name_tab_newline.txt");
	});

	it("leaves an already-safe filename unchanged", () => {
		expect(sanitizeFilename("normal-file_name.v2.tar.gz")).toBe("normal-file_name.v2.tar.gz");
	});
});

describe("rawEmailR2Key", () => {
	const receivedAt = new Date(Date.UTC(2026, 0, 5, 23, 30, 0));

	it("produces the raw/{env}/{mailboxId}/{yyyy}/{mm}/{dd}/{epochMs}-{sha}.eml shape", () => {
		const key = rawEmailR2Key({
			env: "prod",
			mailboxId: "mbx_abc123",
			receivedAt,
			rawSha256: "deadbeef",
		});
		expect(key).toBe(`raw/prod/mbx_abc123/2026/01/05/${receivedAt.getTime()}-deadbeef.eml`);
	});

	it("defaults the env segment to 'dev' when omitted", () => {
		const key = rawEmailR2Key({ mailboxId: "mbx_abc123", receivedAt, rawSha256: "deadbeef" });
		expect(key.startsWith("raw/dev/")).toBe(true);
	});

	it("zero-pads single-digit UTC month and day", () => {
		const key = rawEmailR2Key({
			mailboxId: "mbx_abc123",
			receivedAt: new Date(Date.UTC(2026, 8, 3, 0, 0, 0)),
			rawSha256: "sha",
		});
		expect(key).toContain("/2026/09/03/");
	});
});

describe("attachmentR2Key", () => {
	it("produces the attachments/{env}/{mailboxId}/{messageLocalId}/{sha}-{filename} shape", () => {
		const key = attachmentR2Key({
			env: "prod",
			mailboxId: "mbx_abc123",
			messageLocalId: "msg_local_1",
			attachmentSha256: "feedface",
			safeFilename: "note.txt",
		});
		expect(key).toBe("attachments/prod/mbx_abc123/msg_local_1/feedface-note.txt");
	});

	it("defaults the env segment to 'dev' when omitted", () => {
		const key = attachmentR2Key({
			mailboxId: "mbx_abc123",
			messageLocalId: "msg_local_1",
			attachmentSha256: "feedface",
			safeFilename: "note.txt",
		});
		expect(key.startsWith("attachments/dev/")).toBe(true);
	});

	it("never allows path traversal when fed a sanitizeFilename()-cleaned attacker-supplied filename", () => {
		const maliciousInput = "../../../etc/passwd";
		const safeFilename = sanitizeFilename(maliciousInput);
		const key = attachmentR2Key({
			mailboxId: "mbx_abc123",
			messageLocalId: "msg_local_1",
			attachmentSha256: "feedface",
			safeFilename,
		});
		// The key must stay confined to exactly the 5 expected path segments;
		// a successful traversal would introduce extra "/"-delimited segments.
		expect(key.split("/")).toHaveLength(5);
		expect(key).toBe("attachments/dev/mbx_abc123/msg_local_1/feedface-.._.._.._etc_passwd");
	});
});
