import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { getApiKeyProjection, insertMailbox } from "#/db/d1";
import worker from "#/server";
import { splitSqlStatements } from "../helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };
const env = testEnv as unknown as TestEnv;

/**
 * The key-management routes end to end, through the worker's own router.
 *
 * The DO-level tests already prove keys are minted, rotated and revoked. What
 * they could not see was the API layer in between: it read the DO's JSON to
 * project it into D1 and then returned the already-read Response, so every
 * successful create answered 500 after the key was stored -- and the one-time
 * plaintext secret went with it. The projection it wrote was also keyed on
 * snake_case fields the DO never sends, so the D1 row was never written.
 */
async function applyD1Migrations(db: D1Database): Promise<void> {
	const m1 = await import("../../migrations/d1/0001_initial.sql?raw");
	const m2 = await import("../../migrations/d1/0002_message_index.sql?raw");
	const m3 = await import("../../migrations/d1/0003_mailbox_owner.sql?raw");
	const m6 = await import("../../migrations/d1/0006_transactional_api_keys.sql?raw");
	for (const raw of [m1.default, m2.default, m3.default, m6.default]) {
		for (const statement of splitSqlStatements(raw as string)) {
			await db.prepare(statement).run();
		}
	}
}

beforeAll(async () => {
	await applyD1Migrations(env.INDEX_DB);
});

async function call(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
		env,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("transactional API key routes", () => {
	it(
		"return the plaintext key on create and rotate, and keep the D1 projection in step",
		{ timeout: 20_000 },
		async () => {
			const mailboxId = "mbx_key_routes";
			// Owned by the localhost dev-bypass identity so the ownership gate passes.
			await insertMailbox(env.INDEX_DB, {
				mailbox_id: mailboxId,
				primary_address: "keys@routes.example",
				display_name: null,
				status: "active",
				owner_email: "dev@local",
			});
			const base = `/api/mailboxes/${mailboxId}/transactional/api-keys`;

			const created = await call("POST", base, {
				environment: "live",
				sender: "hola@send.routes.example",
				scopes: ["transactional:send", "transactional:templates:use", "transactional:status"],
				templateAllowlist: ["magic-link"],
				recipientPolicy: "@routes.example",
				quotaMax: 50,
			});
			expect(created.status).toBe(201);
			expect(created.body.plaintextKey).toMatch(/^rck_live_/);
			const keyId = (created.body.key as { keyId: string }).keyId;

			const projected = await getApiKeyProjection(env.INDEX_DB, keyId);
			expect(projected).toMatchObject({
				key_id: keyId,
				mailbox_id: mailboxId,
				sender: "hola@send.routes.example",
				environment: "live",
				recipient_policy: "@routes.example",
				quota_max: 50,
				status: "active",
			});

			const renamed = await call("PATCH", `${base}/${keyId}`, { senderName: "Routes" });
			expect(renamed.status).toBe(200);

			const rotated = await call("POST", `${base}/${keyId}/rotate`);
			expect(rotated.status).toBe(200);
			expect(rotated.body.plaintextKey).toMatch(/^rck_live_/);
			const newKeyId = (rotated.body.key as { keyId: string }).keyId;
			expect((await getApiKeyProjection(env.INDEX_DB, keyId))?.status).toBe("revoked");
			expect((await getApiKeyProjection(env.INDEX_DB, newKeyId))?.status).toBe("active");

			const revoked = await call("POST", `${base}/${newKeyId}/revoke`);
			expect(revoked.status).toBe(200);
			expect((await getApiKeyProjection(env.INDEX_DB, newKeyId))?.status).toBe("revoked");
		},
	);
});
