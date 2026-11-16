import { describe, expect, it } from "vitest";
import {
	catchAllRoutesToWorker,
	catchAllRuleBody,
	createEmailRoutingApi,
	EmailRoutingApiError,
	ensureAddressRoute,
	literalWorkerRuleBody,
	planAddressRoute,
} from "#/lib/email-routing";

/**
 * The module `pnpm setup:routing` and `POST /api/cloudflare/domains/:domain/routing`
 * share. No real Cloudflare call is made: every test hands the client a fetch stub.
 */

const WORKER = "reccado-dev";
const ADDRESS = "hello@example.com";

const literal = (
	address: string,
	actions: Array<{ type: string; value?: string[] }>,
	extra: Record<string, unknown> = {},
) => ({
	id: `r-${address}`,
	enabled: true,
	matchers: [{ type: "literal", field: "to", value: address }],
	actions,
	...extra,
});

describe("planAddressRoute", () => {
	it("creates a literal rule when nothing names the address and the catch-all drops", () => {
		const plan = planAddressRoute({
			address: "Hello@Example.com",
			worker: WORKER,
			rules: [literal("other@example.com", [{ type: "forward", value: ["x@y.z"] }])],
			catchAll: { enabled: true, matchers: [{ type: "all" }], actions: [{ type: "drop" }] },
		});
		expect(plan).toEqual({
			action: "create",
			body: {
				enabled: true,
				name: `hello -> ${WORKER}`,
				matchers: [{ type: "literal", field: "to", value: ADDRESS }],
				actions: [{ type: "worker", value: [WORKER] }],
			},
		});
	});

	it("is already done when an enabled literal rule delivers to this Worker", () => {
		expect(
			planAddressRoute({
				address: ADDRESS,
				worker: WORKER,
				rules: [literal(ADDRESS, [{ type: "worker", value: [WORKER] }])],
				catchAll: null,
			}),
		).toEqual({ action: "already", via: "rule", ruleId: `r-${ADDRESS}` });
	});

	it("is already done when the catch-all delivers to this Worker", () => {
		expect(
			planAddressRoute({
				address: ADDRESS,
				worker: WORKER,
				rules: [],
				catchAll: {
					tag: "ca",
					enabled: true,
					matchers: [{ type: "all" }],
					actions: [{ type: "worker", value: [WORKER] }],
				},
			}),
		).toEqual({ action: "already", via: "catch_all", ruleId: "ca" });
	});

	it("reports a literal rule that forwards the address elsewhere as a conflict", () => {
		const plan = planAddressRoute({
			address: ADDRESS,
			worker: WORKER,
			rules: [literal(ADDRESS, [{ type: "forward", value: ["me@gmail.test"] }], { name: "mine" })],
			catchAll: null,
		});
		expect(plan).toEqual({
			action: "conflict",
			rule: {
				via: "rule",
				id: `r-${ADDRESS}`,
				name: "mine",
				enabled: true,
				action: "forward to me@gmail.test",
			},
		});
	});

	it("reports a literal rule to another Worker as a conflict, even beside one to ours", () => {
		const plan = planAddressRoute({
			address: ADDRESS,
			worker: WORKER,
			rules: [
				literal(ADDRESS, [{ type: "worker", value: [WORKER] }]),
				literal(ADDRESS, [{ type: "worker", value: ["other-worker"] }], { id: "r-2" }),
			],
			catchAll: null,
		});
		expect(plan).toMatchObject({
			action: "conflict",
			rule: { via: "rule", id: "r-2", action: "Worker other-worker" },
		});
	});

	it("treats a disabled rule for the address as someone's rule, not free space", () => {
		const plan = planAddressRoute({
			address: ADDRESS,
			worker: WORKER,
			rules: [literal(ADDRESS, [{ type: "worker", value: [WORKER] }], { enabled: false })],
			catchAll: null,
		});
		expect(plan).toMatchObject({ action: "conflict", rule: { via: "rule", enabled: false } });
	});

	it("reports a catch-all that forwards as a conflict instead of shadowing it", () => {
		const plan = planAddressRoute({
			address: ADDRESS,
			worker: WORKER,
			rules: [],
			catchAll: {
				enabled: true,
				matchers: [{ type: "all" }],
				actions: [{ type: "forward", value: ["all@gmail.test"] }],
			},
		});
		expect(plan).toMatchObject({
			action: "conflict",
			rule: { via: "catch_all", action: "forward to all@gmail.test" },
		});
	});

	it("ignores a disabled catch-all", () => {
		expect(
			planAddressRoute({
				address: ADDRESS,
				worker: WORKER,
				rules: [],
				catchAll: {
					enabled: false,
					matchers: [{ type: "all" }],
					actions: [{ type: "forward", value: ["all@gmail.test"] }],
				},
			}).action,
		).toBe("create");
	});
});

// ---------------------------------------------------------------------------
// Client + ensureAddressRoute against a fetch stub
// ---------------------------------------------------------------------------

type Call = { method: string; url: string; body: unknown };

function stub(routes: Array<[method: string, fragment: string, status: number, body: unknown]>) {
	const calls: Call[] = [];
	const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const hit = routes.find(([m, fragment]) => m === method && url.includes(fragment));
		if (!hit) throw new Error(`unexpected ${method} ${url}`);
		return new Response(JSON.stringify(hit[3]), { status: hit[2] });
	}) as typeof fetch;
	return { calls, api: createEmailRoutingApi("tok", { fetch: fetchStub }) };
}

const ok = (result: unknown, extra: Record<string, unknown> = {}) => ({
	success: true,
	errors: [],
	messages: [],
	result,
	...extra,
});

describe("ensureAddressRoute", () => {
	it("sends exactly one POST with the literal rule when the address is free", async () => {
		const { calls, api } = stub([
			[
				"GET",
				"/zones/z1/email/routing/rules/catch_all",
				200,
				ok({ enabled: false, actions: [{ type: "drop" }] }),
			],
			["GET", "/zones/z1/email/routing/rules?", 200, ok([], { result_info: { total_pages: 1 } })],
			["GET", "/zones/z1/email/routing", 200, ok({ enabled: true, status: "ready" })],
			["POST", "/zones/z1/email/routing/rules", 200, ok({ id: "new-rule" })],
		]);
		const outcome = await ensureAddressRoute(api, {
			zoneId: "z1",
			address: ADDRESS,
			worker: WORKER,
		});
		expect(outcome).toEqual({
			status: "created",
			ruleId: "new-rule",
			rule: literalWorkerRuleBody(ADDRESS, WORKER),
		});
		const writes = calls.filter((c) => c.method !== "GET");
		expect(writes).toEqual([
			{
				method: "POST",
				url: "https://api.cloudflare.com/client/v4/zones/z1/email/routing/rules",
				body: {
					enabled: true,
					name: "hello -> reccado-dev",
					matchers: [{ type: "literal", field: "to", value: ADDRESS }],
					actions: [{ type: "worker", value: ["reccado-dev"] }],
				},
			},
		]);
	});

	it("writes nothing when routing is off for the zone", async () => {
		const { calls, api } = stub([["GET", "/zones/z1/email/routing", 200, ok({ enabled: false })]]);
		expect(
			await ensureAddressRoute(api, { zoneId: "z1", address: ADDRESS, worker: WORKER }),
		).toEqual({
			status: "routing_disabled",
		});
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("reads every page of rules before deciding", async () => {
		const { calls, api } = stub([
			["GET", "/rules/catch_all", 200, ok({ enabled: false })],
			[
				"GET",
				"/rules?per_page=50&page=2",
				200,
				ok([literal(ADDRESS, [{ type: "forward", value: ["x@y.z"] }])], {
					result_info: { total_pages: 2 },
				}),
			],
			["GET", "/rules?per_page=50&page=1", 200, ok([], { result_info: { total_pages: 2 } })],
			["GET", "/email/routing", 200, ok({ enabled: true })],
		]);
		const outcome = await ensureAddressRoute(api, {
			zoneId: "z1",
			address: ADDRESS,
			worker: WORKER,
		});
		expect(outcome.status).toBe("conflict");
		expect(calls.every((c) => c.method === "GET")).toBe(true);
	});

	it("classifies a 403 / code 10000 as a permission failure", async () => {
		const { api } = stub([
			[
				"GET",
				"/email/routing",
				403,
				{ success: false, errors: [{ code: 10000, message: "Authentication error" }] },
			],
		]);
		const error = await ensureAddressRoute(api, {
			zoneId: "z1",
			address: ADDRESS,
			worker: WORKER,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(EmailRoutingApiError);
		expect(error).toMatchObject({ reason: "permission", message: "Authentication error [10000]" });
	});
});

describe("the primitives setup:routing --catch-all uses", () => {
	it("keeps the catch-all payload byte-identical to what the CLI always printed", () => {
		expect(JSON.stringify(catchAllRuleBody("reccado-dev"))).toBe(
			'{"enabled":true,"name":"Catch-all -> reccado-dev","matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["reccado-dev"]}]}',
		);
	});

	it("resolves the zone, reads the catch-all, and PUTs only when it does not route to the Worker", async () => {
		const { calls, api } = stub([
			[
				"GET",
				"/zones?name=example.com&status=active&match=all",
				200,
				ok([
					{ id: "z1", name: "example.com" },
					{ id: "z2", name: "sub.example.com" },
				]),
			],
			[
				"GET",
				"/zones/z1/email/routing/rules/catch_all",
				200,
				ok({ enabled: true, actions: [{ type: "drop" }] }),
			],
			["PUT", "/zones/z1/email/routing/rules/catch_all", 200, ok({ enabled: true })],
		]);
		const zones = await api.findZones("example.com");
		expect(zones).toEqual([{ id: "z1", name: "example.com" }]);
		const current = await api.getCatchAll("z1");
		expect(catchAllRoutesToWorker(current, WORKER)).toBe(false);
		await api.putCatchAll("z1", catchAllRuleBody(WORKER));
		expect(calls.at(-1)).toEqual({
			method: "PUT",
			url: "https://api.cloudflare.com/client/v4/zones/z1/email/routing/rules/catch_all",
			body: catchAllRuleBody(WORKER),
		});
		expect(
			catchAllRoutesToWorker(
				{
					enabled: true,
					matchers: [{ type: "all" }],
					actions: [{ type: "worker", value: [WORKER] }],
				},
				WORKER,
			),
		).toBe(true);
	});

	it("surfaces Cloudflare's errors in the CLI's `message [code]` format", async () => {
		const { api } = stub([
			[
				"GET",
				"/rules/catch_all",
				400,
				{
					success: false,
					errors: [{ code: 2001, message: "bad zone" }],
					messages: [{ code: 1, message: "hint" }],
				},
			],
		]);
		await expect(api.getCatchAll("z1")).rejects.toThrow("bad zone [2001]; hint [1]");
	});
});
