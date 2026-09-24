import { describe, expect, it } from "vitest";
import {
	classifyDmarc,
	isProviderAutoDmarc,
	lookupTxt,
	parseDmarcTags,
	parseDohTxtAnswer,
} from "../../scripts/lib/dmarc";

describe("parseDmarcTags", () => {
	it("reads tags from a quoted DMARC TXT", () => {
		expect(parseDmarcTags('"v=DMARC1; p=none; rua=mailto:d@example.com"')).toEqual({
			v: "DMARC1",
			p: "none",
			rua: "mailto:d@example.com",
		});
	});

	it("is null for non-DMARC TXT", () => {
		expect(parseDmarcTags("v=spf1 -all")).toBeNull();
	});
});

describe("isProviderAutoDmarc", () => {
	it("matches the record Email Sending auto-creates, quoted or not", () => {
		expect(isProviderAutoDmarc("v=DMARC1; p=reject;")).toBe(true);
		expect(isProviderAutoDmarc('"v=DMARC1; p=reject;"')).toBe(true);
		expect(isProviderAutoDmarc("v=DMARC1; p=reject")).toBe(true);
	});

	it("does not match a chosen reject policy", () => {
		expect(isProviderAutoDmarc("v=DMARC1; p=reject; rua=mailto:d@example.com")).toBe(false);
		expect(isProviderAutoDmarc("v=DMARC1; p=reject; adkim=r; aspf=r; pct=100")).toBe(false);
	});
});

describe("classifyDmarc", () => {
	it("passes a chosen policy with reports", () => {
		expect(
			classifyDmarc("send.example.com", [
				"v=DMARC1; p=none; adkim=r; aspf=r; rua=mailto:d@example.com",
			]),
		).toMatchObject({ status: "pass", policy: "none" });
	});

	// The apex left behind today: enforcing, reporting to nobody, chosen by nobody.
	it("warns on the provider's auto-created signature", () => {
		const verdict = classifyDmarc("example.com", ["v=DMARC1; p=reject;"]);
		expect(verdict).toMatchObject({ status: "warn", policy: "reject" });
		expect(verdict.message).toMatch(/auto-creates/);
	});

	it.each(["reject", "quarantine"])("warns on p=%s without rua", (policy) => {
		const verdict = classifyDmarc("example.com", [
			`v=DMARC1; p=${policy}; adkim=r; aspf=r; pct=100`,
		]);
		expect(verdict).toMatchObject({ status: "warn", policy });
		expect(verdict.message).toMatch(/no rua/);
	});

	it("passes monitor mode without rua, but says it reports to nobody", () => {
		const verdict = classifyDmarc("example.com", ["v=DMARC1; p=none;"]);
		expect(verdict.status).toBe("pass");
		expect(verdict.message).toMatch(/without reports/);
	});

	it("warns when there is no record, ignoring unrelated TXT", () => {
		expect(classifyDmarc("example.com", ["google-site-verification=x"])).toMatchObject({
			status: "warn",
			policy: null,
		});
	});

	// Two DMARC records at one name: RFC 7489 treats the policy as absent.
	it("warns on more than one DMARC record", () => {
		const verdict = classifyDmarc("example.com", ["v=DMARC1; p=none;", "v=DMARC1; p=reject;"]);
		expect(verdict).toMatchObject({ status: "warn", policy: null });
		expect(verdict.message).toMatch(/2 DMARC records/);
	});

	it("warns on a record with no valid policy", () => {
		expect(classifyDmarc("example.com", ["v=DMARC1; rua=mailto:x@example.com"]).status).toBe(
			"warn",
		);
	});
});

describe("parseDohTxtAnswer", () => {
	it("returns the TXT strings, unquoted", () => {
		expect(
			parseDohTxtAnswer({
				Status: 0,
				Answer: [{ name: "_dmarc.example.com", type: 16, data: '"v=DMARC1; p=reject;"' }],
			}),
		).toEqual(["v=DMARC1; p=reject;"]);
	});

	it("treats NXDOMAIN as no records, and SERVFAIL as unknown", () => {
		expect(parseDohTxtAnswer({ Status: 3 })).toEqual([]);
		expect(parseDohTxtAnswer({ Status: 2 })).toBeNull();
		expect(parseDohTxtAnswer("nope")).toBeNull();
	});

	it("skips non-TXT answers such as a CNAME hop", () => {
		expect(
			parseDohTxtAnswer({
				Status: 0,
				Answer: [
					{ type: 5, data: "elsewhere.example.net." },
					{ type: 16, data: '"v=DMARC1; p=none;"' },
				],
			}),
		).toEqual(["v=DMARC1; p=none;"]);
	});
});

describe("lookupTxt", () => {
	it("asks DoH for TXT with the dns-json accept header", async () => {
		let seen: { url: string; accept: string | null } | undefined;
		const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			seen = { url: String(input), accept: new Headers(init?.headers).get("accept") };
			return new Response(
				JSON.stringify({ Status: 0, Answer: [{ type: 16, data: '"v=DMARC1; p=none;"' }] }),
			);
		}) as typeof fetch;
		expect(await lookupTxt("_dmarc.example.com", fakeFetch)).toEqual(["v=DMARC1; p=none;"]);
		expect(seen?.url).toBe("https://cloudflare-dns.com/dns-query?name=_dmarc.example.com&type=TXT");
		expect(seen?.accept).toBe("application/dns-json");
	});

	it("is null when the resolver cannot be reached", async () => {
		const failing = (async () => {
			throw new Error("offline");
		}) as typeof fetch;
		expect(await lookupTxt("_dmarc.example.com", failing)).toBeNull();
	});
});
