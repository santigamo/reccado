import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { insertDomain } from "#/db/d1";
import {
	type CloudflareClient,
	FEEDBACK_EVENT_TYPES,
	PermissionError,
	type ProvisionResult,
	provisionSendingDomain,
} from "#/lib/provision";
import migration1 from "../../migrations/d1/0001_initial.sql?raw";
import migration2 from "../../migrations/d1/0002_message_index.sql?raw";
import migration3 from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

beforeAll(async () => {
	const statements = splitSqlStatements([migration1, migration2, migration3].join("\n"));
	for (const statement of statements) {
		await env.INDEX_DB.prepare(statement).run();
	}
});

const ENV = { CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "acct_1" };

let seq = 0;
function uniqueZone(): string {
	seq += 1;
	return `p${seq}.provision.test`;
}

type Subscription = {
	id: string;
	enabled: boolean;
	source?: { type?: string; domain?: string };
	destination?: { queue_id?: string };
	events?: string[];
};

interface FakeOptions {
	zoneId?: string | null;
	sendingSubdomains?: Array<{ id: string; name: string }>;
	routingEnabled?: boolean;
	subscriptions?: Subscription[];
	/** Step names that should refuse on authority grounds. */
	forbid?: Array<"sending" | "routing" | "subscriptions">;
}

function fakeCloudflare(opts: FakeOptions = {}) {
	const calls: string[] = [];
	const refuse = (what: NonNullable<FakeOptions["forbid"]>[number]) => {
		if (opts.forbid?.includes(what)) {
			throw new PermissionError(`refused ${what}`, what);
		}
	};
	const client: CloudflareClient = {
		async findZoneId() {
			calls.push("findZoneId");
			return opts.zoneId === undefined ? "zone_abc" : opts.zoneId;
		},
		async listSendingSubdomains() {
			calls.push("listSendingSubdomains");
			refuse("sending");
			return opts.sendingSubdomains ?? [];
		},
		async createSendingSubdomain(_zoneId, name) {
			calls.push(`createSendingSubdomain:${name}`);
			refuse("sending");
		},
		async getRoutingStatus() {
			calls.push("getRoutingStatus");
			refuse("routing");
			return { enabled: opts.routingEnabled ?? false };
		},
		async enableRouting() {
			calls.push("enableRouting");
			refuse("routing");
		},
		async listSubscriptions() {
			calls.push("listSubscriptions");
			refuse("subscriptions");
			return opts.subscriptions ?? [];
		},
		async createFeedbackSubscription({ sendingDomain }) {
			calls.push(`createFeedbackSubscription:${sendingDomain}`);
			refuse("subscriptions");
		},
	};
	return { client, calls };
}

function step(result: ProvisionResult, name: string) {
	return result.steps.find((entry) => entry.name === name)?.outcome;
}

// The DNS gate reaches the network directly, so tests that expect the DMARC step
// to run stub fetch. Tests that only care about ordering let it fail and assert
// on the step's presence instead.
const realFetch = globalThis.fetch;
function stubDnsApi(): void {
	// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stand-in
	globalThis.fetch = (async (_input: any, init: any) => {
		const result = (init?.method ?? "GET") === "GET" ? [] : { id: "rec" };
		return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
	}) as typeof fetch;
}

describe("provisionSendingDomain", () => {
	it("refuses a sending domain that is not inside the zone", async () => {
		const { client } = fakeCloudflare();
		await expect(
			provisionSendingDomain(
				ENV,
				env.INDEX_DB,
				{
					zone: "example.com",
					sendingDomain: "notify.somewhere-else.com",
					dmarc: { policy: "none" },
				},
				client,
			),
		).rejects.toThrow(/not inside zone/);
	});

	it("registers the zone, then enables sending, then writes DMARC — in that order", async () => {
		stubDnsApi();
		const zone = uniqueZone();
		const { client, calls } = fakeCloudflare();
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain: `notify.${zone}`, dmarc: { policy: "none", rua: "d@example.com" } },
			client,
		);
		globalThis.fetch = realFetch;

		expect(step(result, "register_domain")?.state).toBe("done");
		expect(step(result, "email_sending")?.state).toBe("done");
		expect(step(result, "dmarc")?.state).toBe("done");
		// Sending must precede DMARC: enabling it is what makes Cloudflare write its
		// own p=reject record, which the ramp then replaces.
		const names = result.steps.map((entry) => entry.name);
		expect(names.indexOf("email_sending")).toBeLessThan(names.indexOf("dmarc"));
		expect(calls).toContain(`createSendingSubdomain:notify.${zone}`);
	});

	it("is idempotent: a second run reports `already` and writes nothing", async () => {
		stubDnsApi();
		const zone = uniqueZone();
		const sendingDomain = `notify.${zone}`;
		const first = fakeCloudflare();
		await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain, dmarc: { policy: "none" } },
			first.client,
		);
		// Second run sees the world the first one left behind.
		const second = fakeCloudflare({ sendingSubdomains: [{ id: "sub_1", name: sendingDomain }] });
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain, dmarc: { policy: "none" } },
			second.client,
		);
		globalThis.fetch = realFetch;

		expect(step(result, "register_domain")?.state).toBe("already");
		expect(step(result, "email_sending")?.state).toBe("already");
		expect(second.calls).not.toContain(`createSendingSubdomain:${sendingDomain}`);
	});

	it("skips only the dependents when a step is blocked, and still does the rest", async () => {
		const zone = uniqueZone();
		const { client } = fakeCloudflare({ forbid: ["sending"] });
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{
				zone,
				sendingDomain: `notify.${zone}`,
				dmarc: { policy: "none" },
				inbound: true,
				feedbackQueueId: "queue_1",
				mailbox: { address: `hello@${zone}` },
			},
			client,
		);

		expect(step(result, "email_sending")?.state).toBe("blocked");
		// DMARC and feedback depend on sending having happened.
		expect(step(result, "dmarc")?.state).toBe("skipped");
		expect(step(result, "feedback_subscription")?.state).toBe("skipped");
		// Inbound and the mailbox do not.
		expect(step(result, "email_routing")?.state).toBe("done");
		expect(step(result, "mailbox")?.state).toBe("done");
		expect(result.complete).toBe(false);
	});

	it("names the missing permission when Cloudflare refuses on authority grounds", async () => {
		const zone = uniqueZone();
		const { client } = fakeCloudflare({ forbid: ["sending"] });
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain: `notify.${zone}`, dmarc: { policy: "none" } },
			client,
		);
		const outcome = step(result, "email_sending");
		expect(outcome).toMatchObject({ state: "blocked" });
		expect(outcome?.state === "blocked" && outcome.remedy).toMatch(/Email Sending/);
	});

	it("skips everything when the zone cannot be registered", async () => {
		const zone = uniqueZone();
		const { client } = fakeCloudflare({ zoneId: null });
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{
				zone,
				sendingDomain: `notify.${zone}`,
				dmarc: { policy: "none" },
				mailbox: { address: `hello@${zone}` },
			},
			client,
		);
		expect(step(result, "register_domain")?.state).toBe("blocked");
		for (const name of ["email_sending", "dmarc", "mailbox"]) {
			expect(step(result, name)?.state).toBe("skipped");
		}
	});
});

describe("feedback subscription step", () => {
	async function run(subscriptions: Subscription[]) {
		stubDnsApi();
		const zone = uniqueZone();
		const sendingDomain = `notify.${zone}`;
		const { client, calls } = fakeCloudflare({
			sendingSubdomains: [{ id: "s", name: sendingDomain }],
			subscriptions,
		});
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain, dmarc: { policy: "none" }, feedbackQueueId: "queue_1" },
			client,
		);
		globalThis.fetch = realFetch;
		return { outcome: step(result, "feedback_subscription"), calls, sendingDomain };
	}

	it("creates a subscription covering every event type Reccado acts on", async () => {
		const { outcome, calls, sendingDomain } = await run([]);
		expect(outcome?.state).toBe("done");
		expect(calls).toContain(`createFeedbackSubscription:${sendingDomain}`);
	});

	it("leaves a complete subscription alone", async () => {
		const zone = uniqueZone();
		const sendingDomain = `notify.${zone}`;
		stubDnsApi();
		const { client, calls } = fakeCloudflare({
			sendingSubdomains: [{ id: "s", name: sendingDomain }],
			subscriptions: [
				{
					id: "sub_1",
					enabled: true,
					source: { type: "email.sending", domain: sendingDomain },
					destination: { queue_id: "queue_1" },
					events: [...FEEDBACK_EVENT_TYPES],
				},
			],
		});
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain, dmarc: { policy: "none" }, feedbackQueueId: "queue_1" },
			client,
		);
		globalThis.fetch = realFetch;
		expect(step(result, "feedback_subscription")?.state).toBe("already");
		expect(calls.some((call) => call.startsWith("createFeedbackSubscription"))).toBe(false);
	});

	it("refuses to add a second subscription beside one pointed at another queue", async () => {
		const zone = uniqueZone();
		const sendingDomain = `notify.${zone}`;
		stubDnsApi();
		const { client, calls } = fakeCloudflare({
			sendingSubdomains: [{ id: "s", name: sendingDomain }],
			subscriptions: [
				{
					id: "sub_wrong",
					enabled: true,
					source: { type: "email.sending", domain: sendingDomain },
					// A dev/prod mix-up is one wrong dropdown away, and silently adding a
					// second subscription would hide it rather than surface it.
					destination: { queue_id: "queue_other" },
					events: [...FEEDBACK_EVENT_TYPES],
				},
			],
		});
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain, dmarc: { policy: "none" }, feedbackQueueId: "queue_1" },
			client,
		);
		globalThis.fetch = realFetch;
		expect(step(result, "feedback_subscription")?.state).toBe("blocked");
		expect(calls.some((call) => call.startsWith("createFeedbackSubscription"))).toBe(false);
	});

	it("ignores a subscription that belongs to a different sending domain", async () => {
		const { outcome, calls, sendingDomain } = await run([
			{
				id: "sub_other_domain",
				enabled: true,
				source: { type: "email.sending", domain: "someone-else.test" },
				destination: { queue_id: "queue_1" },
				events: [...FEEDBACK_EVENT_TYPES],
			},
		]);
		expect(outcome?.state).toBe("done");
		expect(calls).toContain(`createFeedbackSubscription:${sendingDomain}`);
	});

	it("refuses to double-deliver when the existing subscription omits event types", async () => {
		const zone = uniqueZone();
		const sendingDomain = `notify.${zone}`;
		stubDnsApi();
		const { client, calls } = fakeCloudflare({
			sendingSubdomains: [{ id: "s", name: sendingDomain }],
			subscriptions: [
				{
					id: "sub_partial",
					enabled: true,
					source: { type: "email.sending", domain: sendingDomain },
					destination: { queue_id: "queue_1" },
					// Delivered only: bounces and complaints are dark, which is the exact
					// state that looks healthy and is not.
					events: ["message.delivered"],
				},
			],
		});
		const result = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain, dmarc: { policy: "none" }, feedbackQueueId: "queue_1" },
			client,
		);
		globalThis.fetch = realFetch;
		const outcome = step(result, "feedback_subscription");
		expect(outcome?.state).toBe("blocked");
		expect(outcome?.state === "blocked" && outcome.reason).toMatch(/message\.bounced/);
		// A second subscription would publish message.delivered twice.
		expect(calls.some((call) => call.startsWith("createFeedbackSubscription"))).toBe(false);
	});
});

describe("mailbox step", () => {
	it("distinguishes a mailbox it created from one that already existed", async () => {
		const zone = uniqueZone();
		await insertDomain(env.INDEX_DB, {
			id: `dom_mb_${seq}`,
			domain: zone,
			zone_id: "zone_abc",
			status: "active",
		});
		const address = `hello@${zone}`;
		const { client } = fakeCloudflare({ forbid: ["sending"] });
		const first = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain: `notify.${zone}`, dmarc: { policy: "none" }, mailbox: { address } },
			client,
		);
		const second = await provisionSendingDomain(
			ENV,
			env.INDEX_DB,
			{ zone, sendingDomain: `notify.${zone}`, dmarc: { policy: "none" }, mailbox: { address } },
			client,
		);
		expect(step(first, "mailbox")?.state).toBe("done");
		expect(step(second, "mailbox")?.state).toBe("already");
	});
});
