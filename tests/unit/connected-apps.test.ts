import { describe, expect, it } from "vitest";
import {
	appInitials,
	appName,
	formatAppDate,
	formatLastUsed,
	orderScopes,
	SCOPE_COPY,
	scopeCopy,
} from "../../src/components/apps/connected-apps";
import { MCP_SCOPES } from "../../src/lib/mcp-scopes";

describe("connected apps helpers", () => {
	it("names an app by its name or a client id prefix", () => {
		expect(appName({ name: " Claude ", client_id: "abcdef1234" })).toBe("Claude");
		expect(appName({ name: null, client_id: "abcdef1234" })).toBe("App abcdef12");
	});

	it("formats dates and tolerates missing or invalid ones", () => {
		expect(formatAppDate(null)).toBe("—");
		expect(formatAppDate("nope")).toBe("—");
		expect(formatAppDate("2026-11-14T10:00:00Z")).toMatch(/2026/);
	});

	it("labels every MCP scope in plain language and marks the approval-gated ones", () => {
		for (const scope of MCP_SCOPES) expect(SCOPE_COPY[scope].label.length).toBeGreaterThan(0);
		expect(scopeCopy("mail:send")).toMatchObject({ label: "Ask to send", gated: true });
		expect(scopeCopy("mail:read").gated).toBe(false);
		expect(scopeCopy("admin").label).toBe("Legacy admin");
		expect(scopeCopy("weird:thing").label).toBe("weird:thing");
		expect(orderScopes(["keys:write", "mail:read", "admin", "mail:read"])).toEqual([
			"mail:read",
			"keys:write",
			"admin",
		]);
	});

	it("derives initials and a last-used label", () => {
		expect(appInitials({ name: "Claude Code", client_id: "x" })).toBe("CC");
		expect(appInitials({ name: null, client_id: "x" })).toBe("A");
		const now = new Date("2026-11-16T12:00:00");
		expect(formatLastUsed(null, now)).toBe("Never");
		expect(formatLastUsed("2026-11-16T08:00:00", now)).toBe("Today");
		expect(formatLastUsed("2026-11-15T08:00:00", now)).toBe("Yesterday");
		expect(formatLastUsed("2026-11-09T08:00:00", now)).toMatch(/9 Nov 2026/);
	});
});
