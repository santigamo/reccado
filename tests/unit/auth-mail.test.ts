import { describe, expect, it } from "vitest";
import {
	authMailHeader,
	extractAuthMarker,
	isInstanceAuthMail,
	isInstanceAuthSender,
} from "#/lib/auth-mail";
import { classifySensitive, redactSensitive } from "#/lib/sensitive-mail";

const env = {
	BETTER_AUTH_SECRET: "s".repeat(40),
	MAIL_FROM_ADDRESS: "Auth <noreply@mail.owner.test>",
};

describe("auth mail marker", () => {
	it("round-trips through a raw MIME header", async () => {
		const headers = await authMailHeader(env, "Owner@Example.com");
		const value = headers["X-Reccado-Auth"];
		expect(value).toMatch(/^v1\.[0-9a-f]{64}$/);
		const raw = new TextEncoder().encode(
			`From: someone@elsewhere.test\r\nX-Reccado-Auth:\r\n ${value}\r\nSubject: hi\r\n\r\nbody`,
		);
		const marker = extractAuthMarker(raw);
		expect(marker).toBe(value);
		expect(
			await isInstanceAuthMail(env, {
				from: "someone@elsewhere.test",
				recipients: ["owner@example.com"],
				marker,
			}),
		).toBe(true);
	});
	it("rejects a marker for another recipient, secret or a forged value", async () => {
		const value = (await authMailHeader(env, "owner@example.com"))["X-Reccado-Auth"];
		const other = { from: "x@y.test", marker: value };
		expect(await isInstanceAuthMail(env, { ...other, recipients: ["agent@example.com"] })).toBe(
			false,
		);
		expect(
			await isInstanceAuthMail(
				{ ...env, BETTER_AUTH_SECRET: "t".repeat(40) },
				{ ...other, recipients: ["owner@example.com"] },
			),
		).toBe(false);
		expect(
			await isInstanceAuthMail(env, {
				from: "x@y.test",
				marker: "v1.abc",
				recipients: ["owner@example.com"],
			}),
		).toBe(false);
	});
	it("emits no header without a secret", async () => {
		expect(await authMailHeader({}, "a@b.test")).toEqual({});
	});
	it("hides on sender alone (fail closed)", async () => {
		expect(isInstanceAuthSender(env, "noreply@mail.owner.test")).toBe(true);
		expect(await isInstanceAuthMail(env, { from: "NoReply@Mail.Owner.test", recipients: [] })).toBe(
			true,
		);
		expect(await isInstanceAuthMail(env, { from: "news@other.test", recipients: [] })).toBe(false);
	});
});

describe("redactor probes (T15 M3)", () => {
	const cases: Array<[string, string, string]> = [
		["spaced code", "Your verification code is 123 456.", "123 456"],
		["hyphen code", "Your verification code is 123-456.", "123-456"],
		["letters only", "Your login code: ABCDEFGH", "ABCDEFGH"],
		["lower letters after colon", "Your login code: abcdefgh", "abcdefgh"],
		["11 digits", "Your verification code is 12345678901.", "12345678901"],
		["PIN", "Your PIN is 4821 for sign in", "4821"],
	];
	it.each(cases)("%s is classified and redacted", (_name, text, secret) => {
		const { kind } = classifySensitive({ from: "noreply@x.test", subject: "Code", text });
		expect(kind).not.toBeNull();
		expect(redactSensitive(text, kind).text).not.toContain(secret);
	});
	it("redacts magic links with a token param the old list missed", () => {
		const text = "Sign in: https://app.example.com/auth?t=abcdef123456 now";
		const { kind } = classifySensitive({ from: "noreply@x.test", subject: "Sign in", text });
		expect(kind).toBe("magic_link");
		expect(redactSensitive(text, kind).text).not.toContain("abcdef123456");
	});
	it("redacts any non-plain URL in a magic_link mail but keeps plain ones", () => {
		const text =
			"Sign in link: https://app.example.com/go?x=1 and help https://app.example.com/help";
		const out = redactSensitive(text, "magic_link").text;
		expect(out).not.toContain("x=1");
		expect(out).toContain("https://app.example.com/help");
		expect(
			redactSensitive("https://app.example.com/a/abcdefghijklmnop", "password_reset").text,
		).not.toContain("abcdefghijklmnop");
	});
	it("does not mask ordinary words", () => {
		const text = "Hello, your code is below. Thanks for using our service";
		expect(redactSensitive(text, "otp").text).toBe(text);
	});
});
