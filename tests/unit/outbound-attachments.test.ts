import { describe, expect, it } from "vitest";
import {
	formatBytes,
	MAX_TOTAL_ATTACHMENT_BYTES,
	normalizeAttachmentType,
	sanitizeAttachmentName,
} from "#/lib/attachment-limits";
import { sha256Hex } from "#/lib/crypto";
import {
	AttachmentUnavailableError,
	bytesToBase64,
	type LoadedAttachment,
	loadSnapshotAttachments,
	providerAttachments,
	type SnapshotAttachment,
} from "#/lib/outbound-attachments";
import { draftAttachmentR2Key, sanitizeFilename } from "#/lib/r2-keys";

function fromBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

function loaded(
	filename: string,
	bytes: Uint8Array,
	contentType = "application/pdf",
): LoadedAttachment {
	return {
		id: crypto.randomUUID(),
		filename,
		contentType,
		size: bytes.byteLength,
		sha256: "x",
		r2Key: `drafts/dev/mbx/d/${filename}`,
		bytes,
	};
}

describe("bytesToBase64", () => {
	it("matches btoa for small inputs, every padding length", () => {
		for (const text of ["", "a", "ab", "abc", "abcd", "hello world"]) {
			expect(bytesToBase64(new TextEncoder().encode(text))).toBe(btoa(text));
		}
	});

	it("round-trips binary larger than one chunk without corruption at the seams", () => {
		const bytes = new Uint8Array(0x8000 * 3 * 2 + 7);
		for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
		const decoded = fromBase64(bytesToBase64(bytes));
		expect(decoded.byteLength).toBe(bytes.byteLength);
		expect(decoded).toEqual(bytes);
	});
});

describe("providerAttachments (what Email Sending composes the multipart/mixed from)", () => {
	it("adds nothing for a message without files", () => {
		expect(providerAttachments([])).toEqual([]);
	});

	it("sends one file as a base64 attachment part with its name and type", () => {
		const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
		const [part, ...rest] = providerAttachments([loaded("invoice.pdf", bytes)]);
		expect(rest).toHaveLength(0);
		expect(part).toMatchObject({
			disposition: "attachment",
			filename: "invoice.pdf",
			type: "application/pdf",
		});
		expect(fromBase64(part!.content as string)).toEqual(bytes);
	});

	it("keeps n files in order and never marks one inline", () => {
		const parts = providerAttachments([
			loaded("a.txt", new TextEncoder().encode("A"), "text/plain"),
			loaded("b.png", new Uint8Array([137, 80, 78, 71]), "image/png"),
			loaded("c.zip", new Uint8Array([80, 75]), "application/zip"),
		]);
		expect(parts.map((p) => p.filename)).toEqual(["a.txt", "b.png", "c.zip"]);
		expect(parts.every((p) => p.disposition === "attachment" && !p.contentId)).toBe(true);
	});

	it("passes a non-ASCII name through unmangled (the provider encodes it)", () => {
		const [part] = providerAttachments([
			loaded("Presupuesto año 2026 — señal 日本.pdf", new Uint8Array([1])),
		]);
		expect(part!.filename).toBe("Presupuesto año 2026 — señal 日本.pdf");
	});
});

describe("sanitizeAttachmentName", () => {
	it("drops any path, so a name cannot climb out of its folder", () => {
		expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
		expect(sanitizeAttachmentName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
		expect(sanitizeAttachmentName("..")).toBe("attachment");
	});

	it("removes control characters and quotes that could break a MIME header", () => {
		expect(sanitizeAttachmentName('evil\r\nX-Injected: 1".txt')).toBe("evilX-Injected: 1.txt");
		expect(sanitizeAttachmentName("\u0000\u0007")).toBe("attachment");
	});

	it("keeps non-ASCII letters, NFC-normalised, and strips leading dots", () => {
		expect(sanitizeAttachmentName("an\u0303o.txt")).toBe("a\u00f1o.txt");
		expect(sanitizeAttachmentName(".bashrc")).toBe("bashrc");
		expect(sanitizeAttachmentName("   ")).toBe("attachment");
	});

	it("bounds the length and keeps the extension", () => {
		const long = `${"x".repeat(400)}.docx`;
		const safe = sanitizeAttachmentName(long);
		expect(safe.length).toBeLessThanOrEqual(180);
		expect(safe.endsWith(".docx")).toBe(true);
	});

	it("leaves the R2 key ASCII and inside the draft prefix whatever the name", () => {
		const key = draftAttachmentR2Key({
			mailboxId: "mbx_1",
			draftId: "draft-1",
			attachmentId: "att-1",
			safeFilename: sanitizeFilename(sanitizeAttachmentName("../../año/../x.html")),
		});
		expect(key).toBe("drafts/dev/mbx_1/draft-1/att-1-x.html");
		expect(key.split("/")).toHaveLength(5);
		expect(key).not.toContain("..");
	});
});

describe("normalizeAttachmentType", () => {
	it("keeps a bare type/subtype, lowercased, without parameters", () => {
		expect(normalizeAttachmentType("Application/PDF")).toBe("application/pdf");
		expect(normalizeAttachmentType("text/plain; charset=utf-8")).toBe("text/plain");
	});

	it("falls back to octet-stream for anything malformed", () => {
		for (const bad of [undefined, null, "", "pdf", "text/html\r\nX: y", "a/b/c", "<script>"]) {
			expect(normalizeAttachmentType(bad)).toBe("application/octet-stream");
		}
	});
});

describe("formatBytes", () => {
	it("speaks in bytes, KB and MB", () => {
		expect(formatBytes(1)).toBe("1 byte");
		expect(formatBytes(2048)).toBe("2 KB");
		expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
		expect(formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)).toBe("17 MB");
	});
});

describe("loadSnapshotAttachments", () => {
	async function frozen(bytes: Uint8Array, key = "k1"): Promise<SnapshotAttachment> {
		return {
			id: "a1",
			filename: "a.bin",
			contentType: "application/octet-stream",
			size: bytes.byteLength,
			sha256: await sha256Hex(bytes),
			r2Key: key,
		};
	}

	function bucket(objects: Record<string, Uint8Array>): Pick<R2Bucket, "get"> {
		return {
			get: async (key: string) =>
				objects[key]
					? ({ arrayBuffer: async () => objects[key]!.slice().buffer } as unknown as R2ObjectBody)
					: null,
		} as Pick<R2Bucket, "get">;
	}

	it("reads the frozen bytes back", async () => {
		const bytes = new Uint8Array([1, 2, 3]);
		const [file] = await loadSnapshotAttachments(bucket({ k1: bytes }), [await frozen(bytes)]);
		expect(file!.bytes).toEqual(bytes);
	});

	it("refuses a missing object", async () => {
		const snapshot = await frozen(new Uint8Array([1]));
		await expect(loadSnapshotAttachments(bucket({}), [snapshot])).rejects.toMatchObject({
			reason: "attachment_missing",
		});
	});

	it("refuses an object whose bytes no longer match what was confirmed", async () => {
		const snapshot = await frozen(new Uint8Array([1, 2, 3]));
		const error = await loadSnapshotAttachments(bucket({ k1: new Uint8Array([9, 9, 9]) }), [
			snapshot,
		]).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AttachmentUnavailableError);
		expect((error as AttachmentUnavailableError).reason).toBe("attachment_changed");
	});
});
