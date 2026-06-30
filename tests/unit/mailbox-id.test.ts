import { describe, expect, it } from "vitest";
import {
	canonicalPrimaryAddress,
	deriveMailboxId,
	mailboxIdFromPrimaryAddress,
} from "#/lib/mailbox-id";

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

	it("derives the same mailbox id for addresses differing only by case/whitespace", async () => {
		const canonical = await deriveMailboxId("secret", "test@example.com");
		const padded = await deriveMailboxId("secret", "  Test@Example.COM  ");
		const upper = await deriveMailboxId("secret", "TEST@EXAMPLE.COM");
		expect(padded).toBe(canonical);
		expect(upper).toBe(canonical);
	});

	it("derives different mailbox ids for different addresses", async () => {
		const a = await deriveMailboxId("secret", "test@example.com");
		const b = await deriveMailboxId("secret", "other@example.com");
		expect(a).not.toBe(b);
	});

	it("derives different mailbox ids for the same address under different secrets", async () => {
		const a = await deriveMailboxId("secret-a", "test@example.com");
		const b = await deriveMailboxId("secret-b", "test@example.com");
		expect(a).not.toBe(b);
	});

	it("produces a fixed-length mbx_ prefixed identifier", async () => {
		const id = await deriveMailboxId("secret", "test@example.com");
		// mbx_ (4 chars) + first 26 chars of the base32url-encoded HMAC digest.
		expect(id).toMatch(/^mbx_[0-9a-v]{26}$/);
	});

	it("rejects an address with no '@' separator", () => {
		expect(() => canonicalPrimaryAddress("not-an-email")).toThrow(
			"Invalid email address: not-an-email",
		);
	});

	it("rejects an address starting with '@' (empty local part)", () => {
		expect(() => canonicalPrimaryAddress("@example.com")).toThrow();
	});

	it("rejects an address with an empty domain part", () => {
		expect(() => canonicalPrimaryAddress("test@")).toThrow();
	});

	describe("mailboxIdFromPrimaryAddress", () => {
		it("throws when MAILBOX_ID_SECRET is unset (undefined)", async () => {
			await expect(
				mailboxIdFromPrimaryAddress({ MAILBOX_ID_SECRET: undefined }, "test@example.com"),
			).rejects.toThrow("MAILBOX_ID_SECRET is not configured");
		});

		it("throws when MAILBOX_ID_SECRET is an empty string", async () => {
			await expect(
				mailboxIdFromPrimaryAddress({ MAILBOX_ID_SECRET: "" }, "test@example.com"),
			).rejects.toThrow("MAILBOX_ID_SECRET is not configured");
		});

		it("derives the same id as deriveMailboxId when the secret is configured", async () => {
			const viaHelper = await mailboxIdFromPrimaryAddress(
				{ MAILBOX_ID_SECRET: "configured-secret" },
				"test@example.com",
			);
			const viaDirect = await deriveMailboxId("configured-secret", "test@example.com");
			expect(viaHelper).toBe(viaDirect);
		});
	});
});
