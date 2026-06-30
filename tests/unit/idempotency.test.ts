import { describe, expect, it } from "vitest";
import { inboundIdempotencyKey, outboundSendIdempotencyKey } from "#/lib/idempotency";

describe("inboundIdempotencyKey", () => {
	it("uses the normalized message-id shape when a Message-ID is present", () => {
		const key = inboundIdempotencyKey({
			mailboxId: "mbx_abc123",
			messageId: "<Test-ID@Example.COM>",
			rawSha256: "deadbeef",
		});
		expect(key).toBe("email:v1:mbx_abc123:message-id:test-id@example.com");
	});

	it("falls back to the raw-sha256 shape when the Message-ID is missing (null)", () => {
		const key = inboundIdempotencyKey({
			mailboxId: "mbx_abc123",
			messageId: null,
			rawSha256: "deadbeef",
		});
		expect(key).toBe("email:v1:mbx_abc123:raw-sha256:deadbeef");
	});

	it("falls back to the raw-sha256 shape when the Message-ID is an empty/whitespace string", () => {
		const key = inboundIdempotencyKey({
			mailboxId: "mbx_abc123",
			messageId: "   ",
			rawSha256: "deadbeef",
		});
		expect(key).toBe("email:v1:mbx_abc123:raw-sha256:deadbeef");
	});

	it("produces the same key for two differently-formatted but equivalent Message-IDs (duplicate detection)", () => {
		const a = inboundIdempotencyKey({
			mailboxId: "mbx_abc123",
			messageId: "<dup@example.com>",
			rawSha256: "sha-a",
		});
		const b = inboundIdempotencyKey({
			mailboxId: "mbx_abc123",
			messageId: "  DUP@EXAMPLE.COM  ",
			rawSha256: "sha-b-different-body",
		});
		expect(a).toBe(b);
		expect(a).toBe("email:v1:mbx_abc123:message-id:dup@example.com");
	});

	it("scopes the key by mailboxId, so the same Message-ID in different mailboxes produces different keys", () => {
		const a = inboundIdempotencyKey({
			mailboxId: "mbx_one",
			messageId: "<shared@example.com>",
			rawSha256: "sha",
		});
		const b = inboundIdempotencyKey({
			mailboxId: "mbx_two",
			messageId: "<shared@example.com>",
			rawSha256: "sha",
		});
		expect(a).not.toBe(b);
	});

	it("scopes the raw-sha256 fallback key so a different rawSha256 produces a different key", () => {
		const a = inboundIdempotencyKey({ mailboxId: "mbx_abc123", messageId: null, rawSha256: "sha-a" });
		const b = inboundIdempotencyKey({ mailboxId: "mbx_abc123", messageId: null, rawSha256: "sha-b" });
		expect(a).not.toBe(b);
	});
});

describe("outboundSendIdempotencyKey", () => {
	it("builds the send:v1:{draftId}:{attemptKey} shape", () => {
		expect(outboundSendIdempotencyKey("draft_123", "attempt_1")).toBe("send:v1:draft_123:attempt_1");
	});

	it("is stable for repeated calls with the same inputs", () => {
		const first = outboundSendIdempotencyKey("draft_123", "attempt_1");
		const second = outboundSendIdempotencyKey("draft_123", "attempt_1");
		expect(first).toBe(second);
	});

	it("produces different keys for different attemptKeys on the same draft", () => {
		const a = outboundSendIdempotencyKey("draft_123", "attempt_1");
		const b = outboundSendIdempotencyKey("draft_123", "attempt_2");
		expect(a).not.toBe(b);
	});
});
