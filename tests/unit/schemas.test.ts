import { describe, expect, it } from "vitest";
import {
	adminMailboxActionSchema,
	confirmSendSchema,
	createAliasSchema,
	createDomainSchema,
	createDraftSchema,
	createMailboxSchema,
	createRoutingRuleSchema,
	messageActionSchema,
	searchQuerySchema,
	threadListQuerySchema,
	updateDraftSchema,
} from "#/api/schemas";

describe("createMailboxSchema", () => {
	it("accepts a valid primaryAddress with an optional displayName", () => {
		const result = createMailboxSchema.parse({ primaryAddress: "user@example.com", displayName: "User" });
		expect(result).toEqual({ primaryAddress: "user@example.com", displayName: "User" });
	});

	it("accepts a valid primaryAddress without a displayName", () => {
		const result = createMailboxSchema.parse({ primaryAddress: "user@example.com" });
		expect(result.displayName).toBeUndefined();
	});

	it("rejects an invalid email for primaryAddress", () => {
		expect(() => createMailboxSchema.parse({ primaryAddress: "not-an-email" })).toThrow();
	});

	it("rejects a missing primaryAddress", () => {
		expect(() => createMailboxSchema.parse({})).toThrow();
	});

	it("rejects an empty displayName", () => {
		expect(() => createMailboxSchema.parse({ primaryAddress: "user@example.com", displayName: "" })).toThrow();
	});

	it("rejects a displayName longer than 120 characters", () => {
		expect(() =>
			createMailboxSchema.parse({ primaryAddress: "user@example.com", displayName: "x".repeat(121) }),
		).toThrow();
	});
});

describe("createAliasSchema", () => {
	it("accepts a valid alias", () => {
		const result = createAliasSchema.parse({ aliasAddress: "alias@example.com", mailboxId: "mbx_1" });
		expect(result).toEqual({ aliasAddress: "alias@example.com", mailboxId: "mbx_1" });
	});

	it("rejects an invalid aliasAddress", () => {
		expect(() => createAliasSchema.parse({ aliasAddress: "not-an-email", mailboxId: "mbx_1" })).toThrow();
	});

	it("rejects a missing mailboxId", () => {
		expect(() => createAliasSchema.parse({ aliasAddress: "alias@example.com" })).toThrow();
	});

	it("rejects an empty mailboxId", () => {
		expect(() => createAliasSchema.parse({ aliasAddress: "alias@example.com", mailboxId: "" })).toThrow();
	});
});

describe("createDomainSchema", () => {
	it("accepts a valid domain and zoneId", () => {
		const result = createDomainSchema.parse({ domain: "example.com", zoneId: "zone_1" });
		expect(result).toEqual({ domain: "example.com", zoneId: "zone_1" });
	});

	it("rejects a domain shorter than 3 characters", () => {
		expect(() => createDomainSchema.parse({ domain: "ab", zoneId: "zone_1" })).toThrow();
	});

	it("rejects a missing zoneId", () => {
		expect(() => createDomainSchema.parse({ domain: "example.com" })).toThrow();
	});
});

describe("createRoutingRuleSchema", () => {
	it("accepts a minimal store rule and defaults enabled to true", () => {
		const result = createRoutingRuleSchema.parse({
			domainId: "dom_1",
			pattern: "*",
			priority: 0,
			action: "store",
			mailboxId: "mbx_1",
		});
		expect(result.enabled).toBe(true);
	});

	it("accepts a forward rule with a forwardTo list of valid emails", () => {
		const result = createRoutingRuleSchema.parse({
			domainId: "dom_1",
			pattern: "*",
			priority: 1,
			action: "forward",
			forwardTo: ["a@example.com", "b@example.com"],
		});
		expect(result.forwardTo).toEqual(["a@example.com", "b@example.com"]);
	});

	it("accepts an explicit enabled=false", () => {
		const result = createRoutingRuleSchema.parse({
			domainId: "dom_1",
			pattern: "*",
			priority: 1,
			action: "reject",
			rejectReason: "spam",
			enabled: false,
		});
		expect(result.enabled).toBe(false);
	});

	it("rejects an invalid action enum value", () => {
		expect(() =>
			createRoutingRuleSchema.parse({ domainId: "dom_1", pattern: "*", priority: 0, action: "delete" }),
		).toThrow();
	});

	it("rejects a forwardTo array containing an invalid email", () => {
		expect(() =>
			createRoutingRuleSchema.parse({
				domainId: "dom_1",
				pattern: "*",
				priority: 0,
				action: "forward",
				forwardTo: ["a@example.com", "not-an-email"],
			}),
		).toThrow();
	});

	it("rejects a negative priority", () => {
		expect(() =>
			createRoutingRuleSchema.parse({ domainId: "dom_1", pattern: "*", priority: -1, action: "store" }),
		).toThrow();
	});

	it("rejects a non-integer priority", () => {
		expect(() =>
			createRoutingRuleSchema.parse({ domainId: "dom_1", pattern: "*", priority: 1.5, action: "store" }),
		).toThrow();
	});

	it("rejects a missing domainId", () => {
		expect(() => createRoutingRuleSchema.parse({ pattern: "*", priority: 0, action: "store" })).toThrow();
	});
});

describe("messageActionSchema", () => {
	it.each(["mark_read", "mark_unread", "archive", "trash", "restore_inbox"])(
		"accepts the %s action",
		(action) => {
			expect(messageActionSchema.parse({ action })).toEqual({ action });
		},
	);

	it("rejects an unknown action", () => {
		expect(() => messageActionSchema.parse({ action: "delete_forever" })).toThrow();
	});

	it("rejects a missing action", () => {
		expect(() => messageActionSchema.parse({})).toThrow();
	});
});

describe("createDraftSchema / updateDraftSchema", () => {
	it("accepts a minimal valid draft", () => {
		const result = createDraftSchema.parse({ to: ["a@example.com"], subject: "Hello" });
		expect(result.to).toEqual(["a@example.com"]);
		expect(result.subject).toBe("Hello");
	});

	it("accepts cc/bcc/bodyText/bodyHtml/threadId when provided", () => {
		const result = createDraftSchema.parse({
			to: ["a@example.com"],
			cc: ["c@example.com"],
			bcc: ["d@example.com"],
			subject: "Hello",
			bodyText: "Hi",
			bodyHtml: "<p>Hi</p>",
			threadId: "thread_1",
		});
		expect(result.cc).toEqual(["c@example.com"]);
		expect(result.bcc).toEqual(["d@example.com"]);
	});

	it("rejects an empty `to` array", () => {
		expect(() => createDraftSchema.parse({ to: [], subject: "Hello" })).toThrow();
	});

	it("rejects an invalid email in `to`", () => {
		expect(() => createDraftSchema.parse({ to: ["not-an-email"], subject: "Hello" })).toThrow();
	});

	it("rejects an empty subject", () => {
		expect(() => createDraftSchema.parse({ to: ["a@example.com"], subject: "" })).toThrow();
	});

	it("rejects a missing `to`", () => {
		expect(() => createDraftSchema.parse({ subject: "Hello" })).toThrow();
	});

	it("updateDraftSchema accepts an empty object (all fields optional via .partial())", () => {
		expect(updateDraftSchema.parse({})).toEqual({});
	});

	it("updateDraftSchema still rejects an invalid email when a field is provided", () => {
		expect(() => updateDraftSchema.parse({ to: ["not-an-email"] })).toThrow();
	});
});

describe("confirmSendSchema", () => {
	it("accepts a non-empty idempotencyKey", () => {
		expect(confirmSendSchema.parse({ idempotencyKey: "key-1" })).toEqual({ idempotencyKey: "key-1" });
	});

	it("rejects an empty idempotencyKey", () => {
		expect(() => confirmSendSchema.parse({ idempotencyKey: "" })).toThrow();
	});

	it("rejects a missing idempotencyKey", () => {
		expect(() => confirmSendSchema.parse({})).toThrow();
	});
});

describe("searchQuerySchema", () => {
	it("coerces a string limit to a number and defaults limit when absent", () => {
		expect(searchQuerySchema.parse({ q: "hello", limit: "10" })).toEqual({ q: "hello", limit: 10 });
		expect(searchQuerySchema.parse({ q: "hello" })).toEqual({ q: "hello", limit: 25 });
	});

	it("rejects a missing q", () => {
		expect(() => searchQuerySchema.parse({})).toThrow();
	});

	it("rejects an empty q", () => {
		expect(() => searchQuerySchema.parse({ q: "" })).toThrow();
	});

	it("rejects a limit above 100", () => {
		expect(() => searchQuerySchema.parse({ q: "hello", limit: "101" })).toThrow();
	});

	it("rejects a limit below 1", () => {
		expect(() => searchQuerySchema.parse({ q: "hello", limit: "0" })).toThrow();
	});
});

describe("threadListQuerySchema", () => {
	it("defaults limit to 25 and leaves cursor/q/label optional", () => {
		const result = threadListQuerySchema.parse({});
		expect(result).toEqual({ limit: 25 });
	});

	it("coerces limit and accepts cursor/q/label", () => {
		const result = threadListQuerySchema.parse({ limit: "5", cursor: "c1", q: "hi", label: "inbox" });
		expect(result).toEqual({ limit: 5, cursor: "c1", q: "hi", label: "inbox" });
	});

	it("rejects a limit above 100", () => {
		expect(() => threadListQuerySchema.parse({ limit: "1000" })).toThrow();
	});
});

describe("adminMailboxActionSchema", () => {
	it("accepts a non-empty mailboxId", () => {
		expect(adminMailboxActionSchema.parse({ mailboxId: "mbx_1" })).toEqual({ mailboxId: "mbx_1" });
	});

	it("rejects an empty mailboxId", () => {
		expect(() => adminMailboxActionSchema.parse({ mailboxId: "" })).toThrow();
	});

	it("rejects a missing mailboxId", () => {
		expect(() => adminMailboxActionSchema.parse({})).toThrow();
	});
});
