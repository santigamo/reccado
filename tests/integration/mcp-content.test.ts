import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { McpMailboxFacade } from "../../src/mcp/mailbox-facade";
import worker from "../../src/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationApproval from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const testEnv = env as unknown as Env;
const owner = {
	userId: "dev-local",
	email: "dev@local",
	local: true,
	scopes: new Set(["mail:read", "mail:draft"]),
};
beforeAll(async () =>
	applyMigrations(
		testEnv.INDEX_DB,
		migrationInitial as string,
		migrationIndex as string,
		migrationOwner as string,
		migrationApproval as string,
		migrationRegistry as string,
		migrationAudit as string,
	),
);

async function mailbox() {
	const id = `mbx_${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, 'active', ?, ?, ?)",
	)
		.bind(id, `${id}@example.com`, owner.email, now, now)
		.run();
	return id;
}

describe("MCP content facade", () => {
	it.each([
		"Your code is 123456",
		"Tu código es 123456",
		"Reset your password https://example.com/reset?token=secret",
	])("redacts sensitive content and gates raw bytes: %s", async (body) => {
		const id = await mailbox();
		const stub = testEnv.MAILBOX_DO.getByName(id);
		const messageId = crypto.randomUUID();
		const now = new Date().toISOString();
		const key = `test/${messageId}`;
		await testEnv.MAIL_OBJECTS.put(key, body);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				"INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at) VALUES ('thread', 'security', ?, 1, 1, ?, ?)",
				now,
				now,
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO messages (id, idempotency_key, thread_id, direction, state, from_addr, to_json, cc_json, bcc_json, subject, received_at, raw_r2_key, raw_sha256, raw_size, body_text, sensitive_classified, parse_status, has_attachments, is_read, created_at, updated_at) VALUES (?, ?, 'thread', 'inbound', 'inbox', 'security@example.com', '[]', '[]', '[]', 'Security', ?, ?, ?, ?, ?, 0, 'parsed', 0, 0, ?, ?)",
				messageId,
				messageId,
				now,
				key,
				messageId,
				body.length,
				body,
				now,
				now,
			);
		});
		const facade = new McpMailboxFacade(testEnv, owner);
		const message = await facade.readMessage(id, messageId);
		expect(message.redacted).toBe(true);
		expect(message.body_text).not.toContain("123456");
		expect(message.body_text).not.toContain("token=secret");
		await expect(facade.readResource(id, messageId)).rejects.toThrow(
			"insufficient_scope: mail:read:sensitive",
		);
		const sensitive = new McpMailboxFacade(testEnv, {
			...owner,
			scopes: new Set([...owner.scopes, "mail:read:sensitive"]),
		});
		expect((await sensitive.readMessage(id, messageId)).body_text).toBe(body);
		expect(new TextDecoder().decode(Uint8Array.from(atob((await sensitive.readResource(id, messageId)).blob), (c) => c.charCodeAt(0)))).toBe(body);
		await expect(
			new McpMailboxFacade(testEnv, { ...owner, email: "other@example.com" }).readMessage(
				id,
				messageId,
			),
		).rejects.toThrow("not_found");
	});

	it("blocks web confirmation for an MCP-created draft", async () => {
		const id = await mailbox();
		const facade = new McpMailboxFacade(testEnv, owner);
		const draft = await facade.createDraft(id, {
			to: ["recipient@example.com"],
			subject: "Hello",
			bodyText: "Body",
			idempotencyKey: crypto.randomUUID(),
		});
		const ctx = createExecutionContext();
		const call = async (suffix: string, body: object) =>
			worker.fetch(
				new Request(`http://localhost/api/mailboxes/${id}/drafts/${draft.draft_id}/${suffix}`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				}),
				testEnv,
				ctx,
			);
		expect((await call("request-send", {})).ok).toBe(true);
		const response = await call("confirm-send", { idempotencyKey: crypto.randomUUID() });
		expect(await response.json()).toMatchObject({ error: "approval_required" });
		await waitOnExecutionContext(ctx);
	});
});
