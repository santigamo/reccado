import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertMailbox } from "#/db/d1";
import { mailboxStub } from "#/lib/mailbox-stub";
import worker from "#/server";
import { splitSqlStatements } from "../helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };
const env = testEnv as unknown as TestEnv;

/**
 * PUT /api/mailboxes/:id/transactional/templates end to end, through the
 * worker's own router: a product that owns its templates in a file re-sends the
 * whole list on every deploy and must get the same answer twice.
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

async function ownedMailbox(mailboxId: string, owner = "dev@local"): Promise<string> {
	// Owned by the localhost dev-bypass identity so the ownership gate passes.
	await insertMailbox(env.INDEX_DB, {
		mailbox_id: mailboxId,
		primary_address: `${mailboxId}@sync.example`,
		display_name: null,
		status: "active",
		owner_email: owner,
	});
	return `/api/mailboxes/${mailboxId}/transactional/templates`;
}

type Row = { id: string; subject: string; body_text: string | null; body_html: string | null };

async function listTemplates(base: string): Promise<Row[]> {
	const listed = await call("GET", base);
	expect(listed.status).toBe(200);
	return (listed.body.templates as Row[]).sort((a, b) => a.id.localeCompare(b.id));
}

const WELCOME = { id: "welcome", subject: "Welcome, {{name}}", body_text: "Hi {{name}}" };
const MAGIC = {
	id: "magic-link",
	subject: "Your sign-in link",
	body_text: "Open {{url}}",
	body_html: "<a href='{{url}}'>Sign in</a>",
};

describe("PUT /api/mailboxes/:id/transactional/templates", () => {
	it("creates, then is a no-op on rerun, then updates only what changed", async () => {
		const base = await ownedMailbox("mbx_sync_cycle");

		const first = await call("PUT", base, { templates: [WELCOME, MAGIC] });
		expect(first.status).toBe(200);
		expect(first.body.results).toEqual([
			{ id: "welcome", outcome: "created" },
			{ id: "magic-link", outcome: "created" },
		]);
		expect(first.body.summary).toEqual({ created: 2, updated: 0, unchanged: 0, archived: 0 });

		const rerun = await call("PUT", base, { templates: [WELCOME, MAGIC] });
		expect(rerun.status).toBe(200);
		expect(rerun.body.results).toEqual([
			{ id: "welcome", outcome: "unchanged" },
			{ id: "magic-link", outcome: "unchanged" },
		]);

		const modified = await call("PUT", base, {
			templates: [WELCOME, { ...MAGIC, subject: "Your new sign-in link" }],
		});
		expect(modified.status).toBe(200);
		expect(modified.body.results).toEqual([
			{ id: "welcome", outcome: "unchanged" },
			{ id: "magic-link", outcome: "updated" },
		]);
		const rows = await listTemplates(base);
		expect(rows.find((r) => r.id === "magic-link")?.subject).toBe("Your new sign-in link");
		expect(rows.find((r) => r.id === "magic-link")?.body_html).toBe(MAGIC.body_html);

		// Omitting a body part is part of the desired state: it clears it.
		const cleared = await call("PUT", base, {
			templates: [WELCOME, { id: MAGIC.id, subject: "Your new sign-in link", body_text: "x" }],
		});
		expect(cleared.body.results).toContainEqual({ id: "magic-link", outcome: "updated" });
		expect((await listTemplates(base)).find((r) => r.id === "magic-link")?.body_html).toBeNull();
	});

	it("changes nothing when one entry in the batch is invalid", async () => {
		const base = await ownedMailbox("mbx_sync_atomic");
		expect((await call("PUT", base, { templates: [WELCOME] })).status).toBe(200);

		const bad = await call("PUT", base, {
			templates: [
				{ ...WELCOME, subject: "Changed" },
				MAGIC,
				{ id: "bad", subject: "Injected\r\nBcc: x@y.com" },
			],
		});
		expect(bad.status).toBe(400);
		expect(bad.body).toMatchObject({ error: "subject_contains_newline", index: 2, id: "bad" });

		const badId = await call("PUT", base, {
			templates: [MAGIC, { id: "../escape", subject: "x" }],
		});
		expect(badId.status).toBe(400);
		expect(badId.body).toMatchObject({ error: "invalid_template_id", index: 1 });

		const rows = await listTemplates(base);
		expect(rows.map((r) => r.id)).toEqual(["welcome"]);
		expect(rows[0]?.subject).toBe(WELCOME.subject);
	});

	it("rolls back earlier writes when a write fails mid-batch", async () => {
		const mailboxId = "mbx_sync_rollback";
		const base = await ownedMailbox(mailboxId);
		// A row whose id collides but belongs to no mailbox this DO serves: it passes
		// validation (the sync does not see it) and then fails the INSERT — after the
		// first entry has already been written inside the same transaction.
		await runInDurableObject(mailboxStub(env, mailboxId), (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO templates (id, mailbox_id, subject, status, created_at, updated_at)
				 VALUES ('collides', 'mbx_other', 's', 'active', '2026-01-01', '2026-01-01')`,
			);
		});
		const failed = await call("PUT", base, {
			templates: [WELCOME, { id: "collides", subject: "x" }],
		});
		expect(failed.status).toBe(409);
		expect(await listTemplates(base)).toEqual([]);
	});

	it("rejects duplicate ids and an oversized batch before writing", async () => {
		const base = await ownedMailbox("mbx_sync_limits");
		const dup = await call("PUT", base, { templates: [WELCOME, MAGIC, WELCOME] });
		expect(dup.status).toBe(400);
		expect(dup.body.error).toBe("validation_error");

		const tooMany = await call("PUT", base, {
			templates: Array.from({ length: 101 }, (_, i) => ({ id: `t${i}`, subject: "s" })),
		});
		expect(tooMany.status).toBe(400);
		expect(await listTemplates(base)).toEqual([]);
	});

	it("archives missing templates only when archiveMissing is true", async () => {
		const base = await ownedMailbox("mbx_sync_archive");
		await call("PUT", base, { templates: [WELCOME, MAGIC] });

		// Default: a template left out of the list is left alone.
		const partial = await call("PUT", base, { templates: [WELCOME] });
		expect(partial.body.results).toEqual([{ id: "welcome", outcome: "unchanged" }]);
		expect((await listTemplates(base)).map((r) => r.id)).toEqual(["magic-link", "welcome"]);

		const pruned = await call("PUT", base, { templates: [WELCOME], archiveMissing: true });
		expect(pruned.status).toBe(200);
		expect(pruned.body.results).toEqual([
			{ id: "welcome", outcome: "unchanged" },
			{ id: "magic-link", outcome: "archived", reason: "missing_from_sync" },
		]);
		expect((await listTemplates(base)).map((r) => r.id)).toEqual(["welcome"]);

		// Listing an archived id again reports it and does not revive or rewrite it.
		const revived = await call("PUT", base, {
			templates: [WELCOME, { ...MAGIC, subject: "Back?" }],
		});
		expect(revived.status).toBe(200);
		expect(revived.body.results).toEqual([
			{ id: "welcome", outcome: "unchanged" },
			{ id: "magic-link", outcome: "archived", reason: "already_archived" },
		]);
		expect((await listTemplates(base)).map((r) => r.id)).toEqual(["welcome"]);
	});

	it("refuses a mailbox the caller does not own", async () => {
		const base = await ownedMailbox("mbx_sync_foreign", "someone-else@example.com");
		const denied = await call("PUT", base, { templates: [WELCOME] });
		expect(denied.status).toBe(403);
	});

	// The per-id routes used to stop at "is an owner of this deployment"; they now
	// require the mailbox's owner_email too, like the key routes and the sync route.
	it("refuses the per-id template routes on a mailbox the caller does not own", async () => {
		const base = await ownedMailbox("mbx_tpl_foreign", "someone-else@example.com");
		const attempts = [
			await call("POST", base, WELCOME),
			await call("GET", base),
			await call("PUT", `${base}/welcome`, { subject: "Hijacked" }),
			await call("POST", `${base}/welcome/archive`),
		];
		expect(attempts.map((a) => a.status)).toEqual([403, 403, 403, 403]);
	});

	it("still serves the per-id template routes to the mailbox owner", async () => {
		const base = await ownedMailbox("mbx_tpl_owned");
		expect((await call("POST", base, WELCOME)).status).toBe(201);
		expect((await call("GET", base)).status).toBe(200);
		expect((await call("PUT", `${base}/welcome`, { subject: "Revised" })).status).toBe(200);
		expect((await call("POST", `${base}/welcome/archive`)).status).toBe(200);
	});
});
