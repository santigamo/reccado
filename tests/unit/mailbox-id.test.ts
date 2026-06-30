import { describe, expect, it } from "vitest";
import { deriveMailboxId, canonicalPrimaryAddress } from "#/lib/mailbox-id";

describe("mailbox-id", () => {
	it("canonicalizes primary addresses", () => {
		expect(canonicalPrimaryAddress(" Test@Example.COM ")).toBe("test@example.com");
	});

	it("derives stable mailbox IDs", async () => {
		const first = await deriveMailboxId("secret", "test@example.com");
		const second = await deriveMailboxId("secret", "test@example.com");
		expect(first).toBe(second);
		expect(first.startsWith("mbx_")).toBe(true);
	});
});
