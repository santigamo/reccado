import { describe, expect, it } from "vitest";
import {
	MAX_DISPLAY_NAME_LENGTH,
	sanitizeAddressNames,
	sanitizeDisplayName,
} from "#/lib/display-name";
import {
	avatarHue,
	displayName,
	initials,
	type MailboxCounts,
	parseAddressNames,
	recipientLabel,
} from "#/lib/mail";
import { formatCount, sumCounts } from "#/lib/use-unified-mail";

/**
 * Display names are the sender's own words. These tests pin what survives from
 * them and, more importantly, that nothing in a name can stand in for, hide, or
 * contradict the real address.
 */

describe("sanitizeDisplayName", () => {
	it("keeps an ordinary name", () => {
		expect(sanitizeDisplayName("Noor Haddad", "noor@haddad.dev")).toBe("Noor Haddad");
		expect(sanitizeDisplayName("José Ñúñez", "jose@example.es")).toBe("José Ñúñez");
	});

	it("returns null for nothing to show", () => {
		expect(sanitizeDisplayName(null, "a@b.co")).toBeNull();
		expect(sanitizeDisplayName(undefined, "a@b.co")).toBeNull();
		expect(sanitizeDisplayName(42, "a@b.co")).toBeNull();
		expect(sanitizeDisplayName("   ", "a@b.co")).toBeNull();
		expect(sanitizeDisplayName('""', "a@b.co")).toBeNull();
	});

	it("turns control characters and line breaks into spaces (no header or row injection)", () => {
		expect(sanitizeDisplayName("Noor\r\nBcc: victim@x.io", "noor@haddad.dev")).toBeNull();
		expect(sanitizeDisplayName("Noor\nHaddad", "noor@haddad.dev")).toBe("Noor Haddad");
		expect(sanitizeDisplayName("Noor\u0000\u0007Haddad\u0085", "noor@haddad.dev")).toBe(
			"Noor Haddad",
		);
		expect(sanitizeDisplayName("Noor\u2028Haddad", "noor@haddad.dev")).toBe("Noor Haddad");
	});

	it("strips bidi overrides, zero-width padding and tag characters", () => {
		// U+202E would draw "Haddad" reversed; U+200B hides a split; tags hide text.
		expect(sanitizeDisplayName("\u202ENoor\u202C Haddad", "noor@haddad.dev")).toBe("Noor Haddad");
		expect(sanitizeDisplayName("No\u200Bor\uFEFF Had\u2066dad\u2069", "noor@haddad.dev")).toBe(
			"Noor Haddad",
		);
		expect(sanitizeDisplayName("Noor\u{E0041}\u{E0042} Haddad", "noor@haddad.dev")).toBe(
			"Noor Haddad",
		);
		expect(sanitizeDisplayName("\u200B\u200D\u2060", "noor@haddad.dev")).toBeNull();
	});

	it("caps the length in code points", () => {
		const long = "A".repeat(500);
		expect(sanitizeDisplayName(long, "a@b.co")).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
		// Astral characters are not split in half.
		const emoji = "😀".repeat(200);
		const capped = sanitizeDisplayName(emoji, "a@b.co");
		expect(Array.from(capped ?? "")).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
		expect(capped?.includes("\uFFFD")).toBe(false);
	});

	it("refuses a name that claims a different address", () => {
		expect(sanitizeDisplayName("ceo@corp.com", "attacker@evil.io")).toBeNull();
		expect(sanitizeDisplayName("Support <help@bank.com>", "attacker@evil.io")).toBeNull();
		expect(sanitizeDisplayName("PayPal (service@paypal.com)", "x@evil.io")).toBeNull();
		// Fullwidth and small commercial at fold to "@" before the comparison.
		expect(sanitizeDisplayName("ceo＠corp.com", "attacker@evil.io")).toBeNull();
		expect(sanitizeDisplayName("ceo﹫corp.com", "attacker@evil.io")).toBeNull();
	});

	it("drops a name that is just the address, keeps one that only repeats it", () => {
		expect(sanitizeDisplayName("noor@haddad.dev", "noor@haddad.dev")).toBeNull();
		expect(sanitizeDisplayName("'NOOR@haddad.dev'", "noor@haddad.dev")).toBeNull();
		expect(sanitizeDisplayName("Noor (noor@haddad.dev)", "noor@haddad.dev")).toBe(
			"Noor (noor@haddad.dev)",
		);
	});
});

describe("sanitizeAddressNames", () => {
	it("keys by lowercased address and keeps only usable names", () => {
		expect(
			sanitizeAddressNames([
				{ address: "Ana@Example.com", name: "Ana Pérez" },
				{ address: "bob@example.com", name: "" },
				{ address: "eve@evil.io", name: "boss@corp.com" },
			]),
		).toEqual({ "ana@example.com": "Ana Pérez" });
	});

	it("is null rather than {} when nobody had a name", () => {
		expect(sanitizeAddressNames([{ address: "bob@example.com", name: null }])).toBeNull();
		expect(sanitizeAddressNames([])).toBeNull();
	});
});

describe("client helpers prefer the stored name", () => {
	it("displayName uses the stored name, else the local part (old rows)", () => {
		expect(displayName("noor@haddad.dev", "Noor Haddad")).toBe("Noor Haddad");
		expect(displayName("noor@haddad.dev", null)).toBe("noor");
		expect(displayName("noor@haddad.dev")).toBe("noor");
		expect(displayName(null)).toBe("Unknown");
	});

	it("displayName re-sanitises a stored name and ignores a spoofing one", () => {
		expect(displayName("noor@haddad.dev", "\u202ENoor")).toBe("Noor");
		expect(displayName("attacker@evil.io", "ceo@corp.com")).toBe("attacker");
	});

	it("initials come from the name, the colour from the address", () => {
		expect(initials("noor@haddad.dev", "Noor Haddad")).toBe("NH");
		expect(initials("noor@haddad.dev", null)).toBe("N");
		// A stranger using Noor's name does not get Noor's colour.
		expect(avatarHue("noor@haddad.dev")).not.toBe(avatarHue("noor@impostor.io"));
	});

	it("recipients render as Name <address>, or the bare address", () => {
		const names = parseAddressNames('{"ana@example.com":"Ana Pérez","x@y.z":7}');
		expect(names).toEqual({ "ana@example.com": "Ana Pérez" });
		expect(recipientLabel("Ana@Example.com", names)).toBe("Ana Pérez <Ana@Example.com>");
		expect(recipientLabel("bob@example.com", names)).toBe("bob@example.com");
		expect(parseAddressNames(null)).toEqual({});
		expect(parseAddressNames("not json")).toEqual({});
		expect(parseAddressNames("[1,2]")).toEqual({});
	});
});

describe("counts formatting", () => {
	it("uses English thousands separators whatever the runtime locale", () => {
		expect(formatCount(14171)).toBe("14,171");
		expect(formatCount(0)).toBe("0");
		expect(formatCount(1_234_567)).toBe("1,234,567");
	});

	const counts = (n: number): MailboxCounts => ({
		inbox: { threads: n, unread: 1, messages: n * 2 },
		sent: { threads: 1, unread: 0, messages: 1 },
		archive: { threads: 0, unread: 0, messages: 0 },
		trash: { threads: 0, unread: 0, messages: 0 },
		all: { threads: n + 1, unread: 1, messages: n * 2 + 1 },
		drafts: 2,
	});

	it("sums mailboxes in scope", () => {
		const total = sumCounts({ byMailbox: { a: counts(3), b: counts(5) }, failed: [] }, ["a", "b"]);
		expect(total?.inbox).toEqual({ threads: 8, unread: 2, messages: 16 });
		expect(total?.drafts).toBe(4);
	});

	it("is null when a mailbox in scope has no counts (no partial totals)", () => {
		expect(sumCounts({ byMailbox: { a: counts(3) }, failed: ["b"] }, ["a", "b"])).toBeNull();
	});
});
