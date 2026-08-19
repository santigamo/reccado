import { describe, expect, it, beforeAll } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import type { TransactionalApiKeyRecord } from "#/lib/transactional-keys";
import { upsertTransactionalRequestLog, listTransactionalRequestLogs } from "#/db/d1";

type TestEnv = Env & {
	INDEX_DB: D1Database;
	MAIL_OBJECTS: R2Bucket;
	MAILBOX_DO: DurableObjectNamespace;
};

const env = testEnv as unknown as TestEnv;

async function applyD1Migrations(db: D1Database): Promise<void> {
	const m1 = await import("../../migrations/d1/0001_initial.sql?raw");
	const m2 = await import("../../migrations/d1/0002_message_index.sql?raw");
	const m3 = await import("../../migrations/d1/0003_mailbox_owner.sql?raw");
	const m6 = await import("../../migrations/d1/0006_transactional_api_keys.sql?raw");
	const m7 = await import("../../migrations/d1/0007_transactional_requests.sql?raw");
	for (const raw of [m1.default, m2.default, m3.default, m6.default, m7.default]) {
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

async function createKey(
	mailboxId: string,
	opts: {
		environment?: string;
		sender?: string;
		scopes?: string[];
		templateAllowlist?: string[];
		recipientPolicy?: string;
		quotaMax?: number;
		expiresAt?: string;
	} = {},
): Promise<{ key: TransactionalApiKeyRecord; plaintextKey: string }> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const body: Record<string, unknown> = {
		environment: opts.environment ?? "live",
		sender: opts.sender ?? "sender@test.com",
		scopes: opts.scopes ?? ["transactional:send", "transactional:templates:use"],
	};
	if (opts.templateAllowlist) body.templateAllowlist = opts.templateAllowlist;
	if (opts.recipientPolicy) body.recipientPolicy = opts.recipientPolicy;
	if (opts.quotaMax != null) body.quotaMax = opts.quotaMax;
	if (opts.expiresAt) body.expiresAt = opts.expiresAt;

	const response = await stub.fetch("https://mailbox-do/transactional/api-keys", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(201);
	const data = (await response.json()) as {
		key: TransactionalApiKeyRecord;
		plaintextKey: string;
	};
	return { key: data.key, plaintextKey: data.plaintextKey };
}

async function createTemplate(mailboxId: string, id: string, subject: string): Promise<void> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const response = await stub.fetch("https://mailbox-do/transactional/templates", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id, subject }),
	});
	expect(response.status).toBe(201);
}

async function sendTransactional(
	mailboxId: string,
	authHeader: string | null,
	idempotencyKey: string | null,
	body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (authHeader) headers.authorization = authHeader;
	if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

	const response = await stub.fetch("https://mailbox-do/transactional/send", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	const json = (await response.json()) as Record<string, unknown>;
	return { status: response.status, json };
}

async function getStatus(
	mailboxId: string,
	plaintextKey: string,
	requestId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const response = await stub.fetch(`https://mailbox-do/transactional/requests/${requestId}`, {
		method: "GET",
		headers: { Authorization: `Bearer ${plaintextKey}` },
	});
	const json = (await response.json()) as Record<string, unknown>;
	return { status: response.status, json };
}

describe("Transactional send flow", () => {
	describe("Auth & key validation", () => {
		it("rejects missing authorization header", async () => {
			const result = await sendTransactional("mbx_send_no_auth", null, "ik-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(401);
			expect(result.json.error).toBe("missing_authorization");
		});

		it("rejects invalid Bearer token", async () => {
			const result = await sendTransactional("mbx_send_bad_tok", "Bearer invalidkey", "ik-2", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("invalid_api_key");
		});

		it("rejects revoked key (verifyApiKey catches it as invalid)", async () => {
			const mailboxId = "mbx_send_revoked";
			const { key, plaintextKey } = await createKey(mailboxId);

			const stub = env.MAILBOX_DO.getByName(mailboxId);
			await stub.fetch(`https://mailbox-do/transactional/api-keys/${key.keyId}/revoke`, {
				method: "POST",
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-rev-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("invalid_api_key");
		});

		it("rejects expired key (verifyApiKey catches it as invalid)", async () => {
			const mailboxId = "mbx_send_expired";
			const { plaintextKey } = await createKey(mailboxId, {
				expiresAt: "2020-01-01T00:00:00.000Z",
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-exp-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("invalid_api_key");
		});

		it("rejects key from wrong mailbox (key not found in DO B)", async () => {
			const mailboxA = "mbx_send_wrng_a";
			const mailboxB = "mbx_send_wrng_b";
			const { plaintextKey } = await createKey(mailboxA, {
				templateAllowlist: ["t"],
			});

			const result = await sendTransactional(mailboxB, `Bearer ${plaintextKey}`, "ik-wr-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("invalid_api_key");
		});

		it("rejects key without transactional:send scope", async () => {
			const mailboxId = "mbx_send_noscp";
			const { plaintextKey } = await createKey(mailboxId, {
				scopes: ["transactional:status"],
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-sc-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("insufficient_scope");
		});
	});

	describe("Test-key rejection", () => {
		it("rejects test environment key", async () => {
			const mailboxId = "mbx_send_testenv";
			const { plaintextKey } = await createKey(mailboxId, {
				environment: "test",
				templateAllowlist: ["welcome"],
			});
			await createTemplate(mailboxId, "welcome", "Hello {{name}}");

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-te-1", {
				template: "welcome",
				to: "a@b.com",
				variables: { name: "World" },
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("test_key_not_allowed_in_production_send");
		});
	});

	describe("Request validation", () => {
		it("rejects missing idempotency key", async () => {
			const mailboxId = "mbx_send_noik";
			const { plaintextKey } = await createKey(mailboxId);

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, null, {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(400);
			expect(result.json.error).toBe("idempotency_key_required");
		});

		it("rejects invalid request body", async () => {
			const mailboxId = "mbx_send_badbody";
			const { plaintextKey } = await createKey(mailboxId);

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-bb-1", {
				notemplate: true,
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("invalid_request_body");
		});
	});

	describe("Template validation", () => {
		it("rejects template not in allowlist", async () => {
			const mailboxId = "mbx_send_tpl_notallwd";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: [],
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-tp-1", {
				template: "my-tpl",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("template_not_allowed");
		});

		it("rejects non-existent template", async () => {
			const mailboxId = "mbx_send_tplnf";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["nonexistent"],
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-tp-2", {
				template: "nonexistent",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("template_not_found");
		});
	});

	describe("Recipient policy", () => {
		it("denies recipient by policy", async () => {
			const mailboxId = "mbx_send_plcy_dny";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				recipientPolicy: "@allowed.com",
			});
			await createTemplate(mailboxId, "t", "Subject");

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-pl-1", {
				template: "t",
				to: "bob@denied.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("not_allowed_by_policy");
		});
	});

	describe("Idempotency & quota", () => {
		it("enforces daily quota", async () => {
			const mailboxId = "mbx_send_quota";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				quotaMax: 1,
			});
			await createTemplate(mailboxId, "t", "Test");

			await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-qt-1", {
				template: "t",
				to: "a@b.com",
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-qt-2", {
				template: "t",
				to: "a@b.com",
			});
			expect(result.status).toBe(403);
			expect(result.json.error).toBe("quota_exceeded");
		});

		it("same idempotency same payload returns original result", async () => {
			const mailboxId = "mbx_send_idem_same";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				quotaMax: 5,
			});
			await createTemplate(mailboxId, "t", "Hello");

			const first = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-ids-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(first.status).toBe(200);
			expect(first.json.requestId).toBeTruthy();

			const second = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-ids-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(second.status).toBe(200);
			expect(second.json.requestId).toBe(first.json.requestId);
			expect(second.json.status).toBe(first.json.status);
		});

		it("same idempotency different payload => 409 conflict", async () => {
			const mailboxId = "mbx_send_idem_diff";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				quotaMax: 5,
			});
			await createTemplate(mailboxId, "t", "Hello");

			await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-idc-1", {
				template: "t",
				to: "a@b.com",
			});

			const result = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-idc-1", {
				template: "t",
				to: "other@b.com",
			});
			expect(result.status).toBe(409);
			expect(result.json.error).toBe("idempotency_key_already_used_with_different_payload");
		});
	});

	describe("D1 projection no secret body", () => {
		it("upsertTransactionalRequestLog does not leak body secret or variables", async () => {
			const mailboxId = "mbx_d1_proj_send";
			const requestId = "test-req-99999";
			const now = new Date().toISOString();

			await upsertTransactionalRequestLog(env.INDEX_DB, {
				request_id: requestId,
				key_id: "test-key-xyz",
				mailbox_id: mailboxId,
				status: "sent",
				to_addr: "recipient@example.com",
				template_id: "welcome",
				sender: "sender@test.com",
				provider_message_id: "<msg@cloudflare.email>",
				error_code: null,
				created_at: now,
				updated_at: now,
			});

			const rows = await listTransactionalRequestLogs(env.INDEX_DB, "test-key-xyz");
			const logRow = rows.find((r) => r.request_id === requestId);
			expect(logRow).toBeTruthy();
			expect(logRow!).not.toHaveProperty("variables_json");
			expect(logRow!).not.toHaveProperty("key_hash");
			expect(logRow!).not.toHaveProperty("plaintextKey");
			expect(logRow!).not.toHaveProperty("body_text");
			expect(logRow!).not.toHaveProperty("body_html");
			expect(logRow!.to_addr).toBe("recipient@example.com");
			expect(logRow!.status).toBe("sent");
			expect(logRow!.mailbox_id).toBe(mailboxId);
		});
	});

	describe("Status isolation", () => {
		it("key with status scope can read its own request but cross-key gets 404", async () => {
			const mailboxId = "mbx_send_stat_only";

			// Create a key that can both send and check status
			const { plaintextKey: sendKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				quotaMax: 10,
				scopes: ["transactional:send", "transactional:status", "transactional:templates:use"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const sendRes = await sendTransactional(mailboxId, `Bearer ${sendKey}`, "ik-st-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(sendRes.status).toBe(200);
			const requestId = sendRes.json.requestId as string;

			// Same key can read its own request
			const ownStatus = await getStatus(mailboxId, sendKey, requestId as string);
			expect(ownStatus.status).toBe(200);
			expect(ownStatus.json).toHaveProperty("status");
			expect(ownStatus.json).toHaveProperty("requestId");

			// A different status-only key cannot read the same request
			const { plaintextKey: statusKey } = await createKey(mailboxId, {
				scopes: ["transactional:status"],
			});

			const crossKeyStatus = await getStatus(mailboxId, statusKey, requestId as string);
			expect(crossKeyStatus.status).toBe(404);
			expect(crossKeyStatus.json.error).toBe("not_found");

			// Status-only key cannot send
			const sendReject = await sendTransactional(mailboxId, `Bearer ${statusKey}`, "ik-st-2", {
				template: "t",
				to: "a@b.com",
			});
			expect(sendReject.status).toBe(403);
			expect(sendReject.json.error).toBe("insufficient_scope");
		});

		it("key cannot read requests created by a different key (cross-key isolation)", async () => {
			const mailboxId = "mbx_send_stat_iso";

			// Key A: has both send and status scope
			const { plaintextKey: keyA } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				quotaMax: 10,
				scopes: ["transactional:send", "transactional:status", "transactional:templates:use"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const sendRes = await sendTransactional(mailboxId, `Bearer ${keyA}`, "ik-iso-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(sendRes.status).toBe(200);
			const requestId = sendRes.json.requestId as string;

			// Key A can read its own request
			const ownStatus = await getStatus(mailboxId, keyA, requestId as string);
			expect(ownStatus.status).toBe(200);
			expect(ownStatus.json).toHaveProperty("status");

			// Key B (different key, also status-scoped) cannot read A's request
			const { plaintextKey: keyB } = await createKey(mailboxId, {
				scopes: ["transactional:status"],
			});

			const crossStatus = await getStatus(mailboxId, keyB, requestId as string);
			expect(crossStatus.status).toBe(404);
			expect(crossStatus.json.error).toBe("not_found");

			// Key B can read its own (nonexistent) request and get 404
			const bOwnStatus = await getStatus(mailboxId, keyB, "nonexistent-request");
			expect(bOwnStatus.status).toBe(404);
			expect(bOwnStatus.json.error).toBe("not_found");
		});
	});
});
