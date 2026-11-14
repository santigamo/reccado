import { describe, expect, it } from "vitest";
import { parsePolicyArgs } from "../../scripts/lib/mcp-policy-args";
import { parsePolicyInput } from "#/lib/mcp-client-policy";

describe("parsePolicyArgs", () => {
	it("parses set with several mailboxes, comma lists and flags", () => {
		expect(parsePolicyArgs(["set", "--client", "c1", "--mailbox", "m1", "m2", "--mailbox", "m3,m4", "--kinds", "template_upsert,restore", "--link-domains", "a.test,b.test", "--allow-variable-links", "--max-per-hour", "5", "--host", "x"]))
			.toEqual({ action: "set", clientId: "c1", mailboxIds: ["m1", "m2", "m3", "m4"], kinds: ["template_upsert", "restore"], linkDomains: ["a.test", "b.test"], allowVariableLinks: true, maxAutoPerHour: 5 });
	});
	it("parses show and rm and rejects bad input", () => {
		expect(parsePolicyArgs(["show"])).toEqual({ action: "show", clientId: undefined });
		expect(parsePolicyArgs(["rm", "--client", "c1"])).toEqual({ action: "rm", clientId: "c1" });
		expect(() => parsePolicyArgs(["set", "--client", "c1"])).toThrow(/--mailbox/);
		expect(() => parsePolicyArgs(["rm"])).toThrow(/--client/);
		expect(() => parsePolicyArgs(["nope"])).toThrow(/set, show or rm/);
		expect(() => parsePolicyArgs(["show", "--bogus", "1"])).toThrow(/unknown flag/);
	});
});

describe("parsePolicyInput", () => {
	const base = { clientId: "c1", mailboxIds: ["m1"], autoKinds: ["template_upsert"], linkDomains: ["A.test"] };
	it("normalises and applies defaults", () => {
		expect(parsePolicyInput(base)).toMatchObject({ linkDomains: ["a.test"], maxAutoPerHour: 20, allowVariableLinks: false });
	});
	it("never lets a policy exceed the auto-eligible ceiling", () => {
		for (const kind of ["send", "api_key_create", "api_key_rotate", "api_key_scopes", "domain_add", "alias_add", "routing_rule_upsert", "mailbox_create", "mailbox_disable"])
			expect(() => parsePolicyInput({ ...base, autoKinds: [kind] }), kind).toThrow(/subset/);
		expect(() => parsePolicyInput({ ...base, maxAutoPerHour: 0 })).toThrow();
		expect(() => parsePolicyInput({ ...base, linkDomains: ["bad domain"] })).toThrow();
	});
});
