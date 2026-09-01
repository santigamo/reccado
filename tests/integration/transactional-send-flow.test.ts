import { describe, expect, it, beforeAll } from "vitest";
import { env as testEnv } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { TransactionalApiKeyRecord } from "#/lib/transactional-keys";
import { upsertTransactionalRequestLog, listTransactionalRequestLogs } from "#/db/d1";
import { splitSqlStatements } from "../helpers/migrations";

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
	const m8 = await import("../../migrations/d1/0008_email_events_suppressions.sql?raw");
	const m15 = await import("../../migrations/d1/0015_transactional_resolved_via.sql?raw");
	for (const raw of [
		m1.default,
		m2.default,
		m3.default,
		m6.default,
		m7.default,
		m8.default,
		m15.default,
	]) {
		const statements = splitSqlStatements(raw as string);
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

/**
 * Drives a send whose provider call throws ambiguously — the only way to produce
 * an `unknown`, and unreachable through the HTTP route because the real EMAIL
 * binding will not fail on demand. Everything else (auth, quota, idempotency,
 * the pre-send row, the at-most-once marker) is the production path.
 */
async function sendAmbiguous(
	mailboxId: string,
	plaintextKey: string,
	idempotencyKey: string,
	body: unknown,
	options: { error?: Error } = {},
): Promise<{ result: Record<string, unknown>; sendAttempts: number }> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	return runInDurableObject(stub, async (_instance, state) => {
		let sendAttempts = 0;
		const { handleTransactionalSend } = await import("#/do/transactional-send-ops");
		const result = await handleTransactionalSend(
			{
				sql: state.storage.sql,
				transactionSync: (fn: () => void) => state.storage.transactionSync(fn),
				email: {
					send: async () => {
						sendAttempts += 1;
						// No non-delivery keyword, so isAmbiguousProviderError says "maybe".
						throw options.error ?? new Error("connection reset by peer");
					},
				} as unknown as SendEmail,
				fromAddress: "sender@test.com",
			},
			(env as unknown as { TRANSACTIONAL_API_KEY_PEPPER: string }).TRANSACTIONAL_API_KEY_PEPPER,
			{
				mailboxId,
				authHeader: `Bearer ${plaintextKey}`,
				idempotencyKeyHeader: idempotencyKey,
				body,
			},
		);
		return { result: result as unknown as Record<string, unknown>, sendAttempts };
	});
}

async function postDeliveryEvent(
	mailboxId: string,
	event: Record<string, unknown>,
	requestId?: string | null,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const response = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ event, requestId: requestId ?? null }),
	});
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
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
			// 429, not 403: a quota is a cue to back off and retry later, which is a
			// different instruction to the caller than "this key may never do this".
			expect(result.status).toBe(429);
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
				delivery_status: null,
				delivery_event_at: null,
				resolved_via: null,
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

	describe("Cloudflare Email Sending delivery events", () => {
		it("suppresses hard-bounced recipients and processes event replays idempotently", async () => {
			const mailboxId = "mbx_delivery_hard_bounce";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const first = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "delivery-1", {
				template: "t",
				to: "hard-bounce@example.com",
			});
			expect(first.status).toBe(200);
			const providerMessageId = first.json.providerMessageId as string;
			const event = {
				event: {
					event_id: "cf-event-hard-bounce-1",
					event_type: "cf.email.sending.message.bounced",
					provider_message_id: providerMessageId,
					to: "hard-bounce@example.com",
					from: "sender@test.com",
					timestamp: new Date().toISOString(),
					bounce_type: "hard",
				},
				requestId: first.json.requestId,
			};
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			const firstEvent = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(event),
			});
			expect(firstEvent.status).toBe(200);
			const status = await getStatus(mailboxId, plaintextKey, first.json.requestId as string);
			expect(status.status).toBe(200);
			expect(status.json.deliveryStatus).toBe("bounced");
			expect(status.json.deliveryEventAt).toBeTruthy();

			const replay = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(event),
			});
			expect(replay.status).toBe(200);
			const replayBody = (await replay.json()) as { idempotent?: boolean };
			expect(replayBody.idempotent).toBe(true);

			const invalidReplay = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...event,
					event: { ...event.event, event_type: "invalid.event" },
				}),
			});
			expect(invalidReplay.status).toBe(400);

			const blocked = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "delivery-2", {
				template: "t",
				to: "hard-bounce@example.com",
			});
			expect(blocked.status).toBe(403);
			expect(blocked.json.error).toBe("recipient_suppressed");
		});

		it("does not suppress deferred or soft-bounced recipients", async () => {
			const mailboxId = "mbx_delivery_soft_bounce";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use"],
			});
			await createTemplate(mailboxId, "t", "Test");
			const first = await sendTransactional(
				mailboxId,
				`Bearer ${plaintextKey}`,
				"delivery-soft-1",
				{
					template: "t",
					to: "temporary@example.com",
				},
			);
			expect(first.status).toBe(200);
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			const event = {
				event: {
					event_id: "cf-event-soft-bounce-1",
					event_type: "cf.email.sending.message.bounced",
					provider_message_id: first.json.providerMessageId,
					to: "temporary@example.com",
					from: "sender@test.com",
					timestamp: new Date().toISOString(),
					bounce_type: "soft",
				},
				requestId: first.json.requestId,
			};
			const response = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(event),
			});
			expect(response.status).toBe(200);

			const second = await sendTransactional(
				mailboxId,
				`Bearer ${plaintextKey}`,
				"delivery-soft-2",
				{
					template: "t",
					to: "temporary@example.com",
				},
			);
			expect(second.status).toBe(200);
		});

		it("rejects an event whose sender does not match the canonical request", async () => {
			const mailboxId = "mbx_delivery_mismatch";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use"],
			});
			await createTemplate(mailboxId, "t", "Test");
			const first = await sendTransactional(
				mailboxId,
				`Bearer ${plaintextKey}`,
				"delivery-mismatch-1",
				{
					template: "t",
					to: "mismatch@example.com",
				},
			);
			expect(first.status).toBe(200);
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			const response = await stub.fetch("https://mailbox-do/transactional/delivery-event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					event: {
						event_id: "cf-event-mismatch-1",
						event_type: "cf.email.sending.message.complained",
						provider_message_id: first.json.providerMessageId,
						to: "mismatch@example.com",
						from: "attacker@example.com",
						timestamp: new Date().toISOString(),
					},
					requestId: first.json.requestId,
				}),
			});
			expect(response.status).toBe(404);
		});
	});

	describe("Resolving an ambiguous send from a delivery event", () => {
		// Cloudflare mints the message id and refuses a sender-chosen Message-ID
		// header, so an ambiguous send never learns the id of a message that may
		// well have gone out. Correlating those events on the envelope is what makes
		// an `unknown` answerable at all; see the block comment on
		// correlateEventToUnknownRequest for why the narrow candidate set makes that
		// sound rather than a guess.
		const eventAt = () => new Date().toISOString();

		it("resolves an unknown to sent when a delivered event correlates on the envelope", async () => {
			const mailboxId = "mbx_unknown_resolve_sent";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "unknown-1", {
				template: "t",
				to: "ghost@example.com",
			});
			expect(ambiguous.result.status).toBe("unknown");
			expect(ambiguous.result.providerMessageId).toBeNull();
			const requestId = ambiguous.result.requestId as string;

			const before = await getStatus(mailboxId, plaintextKey, requestId);
			expect(before.json.status).toBe("unknown");
			expect(before.json.resolvedVia).toBeNull();

			// The provider id on this event was never seen by us — that is the whole
			// point. Nothing is passed as a routing hint either.
			const delivered = await postDeliveryEvent(mailboxId, {
				event_id: "cf-unknown-delivered-1",
				event_type: "cf.email.sending.message.delivered",
				provider_message_id: "cf-id-never-returned-to-us",
				to: "ghost@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
			});
			expect(delivered.status).toBe(200);
			expect(delivered.json.correlation).toBe("envelope");
			expect(delivered.json.resolvedStatus).toBe("sent");
			expect(delivered.json.requestId).toBe(requestId);

			const after = await getStatus(mailboxId, plaintextKey, requestId);
			expect(after.json.status).toBe("sent");
			expect(after.json.deliveryStatus).toBe("delivered");
			// An inferred `sent` must stay distinguishable from one the provider
			// acknowledged at send time.
			expect(after.json.resolvedVia).toBe("envelope_correlation");
			// The id is adopted, so any later event for this message takes the
			// primary path instead of coming back through correlation.
			expect(after.json.providerMessageId).toBe("cf-id-never-returned-to-us");
		});

		it("replays a resolved request as sent without contacting the provider again", async () => {
			const mailboxId = "mbx_unknown_resolve_replay";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use"],
			});
			await createTemplate(mailboxId, "t", "Test");
			const payload = { template: "t", to: "replay@example.com" };

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "unknown-replay", payload);
			expect(ambiguous.result.status).toBe("unknown");
			expect(ambiguous.sendAttempts).toBe(1);

			// Before resolution the replay still answers `unknown` — no send, no
			// invented certainty.
			const replayBefore = await sendAmbiguous(mailboxId, plaintextKey, "unknown-replay", payload);
			expect(replayBefore.result.status).toBe("unknown");
			expect(replayBefore.sendAttempts).toBe(0);

			const delivered = await postDeliveryEvent(mailboxId, {
				event_id: "cf-unknown-replay-1",
				event_type: "cf.email.sending.message.delivered",
				provider_message_id: "cf-id-replay",
				to: "replay@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
			});
			expect(delivered.status).toBe(200);

			// This is the defect the whole change exists to fix: the replay used to
			// return the stored `unknown` forever.
			const replayAfter = await sendAmbiguous(mailboxId, plaintextKey, "unknown-replay", payload);
			expect(replayAfter.result.status).toBe("sent");
			expect(replayAfter.result.requestId).toBe(ambiguous.result.requestId);
			expect(replayAfter.result.providerMessageId).toBe("cf-id-replay");
			// Resolving an unknown is not a retry. Nothing was sent a second time.
			expect(replayAfter.sendAttempts).toBe(0);

			// A different payload under the same key is still a conflict.
			const conflict = await sendAmbiguous(mailboxId, plaintextKey, "unknown-replay", {
				template: "t",
				to: "someone-else@example.com",
			});
			expect(conflict.result.status).toBe("idempotency_conflict");
			expect(conflict.sendAttempts).toBe(0);
		});

		it("resolves an unknown to failed when the provider rejected the message", async () => {
			const mailboxId = "mbx_unknown_resolve_failed";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "unknown-rejected", {
				template: "t",
				to: "refused@example.com",
			});
			expect(ambiguous.result.status).toBe("unknown");

			const rejected = await postDeliveryEvent(mailboxId, {
				event_id: "cf-unknown-rejected-1",
				event_type: "cf.email.sending.message.rejected",
				provider_message_id: "cf-id-rejected",
				to: "refused@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
			});
			expect(rejected.status).toBe(200);
			expect(rejected.json.resolvedStatus).toBe("failed");

			const after = await getStatus(mailboxId, plaintextKey, ambiguous.result.requestId as string);
			expect(after.json.status).toBe("failed");
			expect(after.json.errorCode).toBe("permanent_failure");
			expect(after.json.resolvedVia).toBe("envelope_correlation");
		});

		it("treats a hard bounce as proof the message left, and still suppresses", async () => {
			const mailboxId = "mbx_unknown_resolve_bounced";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "unknown-bounced", {
				template: "t",
				to: "gone@example.com",
			});
			expect(ambiguous.result.status).toBe("unknown");

			const bounced = await postDeliveryEvent(mailboxId, {
				event_id: "cf-unknown-bounced-1",
				event_type: "cf.email.sending.message.bounced",
				provider_message_id: "cf-id-bounced",
				to: "gone@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
				bounce_type: "hard",
			});
			expect(bounced.status).toBe(200);
			// A bounce means the message was transmitted and the far end refused it.
			// That settles "did it leave" as yes; delivery_status carries the bad news.
			expect(bounced.json.resolvedStatus).toBe("sent");

			const after = await getStatus(mailboxId, plaintextKey, ambiguous.result.requestId as string);
			expect(after.json.status).toBe("sent");
			expect(after.json.deliveryStatus).toBe("bounced");

			const blocked = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "post-bounce", {
				template: "t",
				to: "gone@example.com",
			});
			expect(blocked.status).toBe(403);
			expect(blocked.json.error).toBe("recipient_suppressed");
		});

		it("adopts the provider id from a non-terminal event without settling the status", async () => {
			const mailboxId = "mbx_unknown_deferred";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "unknown-deferred", {
				template: "t",
				to: "slow@example.com",
			});
			const requestId = ambiguous.result.requestId as string;

			const deferred = await postDeliveryEvent(mailboxId, {
				event_id: "cf-unknown-deferred-1",
				event_type: "cf.email.sending.message.deferred",
				provider_message_id: "cf-id-deferred",
				to: "slow@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
			});
			expect(deferred.status).toBe(200);
			expect(deferred.json.resolvedStatus).toBeUndefined();

			const mid = await getStatus(mailboxId, plaintextKey, requestId);
			// Still ambiguous — a deferral is not an outcome.
			expect(mid.json.status).toBe("unknown");
			// But the id is ours now, so the eventual terminal event needs no
			// correlation at all.
			expect(mid.json.providerMessageId).toBe("cf-id-deferred");

			const delivered = await postDeliveryEvent(mailboxId, {
				event_id: "cf-unknown-deferred-2",
				event_type: "cf.email.sending.message.delivered",
				provider_message_id: "cf-id-deferred",
				to: "slow@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
			});
			expect(delivered.status).toBe(200);
			expect(delivered.json.correlation).toBe("provider_id");
			expect(delivered.json.resolvedStatus).toBe("sent");
		});

		it("refuses to guess when two ambiguous sends to the same recipient could match", async () => {
			const mailboxId = "mbx_unknown_ambiguous_tie";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const first = await sendAmbiguous(mailboxId, plaintextKey, "tie-1", {
				template: "t",
				to: "twin@example.com",
			});
			const second = await sendAmbiguous(mailboxId, plaintextKey, "tie-2", {
				template: "t",
				to: "twin@example.com",
			});
			expect(first.result.status).toBe("unknown");
			expect(second.result.status).toBe("unknown");

			const event = await postDeliveryEvent(mailboxId, {
				event_id: "cf-tie-1",
				event_type: "cf.email.sending.message.delivered",
				provider_message_id: "cf-id-tie",
				to: "twin@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
			});
			expect(event.status).toBe(409);
			expect(event.json.error).toBe("correlation_ambiguous");

			// Both stay honest rather than one of them being credited at random.
			for (const requestId of [first.result.requestId, second.result.requestId]) {
				const status = await getStatus(mailboxId, plaintextKey, requestId as string);
				expect(status.json.status).toBe("unknown");
				expect(status.json.resolvedVia).toBeNull();
			}
		});

		it("does not let an unmatched event touch a request that already succeeded", async () => {
			const mailboxId = "mbx_unknown_no_candidate";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const sent = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "healthy-1", {
				template: "t",
				to: "healthy@example.com",
			});
			expect(sent.status).toBe(200);

			// A row that already has a provider id is never up for adoption, so this
			// event finds no candidate at all.
			const stray = await postDeliveryEvent(mailboxId, {
				event_id: "cf-stray-1",
				event_type: "cf.email.sending.message.bounced",
				provider_message_id: "cf-id-belongs-to-nobody",
				to: "healthy@example.com",
				from: "sender@test.com",
				timestamp: eventAt(),
				bounce_type: "hard",
			});
			expect(stray.status).toBe(404);

			const after = await getStatus(mailboxId, plaintextKey, sent.json.requestId as string);
			expect(after.json.status).toBe("sent");
			expect(after.json.deliveryStatus).toBeNull();
		});

		it("will not claim a request older than the correlation window", async () => {
			const mailboxId = "mbx_unknown_stale_window";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "stale-window-1", {
				template: "t",
				to: "ancient@example.com",
			});
			expect(ambiguous.result.status).toBe("unknown");

			const event = await postDeliveryEvent(mailboxId, {
				event_id: "cf-stale-window-1",
				event_type: "cf.email.sending.message.delivered",
				provider_message_id: "cf-id-stale",
				to: "ancient@example.com",
				from: "sender@test.com",
				// Thirty days on from the send: far past any plausible bounce delay.
				timestamp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
			});
			expect(event.status).toBe(404);

			const after = await getStatus(mailboxId, plaintextKey, ambiguous.result.requestId as string);
			expect(after.json.status).toBe("unknown");
		});

		it("refuses a routing hint that disagrees with the DO's own candidate", async () => {
			const mailboxId = "mbx_unknown_hint_mismatch";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "hint-mismatch-1", {
				template: "t",
				to: "hinted@example.com",
			});
			const requestId = ambiguous.result.requestId as string;

			// D1 is a rebuildable projection; a stale one must not be able to
			// attribute an event to a request the DO does not agree on.
			const event = await postDeliveryEvent(
				mailboxId,
				{
					event_id: "cf-hint-mismatch-1",
					event_type: "cf.email.sending.message.delivered",
					provider_message_id: "cf-id-hinted",
					to: "hinted@example.com",
					from: "sender@test.com",
					timestamp: eventAt(),
				},
				"some-other-request-id",
			);
			expect(event.status).toBe(409);
			expect(event.json.error).toBe("correlation_hint_mismatch");

			const after = await getStatus(mailboxId, plaintextKey, requestId);
			expect(after.json.status).toBe("unknown");
		});

		it("does not correlate across senders", async () => {
			const mailboxId = "mbx_unknown_sender_scope";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const ambiguous = await sendAmbiguous(mailboxId, plaintextKey, "sender-scope-1", {
				template: "t",
				to: "scoped@example.com",
			});
			expect(ambiguous.result.status).toBe("unknown");

			const event = await postDeliveryEvent(mailboxId, {
				event_id: "cf-sender-scope-1",
				event_type: "cf.email.sending.message.delivered",
				provider_message_id: "cf-id-other-sender",
				to: "scoped@example.com",
				from: "someone-else@test.com",
				timestamp: eventAt(),
			});
			expect(event.status).toBe(404);

			const after = await getStatus(mailboxId, plaintextKey, ambiguous.result.requestId as string);
			expect(after.json.status).toBe("unknown");
		});
	});

	describe("Template revision", () => {
		// Templates used to be write-once: the only writes were an insert against a
		// primary key and an archive flag, so a wording fix or a new HTML part meant
		// a new id -- which is the string the caller hard-codes.
		it("revises a template in place, keeping its id and its declared variables", async () => {
			const mailboxId = "mbx_tpl_revise";
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			await createTemplate(mailboxId, "welcome", "Old subject");

			const updated = await stub.fetch("https://mailbox-do/transactional/templates/welcome", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					subject: "Welcome, {{name}}",
					body_text: "Hello {{name}}, visit {{url}}",
					body_html: '<p>Hello {{name}}, visit <a href="{{url}}">here</a></p>',
				}),
			});
			expect(updated.status).toBe(200);

			const list = (await (
				await stub.fetch("https://mailbox-do/transactional/templates")
			).json()) as { templates: Array<{ id: string; subject: string; body_html: string | null }> };
			const welcome = list.templates.find((t) => t.id === "welcome");
			expect(welcome?.subject).toBe("Welcome, {{name}}");
			// The HTML part is stored alongside the text one rather than replacing it,
			// which is what makes a multipart/alternative send possible.
			expect(welcome?.body_html).toContain("{{url}}");
		});

		it("refuses a revision that would inject a header into the subject", async () => {
			const mailboxId = "mbx_tpl_revise_crlf";
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			await createTemplate(mailboxId, "welcome", "Old subject");
			const response = await stub.fetch("https://mailbox-do/transactional/templates/welcome", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subject: "Hi\r\nBcc: victim@example.com" }),
			});
			expect(response.status).toBe(400);
			expect(((await response.json()) as { error: string }).error).toBe("subject_contains_newline");
		});

		it("404s a revision of a template that does not exist", async () => {
			const stub = env.MAILBOX_DO.getByName("mbx_tpl_revise_missing");
			const response = await stub.fetch("https://mailbox-do/transactional/templates/nope", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subject: "Anything" }),
			});
			expect(response.status).toBe(404);
		});
	});

	describe("Cross-mailbox key isolation", () => {
		// The path names a mailbox and the key is bound to one, so the two can
		// disagree. What happens then is a security boundary, and it had no test.
		it("refuses a key from one mailbox used against another mailbox's path", async () => {
			const owning = "mbx_xmb_owner";
			const other = "mbx_xmb_other";
			const { plaintextKey } = await createKey(owning, {
				templateAllowlist: ["t"],
				scopes: ["transactional:send", "transactional:templates:use"],
			});
			await createTemplate(owning, "t", "Test");
			// The other mailbox has the same template, so a failure here is about the
			// key's binding and nothing else.
			await createTemplate(other, "t", "Test");

			const ownPath = await sendTransactional(owning, `Bearer ${plaintextKey}`, "ik-xmb-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(ownPath.status).toBe(200);

			const wrongPath = await sendTransactional(other, `Bearer ${plaintextKey}`, "ik-xmb-2", {
				template: "t",
				to: "a@b.com",
			});
			expect(wrongPath.status).toBe(403);
			// It fails as an unknown key rather than as a mismatched one: keys live in
			// the owning mailbox's own Durable Object storage, so from the other
			// mailbox's DO this key simply does not exist. The explicit
			// `key_does_not_belong_to_mailbox` check is defence in depth behind that.
			expect(wrongPath.json.error).toBe("invalid_api_key");
		});
	});

	describe("Variable retention", () => {
		// Transactional variables carry action-capable tokens — verification links,
		// password resets, invitation URLs. Keeping them after the send would make
		// this table an accumulating store of live credentials, so a terminal state
		// must drop them while leaving the idempotency record intact.
		it("drops the variables once the send reaches a terminal state", async () => {
			const mailboxId = "mbx_variable_retention";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["verify"],
				scopes: ["transactional:send", "transactional:templates:use"],
			});
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			const createResponse = await stub.fetch("https://mailbox-do/transactional/templates", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id: "verify",
					subject: "Verify your email",
					body_text: "Verify here: {{url}}",
				}),
			});
			expect(createResponse.status).toBe(201);

			const secretUrl = "https://app.example.com/verify?token=super-secret-token-value";
			const sent = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "retention-1", {
				template: "verify",
				to: "user@example.com",
				variables: { url: secretUrl },
			});
			expect(sent.status).toBe(200);
			expect(sent.json.status).toBe("sent");

			const row = await runInDurableObject(stub, (_instance, state) => {
				return state.storage.sql
					.exec(
						"SELECT variables_json, payload_hash, status FROM transactional_requests WHERE request_id = ?",
						sent.json.requestId as string,
					)
					.toArray()[0] as
					| { variables_json: string | null; payload_hash: string; status: string }
					| undefined;
			});

			expect(row).toBeDefined();
			expect(row?.status).toBe("sent");
			// The idempotency record survives; only the token does not.
			expect(row?.payload_hash).toBeTruthy();
			expect(row?.variables_json).toBeNull();

			const allRows = await runInDurableObject(stub, (_instance, state) => {
				return state.storage.sql
					.exec(
						"SELECT COUNT(*) AS n FROM transactional_requests WHERE variables_json LIKE '%super-secret-token-value%'",
					)
					.toArray()[0] as { n: number };
			});
			expect(allRows.n).toBe(0);
		});

		it("replays an identical request after the variables are dropped", async () => {
			const mailboxId = "mbx_variable_retention_replay";
			const { plaintextKey } = await createKey(mailboxId, {
				templateAllowlist: ["verify"],
				scopes: ["transactional:send", "transactional:templates:use"],
			});
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			await stub.fetch("https://mailbox-do/transactional/templates", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: "verify", subject: "Verify", body_text: "Go: {{url}}" }),
			});
			const payload = {
				template: "verify",
				to: "user@example.com",
				variables: { url: "https://app.example.com/verify?token=abc" },
			};
			const first = await sendTransactional(
				mailboxId,
				`Bearer ${plaintextKey}`,
				"retention-replay-1",
				payload,
			);
			expect(first.status).toBe(200);

			// Idempotency compares payload_hash, not the stored variables, so a replay
			// still resolves to the original result rather than sending twice.
			const replay = await sendTransactional(
				mailboxId,
				`Bearer ${plaintextKey}`,
				"retention-replay-1",
				payload,
			);
			expect(replay.status).toBe(200);
			expect(replay.json.requestId).toBe(first.json.requestId);

			const conflict = await sendTransactional(
				mailboxId,
				`Bearer ${plaintextKey}`,
				"retention-replay-1",
				{ ...payload, to: "someone-else@example.com" },
			);
			expect(conflict.status).toBe(409);
		});
	});
	// A send from a domain whose feedback channel never worked returns `sent` with
	// `delivery_status: null` -- byte-identical to a send whose event has simply
	// not arrived yet. One of those means "wait", the other means "stop waiting".
	// Nothing in the response distinguished them, so the status API was silently
	// telling two different stories in one shape.
	describe("Feedback liveness on the status response", () => {
		it("marks a fresh send unobserved and the same domain never_observed once its sends mature", async () => {
			const mailboxId = "mbx_feedback_liveness";
			const { plaintextKey } = await createKey(mailboxId, {
				sender: "bot@notify.example.com",
				templateAllowlist: ["t"],
				quotaMax: 10,
				scopes: ["transactional:send", "transactional:status", "transactional:templates:use"],
			});
			await createTemplate(mailboxId, "t", "Test");

			const sendRes = await sendTransactional(mailboxId, `Bearer ${plaintextKey}`, "ik-fb-1", {
				template: "t",
				to: "a@b.com",
			});
			expect(sendRes.status).toBe(200);
			const requestId = sendRes.json.requestId as string;

			const fresh = await getStatus(mailboxId, plaintextKey, requestId);
			expect(fresh.status).toBe(200);
			expect(fresh.json.deliveryStatus).toBeNull();
			// Too early to judge the channel: an absence of evidence, said as one.
			const freshFeedback = fresh.json.deliveryFeedback as { state: string; reason: string };
			expect(freshFeedback.state).toBe("unobserved");
			expect(freshFeedback.reason).toContain("too early to tell");

			// Age the dispatch past the maturity window. Nothing else changes -- same
			// row, same null delivery_status, same 200.
			const stub = env.MAILBOX_DO.getByName(mailboxId);
			const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
			await runInDurableObject(stub, async (_instance, state) => {
				state.storage.sql.exec(
					"UPDATE transactional_requests SET created_at = ? WHERE request_id = ?",
					old,
					requestId,
				);
			});

			const matured = await getStatus(mailboxId, plaintextKey, requestId);
			expect(matured.json.deliveryStatus).toBeNull();
			const feedback = matured.json.deliveryFeedback as { state: string; reason: string };
			expect(feedback.state).toBe("never_observed");
			expect(feedback.reason).toContain("notify.example.com");
			expect(feedback.reason).toContain("describes the channel, not the message");
			// Additive only: everything a live consumer already reads is untouched.
			expect(matured.json.status).toBe("sent");
			expect(matured.json).toHaveProperty("resolvedVia");
		});
	});
});
