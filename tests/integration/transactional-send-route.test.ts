import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { mailboxStub } from "#/lib/mailbox-stub";
import worker from "#/server";
import { splitSqlStatements } from "../helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };
const env = testEnv as unknown as TestEnv;

/**
 * The From display name, observed at the provider call, through the public
 * `/v1/.../transactional/messages` route.
 *
 * The unit test for the key mapper proves `senderName` survives the read; this
 * proves the whole path — worker router → DO → handleTransactionalSend → EMAIL —
 * hands the provider `{ name, email }` rather than the bare address.
 *
 * How the provider call is observed: the Durable Object runs in the test isolate,
 * so `runInDurableObject` can swap that one instance's `env` for a proxy whose
 * EMAIL records what it is given. Every later request to the same mailbox name
 * (including the one the router makes) hits that same instance. Nothing else in
 * the send path is stubbed.
 */
async function applyD1Migrations(db: D1Database): Promise<void> {
	const migrations = [
		await import("../../migrations/d1/0001_initial.sql?raw"),
		await import("../../migrations/d1/0002_message_index.sql?raw"),
		await import("../../migrations/d1/0003_mailbox_owner.sql?raw"),
		await import("../../migrations/d1/0006_transactional_api_keys.sql?raw"),
		await import("../../migrations/d1/0007_transactional_requests.sql?raw"),
		await import("../../migrations/d1/0008_email_events_suppressions.sql?raw"),
		await import("../../migrations/d1/0015_transactional_resolved_via.sql?raw"),
	];
	for (const m of migrations) {
		for (const statement of splitSqlStatements(m.default as string)) {
			await db.prepare(statement).run();
		}
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.INDEX_DB);
});

async function doJson(mailboxId: string, path: string, body: unknown): Promise<Response> {
	return mailboxStub(env, mailboxId).fetch(`https://mailbox-do${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** Swap this DO instance's EMAIL binding for a recorder; returns the recorded calls. */
async function recordEmail(mailboxId: string): Promise<unknown[]> {
	const calls: unknown[] = [];
	await runInDurableObject(mailboxStub(env, mailboxId), (instance) => {
		const holder = instance as unknown as { env: Env };
		const original = holder.env;
		const fake = {
			send: async (message: unknown) => {
				calls.push(message);
				return { messageId: "<recorded@test>" };
			},
		};
		holder.env = new Proxy(original, {
			get: (target, prop) => (prop === "EMAIL" ? fake : Reflect.get(target, prop)),
		});
	});
	return calls;
}

async function sendViaRouter(
	mailboxId: string,
	plaintextKey: string,
	idempotencyKey: string,
	body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`http://localhost/v1/mailboxes/${mailboxId}/transactional/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${plaintextKey}`,
				"idempotency-key": idempotencyKey,
			},
			body: JSON.stringify(body),
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function liveKey(mailboxId: string, senderName?: string): Promise<string> {
	const created = await doJson(mailboxId, "/transactional/api-keys", {
		environment: "live",
		sender: "hola@send.transcribo.example",
		...(senderName ? { senderName } : {}),
		scopes: ["transactional:send", "transactional:templates:use"],
		templateAllowlist: ["welcome"],
	});
	expect(created.status).toBe(201);
	return ((await created.json()) as { plaintextKey: string }).plaintextKey;
}

async function welcomeTemplate(mailboxId: string): Promise<void> {
	const created = await doJson(mailboxId, "/transactional/templates", {
		id: "welcome",
		subject: "Hola {{name}}",
		body_text: "Bienvenido, {{name}}",
	});
	expect(created.status).toBe(201);
}

describe("POST /v1/mailboxes/:id/transactional/messages — From display name", () => {
	it("hands the provider { name, email } for a key with a senderName", async () => {
		const mailboxId = "mbx_route_sender_name";
		const plaintextKey = await liveKey(mailboxId, "Transcribo");
		await welcomeTemplate(mailboxId);
		const calls = await recordEmail(mailboxId);

		const result = await sendViaRouter(mailboxId, plaintextKey, "ik-route-name-1", {
			template: "welcome",
			to: "user@example.com",
			variables: { name: "Ana" },
		});
		expect(result.status).toBe(200);
		expect(result.json.status).toBe("sent");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			from: { name: "Transcribo", email: "hola@send.transcribo.example" },
			to: ["user@example.com"],
			subject: "Hola Ana",
		});
	});

	it("sends the bare address for a key without one", async () => {
		const mailboxId = "mbx_route_sender_bare";
		const plaintextKey = await liveKey(mailboxId);
		await welcomeTemplate(mailboxId);
		const calls = await recordEmail(mailboxId);

		const result = await sendViaRouter(mailboxId, plaintextKey, "ik-route-bare-1", {
			template: "welcome",
			to: "user@example.com",
			variables: { name: "Ana" },
		});
		expect(result.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect((calls[0] as { from: unknown }).from).toBe("hola@send.transcribo.example");
	});
});

async function statusViaRouter(
	mailboxId: string,
	plaintextKey: string,
	requestId: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`http://localhost/v1/mailboxes/${mailboxId}/transactional/messages/${requestId}`, {
			method: "GET",
			headers: { authorization: `Bearer ${plaintextKey}` },
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function statusKey(mailboxId: string): Promise<string> {
	const created = await doJson(mailboxId, "/transactional/api-keys", {
		environment: "live",
		sender: "hola@send.transcribo.example",
		scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
		templateAllowlist: ["welcome"],
	});
	expect(created.status).toBe(201);
	return ((await created.json()) as { plaintextKey: string }).plaintextKey;
}

/** Same key id and environment — both public — with a secret that was never issued. */
function withFabricatedSecret(plaintextKey: string): string {
	const [prefix, environment, keyId, secret] = plaintextKey.split("_") as [
		string,
		string,
		string,
		string,
	];
	const forged = secret.slice(0, -1) + (secret.endsWith("a") ? "b" : "a");
	return [prefix, environment, keyId, forged].join("_");
}

function keyIdOf(plaintextKey: string): string {
	return plaintextKey.split("_")[2]!;
}

async function sentRequest(mailboxId: string, plaintextKey: string, ik: string): Promise<string> {
	const sent = await sendViaRouter(mailboxId, plaintextKey, ik, {
		template: "welcome",
		to: "user@example.com",
		variables: { name: "Ana" },
	});
	expect(sent.status).toBe(200);
	return sent.json.requestId as string;
}

/** A mailbox with a status-scoped key, the welcome template and one sent request. */
async function mailboxWithSentRequest(
	mailboxId: string,
): Promise<{ key: string; requestId: string }> {
	const key = await statusKey(mailboxId);
	await welcomeTemplate(mailboxId);
	await recordEmail(mailboxId);
	const requestId = await sentRequest(mailboxId, key, `ik-${mailboxId}`);
	return { key, requestId };
}

describe("GET /v1/mailboxes/:id/transactional/messages/:requestId — key authentication", () => {
	it("answers a valid key with the status of its own request", async () => {
		const { key, requestId } = await mailboxWithSentRequest("mbx_status_auth_valid");
		const status = await statusViaRouter("mbx_status_auth_valid", key, requestId);
		expect(status.status).toBe(200);
		expect(status.json.status).toBe("sent");
		expect(status.json.requestId).toBe(requestId);
	});

	it("refuses a real key id carrying a fabricated secret", async () => {
		const mailboxId = "mbx_status_auth_forged";
		const { key, requestId } = await mailboxWithSentRequest(mailboxId);
		const forged = await statusViaRouter(mailboxId, withFabricatedSecret(key), requestId);
		expect(forged.status).toBe(403);
		expect(forged.json).toEqual({ error: "invalid_api_key" });
	});

	it("refuses an expired key", async () => {
		const mailboxId = "mbx_status_auth_expired";
		const { key, requestId } = await mailboxWithSentRequest(mailboxId);
		await runInDurableObject(mailboxStub(env, mailboxId), (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE api_keys SET expires_at = ? WHERE key_id = ?",
				"2020-01-01T00:00:00.000Z",
				keyIdOf(key),
			);
		});
		const expired = await statusViaRouter(mailboxId, key, requestId);
		expect(expired.status).toBe(403);
		expect(expired.json).toEqual({ error: "key_expired" });
	});

	it("refuses a revoked key", async () => {
		const mailboxId = "mbx_status_auth_revoked";
		const { key, requestId } = await mailboxWithSentRequest(mailboxId);
		const revoked = await doJson(mailboxId, `/transactional/api-keys/${keyIdOf(key)}/revoke`, {});
		expect(revoked.status).toBe(200);
		const status = await statusViaRouter(mailboxId, key, requestId);
		expect(status.status).toBe(403);
		expect(status.json).toEqual({ error: "key_revoked" });
	});

	it("does not reveal that a key is revoked to a caller without its secret", async () => {
		const mailboxId = "mbx_status_auth_revoked_forged";
		const { key, requestId } = await mailboxWithSentRequest(mailboxId);
		await doJson(mailboxId, `/transactional/api-keys/${keyIdOf(key)}/revoke`, {});
		const status = await statusViaRouter(mailboxId, withFabricatedSecret(key), requestId);
		expect(status.status).toBe(403);
		expect(status.json).toEqual({ error: "invalid_api_key" });
	});

	it("answers 404 for another key's request on the same mailbox", async () => {
		const mailboxId = "mbx_status_auth_cross_key";
		const { requestId } = await mailboxWithSentRequest(mailboxId);
		const other = await statusKey(mailboxId);
		const status = await statusViaRouter(mailboxId, other, requestId);
		expect(status.status).toBe(404);
		expect(status.json).toEqual({ error: "not_found" });
	});
});

/** Swap this DO instance's EMAIL binding for one that throws `error`; returns the attempt count. */
async function refuseEmail(mailboxId: string, error: Error): Promise<{ attempts: number }> {
	const counter = { attempts: 0 };
	await runInDurableObject(mailboxStub(env, mailboxId), (instance) => {
		const holder = instance as unknown as { env: Env };
		const original = holder.env;
		const fake = {
			send: async () => {
				counter.attempts += 1;
				throw error;
			},
		};
		holder.env = new Proxy(original, {
			get: (target, prop) => (prop === "EMAIL" ? fake : Reflect.get(target, prop)),
		});
	});
	return counter;
}

type RequestRow = {
	status: string;
	error_code: string | null;
	variables_json: string | null;
};

async function requestRow(mailboxId: string, requestId: string): Promise<RequestRow | undefined> {
	return runInDurableObject(mailboxStub(env, mailboxId), (_instance, state) => {
		return state.storage.sql
			.exec<RequestRow>(
				"SELECT status, error_code, variables_json FROM transactional_requests WHERE request_id = ?",
				requestId,
			)
			.toArray()[0];
	});
}

describe("POST /v1/mailboxes/:id/transactional/messages — definite provider refusal", () => {
	it("answers 502 permanent_failure, settles the row and replays the same result", async () => {
		const mailboxId = "mbx_route_permanent_failure";
		const key = await statusKey(mailboxId);
		await welcomeTemplate(mailboxId);
		// "rejected" is a non-delivery signal, so isAmbiguousProviderError says definite.
		const provider = await refuseEmail(mailboxId, new Error("550 5.1.1 recipient rejected"));
		const payload = { template: "welcome", to: "user@example.com", variables: { name: "Ana" } };

		const first = await sendViaRouter(mailboxId, key, "ik-permanent-1", payload);
		expect(first.status).toBe(502);
		expect(first.json).toMatchObject({
			status: "permanent_failure",
			keyId: keyIdOf(key),
			providerMessageId: null,
			error: "permanent_failure",
		});
		const requestId = first.json.requestId as string;
		expect(requestId).toMatch(/.+/);
		expect(provider.attempts).toBe(1);

		// Terminal, with the variables purged — they can carry live tokens.
		expect(await requestRow(mailboxId, requestId)).toEqual({
			status: "failed",
			error_code: "permanent_failure",
			variables_json: null,
		});

		// A replay answers the same terminal result, not 202, and does not resend.
		const replay = await sendViaRouter(mailboxId, key, "ik-permanent-1", payload);
		expect(replay.status).toBe(502);
		expect(replay.json).toMatchObject({ status: "permanent_failure", requestId });
		expect(provider.attempts).toBe(1);

		// The stale reconciler only looks at pending/sending rows; a settled one is not its business.
		const reconciled = await runInDurableObject(
			mailboxStub(env, mailboxId),
			async (_instance, state) => {
				const { reconcileStaleTransactionalRequests } = await import(
					"#/do/transactional-send-ops"
				);
				return reconcileStaleTransactionalRequests(state.storage.sql, "9999-12-31T00:00:00.000Z");
			},
		);
		expect(reconciled.reconciled).toBe(0);
		expect((await requestRow(mailboxId, requestId))?.status).toBe("failed");

		const status = await statusViaRouter(mailboxId, key, requestId);
		expect(status.status).toBe(200);
		expect(status.json).toMatchObject({ status: "failed", errorCode: "permanent_failure" });
	});
});
