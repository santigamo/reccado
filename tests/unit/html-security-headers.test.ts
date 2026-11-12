import { describe, expect, it } from "vitest";
import { withHtmlSecurityHeaders } from "../../src/server";

describe("SSR HTML security headers", () => {
	it("sets anti-framing headers and no-referrer on /approve", async () => {
		const response = withHtmlSecurityHeaders(
			new Response("<html></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
			"/approve/abc",
		);
		expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		expect(await response.text()).toBe("<html></html>");
	});

	it("keeps other CSP directives, replaces frame-ancestors, and skips Referrer-Policy elsewhere", () => {
		const response = withHtmlSecurityHeaders(
			new Response("x", {
				headers: { "content-type": "text/html", "content-security-policy": "default-src 'self'; frame-ancestors *" },
			}),
			"/security",
		);
		expect(response.headers.get("content-security-policy")).toBe("default-src 'self'; frame-ancestors 'none'");
		expect(response.headers.get("referrer-policy")).toBeNull();
	});

	it("leaves non-HTML responses alone", () => {
		const json = Response.json({ ok: true });
		expect(withHtmlSecurityHeaders(json, "/x")).toBe(json);
	});
});
