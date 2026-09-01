import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	type AliasRow,
	type DomainRow,
	getAlias,
	getMailbox,
	getRoutingRule,
	listAliases,
	type MailboxRow,
	resolveRoutingForRecipient,
	type RoutingRuleRow,
} from "#/db/d1";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

// vitest-pool-workers hands out a schema-less D1 binding; migrations are not applied for us, and
// D1Database#exec() only takes one statement per line, so the multi-line CREATE TABLEs are split.
async function applyMigration(sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

beforeAll(async () => {
	await applyMigration(migrationInitial as string);
	await applyMigration(migrationMessageIndex as string);
	await applyMigration(migrationMailboxOwner as string);
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

function send(method: string, path: string, body?: unknown) {
	return call(path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

// D1 storage is not reset between it() blocks in a file, and domain/mailbox/alias keys are all
// unique, so every test names its own rows.
let seq = 0;
function unique(): string {
	seq += 1;
	return `cp${seq}`;
}

type MailboxResponse = {
	mailbox: MailboxRow;
	created: boolean;
	alias: AliasRow | null;
	aliasCreated: boolean;
	aliasReason: string | null;
};

async function registerDomain(domain: string): Promise<DomainRow> {
	const { status, body } = await send("POST", "/api/domains", { domain, zoneId: `zone-${domain}` });
	expect([200, 201]).toContain(status);
	return body.domain as DomainRow;
}

describe("POST /api/mailboxes provisions the primary alias", () => {
	it("creates the alias when the address's domain is registered and active, so mail actually routes", async () => {
		const suffix = unique();
		const domain = `${suffix}.mailbox.test`;
		await registerDomain(domain);

		const address = `inbox@${domain}`;
		const { status, body } = await send("POST", "/api/mailboxes", { primaryAddress: address });
		const payload = body as unknown as MailboxResponse;
		expect(status).toBe(201);
		expect(payload.created).toBe(true);
		expect(payload.aliasCreated).toBe(true);
		expect(payload.aliasReason).toBeNull();
		expect(payload.alias?.alias_address).toBe(address);
		expect(payload.alias?.mailbox_id).toBe(payload.mailbox.mailbox_id);

		// The point of the alias: without it this recipient would not resolve to the mailbox.
		const routing = await resolveRoutingForRecipient(testEnv.INDEX_DB, address);
		expect(routing.action).toBe("store");
		expect(routing.action === "store" && routing.mailboxId).toBe(payload.mailbox.mailbox_id);
	});

	it("still creates the mailbox (201, not 400) when the domain is not registered, and says why no alias exists", async () => {
		const suffix = unique();
		const address = `inbox@${suffix}.unregistered.test`;
		const { status, body } = await send("POST", "/api/mailboxes", { primaryAddress: address });
		const payload = body as unknown as MailboxResponse;
		expect(status).toBe(201);
		expect(payload.mailbox.primary_address).toBe(address);
		expect(payload.aliasCreated).toBe(false);
		expect(payload.alias).toBeNull();
		expect(payload.aliasReason).toContain(`${suffix}.unregistered.test`);
		expect(await getAlias(testEnv.INDEX_DB, address)).toBeNull();
	});

	it("does not create the alias while the domain is registered but not active", async () => {
		const suffix = unique();
		const domain = `${suffix}.pending.test`;
		const registered = await registerDomain(domain);
		await send("PATCH", `/api/domains/${domain}`, { status: "pending" });
		expect(registered.domain).toBe(domain);

		const address = `inbox@${domain}`;
		const { status, body } = await send("POST", "/api/mailboxes", { primaryAddress: address });
		const payload = body as unknown as MailboxResponse;
		expect(status).toBe(201);
		expect(payload.aliasCreated).toBe(false);
		expect(payload.aliasReason).toContain("pending");
	});

	it("converges on a repeat call: same mailbox, no duplicate alias, and the alias appears once the domain is registered", async () => {
		const suffix = unique();
		const domain = `${suffix}.converge.test`;
		const address = `inbox@${domain}`;

		// First call: no domain yet, so mailbox only.
		const first = (await send("POST", "/api/mailboxes", { primaryAddress: address }))
			.body as unknown as MailboxResponse;
		expect(first.created).toBe(true);
		expect(first.aliasCreated).toBe(false);

		// Register the domain, then repeat the very same request.
		await registerDomain(domain);
		const second = await send("POST", "/api/mailboxes", { primaryAddress: address });
		const secondPayload = second.body as unknown as MailboxResponse;
		expect(second.status).toBe(200);
		expect(secondPayload.created).toBe(false);
		expect(secondPayload.mailbox.mailbox_id).toBe(first.mailbox.mailbox_id);
		expect(secondPayload.aliasCreated).toBe(true);

		// Third call must be a pure no-op: no second mailbox, no second alias, no error.
		const third = await send("POST", "/api/mailboxes", { primaryAddress: address });
		const thirdPayload = third.body as unknown as MailboxResponse;
		expect(third.status).toBe(200);
		expect(thirdPayload.created).toBe(false);
		expect(thirdPayload.aliasCreated).toBe(false);
		expect(thirdPayload.alias?.alias_address).toBe(address);
		const aliases = (await listAliases(testEnv.INDEX_DB)).filter(
			(row) => row.alias_address === address,
		);
		expect(aliases).toHaveLength(1);
		const mailboxes = await testEnv.INDEX_DB.prepare(
			"SELECT COUNT(*) AS n FROM mailboxes WHERE primary_address = ?",
		)
			.bind(address)
			.first<{ n: number }>();
		expect(mailboxes?.n).toBe(1);
	});

	it("refuses to hijack an alias that already routes to a different mailbox", async () => {
		const suffix = unique();
		const domain = `${suffix}.hijack.test`;
		const registered = await registerDomain(domain);
		const address = `shared@${domain}`;

		const other = (await send("POST", "/api/mailboxes", { primaryAddress: `other@${domain}` }))
			.body as unknown as MailboxResponse;
		await send("POST", "/api/aliases", {
			aliasAddress: address,
			mailboxId: other.mailbox.mailbox_id,
		});
		expect(registered.status).toBe("active");

		const { status, body } = await send("POST", "/api/mailboxes", { primaryAddress: address });
		const payload = body as unknown as MailboxResponse;
		expect(status).toBe(201);
		expect(payload.aliasCreated).toBe(false);
		expect(payload.aliasReason).toContain(other.mailbox.mailbox_id);
		// The alias still points where it did.
		expect((await getAlias(testEnv.INDEX_DB, address))?.mailbox_id).toBe(other.mailbox.mailbox_id);
	});
});

describe("PATCH/DELETE /api/mailboxes/:mailboxId", () => {
	async function seedMailbox(): Promise<MailboxRow> {
		const suffix = unique();
		const domain = `${suffix}.mbxcrud.test`;
		await registerDomain(domain);
		const body = (await send("POST", "/api/mailboxes", { primaryAddress: `inbox@${domain}` }))
			.body as unknown as MailboxResponse;
		return body.mailbox;
	}

	it("updates displayName and status", async () => {
		const mailbox = await seedMailbox();
		const { status, body } = await send("PATCH", `/api/mailboxes/${mailbox.mailbox_id}`, {
			displayName: "Renamed Inbox",
			status: "disabled",
		});
		expect(status).toBe(200);
		expect((body.mailbox as MailboxRow).display_name).toBe("Renamed Inbox");
		expect((body.mailbox as MailboxRow).status).toBe("disabled");
	});

	it("leaves omitted fields alone and can clear displayName with an explicit null", async () => {
		const mailbox = await seedMailbox();
		await send("PATCH", `/api/mailboxes/${mailbox.mailbox_id}`, { displayName: "Named" });
		const kept = (await send("PATCH", `/api/mailboxes/${mailbox.mailbox_id}`, { status: "active" }))
			.body.mailbox as MailboxRow;
		expect(kept.display_name).toBe("Named");
		const cleared = (
			await send("PATCH", `/api/mailboxes/${mailbox.mailbox_id}`, { displayName: null })
		).body.mailbox as MailboxRow;
		expect(cleared.display_name).toBeNull();
		expect(cleared.status).toBe("active");
	});

	it("rejects an empty patch body", async () => {
		const mailbox = await seedMailbox();
		const { status, body } = await send("PATCH", `/api/mailboxes/${mailbox.mailbox_id}`, {});
		expect(status).toBe(400);
		expect(body.error).toBe("validation_error");
	});

	it("DELETE is a soft delete: the row survives with status='disabled'", async () => {
		const mailbox = await seedMailbox();
		const { status, body } = await send("DELETE", `/api/mailboxes/${mailbox.mailbox_id}`);
		expect(status).toBe(200);
		expect(body.deleted).toBe("soft");
		const stored = await getMailbox(testEnv.INDEX_DB, mailbox.mailbox_id);
		expect(stored).not.toBeNull();
		expect(stored?.status).toBe("disabled");
	});

	it("404s on an unknown mailbox for both PATCH and DELETE", async () => {
		const patch = await send("PATCH", "/api/mailboxes/mbx_does_not_exist", { status: "disabled" });
		expect(patch.status).toBe(404);
		expect(patch.body.error).toBe("mailbox_not_found");
		const del = await send("DELETE", "/api/mailboxes/mbx_does_not_exist");
		expect(del.status).toBe(404);
		expect(del.body.error).toBe("mailbox_not_found");
	});
});

describe("PATCH/DELETE /api/domains/:domain", () => {
	it("updates the status and accepts either the domain name or its id", async () => {
		const suffix = unique();
		const domain = `${suffix}.domcrud.test`;
		const registered = await registerDomain(domain);

		const byName = await send("PATCH", `/api/domains/${domain}`, { status: "disabled" });
		expect(byName.status).toBe(200);
		expect((byName.body.domain as DomainRow).status).toBe("disabled");

		const byId = await send("PATCH", `/api/domains/${registered.id}`, { status: "active" });
		expect(byId.status).toBe(200);
		expect((byId.body.domain as DomainRow).status).toBe("active");
	});

	it("DELETE is a soft delete that stops the domain accepting mail without breaking its rows", async () => {
		const suffix = unique();
		const domain = `${suffix}.domdelete.test`;
		await registerDomain(domain);
		const address = `inbox@${domain}`;
		const created = (await send("POST", "/api/mailboxes", { primaryAddress: address }))
			.body as unknown as MailboxResponse;
		expect(created.aliasCreated).toBe(true);
		expect((await resolveRoutingForRecipient(testEnv.INDEX_DB, address)).action).toBe("store");

		const { status, body } = await send("DELETE", `/api/domains/${domain}`);
		expect(status).toBe(200);
		expect(body.deleted).toBe("soft");
		expect((body.domain as DomainRow).status).toBe("disabled");

		// The point of the soft delete: routing stops, the alias row it depends on survives.
		const routing = await resolveRoutingForRecipient(testEnv.INDEX_DB, address);
		expect(routing.action).toBe("reject");
		expect(routing.action === "reject" && routing.reason).toBe("unknown_domain");
		expect(await getAlias(testEnv.INDEX_DB, address)).not.toBeNull();
	});

	it("DELETE on a mailbox actually stops mail, instead of leaving the alias delivering", async () => {
		const suffix = unique();
		const domain = `${suffix}.mbxdelete.test`;
		await registerDomain(domain);
		const address = `inbox@${domain}`;
		const created = (await send("POST", "/api/mailboxes", { primaryAddress: address }))
			.body as unknown as MailboxResponse;
		const mailboxId = (created.mailbox as MailboxRow).mailbox_id;
		expect((await resolveRoutingForRecipient(testEnv.INDEX_DB, address)).action).toBe("store");

		const { status } = await send("DELETE", `/api/mailboxes/${mailboxId}`);
		expect(status).toBe(200);

		// The mailbox's own status is authoritative over the rows pointing at it. Without
		// this, a disabled mailbox kept accepting mail and DELETE was a lie.
		const routing = await resolveRoutingForRecipient(testEnv.INDEX_DB, address);
		expect(routing.action).toBe("reject");
		expect(routing.action === "reject" && routing.reason).toBe("mailbox_disabled");
	});

	it("a disabled mailbox rejects rather than falling through to the domain catch-all", async () => {
		const suffix = unique();
		const domain = `${suffix}.catchfall.test`;
		const domainRow = await registerDomain(domain);
		const address = `solo@${domain}`;
		const created = (await send("POST", "/api/mailboxes", { primaryAddress: address }))
			.body as unknown as MailboxResponse;
		const mailboxId = (created.mailbox as MailboxRow).mailbox_id;

		// A catch-all pointing at the SAME mailbox: the tempting bug is to let the
		// alias check fail and then have the rule quietly re-deliver to the very
		// mailbox that was just disabled.
		await send("POST", "/api/routing-rules", {
			domainId: (domainRow as DomainRow).id,
			pattern: "*",
			priority: 100,
			action: "store",
			mailboxId,
		});
		await send("DELETE", `/api/mailboxes/${mailboxId}`);

		const routing = await resolveRoutingForRecipient(testEnv.INDEX_DB, `otra@${domain}`);
		expect(routing.action).toBe("reject");
		expect(routing.action === "reject" && routing.reason).toBe("mailbox_disabled");
	});

	it("404s on an unknown domain for both PATCH and DELETE", async () => {
		const patch = await send("PATCH", "/api/domains/nope.invalid", { status: "disabled" });
		expect(patch.status).toBe(404);
		expect(patch.body.error).toBe("domain_not_found");
		const del = await send("DELETE", "/api/domains/nope.invalid");
		expect(del.status).toBe(404);
		expect(del.body.error).toBe("domain_not_found");
	});
});

describe("PATCH/DELETE /api/aliases/:aliasAddress", () => {
	async function seedAlias(): Promise<{ address: string; mailboxId: string }> {
		const suffix = unique();
		const domain = `${suffix}.aliascrud.test`;
		await registerDomain(domain);
		const created = (await send("POST", "/api/mailboxes", { primaryAddress: `inbox@${domain}` }))
			.body as unknown as MailboxResponse;
		return { address: `inbox@${domain}`, mailboxId: created.mailbox.mailbox_id };
	}

	it("PATCH toggles status, which takes the address out of routing", async () => {
		const { address } = await seedAlias();
		const { status, body } = await send("PATCH", `/api/aliases/${address}`, { status: "disabled" });
		expect(status).toBe(200);
		expect((body.alias as AliasRow).status).toBe("disabled");
		expect((await resolveRoutingForRecipient(testEnv.INDEX_DB, address)).action).toBe("reject");
	});

	it("DELETE is a hard delete, freeing the address for another mailbox", async () => {
		const { address } = await seedAlias();
		const { status, body } = await send("DELETE", `/api/aliases/${address}`);
		expect(status).toBe(200);
		expect(body.deleted).toBe("hard");
		expect(await getAlias(testEnv.INDEX_DB, address)).toBeNull();

		// The reason it is hard: the address can be claimed again straight away.
		const domain = address.split("@")[1] as string;
		const other = (await send("POST", "/api/mailboxes", { primaryAddress: `second@${domain}` }))
			.body as unknown as MailboxResponse;
		const reclaimed = await send("POST", "/api/aliases", {
			aliasAddress: address,
			mailboxId: other.mailbox.mailbox_id,
		});
		expect(reclaimed.status).toBe(201);
		expect((await getAlias(testEnv.INDEX_DB, address))?.mailbox_id).toBe(other.mailbox.mailbox_id);
	});

	it("404s on an unknown alias for both PATCH and DELETE", async () => {
		const patch = await send("PATCH", "/api/aliases/ghost@nowhere.test", { status: "disabled" });
		expect(patch.status).toBe(404);
		expect(patch.body.error).toBe("alias_not_found");
		const del = await send("DELETE", "/api/aliases/ghost@nowhere.test");
		expect(del.status).toBe(404);
		expect(del.body.error).toBe("alias_not_found");
	});
});

describe("PATCH/DELETE /api/routing-rules/:ruleId", () => {
	async function seedRule(
		overrides: Record<string, unknown> = {},
	): Promise<{ ruleId: string; mailboxId: string; domainId: string; domain: string }> {
		const suffix = unique();
		const domain = `${suffix}.rulecrud.test`;
		const registered = await registerDomain(domain);
		const created = (await send("POST", "/api/mailboxes", { primaryAddress: `inbox@${domain}` }))
			.body as unknown as MailboxResponse;
		const rule = await send("POST", "/api/routing-rules", {
			domainId: registered.id,
			pattern: "*",
			priority: 100,
			action: "store",
			mailboxId: created.mailbox.mailbox_id,
			...overrides,
		});
		expect(rule.status).toBe(201);
		return {
			ruleId: rule.body.id as string,
			mailboxId: created.mailbox.mailbox_id,
			domainId: registered.id,
			domain,
		};
	}

	it("updates pattern, priority and enabled, leaving untouched fields intact", async () => {
		const { ruleId, mailboxId } = await seedRule();
		const { status, body } = await send("PATCH", `/api/routing-rules/${ruleId}`, {
			pattern: "support",
			priority: 5,
			enabled: false,
		});
		expect(status).toBe(200);
		const rule = body.rule as RoutingRuleRow;
		expect(rule.pattern).toBe("support");
		expect(rule.priority).toBe(5);
		expect(rule.enabled).toBe(0);
		expect(rule.action).toBe("store");
		expect(rule.mailbox_id).toBe(mailboxId);
	});

	it("re-validates the merged rule: switching to store without a mailbox is rejected", async () => {
		const { ruleId, domainId } = await seedRule({
			action: "reject",
			rejectReason: "no",
			mailboxId: undefined,
		});
		expect(domainId).toBeTruthy();
		const { status, body } = await send("PATCH", `/api/routing-rules/${ruleId}`, {
			action: "store",
		});
		expect(status).toBe(400);
		expect(body.error).toBe("mailbox_id_required");
		// Nothing was written.
		expect((await getRoutingRule(testEnv.INDEX_DB, ruleId))?.action).toBe("reject");
	});

	it("rejects a store rule pointed at a mailbox that does not exist", async () => {
		const { ruleId } = await seedRule();
		const { status, body } = await send("PATCH", `/api/routing-rules/${ruleId}`, {
			mailboxId: "mbx_missing",
		});
		expect(status).toBe(400);
		expect(body.error).toBe("mailbox_not_found");
	});

	it("rejects a forward rule left without destinations", async () => {
		const { ruleId } = await seedRule();
		const { status, body } = await send("PATCH", `/api/routing-rules/${ruleId}`, {
			action: "forward",
		});
		expect(status).toBe(400);
		expect(body.error).toBe("forward_to_required");

		const ok = await send("PATCH", `/api/routing-rules/${ruleId}`, {
			action: "forward",
			forwardTo: ["ops@example.com"],
		});
		expect(ok.status).toBe(200);
		expect((ok.body.rule as RoutingRuleRow).forward_to_json).toBe('["ops@example.com"]');
	});

	it("DELETE is a hard delete: the rule row is gone", async () => {
		const { ruleId } = await seedRule();
		const { status, body } = await send("DELETE", `/api/routing-rules/${ruleId}`);
		expect(status).toBe(200);
		expect(body.deleted).toBe("hard");
		expect(await getRoutingRule(testEnv.INDEX_DB, ruleId)).toBeNull();
	});

	it("404s on an unknown rule for both PATCH and DELETE", async () => {
		const patch = await send("PATCH", "/api/routing-rules/rule_missing", { priority: 1 });
		expect(patch.status).toBe(404);
		expect(patch.body.error).toBe("routing_rule_not_found");
		const del = await send("DELETE", "/api/routing-rules/rule_missing");
		expect(del.status).toBe(404);
		expect(del.body.error).toBe("routing_rule_not_found");
	});
});

// The destructive verbs are new, so this pins down that the Origin guard in hono.ts counts them
// as state-changing. A DELETE that slipped past it would be a CSRF-triggerable data loss.
describe("CSRF Origin guard covers the destructive verbs", () => {
	it("rejects PATCH and DELETE from a foreign Origin with 403 origin_mismatch", async () => {
		const suffix = unique();
		const domain = `${suffix}.csrf.test`;
		await registerDomain(domain);
		const created = (await send("POST", "/api/mailboxes", { primaryAddress: `inbox@${domain}` }))
			.body as unknown as MailboxResponse;
		const mailboxId = created.mailbox.mailbox_id;

		for (const [method, body] of [
			["PATCH", { status: "disabled" }],
			["DELETE", undefined],
		] as const) {
			const { status, body: payload } = await call(`/api/mailboxes/${mailboxId}`, {
				method,
				headers: { "content-type": "application/json", origin: "https://evil.example.com" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			expect(status).toBe(403);
			expect(payload.error).toBe("origin_mismatch");
		}
		// The mailbox is untouched.
		expect((await getMailbox(testEnv.INDEX_DB, mailboxId))?.status).toBe("active");
	});
});

describe("POST /api/domains/:domain/provision", () => {
	const realFetch = globalThis.fetch;

	/**
	 * Stands in for Cloudflare across every endpoint provisioning touches. The
	 * endpoint builds its own client from the env token, so unlike the unit tests
	 * there is no seam to inject through — the seam is the network itself, which
	 * is the right level for an integration test anyway.
	 */
	function stubCloudflare(): { requests: Array<{ method: string; url: string }> } {
		const requests: Array<{ method: string; url: string }> = [];
		// biome-ignore lint/suspicious/noExplicitAny: minimal fetch stand-in
		globalThis.fetch = (async (input: any, init: any) => {
			const url = typeof input === "string" ? input : input.url;
			const method = init?.method ?? "GET";
			requests.push({ method, url });
			let result: unknown = {};
			if (url.includes("/zones?name=")) result = [{ id: "zone_test" }];
			else if (url.includes("/email/sending/subdomains")) result = method === "GET" ? [] : {};
			else if (url.includes("/email/routing")) result = { enabled: false };
			else if (url.includes("event_subscriptions")) result = [];
			else if (url.includes("dns_records")) result = method === "GET" ? [] : { id: "rec" };
			return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
		}) as typeof fetch;
		return { requests };
	}

	// The Worker builds its Cloudflare client from the env, and .dev.vars leaves the
	// token empty (correctly — no real credential belongs in the repo). Without one
	// the run short-circuits before the first step, so these tests supply a fake.
	const realToken = (testEnv as { CLOUDFLARE_API_TOKEN?: string }).CLOUDFLARE_API_TOKEN;
	beforeEach(() => {
		(testEnv as { CLOUDFLARE_API_TOKEN?: string }).CLOUDFLARE_API_TOKEN = "test-token";
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
		(testEnv as { CLOUDFLARE_API_TOKEN?: string }).CLOUDFLARE_API_TOKEN = realToken;
	});

	it("reports every step, and answers 200 even when a step is blocked", async () => {
		const { requests } = stubCloudflare();
		const zone = "provision-api.test";
		const response = await send("POST", `/api/domains/${zone}/provision`, {
			subdomain: "notify",
			dmarc: { policy: "none", rua: "dmarc@example.com" },
			inbound: true,
		});

		expect(response.status).toBe(200);
		const body = response.body as {
			sendingDomain: string;
			steps: Array<{ name: string; outcome: { state: string } }>;
		};
		expect(body.sendingDomain).toBe(`notify.${zone}`);

		const states = Object.fromEntries(
			body.steps.map((step) => [step.name, step.outcome.state]),
		);
		expect(states.register_domain).toBe("done");
		expect(states.email_sending).toBe("done");
		expect(states.dmarc).toBe("done");
		expect(states.email_routing).toBe("done");

		// The DMARC record went to the registered zone, at the composed name, as TXT.
		const dmarcWrite = requests.find(
			(request) => request.url.includes("dns_records") && request.method === "POST",
		);
		expect(dmarcWrite?.url).toContain("/zones/zone_test/dns_records");
	});

	it("is idempotent: running it again changes nothing", async () => {
		stubCloudflare();
		const zone = "provision-idem.test";
		const payload = { subdomain: "notify", dmarc: { policy: "none" as const } };
		await send("POST", `/api/domains/${zone}/provision`, payload);
		const second = await send("POST", `/api/domains/${zone}/provision`, payload);
		const states = Object.fromEntries(
			(second.body.steps as Array<{ name: string; outcome: { state: string } }>).map((step) => [
				step.name,
				step.outcome.state,
			]),
		);
		// The domain row is now there, so registration reports `already` rather than
		// inserting a duplicate.
		expect(states.register_domain).toBe("already");
	});

	it("refuses a mailbox that is not on the zone being provisioned", async () => {
		stubCloudflare();
		const response = await send("POST", "/api/domains/provision-mb.test/provision", {
			subdomain: "notify",
			dmarc: { policy: "none" },
			// Inbound routing is enabled on the zone in the path, so a mailbox on
			// another domain would be created and never receive anything.
			mailbox: { address: "hello@somewhere-else.test" },
		});
		expect(response.status).toBe(400);
		expect(response.body.code ?? response.body.error).toBeTruthy();
	});

	it("rejects a subdomain that is not a single DNS label", async () => {
		stubCloudflare();
		const response = await send("POST", "/api/domains/provision-label.test/provision", {
			subdomain: "notify.evil",
			dmarc: { policy: "none" },
		});
		expect(response.status).toBe(400);
	});

	it("requires an explicit DMARC policy", async () => {
		stubCloudflare();
		const response = await send("POST", "/api/domains/provision-dmarc.test/provision", {
			subdomain: "notify",
		});
		expect(response.status).toBe(400);
	});
});
