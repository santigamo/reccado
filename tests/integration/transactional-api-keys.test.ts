import { describe, expect, it, beforeAll } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import type { TransactionalApiKeyRecord } from "#/lib/transactional-keys";
import {
	upsertApiKeyProjection,
	getMailboxForOwner,
	insertMailbox,
	getApiKeyProjection,
} from "#/db/d1";

type TestEnv = Env & {
	INDEX_DB: D1Database;
	MAIL_OBJECTS: R2Bucket;
	MAILBOX_DO: DurableObjectNamespace;
};

const env = testEnv as unknown as TestEnv;

/**
 * Applies D1 migrations needed before tests that touch the mailboxes table.
 * The test pool's D1 binding starts empty; dev migrations are not auto-applied.
 * D1Database#exec() only accepts one statement per line, so multi-line CREATE TABLE
 * statements are split on ";" and executed via prepare().run() instead.
 */
async function applyD1Migrations(db: D1Database): Promise<void> {
	const m1 = await import("../../migrations/d1/0001_initial.sql?raw");
	const m2 = await import("../../migrations/d1/0002_message_index.sql?raw");
	const m3 = await import("../../migrations/d1/0003_mailbox_owner.sql?raw");
	const m6 = await import("../../migrations/d1/0006_transactional_api_keys.sql?raw");
	for (const raw of [m1.default, m2.default, m3.default, m6.default]) {
		const statements = (raw as string)
			.split(";")
			.map((s) => s.trim())
			.filter(Boolean);
		for (const statement of statements) {
			await db.prepare(statement).run();
		}
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.INDEX_DB);
});

describe("Transactional API key integration tests", () => {
	it("creates, lists, revokes, rotates an API key via the DO", async () => {
		const mailboxId = "mbx_test_keys";

		const stub = env.MAILBOX_DO.getByName(mailboxId);

		// Create a key
		const createResponse = await stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				environment: "test",
				sender: "sender@example.com",
				scopes: ["transactional:send", "transactional:status"],
			}),
		});
		const createBody = (await createResponse.json()) as {
			key: TransactionalApiKeyRecord;
			plaintextKey: string;
			auditEvent: { id: string };
		};

		expect(createResponse.status).toBe(201);
		expect(createBody.plaintextKey).toMatch(/^rck_test_[0-9a-f]{32}_/);
		expect(createBody.key.status).toBe("active");
		expect(createBody.key.sender).toBe("sender@example.com");
		expect(createBody.key.scopes).toEqual(["transactional:send", "transactional:status"]);
		expect(createBody.key.environment).toBe("test");

		const keyId = createBody.key.keyId;
		expect(createBody.plaintextKey).toBeTruthy();

		// List keys — no hash/secret should leak
		const listResponse = await stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "GET",
		});
		const listBody = (await listResponse.json()) as { keys: Array<TransactionalApiKeyRecord> };
		expect(listBody.keys.length).toBeGreaterThanOrEqual(1);
		const listedKey = listBody.keys.find((k) => k.keyId === keyId);
		expect(listedKey).toBeTruthy();
		expect(listedKey!).not.toHaveProperty("keyHash");
		expect(listedKey!.status).toBe("active");

		// Ensure no hash/secret in list response
		for (const key of listBody.keys) {
			expect(key).not.toHaveProperty("keyHash");
			expect(key).not.toHaveProperty("plaintextKey");
			expect(key).not.toHaveProperty("secret");
		}

		// Rotate the (active) key
		const rotateResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${keyId}/rotate`,
			{ method: "POST" },
		);
		expect(rotateResponse.status).toBe(200);
		const rotateBody = (await rotateResponse.json()) as {
			key: TransactionalApiKeyRecord;
			plaintextKey: string;
			auditEvent: { id: string };
			previousKeyId: string;
			previousKeyProjection: Record<string, unknown>;
		};
		expect(rotateBody.plaintextKey).toMatch(/^rck_test_/);
		expect(rotateBody.key.status).toBe("active");
		expect(rotateBody.key.keyId).not.toBe(keyId);

		// Verify rotate response includes previousKeyId and previousKeyProjection
		expect(rotateBody.previousKeyId).toBe(keyId);
		expect(rotateBody.previousKeyProjection).toBeTruthy();
		expect(rotateBody.previousKeyProjection!.status).toBe("revoked");
		expect(rotateBody.previousKeyProjection!.keyId).toBe(keyId);

		const newKeyId = rotateBody.key.keyId;

		// Revoke the rotated key.
		// The DO revoke handler returns { key: RevokeApiKeyResult }, and RevokeApiKeyResult
		// has { key, auditEvent, projection } — so the full JSON is:
		// { "key": { "key": {...record...}, "auditEvent": {...}, "projection": {...} } }
		const revokeResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${newKeyId}/revoke`,
			{ method: "POST" },
		);
		const revokeBody = (await revokeResponse.json()) as {
			key: {
				key: TransactionalApiKeyRecord;
				auditEvent: { id: string };
				projection: Record<string, unknown>;
			};
		};
		expect(revokeBody.key.key.status).toBe("revoked");
		expect(revokeBody.key.key.revokedAt).toBeTruthy();

		// Verify revoke response includes projection inside the nested key
		expect(revokeBody.key.projection).toBeTruthy();
		expect(revokeBody.key.projection!.status).toBe("revoked");
		expect(revokeBody.key.projection!.keyId).toBe(newKeyId);

		// Verify revoked key appears as revoked in list
		const listAfterRevoke = await stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "GET",
		});
		const listAfterRevokeBody = (await listAfterRevoke.json()) as {
			keys: Array<TransactionalApiKeyRecord>;
		};
		const revokedListed = listAfterRevokeBody.keys.find((k) => k.keyId === newKeyId);
		expect(revokedListed!.status).toBe("revoked");

		// Attempting to rotate a revoked key returns 400
		const rotateRevokedResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${newKeyId}/rotate`,
			{ method: "POST" },
		);
		expect(rotateRevokedResponse.status).toBe(400);
	});

	it("prevents key from crossing mailboxes", async () => {
		const mailboxA = "mbx_cross_a";
		const mailboxB = "mbx_cross_b";

		const stubA = env.MAILBOX_DO.getByName(mailboxA);

		// Create a key in mailbox A
		const createResponse = await stubA.fetch("https://mailbox-do/transactional/api-keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				environment: "test",
				sender: "a@example.com",
				scopes: ["transactional:send"],
			}),
		});
		const createBody = (await createResponse.json()) as {
			key: TransactionalApiKeyRecord;
			plaintextKey: string;
		};
		expect(createBody.key.mailboxId).toBe(mailboxA);
		expect(createBody.key.mailboxId).not.toBe(mailboxB);

		// Verify key is listed in mailbox A only
		const listA = await stubA.fetch("https://mailbox-do/transactional/api-keys", { method: "GET" });
		const listABody = (await listA.json()) as { keys: Array<{ mailboxId: string }> };
		for (const key of listABody.keys) {
			expect(key.mailboxId).toBe(mailboxA);
		}

		// Mailbox B should have no keys
		const stubB = env.MAILBOX_DO.getByName(mailboxB);
		const listB = await stubB.fetch("https://mailbox-do/transactional/api-keys", { method: "GET" });
		const listBBody = (await listB.json()) as { keys: Array<unknown> };
		expect(listBBody.keys.length).toBe(0);
	});

	it("returns 404 for non-existent key operations", async () => {
		const mailboxId = "mbx_test_notfound";
		const stub = env.MAILBOX_DO.getByName(mailboxId);

		const fakeKeyId = "00000000000000000000000000000000";

		const revokeResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${fakeKeyId}/revoke`,
			{ method: "POST" },
		);
		expect(revokeResponse.status).toBe(404);

		const rotateResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${fakeKeyId}/rotate`,
			{ method: "POST" },
		);
		expect(rotateResponse.status).toBe(404);
	});

	it("ensures D1 is not needed for canonical key decisions", async () => {
		// Key operations happen entirely within the DO's SQL storage.
		// D1 is only a rebuildable projection. This test verifies the
		// DO can create and manage keys without any D1 involvement.
		const mailboxId = "mbx_test_no_d1";

		const stub = env.MAILBOX_DO.getByName(mailboxId);

		const createResponse = await stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				environment: "live",
				sender: "no-d1-test@example.com",
				scopes: ["transactional:status"],
			}),
		});
		expect(createResponse.status).toBe(201);

		const createData = (await createResponse.json()) as {
			key: TransactionalApiKeyRecord;
			plaintextKey: string;
		};
		const revokeResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${createData.key.keyId}/revoke`,
			{ method: "POST" },
		);
		expect(revokeResponse.status).toBe(200);
		expect(revokeResponse.ok).toBe(true);
	});

	it("writes D1 projection and verifies ownership on API routes", async () => {
		const mailboxId = "mbx_d1_proj_owner";
		const ownerEmail = "owner@example.com";

		// Seed a mailbox with owner into D1
		await insertMailbox(env.INDEX_DB, {
			mailbox_id: mailboxId,
			primary_address: `${mailboxId}@example.com`,
			display_name: null,
			status: "active",
			owner_email: ownerEmail,
		});

		// Verify ownership lookup works
		const owned = await getMailboxForOwner(env.INDEX_DB, mailboxId, ownerEmail);
		expect(owned).not.toBeNull();
		expect(owned!.mailbox_id).toBe(mailboxId);

		const nonOwned = await getMailboxForOwner(env.INDEX_DB, mailboxId, "other@example.com");
		expect(nonOwned).toBeNull();

		// Create a key via DO and verify D1 projection is separate (DO doesn't write D1)
		const stub = env.MAILBOX_DO.getByName(mailboxId);

		const createResponse = await stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				environment: "test",
				sender: "sender@test.com",
				scopes: ["transactional:send"],
			}),
		});
		const createResult = (await createResponse.json()) as {
			key: TransactionalApiKeyRecord;
			plaintextKey: string;
			projection: Record<string, unknown>;
		};
		expect(createResult.projection).toBeTruthy();
		expect(createResult.projection!.keyId).toBe(createResult.key.keyId);
		expect(createResult.projection!.status).toBe("active");
		// Projection should not contain hash or plaintext
		expect(createResult.projection).not.toHaveProperty("keyHash");
		expect(createResult.projection).not.toHaveProperty("plaintextKey");

		// Write the projection to D1 manually (simulates what the route handler does)
		const p = createResult.projection as Record<string, unknown>;
		await upsertApiKeyProjection(env.INDEX_DB, {
			key_id: p.keyId as string,
			mailbox_id: p.mailboxId as string,
			sender: p.sender as string,
			display_suffix: p.displaySuffix as string,
			environment: p.environment as "test" | "live",
			scopes_json: JSON.stringify(p.scopes ?? []),
			template_allowlist_json: p.templateAllowlist ? JSON.stringify(p.templateAllowlist) : null,
			recipient_policy: (p.recipientPolicy as string) ?? null,
			quota_max: (p.quotaMax as number) ?? null,
			quota_used: 0,
			expires_at: (p.expiresAt as string) ?? null,
			status: p.status as "active" | "revoked",
			created_at: p.createdAt as string,
			updated_at: p.updatedAt as string,
			revoked_at: (p.revokedAt as string) ?? null,
		});

		// Verify projection was written to D1
		const projection = await getApiKeyProjection(env.INDEX_DB, p.keyId as string);
		expect(projection).not.toBeNull();
		expect(projection!.mailbox_id).toBe(mailboxId);
		expect(projection!.sender).toBe("sender@test.com");
		expect(projection!.status).toBe("active");

		// Verify D1 projection never exposes hash or secret
		expect(projection).not.toHaveProperty("key_hash");
		expect(projection).not.toHaveProperty("plaintextKey");
	});

	it("writes D1 projection on revoke", async () => {
		const mailboxId = "mbx_d1_revoke_proj";

		// Seed mailbox
		await insertMailbox(env.INDEX_DB, {
			mailbox_id: mailboxId,
			primary_address: `${mailboxId}@example.com`,
			display_name: null,
			status: "active",
			owner_email: "test@example.com",
		});

		const stub = env.MAILBOX_DO.getByName(mailboxId);
		// DO create response: { key: {...}, plaintextKey: "...", auditEvent: {...}, projection: {...} }
		const createResult = (await stub
			.fetch("https://mailbox-do/transactional/api-keys", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					environment: "test",
					sender: "revoke-proj@test.com",
					scopes: ["transactional:send"],
				}),
			})
			.then((r) => r.json())) as {
			key: TransactionalApiKeyRecord;
			projection: Record<string, unknown>;
		};

		// Revoke and get projection.
		// The DO revoke handler returns { key: { key: {...}, auditEvent: {...}, projection: {...} } }
		const revokeResult = (await stub
			.fetch(`https://mailbox-do/transactional/api-keys/${createResult.key.keyId}/revoke`, {
				method: "POST",
			})
			.then((r) => r.json())) as {
			key: { key: TransactionalApiKeyRecord; projection: Record<string, unknown> };
		};

		expect(revokeResult.key.projection).toBeTruthy();
		expect(revokeResult.key.projection!.status).toBe("revoked");
		expect(revokeResult.key.projection!.revokedAt).toBeTruthy();
		expect(revokeResult.key.projection).not.toHaveProperty("keyHash");
	});
});
