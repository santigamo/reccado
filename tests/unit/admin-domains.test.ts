import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { createDomain, deleteDomain, domainStatus, patchDomain } from "#/lib/admin/domains";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import { splitSqlStatements } from "../helpers/migrations";

const actor = { userId: "owner", email: "owner@example.test", owners: ["owner@example.test"] };
const denied = { userId: "other", email: "other@example.test", owners: ["owner@example.test"] };

beforeAll(async () => {
	for (const statement of splitSqlStatements(migrationInitial))
		await env.INDEX_DB.prepare(statement).run();
});

describe("domain admin service", () => {
	it("creates, checks, updates and disables a domain", async () => {
		const created = await createDomain(env, actor, { domain: "admin.test", zoneId: "zone" });
		expect(created.created).toBe(true);
		expect((await domainStatus(env, actor, { domain: "admin.test" }))?.domain.domain).toBe(
			"admin.test",
		);
		expect(
			(await patchDomain(env, actor, { domain: "admin.test", body: { status: "disabled" } })).domain
				?.status,
		).toBe("disabled");
		expect((await deleteDomain(env, actor, { domain: "admin.test" })).deleted).toBe("soft");
	});
	it("denies a non-owner", async () => {
		await expect(domainStatus(env, denied, { domain: "admin.test" })).rejects.toMatchObject({
			status: 403,
		});
	});
	it("reports missing domains and rejects invalid input", async () => {
		await expect(domainStatus(env, actor, { domain: "missing.test" })).rejects.toMatchObject({
			code: "domain_not_found",
		});
		await expect(deleteDomain(env, actor, { domain: "missing.test" })).rejects.toMatchObject({
			code: "domain_not_found",
		});
		await expect(createDomain(env, actor, { domain: "invalid" })).rejects.toThrow();
	});
});
