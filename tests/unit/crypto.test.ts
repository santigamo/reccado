import { describe, expect, it } from "vitest";
import { base32urlEncode, hmacSha256, randomTraceId, sha256Hex } from "#/lib/crypto";

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("sha256Hex", () => {
	it("matches the known SHA-256 vector for the empty input", async () => {
		const digest = await sha256Hex(new Uint8Array());
		expect(digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("matches the known SHA-256 vector for 'abc'", async () => {
		const digest = await sha256Hex(new TextEncoder().encode("abc"));
		expect(digest).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("is stable across repeated calls with the same input", async () => {
		const bytes = new TextEncoder().encode("stability check payload");
		const first = await sha256Hex(bytes);
		const second = await sha256Hex(bytes);
		expect(first).toBe(second);
	});

	it("produces a 64-character lowercase hex string", async () => {
		const digest = await sha256Hex(new TextEncoder().encode("any payload"));
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("hmacSha256", () => {
	it("matches the known HMAC-SHA256 vector for key='key'", async () => {
		const signature = await hmacSha256("key", "The quick brown fox jumps over the lazy dog");
		expect(toHex(signature)).toBe(
			"f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
		);
	});

	it("rejects an empty secret (WebCrypto requires a non-zero-length raw HMAC key)", async () => {
		await expect(hmacSha256("", "any message")).rejects.toThrow();
	});

	it("produces different signatures for different secrets given the same message", async () => {
		const a = await hmacSha256("secret-a", "same message");
		const b = await hmacSha256("secret-b", "same message");
		expect(toHex(a)).not.toBe(toHex(b));
	});

	it("is stable across repeated calls with the same inputs", async () => {
		const first = await hmacSha256("secret", "message");
		const second = await hmacSha256("secret", "message");
		expect(toHex(first)).toBe(toHex(second));
	});
});

describe("base32urlEncode", () => {
	it("returns an empty string for empty input", () => {
		expect(base32urlEncode(new Uint8Array())).toBe("");
	});

	it("encodes a single byte (8 bits, not a multiple of 5)", () => {
		expect(base32urlEncode(new Uint8Array([0]))).toBe("00");
		expect(base32urlEncode(new Uint8Array([255]))).toBe("vs");
	});

	it("encodes two bytes (16 bits, not a multiple of 5)", () => {
		expect(base32urlEncode(new Uint8Array([0, 0]))).toBe("0000");
	});

	it("encodes three bytes (24 bits, not a multiple of 5)", () => {
		expect(base32urlEncode(new Uint8Array([1, 2, 3]))).toBe("04106");
	});

	it("encodes five bytes cleanly (40 bits, an exact multiple of 5)", () => {
		expect(base32urlEncode(new Uint8Array([1, 2, 3, 4, 5]))).toBe("04106105");
	});

	it("only emits characters from the documented base32 alphabet", () => {
		const bytes = new Uint8Array(32);
		for (let i = 0; i < bytes.length; i += 1) {
			bytes[i] = (i * 37) % 256;
		}
		const encoded = base32urlEncode(bytes);
		expect(encoded).toMatch(/^[0-9a-v]+$/);
	});

	it("is stable across repeated calls with the same input", () => {
		const bytes = new TextEncoder().encode("hello");
		expect(base32urlEncode(bytes)).toBe(base32urlEncode(bytes));
		expect(base32urlEncode(bytes)).toBe("d1imor3f");
	});
});

describe("randomTraceId", () => {
	it("returns a UUID-shaped string", () => {
		const id = randomTraceId();
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
	});

	it("produces unique values across many calls", () => {
		const ids = new Set(Array.from({ length: 200 }, () => randomTraceId()));
		expect(ids.size).toBe(200);
	});
});
