import { describe, expect, it } from "vitest";
import { constrainConsentScopes } from "#/api/better-auth";

const ALL = "mail:read mail:draft mail:send mail:read:sensitive admin";

async function constrain(body: Record<string, unknown>): Promise<{ scope?: string }> {
	const request = new Request("https://example.com/api/auth/oauth2/consent", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await (await constrainConsentScopes(request)).json()) as { scope?: string };
}

describe("consent scope narrowing", () => {
	it("does not grant high-risk scopes when the body names no scope", async () => {
		const out = await constrain({ accept: true, oauth_query: `client_id=x&scope=${encodeURIComponent(ALL)}` });
		expect(out.scope).toBe("mail:read mail:draft");
	});

	it("grants only the high-risk scopes explicitly ticked", async () => {
		const out = await constrain({
			accept: true,
			scope: "mail:read mail:draft admin",
			oauth_query: `scope=${encodeURIComponent(ALL)}`,
		});
		expect(out.scope).toBe("mail:read mail:draft admin");
	});

	it("never adds scopes that were not requested", async () => {
		const out = await constrain({
			accept: true,
			scope: "admin mail:read",
			oauth_query: `scope=${encodeURIComponent("mail:read mail:draft")}`,
		});
		expect(out.scope).toBe("mail:read mail:draft");
	});

	it("leaves a denial untouched", async () => {
		const out = await constrain({ accept: false, oauth_query: `scope=${encodeURIComponent(ALL)}` });
		expect(out.scope).toBeUndefined();
	});
});
