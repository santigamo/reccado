import { describe, expect, it } from "vitest";
import { appName, formatAppDate } from "../../src/components/apps/connected-apps";

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
});
