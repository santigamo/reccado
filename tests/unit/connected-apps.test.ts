import { describe, expect, it } from "vitest";
import {
	canDelegate,
	DELEGATION_DISABLED_REASON,
	delegationBlockedReason,
	draftFromPolicy,
	emptyDraft,
	KIND_LABELS,
	parseDomainList,
	policyRequestBody,
	validateDraft,
	AUTO_ELIGIBLE,
} from "../../src/components/apps/connected-apps";

const app = (granted_scopes: string[], authorized = true) => ({ granted_scopes, authorized });

describe("connected apps helpers", () => {
	it("allows delegation only for admin without mail-read scopes", () => {
		expect(canDelegate(app(["admin"]))).toBe(true);
		expect(canDelegate(app(["admin", "mail:draft"]))).toBe(true);
		expect(canDelegate(app(["admin", "mail:read"]))).toBe(false);
		expect(canDelegate(app(["admin", "mail:read:sensitive"]))).toBe(false);
		expect(canDelegate(app(["mail:draft"]))).toBe(false);
		expect(canDelegate(app(["admin"], false))).toBe(false);
	});

	it("explains why it is disabled", () => {
		expect(delegationBlockedReason(app(["admin", "mail:read"]))).toBe(DELEGATION_DISABLED_REASON);
		expect(delegationBlockedReason(app(["mail:draft"]))).toMatch(/administración/);
		expect(delegationBlockedReason(app([], false))).toMatch(/Autoriza/);
		expect(delegationBlockedReason(app(["admin"]))).toBeNull();
	});

	it("describes every auto-eligible kind", () => {
		for (const kind of AUTO_ELIGIBLE) expect(KIND_LABELS[kind].hint.length).toBeGreaterThan(0);
	});

	it("builds the PUT body and validates the draft", () => {
		expect(parseDomainList("A.com, b.com  a.com\n")).toEqual(["a.com", "b.com"]);
		expect(validateDraft(emptyDraft())).toMatch(/buzón/);
		const draft = { ...emptyDraft(), mailboxIds: ["m1"], kinds: ["template_upsert" as const], linkDomains: "x.com, y.com" };
		expect(validateDraft(draft)).toBeNull();
		expect(validateDraft({ ...draft, maxAutoPerHour: 0 })).toMatch(/1 y 1000/);
		expect(policyRequestBody(draft)).toEqual({
			mailboxIds: ["m1"], kinds: ["template_upsert"], linkDomains: ["x.com", "y.com"], allowVariableLinks: false, maxAutoPerHour: 20,
		});
	});

	it("round-trips a stored policy into a draft", () => {
		const draft = draftFromPolicy({ clientId: "c", mailboxIds: ["m"], autoKinds: ["restore"], linkDomains: ["a.com", "b.com"], allowVariableLinks: true, maxAutoPerHour: 5 });
		expect(draft).toEqual({ mailboxIds: ["m"], kinds: ["restore"], linkDomains: "a.com, b.com", allowVariableLinks: true, maxAutoPerHour: 5 });
	});
});
