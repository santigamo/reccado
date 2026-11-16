import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "../../src/cloudflare/types";
import { sha256Hex } from "../../src/lib/crypto";
import { authMailHeader } from "../../src/lib/auth-mail";
import { rawEmailR2Key } from "../../src/lib/r2-keys";
import { ingestInboundEmail } from "../../src/do/mailbox-ingest";
import { McpMailboxFacade } from "../../src/mcp/mailbox-facade";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationApproval from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const testEnv = env as unknown as Env;
const base = { userId: "dev-local", email: "dev@local", local: true };
const plain = new McpMailboxFacade(testEnv, {
	...base,
	scopes: new Set(["mail:read", "mail:draft"]),
});
const sensitive = new McpMailboxFacade(testEnv, {
	...base,
	scopes: new Set(["mail:read", "mail:draft", "mail:read:sensitive"]),
});
const AUTH_SENDER = (testEnv.MAIL_FROM_ADDRESS ?? "noreply@mail.example.com").toLowerCase();
const SECRET = "k".repeat(40);

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
		.bind(id, `${id}@example.com`, base.email, now, now)
		.run();
	return id;
}

async function ingest(
	id: string,
	input: {
		from: string;
		subject: string;
		body: string;
		extraHeaders?: string;
		authSecret?: string;
	},
) {
	const raw = new TextEncoder().encode(
		`From: ${input.from}\r\nTo: owner@example.com\r\nSubject: ${input.subject}\r\nMessage-ID: <${crypto.randomUUID()}@t>\r\n${input.extraHeaders ?? ""}Content-Type: text/plain\r\n\r\n${input.body}`,
	);
	const rawSha256 = await sha256Hex(raw);
	const rawR2Key = rawEmailR2Key({ mailboxId: id, receivedAt: new Date(), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, raw);
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: new Date().toISOString(),
		receivedAt: new Date().toISOString(),
		mailboxId: id,
		domain: "example.com",
		recipient: "owner@example.com",
		sender: input.from,
		rawR2Key,
		rawSha256,
		rawSize: raw.byteLength,
		messageId: null,
		headers: { subject: input.subject, date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: "owner@example.com" },
		idempotencyKey: crypto.randomUUID(),
	};
	const stub = testEnv.MAILBOX_DO.getByName(id);
	return runInDurableObject(stub, async (_i, state) => {
		const result = await ingestInboundEmail(
			{
				sql: state.storage.sql,
				r2: testEnv.MAIL_OBJECTS,
				mailboxId: id,
				transactionSync: (fn) => state.storage.transactionSync(fn),
				authMail: {
					BETTER_AUTH_SECRET: input.authSecret ?? SECRET,
					MAIL_FROM_ADDRESS: testEnv.MAIL_FROM_ADDRESS,
				},
			},
			message,
		);
		const row = state.storage.sql
			.exec<{ sensitive_kind: string | null; thread_id: string }>(
				"SELECT sensitive_kind, thread_id FROM messages WHERE id = ?",
				result.messageLocalId,
			)
			.toArray()[0];
		return {
			id: result.messageLocalId,
			threadId: row?.thread_id ?? "",
			kind: row?.sensitive_kind ?? null,
		};
	});
}

describe("instance authentication mail is invisible to MCP", () => {
	it("hides marker-only mail (foreign sender) at ingest in every read path, even with sensitive scope", async () => {
		const id = await mailbox();
		const header = (await authMailHeader({ BETTER_AUTH_SECRET: SECRET }, "owner@example.com"))[
			"X-Reccado-Auth"
		];
		const hidden = await ingest(id, {
			from: "relay@elsewhere.test",
			subject: "zebratoken sign-in",
			body: "Sign-in code: 654321 zebratoken",
			extraHeaders: `X-Reccado-Auth: ${header}\r\n`,
		});
		expect(hidden.kind).toBe("instance_auth");
		await expectInvisible(id, hidden, "zebratoken");
	});

	it("hides sender-only mail (no marker)", async () => {
		const id = await mailbox();
		const hidden = await ingest(id, {
			from: AUTH_SENDER,
			subject: "quokkacode",
			body: "quokkacode 111222",
		});
		expect(hidden.kind).toBe("instance_auth");
		await expectInvisible(id, hidden, "quokkacode");
	});

	it("hides legacy rows ingested before classification, by sender", async () => {
		const id = await mailbox();
		const stub = testEnv.MAILBOX_DO.getByName(id);
		const mid = crypto.randomUUID();
		const now = new Date().toISOString();
		await testEnv.MAIL_OBJECTS.put(`legacy/${mid}`, "x");
		await runInDurableObject(stub, async (_i, state) => {
			state.storage.sql.exec(
				"INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at) VALUES ('t', 's', ?, 1, 1, ?, ?)",
				now,
				now,
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO messages (id, idempotency_key, thread_id, direction, state, from_addr, to_json, cc_json, bcc_json, subject, received_at, raw_r2_key, raw_sha256, raw_size, body_text, sensitive_classified, parse_status, has_attachments, is_read, created_at, updated_at) VALUES (?, ?, 't', 'inbound', 'inbox', ?, '[]', '[]', '[]', 'legacyword', ?, ?, ?, 1, 'legacyword 999888', 0, 'parsed', 0, 0, ?, ?)",
				mid,
				mid,
				AUTH_SENDER,
				now,
				`legacy/${mid}`,
				mid,
				now,
				now,
			);
			state.storage.sql.exec(
				"INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text) VALUES (?, 'legacyword', ?, '[]', '', 'legacyword 999888')",
				mid,
				AUTH_SENDER,
			);
		});
		await expectInvisible(id, { id: mid, threadId: "t" }, "legacyword");
	});

	it("keeps a normal mail visible next to hidden auth mail", async () => {
		const id = await mailbox();
		const normal = await ingest(id, {
			from: "friend@example.org",
			subject: "lunch",
			body: "lunch at noon, giraffeword",
		});
		await ingest(id, { from: AUTH_SENDER, subject: "code", body: "code 123123" });
		const threads = await plain.listThreads(id, 20);
		expect(threads.map((t) => t.id)).toEqual([normal.threadId]);
		expect((await plain.searchMessages(id, "giraffeword", 10)).length).toBe(1);
	});
});

async function expectInvisible(id: string, m: { id: string; threadId: string }, word: string) {
	for (const facade of [plain, sensitive]) {
		expect(await facade.listThreads(id, 20)).toEqual([]);
		await expect(facade.readThread(id, m.threadId)).rejects.toThrow("not_found");
		await expect(facade.readMessage(id, m.id)).rejects.toThrow("not_found");
		expect(await facade.searchMessages(id, word, 10)).toEqual([]);
		await expect(facade.readResource(id, m.id)).rejects.toThrow("not_found");
		await expect(facade.updateMessages(id, [m.id], "trash")).rejects.toThrow("not_found");
	}
}

describe("search is not an oracle for sensitive bodies (P2)", () => {
	it("matches sensitive messages on subject only without the sensitive scope", async () => {
		const id = await mailbox();
		const m = await ingest(id, {
			from: "security@bank.test",
			subject: "Your verification code",
			body: "Your verification code is 482913 platypusbody",
		});
		expect(m.kind).toBe("otp");
		expect(await plain.searchMessages(id, "482913", 10)).toEqual([]);
		expect(await plain.searchMessages(id, "platypusbody", 10)).toEqual([]);
		expect((await plain.searchMessages(id, "verification", 10)).length).toBe(1);
		expect((await sensitive.searchMessages(id, "482913", 10)).length).toBe(1);
	});
});

describe("readResource fails closed", () => {
	it("needs sensitive scope for unclassified and parse-failed rows", async () => {
		const id = await mailbox();
		const stub = testEnv.MAILBOX_DO.getByName(id);
		const now = new Date().toISOString();
		const insert = (mid: string, classified: number, status: string) =>
			runInDurableObject(stub, async (_i, state) => {
				state.storage.sql.exec(
					"INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at) VALUES ('t', 's', ?, 1, 1, ?, ?)",
					now,
					now,
					now,
				);
				state.storage.sql.exec(
					"INSERT INTO messages (id, idempotency_key, thread_id, direction, state, from_addr, to_json, cc_json, bcc_json, subject, received_at, raw_r2_key, raw_sha256, raw_size, body_text, sensitive_classified, parse_status, has_attachments, is_read, created_at, updated_at) VALUES (?, ?, 't', 'inbound', 'inbox', 'a@b.test', '[]', '[]', '[]', 'hello', ?, ?, ?, 1, 'hello', ?, ?, 0, 0, ?, ?)",
					mid,
					mid,
					now,
					`r/${mid}`,
					mid,
					classified,
					status,
					now,
					now,
				);
			});
		const failed = crypto.randomUUID();
		const unclassified = crypto.randomUUID();
		const clean = crypto.randomUUID();
		for (const [mid, c, st] of [
			[failed, 1, "failed"],
			[unclassified, 0, "parsed"],
			[clean, 1, "parsed"],
		] as const) {
			await testEnv.MAIL_OBJECTS.put(`r/${mid}`, "raw");
			await insert(mid, c, st);
		}
		await expect(plain.readResource(id, failed)).rejects.toThrow("insufficient_scope");
		await expect(plain.readResource(id, unclassified)).rejects.toThrow("insufficient_scope");
		expect((await plain.readResource(id, clean)).mimeType).toBe("message/rfc822");
		expect((await sensitive.readResource(id, failed)).blob).toBeTruthy();
	});
});

describe("draft ownership (L2)", () => {
	it("refuses to update or cancel drafts not created over MCP", async () => {
		const id = await mailbox();
		const stub = testEnv.MAILBOX_DO.getByName(id);
		const human = await stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: ["a@example.com"],
				subject: "mine",
				bodyText: "b",
				idempotencyKey: crypto.randomUUID(),
			}),
		});
		const { id: draftId } = (await human.json()) as { id: string };
		await expect(
			plain.updateDraft(id, draftId, { to: ["z@example.com"], subject: "x", bodyText: "y" }),
		).rejects.toThrow("draft_not_agent_owned");
		await expect(plain.cancelDraft(id, draftId)).rejects.toThrow("draft_not_agent_owned");
		const own = await plain.createDraft(id, {
			to: ["z@example.com"],
			subject: "agent",
			bodyText: "b",
			idempotencyKey: crypto.randomUUID(),
		});
		await plain.updateDraft(id, own.draft_id, {
			to: ["z@example.com"],
			subject: "agent2",
			bodyText: "b",
		});
		expect(await plain.cancelDraft(id, own.draft_id)).toMatchObject({ status: "cancelled" });
	});
});
