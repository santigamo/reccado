import { describe, expect, it } from "vitest";
import { parseSendingDomains, resolveSenderIdentity, type SenderEnv } from "#/lib/sender-identity";

const baseEnv: SenderEnv = { MAIL_FROM_ADDRESS: "noreply@mail.imsanti.dev" };

describe("parseSendingDomains", () => {
	it("splits, trims and lowercases", () => {
		expect(parseSendingDomains(" Imsanti.dev , mail.imsanti.dev ")).toEqual([
			"imsanti.dev",
			"mail.imsanti.dev",
		]);
	});

	it("treats unset as no verified domains", () => {
		expect(parseSendingDomains(undefined)).toEqual([]);
	});
});

describe("resolveSenderIdentity", () => {
	it("sends as the mailbox when its domain is verified", () => {
		const identity = resolveSenderIdentity(
			{ ...baseEnv, MAIL_SENDING_DOMAINS: "imsanti.dev" },
			"hello@imsanti.dev",
		);
		expect(identity).toEqual({ from: "hello@imsanti.dev", replyTo: null });
	});

	it("falls back to the global sender with Reply-To when the domain is unverified", () => {
		const identity = resolveSenderIdentity(baseEnv, "hello@imsanti.dev");
		expect(identity).toEqual({
			from: "noreply@mail.imsanti.dev",
			replyTo: "hello@imsanti.dev",
		});
	});

	it("does not set Reply-To pointing at itself", () => {
		const identity = resolveSenderIdentity(baseEnv, "noreply@mail.imsanti.dev");
		expect(identity.replyTo).toBeNull();
	});

	it("handles an unknown mailbox address", () => {
		expect(resolveSenderIdentity(baseEnv, null)).toEqual({
			from: "noreply@mail.imsanti.dev",
			replyTo: null,
		});
	});

	it("normalizes case before matching", () => {
		const identity = resolveSenderIdentity(
			{ ...baseEnv, MAIL_SENDING_DOMAINS: "IMSANTI.DEV" },
			"Hello@Imsanti.dev",
		);
		expect(identity.from).toBe("hello@imsanti.dev");
	});
});
