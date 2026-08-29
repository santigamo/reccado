import { describe, expect, it } from "vitest";
import {
	parseSendingDomains,
	resolveDeliveredAlias,
	resolveSenderIdentity,
	type SenderEnv,
} from "#/lib/sender-identity";

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

describe("resolveDeliveredAlias", () => {
	const aliasEnv: SenderEnv = { ...baseEnv, MAIL_SENDING_DOMAINS: "imsanti.dev" };

	it("picks the recipient that belongs to the mailbox domain", () => {
		expect(
			resolveDeliveredAlias(
				aliasEnv,
				["cliente@example.com", "shop@imsanti.dev"],
				"hello@imsanti.dev",
			),
		).toBe("shop@imsanti.dev");
	});

	it("recognises the mailbox's own domain even when MAIL_SENDING_DOMAINS is unset", () => {
		expect(resolveDeliveredAlias(baseEnv, ["Shop@Imsanti.dev"], "hello@imsanti.dev")).toBe(
			"shop@imsanti.dev",
		);
	});

	it("returns null when no recipient is ours, so the caller keeps primary_address", () => {
		expect(
			resolveDeliveredAlias(aliasEnv, ["cliente@example.com"], "hello@imsanti.dev"),
		).toBeNull();
	});

	it("returns null with nothing to compare against", () => {
		expect(resolveDeliveredAlias({}, ["shop@imsanti.dev"], null)).toBeNull();
		expect(resolveDeliveredAlias(aliasEnv, [], "hello@imsanti.dev")).toBeNull();
	});

	it("ignores junk entries in the recipient list", () => {
		expect(
			resolveDeliveredAlias(
				aliasEnv,
				[null, "", "not-an-address", "shop@imsanti.dev"],
				"hello@imsanti.dev",
			),
		).toBe("shop@imsanti.dev");
	});
});
