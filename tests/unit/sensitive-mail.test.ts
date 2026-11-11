import { describe, expect, it } from "vitest";
import { parseMimeBytes } from "#/lib/mime";
import { classifySensitive, redactSensitive, sensitiveKindForRead } from "#/lib/sensitive-mail";
import magic from "../../fixtures/mime/sensitive-magic.eml?raw";
import conversation from "../../fixtures/mime/sensitive-negative-conversation.eml?raw";
import newsletter from "../../fixtures/mime/sensitive-negative-newsletter.eml?raw";
import otpEn from "../../fixtures/mime/sensitive-otp-en.eml?raw";
import otpEs from "../../fixtures/mime/sensitive-otp-es.eml?raw";
import reset from "../../fixtures/mime/sensitive-reset.eml?raw";

describe("sensitive mail", () => {
	it.each([
		[otpEs, "otp"],
		[otpEn, "otp"],
		[reset, "password_reset"],
		[magic, "magic_link"],
		[conversation, null],
		[newsletter, null],
	])("classifies MIME examples", async (fixture, expected) => {
		const parsed = await parseMimeBytes(new TextEncoder().encode(fixture as string));
		expect(
			classifySensitive({
				from: parsed.from,
				subject: parsed.subject,
				text: parsed.text,
				html: parsed.html,
			}).kind,
		).toBe(expected);
	});
	it("recognizes verification and handles HTML-only content", () => {
		expect(
			classifySensitive({
				from: "accounts@example.com",
				subject: "Verify your account",
				text: null,
				html: '<a href="https://example.com/verify?token=secret">Verify</a>',
			}).kind,
		).toBe("verification");
	});
	it("recognizes a code on a separate line", () => {
		expect(
			classifySensitive({
				from: "security@example.com",
				subject: "Your code",
				text: "Use this code:\n\n482631",
			}).kind,
		).toBe("otp");
	});
	it("recognizes a sign-in link without the words magic link", () => {
		expect(
			classifySensitive({
				from: "accounts@example.com",
				subject: "Sign in to your account",
				text: "https://example.com/login?token=secret",
			}).kind,
		).toBe("magic_link");
	});
	it("redacts codes and secret links and is idempotent", () => {
		const first = redactSensitive(
			"Code 482631; https://example.com/reset?token=secret and https://example.com/abcdefghijklmnopqrstuvwx",
			"otp",
		);
		expect(first.text).toBe(
			"Code ••••••; https://example.com/[enlace oculto] and https://example.com/[enlace oculto]",
		);
		expect(first.redactions).toBe(3);
		expect(redactSensitive(first.text, "otp")).toEqual({ text: first.text, redactions: 0 });
	});
	it("hides token parameters escaped in HTML", () => {
		expect(redactSensitive("https://example.com/a?x=1&amp;token=secret", "verification").text).toBe(
			"https://example.com/[enlace oculto]",
		);
	});
	it("classifies legacy rows but trusts completed classifications", () => {
		const row = {
			sensitive_kind: null,
			sensitive_classified: 0,
			from_addr: "security@example.com",
			subject: "Your code",
			body_text: "Your code is 482631",
		};
		expect(sensitiveKindForRead(row)).toBe("otp");
		expect(sensitiveKindForRead({ ...row, sensitive_classified: 1 })).toBeNull();
	});
});
