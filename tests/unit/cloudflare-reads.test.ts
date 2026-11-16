import { describe, expect, it } from "vitest";
import { classifyAddressRouting, dmarcPolicyOf } from "#/lib/admin/cloudflare-reads";

const literal = (
	address: string,
	actions: Array<{ type: string; value?: string[] }>,
	enabled = true,
) => ({
	enabled,
	matchers: [{ type: "literal", field: "to", value: address }],
	actions,
});

describe("classifyAddressRouting", () => {
	it("reports a literal rule to a Worker as routed, naming the Worker", () => {
		const [result] = classifyAddressRouting(
			["Hello@Example.com"],
			[literal("hello@example.com", [{ type: "worker", value: ["reccado-dev"] }])],
			null,
		);
		expect(result).toEqual({
			address: "hello@example.com",
			state: "routed",
			via: "rule",
			workers: ["reccado-dev"],
		});
	});

	it("lets a literal forward rule win over a catch-all to a Worker", () => {
		const [result] = classifyAddressRouting(
			["hello@example.com"],
			[literal("hello@example.com", [{ type: "forward", value: ["x@y.z"] }])],
			{ enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["w"] }] },
		);
		expect(result).toMatchObject({ state: "elsewhere", via: "rule", action: "forward" });
	});

	it("ignores disabled rules and uses an enabled catch-all to a Worker", () => {
		const [result] = classifyAddressRouting(
			["hello@example.com"],
			[literal("hello@example.com", [{ type: "worker", value: ["w"] }], false)],
			{ enabled: true, matchers: [{ type: "all" }], actions: [{ type: "worker", value: ["w"] }] },
		);
		expect(result).toMatchObject({ state: "routed", via: "catch_all", workers: ["w"] });
	});

	it("never reports routed without a rule: a disabled or dropping catch-all is not_routed", () => {
		expect(
			classifyAddressRouting(["a@example.com"], [], {
				enabled: false,
				actions: [{ type: "worker", value: ["w"] }],
			})[0],
		).toEqual({ address: "a@example.com", state: "not_routed" });
		expect(
			classifyAddressRouting(["a@example.com"], [], {
				enabled: true,
				actions: [{ type: "drop" }],
			})[0],
		).toEqual({ address: "a@example.com", state: "not_routed" });
	});
});

describe("dmarcPolicyOf", () => {
	it("reads p= from a DMARC record, quoted or not", () => {
		expect(dmarcPolicyOf("v=DMARC1; p=none; rua=mailto:d@example.com")).toBe("none");
		expect(dmarcPolicyOf('"v=DMARC1;p=Quarantine"')).toBe("quarantine");
		expect(dmarcPolicyOf("v=DMARC1; sp=reject")).toBeNull();
	});
});
