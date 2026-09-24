import { describe, expect, it } from "vitest";
import {
	normalizeZone,
	parseWranglerDnsGetOutput,
	resolveDmarcPlan,
	resolveSendingTarget,
	type SendingTarget,
	selectProviderRecords,
} from "../../scripts/lib/sending-plan";

function target(opts: { subdomain?: string; apex?: boolean } = {}): SendingTarget {
	const result = resolveSendingTarget({ zone: "example.com", ...opts });
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

describe("normalizeZone", () => {
	it("lowercases and drops a trailing dot", () => {
		expect(normalizeZone("Example.COM.")).toEqual({ ok: true, value: "example.com" });
	});

	it("rejects a missing or malformed zone", () => {
		expect(normalizeZone(undefined).ok).toBe(false);
		expect(normalizeZone("not a domain").ok).toBe(false);
	});
});

describe("resolveSendingTarget", () => {
	it("defaults to send.<zone>, never the apex", () => {
		expect(target()).toMatchObject({
			sendingDomain: "send.example.com",
			isApex: false,
			bounceDomain: "cf-bounce.send.example.com",
			dmarcDomain: "_dmarc.send.example.com",
		});
		expect(target({ subdomain: "" }).sendingDomain).toBe("send.example.com");
	});

	it("accepts a fully-qualified subdomain", () => {
		expect(target({ subdomain: "Mail.Example.com." }).sendingDomain).toBe("mail.example.com");
	});

	// Previously rejected, which is why the apex was onboarded by hand.
	it.each([
		{ apex: true },
		{ subdomain: "@" },
		{ subdomain: "example.com" },
		{ apex: true, subdomain: "@" },
	])("targets the zone apex for %o", (opts) => {
		expect(target(opts)).toEqual({
			zone: "example.com",
			label: null,
			sendingDomain: "example.com",
			isApex: true,
			bounceDomain: "cf-bounce.example.com",
			dmarcDomain: "_dmarc.example.com",
		});
	});

	it("refuses --apex together with a real subdomain", () => {
		const result = resolveSendingTarget({ zone: "example.com", apex: true, subdomain: "send" });
		expect(result.ok).toBe(false);
	});

	it.each(["hello@send", "bad label", "send/x"])("rejects subdomain %s", (subdomain) => {
		expect(resolveSendingTarget({ zone: "example.com", subdomain }).ok).toBe(false);
	});
});

describe("resolveDmarcPlan", () => {
	it("defaults a subdomain to monitor mode, and warns without rua", () => {
		const plan = resolveDmarcPlan({ target: target() });
		if (!plan.ok) throw new Error(plan.error);
		expect(plan.value.value).toBe("v=DMARC1; p=none; adkim=r; aspf=r");
		expect(plan.value.warnings.join(" ")).toMatch(/no --dmarc-rua/);
	});

	it("builds the same string the Worker's gate does", () => {
		const plan = resolveDmarcPlan({
			target: target(),
			policy: "Quarantine",
			alignment: "strict",
			rua: "dmarc@example.com",
		});
		if (!plan.ok) throw new Error(plan.error);
		expect(plan.value.value).toBe(
			"v=DMARC1; p=quarantine; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@example.com",
		);
	});

	// The apex DMARC governs every sender on the organizational domain; any
	// default would either relax an enforcing domain or break a sender we can't see.
	it("refuses the apex without an explicit policy", () => {
		const plan = resolveDmarcPlan({ target: target({ apex: true }), rua: "dmarc@example.com" });
		expect(plan.ok).toBe(false);
		if (!plan.ok) expect(plan.error).toMatch(/--dmarc-policy/);
	});

	it("accepts the apex with an explicit policy and says loudly what it governs", () => {
		const plan = resolveDmarcPlan({
			target: target({ apex: true }),
			policy: "none",
			rua: "dmarc@example.com",
		});
		if (!plan.ok) throw new Error(plan.error);
		expect(plan.value.value).toBe(
			"v=DMARC1; p=none; adkim=r; aspf=r; rua=mailto:dmarc@example.com",
		);
		expect(plan.value.warnings.join(" ")).toMatch(/EVERY sender using @example\.com/);
	});

	it("rejects unknown policy and alignment values", () => {
		expect(resolveDmarcPlan({ target: target(), policy: "strict" }).ok).toBe(false);
		expect(resolveDmarcPlan({ target: target(), alignment: "loose" }).ok).toBe(false);
	});
});

// Shape copied from `wrangler email sending dns get transcribo.es` (4.128.0), DKIM key shortened.
const APEX_DNS_GET = `
 ⛅️ wrangler 4.128.0
───────────────────
MX record:
  Name:     cf-bounce.example.com
  Content:  route1.mx.cloudflare.net.
  Priority: 51
  TTL:      1

MX record:
  Name:     cf-bounce.example.com
  Content:  route2.mx.cloudflare.net.
  Priority: 99
  TTL:      1

TXT record:
  Name:     cf-bounce.example.com
  Content:  "v=spf1 include:_spf.mx.cloudflare.net ~all"
  TTL:      1

TXT record:
  Name:     cf-bounce._domainkey.example.com
  Content:  "v=DKIM1; h=sha256; k=rsa; p=MIIBIjAN"
  TTL:      1

TXT record:
  Name:     _dmarc.example.com
  Content:  "v=DMARC1; p=reject;"
  TTL:      1
`;

describe("provider records for the apex", () => {
	const records = parseWranglerDnsGetOutput(APEX_DNS_GET);

	it("parses every block, stripping TXT quotes", () => {
		expect(records).toHaveLength(5);
		expect(records.find((r) => r.name === "_dmarc.example.com")?.content).toBe(
			"v=DMARC1; p=reject;",
		);
	});

	// The provider's p=reject suggestion must never reach the organizational domain.
	it("selects DKIM + bounce MX only, never the provider's DMARC or SPF", () => {
		const { dkim, mx } = selectProviderRecords(records, "example.com");
		expect(dkim).toEqual({
			type: "TXT",
			name: "cf-bounce._domainkey.example.com",
			content: "v=DKIM1; h=sha256; k=rsa; p=MIIBIjAN",
		});
		expect(mx.map((r) => [r.content, r.priority])).toEqual([
			["route1.mx.cloudflare.net.", 51],
			["route2.mx.cloudflare.net.", 99],
		]);
	});

	it("does not pick a subdomain's DKIM for the apex", () => {
		const sub = parseWranglerDnsGetOutput(
			APEX_DNS_GET.replaceAll(
				"cf-bounce._domainkey.example.com",
				"cf-bounce._domainkey.send.example.com",
			),
		);
		expect(selectProviderRecords(sub, "example.com").dkim).toBeUndefined();
		expect(selectProviderRecords(sub, "send.example.com").dkim?.name).toBe(
			"cf-bounce._domainkey.send.example.com",
		);
	});
});
