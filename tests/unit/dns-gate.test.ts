import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { insertDomain } from "#/db/d1";
import { DnsGateRefusal, buildDmarcValue, ensureDmarcRecord } from "#/lib/dns-gate";
import migration1 from "../../migrations/d1/0001_initial.sql?raw";
import migration2 from "../../migrations/d1/0002_message_index.sql?raw";
import migration3 from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

// ---------------------------------------------------------------------------
// The source guard
// ---------------------------------------------------------------------------

// Same technique as the mailbox-stub guard: Vite inlines every file under src/
// as a string at build time, because Node's `fs` does not see the project tree
// from inside the Workers pool. Nothing is filtered — a DNS write hidden in a
// .tsx route or in generated code is still a DNS write.
const sourceFiles = import.meta.glob("../../src/**/*", {
	query: "?raw",
	eager: true,
	import: "default",
}) as Record<string, string>;

/** The one file allowed to address the DNS API. It is the gate. */
const GATE_PATH = "src/lib/dns-gate.ts";

// `dns_records` is how the Cloudflare REST API spells this authority, in every
// method that reads, creates, patches or deletes a record. Matching the literal
// is a deliberate choice about scope: it catches the way a person in a hurry
// actually writes the call, not a path assembled from fragments to evade it.
// This guard is a ratchet against decay, not a sandbox against a hostile author.
const DNS_WRITE_PATTERN = /dns_records/g;

const WHY_BYPASSING_HURTS = `The Worker holds a Cloudflare token that can edit DNS for Reccado's zones. Those
zones are shared with things that have nothing to do with email: the apex, MX
records for real mailboxes, and TXT records that third parties use for account
recovery. Cloudflare has no record-level token scope, so the ONLY thing keeping
"publish a DMARC policy" from being "rewrite the zone" is that every write goes
through one function that composes the record itself and resolves the zone from
the domains registry rather than from its caller.

A direct call to dns_records re-opens that gap. Route the call sites listed
above through ensureDmarcRecord() from #/lib/dns-gate, and if you need to write
a record shape the gate does not yet support, add an intent-shaped function to
the gate instead of a general-purpose one.`;

function toRepoPath(globKey: string): string {
	return globKey.slice(globKey.indexOf("src/"));
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split("\n").length;
}

describe("dns-gate source guard", () => {
	it("is the only file in src/ that addresses the Cloudflare DNS record API", () => {
		const offenders = new Set<string>();
		for (const [globKey, source] of Object.entries(sourceFiles)) {
			const path = toRepoPath(globKey);
			if (path === GATE_PATH) continue;
			for (const match of source.matchAll(DNS_WRITE_PATTERN)) {
				offenders.add(`${path}:${lineOf(source, match.index)}`);
			}
		}
		expect(
			[...offenders].sort(),
			`Direct Cloudflare DNS access outside the gate:\n\n${[...offenders].sort().join("\n")}\n\n${WHY_BYPASSING_HURTS}`,
		).toEqual([]);
	});

	it("actually sees the source tree", () => {
		// A glob that silently resolves to nothing would make the guard above pass
		// forever while checking nothing at all.
		expect(Object.keys(sourceFiles).some((key) => toRepoPath(key) === GATE_PATH)).toBe(true);
		expect(Object.keys(sourceFiles).length).toBeGreaterThan(20);
	});
});

// ---------------------------------------------------------------------------
// Behaviour
// ---------------------------------------------------------------------------

interface RecordedCall {
	method: string;
	url: string;
	body: Record<string, unknown> | undefined;
}

const realFetch = globalThis.fetch;
let calls: RecordedCall[] = [];

/**
 * Stand in for the Cloudflare API. `listResponse` is what a GET on the record
 * name returns; everything else succeeds. Every request is recorded so the tests
 * can assert on what the gate ASKED FOR, which is the part that matters — a gate
 * that returns the right value while sending the wrong request is not a gate.
 */
function stubCloudflare(listResponse: Array<{ id: string; type: string; content: string }>): void {
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stand-in
	globalThis.fetch = (async (input: any, init: any) => {
		const url = typeof input === "string" ? input : input.url;
		const method = init?.method ?? "GET";
		calls.push({
			method,
			url,
			body: init?.body ? JSON.parse(init.body as string) : undefined,
		});
		const result = method === "GET" ? listResponse : { id: "rec_new" };
		return new Response(JSON.stringify({ success: true, errors: [], result }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
}

/** Fails the test if the gate touches the network at all. */
function forbidNetwork(): void {
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stand-in
	globalThis.fetch = (async (input: any) => {
		throw new Error(`gate reached the network when it should have refused: ${String(input)}`);
	}) as typeof fetch;
}

afterEach(() => {
	globalThis.fetch = realFetch;
	calls = [];
});

const TOKEN_ENV = { CLOUDFLARE_API_TOKEN: "test-token" };

let seq = 0;
function uniqueSuffix(): string {
	seq += 1;
	return `g${seq}`;
}

async function seedZone(opts: {
	status?: "pending" | "active" | "disabled";
	zoneId?: string;
}): Promise<{ domain: string; zoneId: string }> {
	const suffix = uniqueSuffix();
	const domain = `${suffix}.gate.test`;
	const zoneId = opts.zoneId ?? `zone_${suffix}`;
	await insertDomain(env.INDEX_DB, {
		id: `dom_${suffix}`,
		domain,
		zone_id: zoneId,
		status: opts.status ?? "active",
	});
	return { domain, zoneId };
}

beforeAll(async () => {
	const statements = splitSqlStatements([migration1, migration2, migration3].join("\n"));
	for (const statement of statements) {
		await env.INDEX_DB.prepare(statement).run();
	}
});

describe("buildDmarcValue", () => {
	it("omits pct in monitor mode, where it would be meaningless", () => {
		expect(buildDmarcValue("none")).toBe("v=DMARC1; p=none; adkim=r; aspf=r");
	});

	it("carries pct and rua once enforcing", () => {
		expect(buildDmarcValue("quarantine", "strict", "dmarc@example.com")).toBe(
			"v=DMARC1; p=quarantine; adkim=s; aspf=s; pct=100; rua=mailto:dmarc@example.com",
		);
	});
});

describe("dns-gate refusals", () => {
	it("refuses a domain that is not in the registry", async () => {
		forbidNetwork();
		await expect(
			ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
				sendingDomain: "notify.never-registered.test",
				policy: "none",
			}),
		).rejects.toBeInstanceOf(DnsGateRefusal);
	});

	it("refuses a registered domain that is disabled", async () => {
		const { domain } = await seedZone({ status: "disabled" });
		forbidNetwork();
		await expect(
			ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
				sendingDomain: `notify.${domain}`,
				policy: "none",
			}),
		).rejects.toThrow(/disabled/);
	});

	it("refuses when the registry has no zone id to write to", async () => {
		const { domain } = await seedZone({ zoneId: "" });
		forbidNetwork();
		await expect(
			ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
				sendingDomain: `notify.${domain}`,
				policy: "none",
			}),
		).rejects.toThrow(/no zone_id/);
	});

	it("refuses without a token rather than failing somewhere further in", async () => {
		forbidNetwork();
		await expect(
			ensureDmarcRecord({}, env.INDEX_DB, { sendingDomain: "x.gate.test", policy: "none" }),
		).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
	});

	it.each([
		["path traversal", "notify.example.com/../../zones"],
		["a query separator", "notify.example.com?x=1"],
		["a bare label with no dot", "localhost"],
		["an empty label", "notify..example.com"],
		["a space", "notify example.com"],
	])("refuses a domain containing %s", async (_label, sendingDomain) => {
		forbidNetwork();
		await expect(
			ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, { sendingDomain, policy: "none" }),
		).rejects.toBeInstanceOf(DnsGateRefusal);
	});
});

describe("dns-gate request shape", () => {
	it("writes TXT at _dmarc.<sending domain> in the zone the registry names", async () => {
		const { domain, zoneId } = await seedZone({});
		stubCloudflare([]);
		const outcome = await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: `notify.${domain}`,
			policy: "none",
			rua: "dmarc@example.com",
		});

		expect(outcome.status).toBe("created");
		expect(outcome.name).toBe(`_dmarc.notify.${domain}`);

		const write = calls.find((call) => call.method === "POST");
		expect(write).toBeDefined();
		expect(write?.url).toContain(`/zones/${zoneId}/dns_records`);
		expect(write?.body).toMatchObject({
			type: "TXT",
			name: `_dmarc.notify.${domain}`,
			content: "v=DMARC1; p=none; adkim=r; aspf=r; rua=mailto:dmarc@example.com",
		});
	});

	it("never addresses the apex, whatever the intent asks for", async () => {
		const { domain } = await seedZone({});
		stubCloudflare([]);
		// Sending from the apex itself is legitimate; _dmarc.<apex> is still not the apex.
		await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: domain,
			policy: "none",
		});
		const write = calls.find((call) => call.method === "POST");
		expect(write?.body).toMatchObject({ name: `_dmarc.${domain}` });
		for (const call of calls) {
			expect(call.body?.name).not.toBe(domain);
		}
	});

	it("resolves the most specific registered zone when zones nest", async () => {
		const suffix = uniqueSuffix();
		const parent = `${suffix}.nest.test`;
		const child = `mail.${parent}`;
		await insertDomain(env.INDEX_DB, {
			id: `dom_${suffix}_p`,
			domain: parent,
			zone_id: "zone_parent",
			status: "active",
		});
		await insertDomain(env.INDEX_DB, {
			id: `dom_${suffix}_c`,
			domain: child,
			zone_id: "zone_child",
			status: "active",
		});
		stubCloudflare([]);
		await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: `notify.${child}`,
			policy: "none",
		});
		expect(calls.every((call) => call.url.includes("zone_child"))).toBe(true);
	});
});

describe("dns-gate upsert behaviour", () => {
	it("leaves a matching record untouched even when Cloudflare quotes it", async () => {
		const { domain } = await seedZone({});
		// Provider-provisioned records come back quoted; API-created ones do not.
		// Treating those as different is what created duplicate DMARC records before.
		stubCloudflare([
			{ id: "rec_1", type: "TXT", content: '"v=DMARC1; p=none; adkim=r; aspf=r"' },
		]);
		const outcome = await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: `notify.${domain}`,
			policy: "none",
		});
		expect(outcome.status).toBe("unchanged");
		expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
	});

	it("patches, rather than duplicates, a record with a different policy", async () => {
		const { domain } = await seedZone({});
		// This is the real starting state: Cloudflare Email Sending provisions p=reject.
		stubCloudflare([{ id: "rec_cf", type: "TXT", content: '"v=DMARC1; p=reject"' }]);
		const outcome = await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: `notify.${domain}`,
			policy: "none",
			rua: "dmarc@example.com",
		});
		expect(outcome.status).toBe("updated");
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		const patch = calls.find((call) => call.method === "PATCH");
		expect(patch?.url).toContain("/dns_records/rec_cf");
	});

	it("collapses duplicate DMARC records, which otherwise read as no policy at all", async () => {
		const { domain } = await seedZone({});
		stubCloudflare([
			{ id: "rec_keep", type: "TXT", content: "v=DMARC1; p=none" },
			{ id: "rec_dupe", type: "TXT", content: '"v=DMARC1; p=reject"' },
		]);
		await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: `notify.${domain}`,
			policy: "none",
		});
		const deletes = calls.filter((call) => call.method === "DELETE");
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.url).toContain("rec_dupe");
	});

	it("never deletes a TXT record whose meaning it does not understand", async () => {
		const { domain } = await seedZone({});
		// A verification token someone else put at this name. Not ours to remove.
		stubCloudflare([
			{ id: "rec_other", type: "TXT", content: '"some-vendor-verification=abc123"' },
		]);
		const outcome = await ensureDmarcRecord(TOKEN_ENV, env.INDEX_DB, {
			sendingDomain: `notify.${domain}`,
			policy: "none",
		});
		expect(outcome.status).toBe("created");
		expect(calls.some((call) => call.method === "DELETE")).toBe(false);
	});
});
