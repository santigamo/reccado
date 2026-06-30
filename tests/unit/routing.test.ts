import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
	insertAlias,
	insertDomain,
	insertMailbox,
	insertRoutingRule,
	resolveRoutingForRecipient,
} from "#/db/d1";
import migration1 from "../../migrations/d1/0001_initial.sql?raw";
import migration2 from "../../migrations/d1/0002_message_index.sql?raw";

// The pool's D1 binding starts empty; the dev migrations aren't applied
// automatically by vitest-pool-workers, so we apply them once for this file.
async function applyMigrations(): Promise<void> {
	const statements = [migration1, migration2]
		.join("\n")
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	for (const statement of statements) {
		await env.INDEX_DB.prepare(statement).run();
	}
}

// D1 storage is NOT reset between `it()` blocks within a file (verified:
// writes from one test are visible in the next), and routing_rules.id /
// domains.domain / domains.id / mailboxes.mailbox_id are all unique. Every
// test below seeds its own uniquely-suffixed rows so tests stay isolated
// from each other regardless of execution order.
let seq = 0;
function uniqueSuffix(): string {
	seq += 1;
	return `t${seq}`;
}

async function seedDomain(status: "pending" | "active" | "disabled" = "active") {
	const suffix = uniqueSuffix();
	const id = `dom_${suffix}`;
	const domain = `${suffix}.routing.test`;
	await insertDomain(env.INDEX_DB, { id, domain, zone_id: `zone_${suffix}`, status });
	return { id, domain, suffix };
}

async function seedMailbox(suffix: string): Promise<string> {
	const mailboxId = `mbx_${suffix}`;
	await insertMailbox(env.INDEX_DB, {
		mailbox_id: mailboxId,
		primary_address: `${suffix}@mailbox.routing.test`,
		display_name: null,
		status: "active",
	});
	return mailboxId;
}

describe("resolveRoutingForRecipient", () => {
	beforeAll(async () => {
		await applyMigrations();
	});

	it("resolves an exact alias match to a store action with no rule involved", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const mailboxId = await seedMailbox(suffix);
		const aliasAddress = `user-${suffix}@${domain}`;
		await insertAlias(env.INDEX_DB, {
			alias_address: aliasAddress,
			mailbox_id: mailboxId,
			domain_id: domainId,
			status: "active",
		});

		// Recipient casing should be canonicalized before the alias lookup.
		const result = await resolveRoutingForRecipient(env.INDEX_DB, aliasAddress.toUpperCase());

		expect(result).toEqual({
			action: "store",
			mailboxId,
			ruleId: null,
			matchedAlias: aliasAddress,
		});
	});

	it("resolves to forward (with forwardTo) when a matching rule has action=forward", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const ruleId = `rule_${suffix}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: "*",
			priority: 10,
			action: "forward",
			mailbox_id: null,
			forward_to_json: JSON.stringify(["dest@elsewhere.test", "dest2@elsewhere.test"]),
			reject_reason: null,
			enabled: 1,
		});
		const recipient = `anything-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "forward",
			forwardTo: ["dest@elsewhere.test", "dest2@elsewhere.test"],
			ruleId,
			matchedAlias: recipient,
		});
	});

	it("resolves to reject (with reason) when a matching rule has action=reject", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const ruleId = `rule_${suffix}`;
		const localPart = `blocked-${suffix}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: localPart,
			priority: 10,
			action: "reject",
			mailbox_id: null,
			forward_to_json: "[]",
			reject_reason: "blocked_sender",
			enabled: 1,
		});
		const recipient = `${localPart}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "blocked_sender",
			ruleId,
			matchedAlias: recipient,
		});
	});

	it("falls back to a default 'rejected_by_rule' reason when a reject rule has no reject_reason", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const ruleId = `rule_${suffix}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: "*",
			priority: 10,
			action: "reject",
			mailbox_id: null,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});
		const recipient = `anyone-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "rejected_by_rule",
			ruleId,
			matchedAlias: recipient,
		});
	});

	it("matches a bare '*' wildcard pattern against any local part", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const mailboxId = await seedMailbox(suffix);
		const ruleId = `rule_${suffix}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: "*",
			priority: 10,
			action: "store",
			mailbox_id: mailboxId,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});
		const recipient = `whatever-local-part-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({ action: "store", mailboxId, ruleId, matchedAlias: recipient });
	});

	it("matches a '*@domain' wildcard pattern", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const mailboxId = await seedMailbox(suffix);
		const ruleId = `rule_${suffix}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: `*@${domain}`,
			priority: 10,
			action: "store",
			mailbox_id: mailboxId,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});
		const recipient = `someone-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({ action: "store", mailboxId, ruleId, matchedAlias: recipient });
	});

	it("matches an exact local-part pattern (no domain in the pattern)", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const mailboxId = await seedMailbox(suffix);
		const ruleId = `rule_${suffix}`;
		const localPart = `billing-${suffix}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: localPart,
			priority: 10,
			action: "store",
			mailbox_id: mailboxId,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});

		const result = await resolveRoutingForRecipient(env.INDEX_DB, `${localPart}@${domain}`);

		expect(result).toEqual({
			action: "store",
			mailboxId,
			ruleId,
			matchedAlias: `${localPart}@${domain}`,
		});
	});

	it("matches an exact full-address pattern", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const mailboxId = await seedMailbox(suffix);
		const ruleId = `rule_${suffix}`;
		const recipient = `exact-${suffix}@${domain}`;
		await insertRoutingRule(env.INDEX_DB, {
			id: ruleId,
			domain_id: domainId,
			pattern: recipient,
			priority: 10,
			action: "store",
			mailbox_id: mailboxId,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({ action: "store", mailboxId, ruleId, matchedAlias: recipient });
	});

	it("rejects with unknown_domain when the domain row is disabled", async () => {
		const { domain } = await seedDomain("disabled");
		const recipient = `user@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "unknown_domain",
			ruleId: null,
			matchedAlias: recipient,
		});
	});

	it("rejects with unknown_domain when there is no domain row at all", async () => {
		const suffix = uniqueSuffix();
		const recipient = `user@nonexistent-${suffix}.routing.test`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "unknown_domain",
			ruleId: null,
			matchedAlias: recipient,
		});
	});

	it("ignores a disabled rule and falls through to unmatched_recipient", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		await insertRoutingRule(env.INDEX_DB, {
			id: `rule_${suffix}`,
			domain_id: domainId,
			pattern: "*",
			priority: 10,
			action: "reject",
			mailbox_id: null,
			forward_to_json: "[]",
			reject_reason: "should_not_apply_because_disabled",
			enabled: 0,
		});
		const recipient = `user-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "unmatched_recipient",
			ruleId: null,
			matchedAlias: recipient,
		});
	});

	it("rejects with unmatched_recipient when an active domain has no routing rules at all", async () => {
		const { domain, suffix } = await seedDomain();
		const recipient = `user-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "unmatched_recipient",
			ruleId: null,
			matchedAlias: recipient,
		});
	});

	it("rejects with unmatched_recipient when no rule pattern matches the recipient", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		await insertRoutingRule(env.INDEX_DB, {
			id: `rule_${suffix}`,
			domain_id: domainId,
			pattern: `only-this-local-part-${suffix}`,
			priority: 10,
			action: "reject",
			mailbox_id: null,
			forward_to_json: "[]",
			reject_reason: "x",
			enabled: 1,
		});
		const recipient = `someone-else-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "reject",
			reason: "unmatched_recipient",
			ruleId: null,
			matchedAlias: recipient,
		});
	});

	it("applies the lowest-priority matching rule first, ignoring higher-priority matches", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		const mailboxId = await seedMailbox(suffix);
		const lowPriorityRuleId = `rule_low_${suffix}`;
		const highPriorityRuleId = `rule_high_${suffix}`;

		// Insert the higher-priority-number (lower-precedence) rule first to
		// make sure the result depends on `priority`, not insertion order.
		await insertRoutingRule(env.INDEX_DB, {
			id: highPriorityRuleId,
			domain_id: domainId,
			pattern: "*",
			priority: 20,
			action: "reject",
			mailbox_id: null,
			forward_to_json: "[]",
			reject_reason: "should_not_win",
			enabled: 1,
		});
		await insertRoutingRule(env.INDEX_DB, {
			id: lowPriorityRuleId,
			domain_id: domainId,
			pattern: "*",
			priority: 5,
			action: "store",
			mailbox_id: mailboxId,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});
		const recipient = `user-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		expect(result).toEqual({
			action: "store",
			mailboxId,
			ruleId: lowPriorityRuleId,
			matchedAlias: recipient,
		});
	});

	it("rejects a malformed recipient with no '@' as invalid_recipient", async () => {
		const result = await resolveRoutingForRecipient(env.INDEX_DB, "not-an-email");

		expect(result).toEqual({
			action: "reject",
			reason: "invalid_recipient",
			ruleId: null,
			matchedAlias: "not-an-email",
		});
	});

	it("documents current behavior: a store rule without a mailbox_id is silently skipped", async () => {
		const { id: domainId, domain, suffix } = await seedDomain();
		await insertRoutingRule(env.INDEX_DB, {
			id: `rule_${suffix}`,
			domain_id: domainId,
			pattern: "*",
			priority: 10,
			action: "store",
			mailbox_id: null,
			forward_to_json: "[]",
			reject_reason: null,
			enabled: 1,
		});
		const recipient = `user-${suffix}@${domain}`;

		const result = await resolveRoutingForRecipient(env.INDEX_DB, recipient);

		// A misconfigured store rule (no mailbox_id) does not match, and
		// resolution falls through to the unmatched_recipient default reject.
		expect(result).toEqual({
			action: "reject",
			reason: "unmatched_recipient",
			ruleId: null,
			matchedAlias: recipient,
		});
	});
});
