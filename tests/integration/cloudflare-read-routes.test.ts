import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database; CLOUDFLARE_API_TOKEN?: string };
const testEnv = env as unknown as TestEnv;
const realFetch = globalThis.fetch;
const realToken = testEnv.CLOUDFLARE_API_TOKEN;

beforeAll(async () => {
	for (const sql of [migrationInitial, migrationMessageIndex, migrationMailboxOwner])
		for (const statement of splitSqlStatements(sql as string))
			await testEnv.INDEX_DB.prepare(statement).run();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	testEnv.CLOUDFLARE_API_TOKEN = realToken;
});

async function call(
	path: string,
	init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(new Request(`http://localhost${path}`, init), env, ctx);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function post(path: string, body: unknown) {
	return call(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

type Requests = Array<{ method: string; url: string }>;

/** Answers Cloudflare reads from a table of `url substring -> [status, result]`; records every call. */
function stubCloudflare(routes: Array<[string, number, unknown]>): Requests {
	const requests: Requests = [];
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stand-in
	globalThis.fetch = (async (input: any, init: any) => {
		const url = typeof input === "string" ? input : input.url;
		const method = init?.method ?? "GET";
		requests.push({ method, url });
		const hit = routes.find(([fragment]) => url.includes(fragment));
		if (!hit) return new Response(JSON.stringify({ success: false, errors: [] }), { status: 404 });
		const [, status, result] = hit;
		const success = status < 400;
		return new Response(
			JSON.stringify({
				success,
				errors: success ? [] : [{ code: status === 403 ? 9109 : 1000, message: "nope" }],
				result,
				result_info: { page: 1, total_pages: 1 },
			}),
			{ status },
		);
	}) as typeof fetch;
	return requests;
}

describe("GET /api/cloudflare/zones", () => {
	it("says the token is missing instead of guessing", async () => {
		testEnv.CLOUDFLARE_API_TOKEN = "";
		const { status, body } = await call("/api/cloudflare/zones");
		expect(status).toBe(200);
		expect(body).toMatchObject({ ok: false, reason: "token_missing" });
	});

	it("reports a permission refusal as such", async () => {
		testEnv.CLOUDFLARE_API_TOKEN = "test-token";
		stubCloudflare([["/zones?", 403, null]]);
		const { body } = await call("/api/cloudflare/zones");
		expect(body).toMatchObject({ ok: false, reason: "permission" });
	});

	it("lists active zones not yet registered, and only reads", async () => {
		await post("/api/domains", { domain: "registered-zone.test", zoneId: "z-reg" });
		testEnv.CLOUDFLARE_API_TOKEN = "test-token";
		const requests = stubCloudflare([
			[
				"/zones?",
				200,
				[
					{ id: "z-reg", name: "registered-zone.test", status: "active" },
					{ id: "z-new", name: "Fresh-Zone.test", status: "active" },
				],
			],
		]);
		const { body } = await call("/api/cloudflare/zones");
		expect(body).toEqual({
			ok: true,
			zones: [{ id: "z-new", name: "fresh-zone.test" }],
			total: 2,
			registered: 1,
			truncated: false,
		});
		expect(requests.every((r) => r.method === "GET")).toBe(true);
	});
});

describe("GET /api/cloudflare/domains/:domain/overview", () => {
	it("404s an unregistered domain", async () => {
		const { status, body } = await call("/api/cloudflare/domains/nope.invalid/overview");
		expect(status).toBe(404);
		expect(body.error).toBe("domain_not_found");
	});

	it("without a token every address is unknown, never routed", async () => {
		await post("/api/domains", { domain: "overview-notoken.test", zoneId: "z-nt" });
		await post("/api/mailboxes", { primaryAddress: "hello@overview-notoken.test" });
		testEnv.CLOUDFLARE_API_TOKEN = "";
		const { status, body } = await call("/api/cloudflare/domains/overview-notoken.test/overview");
		expect(status).toBe(200);
		expect(body.sending).toMatchObject({ ok: false, reason: "token_missing" });
		expect(body.routing).toMatchObject({
			ok: false,
			reason: "token_missing",
			addresses: [{ address: "hello@overview-notoken.test", state: "unknown" }],
		});
	});

	it("reads sending, DMARC and per-address routing without writing anything", async () => {
		const zone = "overview-live.test";
		await post("/api/domains", { domain: zone, zoneId: "z-live" });
		await post("/api/mailboxes", { primaryAddress: `hello@${zone}` });
		await post("/api/mailboxes", { primaryAddress: `press@${zone}` });
		testEnv.CLOUDFLARE_API_TOKEN = "test-token";
		const requests = stubCloudflare([
			["/email/sending/subdomains", 200, [{ id: "s1", name: `send.${zone}` }]],
			["/email/routing/rules/catch_all", 200, { enabled: false, actions: [{ type: "drop" }] }],
			[
				"/email/routing/rules",
				200,
				[
					{
						enabled: true,
						matchers: [{ type: "literal", field: "to", value: `hello@${zone}` }],
						actions: [{ type: "worker", value: ["reccado-dev"] }],
					},
				],
			],
			["/email/routing", 200, { enabled: true }],
			["/dns_records", 200, [{ content: '"v=DMARC1; p=quarantine; rua=mailto:d@x.test"' }]],
		]);
		const { body } = await call(`/api/cloudflare/domains/${zone}/overview`);
		expect(body.sending).toEqual({ ok: true, subdomains: [`send.${zone}`] });
		expect(body.dmarc).toMatchObject({
			ok: true,
			records: [{ sendingDomain: `send.${zone}`, policy: "quarantine" }],
		});
		expect(body.inbound).toEqual({ ok: true, enabled: true });
		expect(body.routing).toEqual({
			ok: true,
			enabled: true,
			addresses: [
				{ address: `hello@${zone}`, state: "routed", via: "rule", workers: ["reccado-dev"] },
				{ address: `press@${zone}`, state: "not_routed" },
			],
			catchAll: { address: `*@${zone}`, state: "not_routed" },
		});
		expect(requests.every((r) => r.method === "GET")).toBe(true);
		expect(requests.some((r) => r.url.includes("/zones/z-live/dns_records?type=TXT"))).toBe(true);
	});

	it("routing off for the zone means nothing is routed, whatever the rules say", async () => {
		const zone = "overview-off.test";
		await post("/api/domains", { domain: zone, zoneId: "z-off" });
		await post("/api/mailboxes", { primaryAddress: `hello@${zone}` });
		testEnv.CLOUDFLARE_API_TOKEN = "test-token";
		stubCloudflare([
			["/email/sending/subdomains", 200, []],
			[
				"/email/routing/rules/catch_all",
				200,
				{ enabled: true, actions: [{ type: "worker", value: ["w"] }] },
			],
			["/email/routing/rules", 200, []],
			["/email/routing", 200, { enabled: false }],
		]);
		const { body } = await call(`/api/cloudflare/domains/${zone}/overview`);
		expect(body.routing).toEqual({
			ok: true,
			enabled: false,
			addresses: [{ address: `hello@${zone}`, state: "not_routed" }],
			catchAll: { address: `*@${zone}`, state: "not_routed" },
		});
	});

	it("a token that cannot read Email Routing leaves addresses unknown", async () => {
		const zone = "overview-perm.test";
		await post("/api/domains", { domain: zone, zoneId: "z-perm" });
		await post("/api/mailboxes", { primaryAddress: `hello@${zone}` });
		testEnv.CLOUDFLARE_API_TOKEN = "test-token";
		stubCloudflare([
			["/email/sending/subdomains", 200, []],
			["/email/routing", 403, null],
		]);
		const { body } = await call(`/api/cloudflare/domains/${zone}/overview`);
		expect(body.routing).toMatchObject({
			ok: false,
			reason: "permission",
			addresses: [{ address: `hello@${zone}`, state: "unknown" }],
		});
		expect(body.sending).toEqual({ ok: true, subdomains: [] });
	});
});
