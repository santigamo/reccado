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
