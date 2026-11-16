import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage, MailboxIngestResult } from "#/cloudflare/types";
import { upsertMessageIndex } from "#/db/d1";
import { confirmSendDraft } from "#/do/mailbox-do";
import { PURGE_BATCH_MESSAGES } from "#/do/mailbox-purge";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationTelegramExperience from "../../migrations/d1/0014_telegram_experience.sql?raw";
import controlPlaneRegistrySource from "../../src/lib/control-plane-registry.ts?raw";
import adminToolsSource from "../../src/mcp/admin-tools.ts?raw";
import facadeSource from "../../src/mcp/mailbox-facade.ts?raw";
import toolsSource from "../../src/mcp/tools.ts?raw";
import { applyMigrations } from "../helpers/migrations";

/**
 * Permanent deletion ("Delete forever", "Empty trash"), end to end: only from
 * the Trash, what goes from the DO / R2 / D1, the R2 objects that must survive
 * because something else still points at them, thread bookkeeping, resuming
 * after R2 and D1 failures, bounded batches, the owner-only gate, and a
 * re-delivered copy of a deleted email staying deleted.
 */

type TestEnv = Env & { MAIL_OBJECTS: R2Bucket; INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyMigrations(
		testEnv.INDEX_DB,
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
		migrationTelegram,
		migrationTelegramExperience,
	);
});

async function fetchWorker(request: Request, workerEnv: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, workerEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function newMailbox(): Promise<string> {
	const mailboxId = `mbx_purge_${crypto.randomUUID().slice(0, 8)}`;
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	)
		.bind(mailboxId, `${mailboxId}@example.com`, null, "active", "dev@local", now, now)
		.run();
	return mailboxId;
}

function api(mailboxId: string, path: string, init?: RequestInit): Promise<Response> {
	return fetchWorker(new Request(`http://localhost/api/mailboxes/${mailboxId}${path}`, init));
}

function postJson(mailboxId: string, path: string, body: unknown): Promise<Response> {
	return api(mailboxId, path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

type PurgeOp = {
	operationId: string;
	status: "running" | "done";
	requested: number;
	deleted: number;
	conversations: number;
	conversationsRemoved: number;
	remaining: number;
};

async function purge(mailboxId: string, body: unknown): Promise<PurgeOp> {
	const response = await postJson(mailboxId, "/purge", body);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await response.json()) as PurgeOp;
}

function trash(mailboxId: string, messageIds: string[]) {
	return postJson(mailboxId, "/bulk-actions", { action: "trash", messageIds });
}

function sql<T>(mailboxId: string, fn: (s: SqlStorage) => T): Promise<T> {
	return runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), (_i, state) =>
		fn(state.storage.sql),
	);
}

function count(mailboxId: string, query: string, ...params: SqlStorageValue[]): Promise<number> {
	return sql(
		mailboxId,
		(s) => s.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM (${query})`, ...params).one().n,
	);
}

async function exists(key: string): Promise<boolean> {
	return (await testEnv.MAIL_OBJECTS.head(key)) !== null;
}

/** Run every pending mailbox job now (and the next purge batch), as the alarm would. */
async function runAlarm(mailboxId: string): Promise<void> {
	await sql(mailboxId, (s) =>
		s.exec(
			"UPDATE jobs SET next_run_at = ? WHERE status = 'pending'",
			new Date(Date.now() - 1000).toISOString(),
		),
	);
	await testEnv.MAILBOX_DO.getByName(mailboxId).fetch("https://mailbox-do/alarm", {
		method: "POST",
	});
}

function mime(input: {
	messageId: string;
	subject: string;
	inReplyTo?: string;
	attachment?: string;
}): string {
	const lines = [
		"From: Ana Ruiz <ana@example.net>",
		"To: box@example.com",
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		...(input.inReplyTo
			? [`In-Reply-To: <${input.inReplyTo}>`, `References: <${input.inReplyTo}>`]
			: []),
		"Date: Mon, 16 Nov 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b1"',
		"",
		"--b1",
		'Content-Type: multipart/alternative; boundary="b2"',
		"",
		"--b2",
		"Content-Type: text/plain; charset=utf-8",
		"",
		`Body of ${input.subject}`,
		"--b2",
		"Content-Type: text/html; charset=utf-8",
		"",
		`<p>Body of ${input.subject}</p>`,
		"--b2--",
		...(input.attachment
			? [
					"--b1",
					`Content-Type: text/plain; name="${input.attachment}"`,
					`Content-Disposition: attachment; filename="${input.attachment}"`,
					"",
					`Contents of ${input.attachment} in ${input.messageId}`,
				]
			: []),
		"--b1--",
		"",
	];
	return lines.join("\r\n");
}

type Ingested = MailboxIngestResult & { rawR2Key: string };

async function ingest(
	mailboxId: string,
	input: {
		messageId: string;
		subject?: string;
		inReplyTo?: string;
		attachment?: string;
		receivedAt?: string;
		/** Reuse an existing raw object (a duplicate/conflict delivery). */
		rawR2Key?: string;
	},
): Promise<Ingested> {
	const subject = input.subject ?? "Hello";
	const rawBytes = new TextEncoder().encode(mime({ ...input, subject }));
	const rawSha256 = await sha256Hex(rawBytes);
	const receivedAt = input.receivedAt ?? new Date().toISOString();
	const rawR2Key =
		input.rawR2Key ??
		rawEmailR2Key({
			mailboxId,
			receivedAt: new Date(receivedAt),
			rawSha256: `${rawSha256}${crypto.randomUUID().slice(0, 4)}`,
		});
	if (!input.rawR2Key) await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: receivedAt,
		receivedAt,
		mailboxId,
		domain: "example.com",
		recipient: "box@example.com",
		sender: "ana@example.net",
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId: input.messageId,
		headers: {
			subject,
			date: null,
			inReplyTo: input.inReplyTo ?? null,
			references: input.inReplyTo ? [input.inReplyTo] : [],
		},
		routing: { ruleId: null, action: "store", matchedAlias: "box@example.com" },
		idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId: input.messageId, rawSha256 }),
	};
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		"https://mailbox-do/ingest",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		},
	);
	expect(response.status).toBe(200);
	return { ...((await response.json()) as MailboxIngestResult), rawR2Key };
}

type StoredMessage = {
	id: string;
	thread_id: string;
	raw_r2_key: string;
	body_html_r2_key: string | null;
	attachments: Array<{ id: string; r2_key: string }>;
};

async function stored(mailboxId: string, messageId: string): Promise<StoredMessage> {
	const response = await api(mailboxId, `/messages/${messageId}`);
	return ((await response.json()) as { message: StoredMessage }).message;
}

function keysOf(message: StoredMessage): string[] {
	return [
		message.raw_r2_key,
		...(message.body_html_r2_key ? [message.body_html_r2_key] : []),
		...message.attachments.map((a) => a.r2_key),
	];
}

type Sent = { attachments?: unknown[] };

function confirm(mailboxId: string, draftId: string, key: string) {
	return runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (_i, state) =>
		confirmSendDraft(
			{
				sql: state.storage.sql,
				transactionSync: (fn) => state.storage.transactionSync(fn),
				email: {
					send: async (_mail: Sent) => ({ messageId: `<${crypto.randomUUID()}@cloudflare.email>` }),
				} as unknown as Env["EMAIL"],
				fromAddress: `${mailboxId}@example.com`,
				replyToAddress: null,
				r2: testEnv.MAIL_OBJECTS,
				mailboxId,
			},
			draftId,
			key,
		),
	);
}

async function createDraft(mailboxId: string): Promise<string> {
	const response = await postJson(mailboxId, "/drafts", {
		to: ["client@example.net"],
		subject: "Fwd: files",
		bodyText: "See attached.",
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

async function forwardInto(mailboxId: string, draftId: string, messageId: string) {
	const response = await postJson(mailboxId, `/drafts/${draftId}/attachments/from-message`, {
		messageId,
	});
	expect(response.status).toBe(200);
	return ((await response.json()) as { added: Array<{ id: string }> }).added;
}

describe("Delete forever only works on the Trash", () => {
	it("refuses messages and conversations that are not in the Trash, and deletes nothing", async () => {
		const mailboxId = await newMailbox();
		const m = await ingest(mailboxId, { messageId: `inbox-${crypto.randomUUID()}@x` });

		for (const body of [{ messageIds: [m.messageLocalId] }, { threadIds: [m.threadId] }]) {
			const response = await postJson(mailboxId, "/purge", body);
			expect(response.status).toBe(409);
			expect(((await response.json()) as { error: string }).error).toBe("not_in_trash");
		}
		// Empty trash with nothing in it is a no-op, not an error.
		const empty = await purge(mailboxId, { emptyTrash: true });
		expect(empty).toMatchObject({ status: "done", requested: 0, deleted: 0 });

		expect(await count(mailboxId, "SELECT id FROM messages")).toBe(1);
		for (const key of keysOf(await stored(mailboxId, m.messageLocalId)))
			expect(await exists(key)).toBe(true);
	});

	it("refuses the whole request when any explicit message is outside the Trash", async () => {
		const mailboxId = await newMailbox();
		const a = await ingest(mailboxId, { messageId: `a-${crypto.randomUUID()}@x` });
		const b = await ingest(mailboxId, { messageId: `b-${crypto.randomUUID()}@x` });
		await trash(mailboxId, [a.messageLocalId]);
		const response = await postJson(mailboxId, "/purge", {
			messageIds: [a.messageLocalId, b.messageLocalId],
		});
		expect(response.status).toBe(409);
		expect(await count(mailboxId, "SELECT id FROM messages")).toBe(2);
	});
});

describe("what a permanent delete removes", () => {
	it("removes the DO rows, the R2 objects and the D1 rows, and keeps a tombstone in the ledger", async () => {
		const mailboxId = await newMailbox();
		const m = await ingest(mailboxId, {
			messageId: `full-${crypto.randomUUID()}@x`,
			subject: "Secret plans",
			attachment: "plan.txt",
		});
		const before = await stored(mailboxId, m.messageLocalId);
		const keys = keysOf(before);
		expect(keys).toHaveLength(3); // raw, html body, attachment
		for (const key of keys) expect(await exists(key)).toBe(true);

		// The D1 projections keyed by this message.
		await upsertMessageIndex(testEnv.INDEX_DB, {
			mailbox_id: mailboxId,
			message_local_id: m.messageLocalId,
			thread_id: m.threadId!,
			rfc_message_id: null,
			subject: "Secret plans",
			from_addr: "ana@example.net",
			to_json: "[]",
			snippet: null,
			received_at: new Date().toISOString(),
			has_attachments: 1,
			labels_json: "[]",
			state: "inbox",
			raw_r2_key: m.rawR2Key,
			raw_sha256: "x",
			updated_at: new Date().toISOString(),
		});
		const now = new Date().toISOString();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO telegram_links (chat_id, message_id, mailbox_id, thread_id, message_local_id, created_at) VALUES ('c', ?, ?, ?, ?, ?)",
		)
			.bind(Math.floor(Math.random() * 1e9), mailboxId, m.threadId, m.messageLocalId, now)
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO telegram_retained (id, chat_id, mailbox_id, mailbox_address, message_local_id, thread_id, from_addr, retained_at) VALUES (?, 'c', ?, 'box@example.com', ?, ?, 'ana@example.net', ?)",
		)
			.bind(crypto.randomUUID(), mailboxId, m.messageLocalId, m.threadId, now)
			.run();

		await trash(mailboxId, [m.messageLocalId]);
		const countsBefore = (await (await api(mailboxId, "/counts")).json()) as {
			counts: { trash: { threads: number } };
		};
		expect(countsBefore.counts.trash.threads).toBe(1);

		const op = await purge(mailboxId, { threadIds: [m.threadId] });
		expect(op).toMatchObject({
			status: "done",
			requested: 1,
			deleted: 1,
			conversations: 1,
			conversationsRemoved: 1,
			remaining: 0,
		});

		// Mailbox DO.
		for (const [table, column] of [
			["messages", "id"],
			["attachments", "message_id"],
			["message_headers", "message_id"],
			["message_labels", "message_id"],
			["message_fts", "message_id"],
		] as const) {
			expect(
				await count(mailboxId, `SELECT 1 FROM ${table} WHERE ${column} = ?`, m.messageLocalId),
				table,
			).toBe(0);
		}
		expect(await count(mailboxId, "SELECT 1 FROM threads WHERE id = ?", m.threadId!)).toBe(0);
		expect(
			await count(
				mailboxId,
				"SELECT 1 FROM realtime_events WHERE payload_json LIKE '%Secret plans%'",
			),
		).toBe(0);
		const ledger = await sql(mailboxId, (s) =>
			s
				.exec<{ error_code: string; message_local_id: string }>(
					"SELECT error_code, message_local_id FROM ingest_events",
				)
				.toArray(),
		);
		expect(ledger).toEqual([{ error_code: "purged", message_local_id: m.messageLocalId }]);

		// R2.
		for (const key of keys) expect(await exists(key), key).toBe(false);

		// D1.
		for (const table of ["message_index", "telegram_links", "telegram_retained"]) {
			const row = await testEnv.INDEX_DB.prepare(
				`SELECT COUNT(*) AS n FROM ${table} WHERE mailbox_id = ? AND message_local_id = ?`,
			)
				.bind(mailboxId, m.messageLocalId)
				.first<{ n: number }>();
			expect(row?.n, table).toBe(0);
		}

		// Counts and list.
		const counts = (await (await api(mailboxId, "/counts")).json()) as {
			counts: { trash: { threads: number; messages: number }; all: { messages: number } };
		};
		expect(counts.counts.trash).toMatchObject({ threads: 0, messages: 0 });
		expect(counts.counts.all.messages).toBe(0);
		const list = (await (await api(mailboxId, "/threads?state=trash")).json()) as {
			threads: unknown[];
		};
		expect(list.threads).toEqual([]);

		// One ops event, counts only: no subject, no address.
		const events = await testEnv.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'mailbox.messages_purged' AND subject = ?",
		)
			.bind(mailboxId)
			.all<{ payload_json: string }>();
		expect(events.results).toHaveLength(1);
		const payload = events.results[0]!.payload_json;
		expect(JSON.parse(payload)).toMatchObject({
			mailboxId,
			operationId: op.operationId,
			scope: "threads",
			messages: 1,
			conversations: 1,
			conversationsRemoved: 1,
		});
		expect(payload).not.toContain("Secret");
		expect(payload).not.toContain("ana@example.net");

		// A retry of the same request finds nothing left and is not an error.
		const again = await purge(mailboxId, { threadIds: [m.threadId] });
		expect(again).toMatchObject({ status: "done", deleted: 0 });
	});

	it("keeps a conversation that still has other messages consistent", async () => {
		const mailboxId = await newMailbox();
		const firstId = `first-${crypto.randomUUID()}@x`;
		const first = await ingest(mailboxId, {
			messageId: firstId,
			subject: "Project",
			receivedAt: "2026-11-10T10:00:00.000Z",
		});
		const reply = await ingest(mailboxId, {
			messageId: `reply-${crypto.randomUUID()}@x`,
			subject: "Re: Project",
			inReplyTo: firstId,
			receivedAt: "2026-11-12T10:00:00.000Z",
		});
		expect(reply.threadId).toBe(first.threadId);
		await trash(mailboxId, [reply.messageLocalId]);

		const op = await purge(mailboxId, { threadIds: [first.threadId] });
		expect(op).toMatchObject({ deleted: 1, conversations: 1, conversationsRemoved: 0 });

		const thread = await sql(mailboxId, (s) =>
			s
				.exec<{ message_count: number; unread_count: number; last_message_at: string }>(
					"SELECT message_count, unread_count, last_message_at FROM threads WHERE id = ?",
					first.threadId!,
				)
				.one(),
		);
		expect(thread).toEqual({
			message_count: 1,
			unread_count: 1,
			last_message_at: "2026-11-10T10:00:00.000Z",
		});
		const inbox = (await (await api(mailboxId, "/threads?state=inbox")).json()) as {
			threads: Array<{
				id: string;
				message_count: number;
				latest_subject: string;
				participants: unknown[];
			}>;
		};
		expect(inbox.threads).toHaveLength(1);
		expect(inbox.threads[0]).toMatchObject({
			id: first.threadId,
			message_count: 1,
			latest_subject: "Project",
		});
		expect(inbox.threads[0]!.participants.length).toBeGreaterThan(0);
		const detail = (await (await api(mailboxId, `/threads/${first.threadId}`)).json()) as {
			messages: Array<{ id: string }>;
		};
		expect(detail.messages.map((x) => x.id)).toEqual([first.messageLocalId]);
		expect(await exists(first.rawR2Key)).toBe(true);
		expect(await exists(reply.rawR2Key)).toBe(false);
	});
});

describe("shared R2 objects survive while something points at them", () => {
	it("keeps a forwarded attachment an open draft refers to, and deletes it once the draft lets go", async () => {
		const mailboxId = await newMailbox();
		const original = await ingest(mailboxId, {
			messageId: `orig-${crypto.randomUUID()}@x`,
			attachment: "contract.txt",
		});
		const message = await stored(mailboxId, original.messageLocalId);
		const attachmentKey = message.attachments[0]!.r2_key;
		const draftId = await createDraft(mailboxId);
		const [added] = await forwardInto(mailboxId, draftId, original.messageLocalId);

		await trash(mailboxId, [original.messageLocalId]);
		await purge(mailboxId, { messageIds: [original.messageLocalId] });

		expect(await exists(original.rawR2Key)).toBe(false);
		expect(await exists(message.body_html_r2_key!)).toBe(false);
		expect(await exists(attachmentKey)).toBe(true);

		// The draft was the last reference: dropping the file deletes the object.
		const removed = await api(mailboxId, `/drafts/${draftId}/attachments/${added!.id}`, {
			method: "DELETE",
		});
		expect(removed.status).toBe(200);
		expect(await exists(attachmentKey)).toBe(false);
	});

	it("keeps an object a sent copy re-uses, deletes it with the last message, and empties the sent draft", async () => {
		const mailboxId = await newMailbox();
		const original = await ingest(mailboxId, {
			messageId: `orig2-${crypto.randomUUID()}@x`,
			attachment: "invoice.txt",
		});
		const attachmentKey = (await stored(mailboxId, original.messageLocalId)).attachments[0]!.r2_key;
		const draftId = await createDraft(mailboxId);
		await forwardInto(mailboxId, draftId, original.messageLocalId);
		await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			`https://mailbox-do/drafts/${draftId}/request-send`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mailboxAddress: `${mailboxId}@example.com` }),
			},
		);
		const sent = await confirm(mailboxId, draftId, `attempt-${draftId}`);
		expect(sent.sent).toBe(true);
		const sentCopy = await stored(mailboxId, String(sent.messageLocalId));
		expect(sentCopy.attachments.map((a) => a.r2_key)).toEqual([attachmentKey]);

		await trash(mailboxId, [original.messageLocalId]);
		await purge(mailboxId, { messageIds: [original.messageLocalId] });
		expect(await exists(attachmentKey)).toBe(true);

		await trash(mailboxId, [sentCopy.id]);
		await purge(mailboxId, { messageIds: [sentCopy.id] });
		expect(await exists(attachmentKey)).toBe(false);
		const draft = await sql(mailboxId, (s) =>
			s
				.exec<{ status: string; subject: string; body_text: string | null; to_json: string }>(
					"SELECT status, subject, body_text, to_json FROM outbound_drafts WHERE id = ?",
					draftId,
				)
				.one(),
		);
		expect(draft).toEqual({ status: "sent", subject: "", body_text: null, to_json: "[]" });
		expect(
			await count(mailboxId, "SELECT 1 FROM mailbox_meta WHERE key = ?", `send_intent:${draftId}`),
		).toBe(0);
		// The send marker stays: a replayed confirm-send still sends nothing.
		const replay = await confirm(mailboxId, draftId, `attempt-${draftId}`);
		expect(replay.sent).toBe(false);
	});

	it("keeps a raw object another delivery still points at", async () => {
		const mailboxId = await newMailbox();
		const first = await ingest(mailboxId, { messageId: `dup-a-${crypto.randomUUID()}@x` });
		const second = await ingest(mailboxId, {
			messageId: `dup-b-${crypto.randomUUID()}@x`,
			rawR2Key: first.rawR2Key,
		});
		expect(second.status).toBe("inserted");

		await trash(mailboxId, [first.messageLocalId]);
		await purge(mailboxId, { messageIds: [first.messageLocalId] });
		expect(await exists(first.rawR2Key)).toBe(true);

		await trash(mailboxId, [second.messageLocalId]);
		await purge(mailboxId, { messageIds: [second.messageLocalId] });
		expect(await exists(first.rawR2Key)).toBe(false);
	});
});

describe("partial failures resume", () => {
	type Swappable = { env: Env };

	function failing<T extends object>(target: T, method: string): T {
		return new Proxy(target, {
			get(t, prop) {
				if (prop === method)
					return () => {
						throw new Error(`${method} unavailable`);
					};
				const value = Reflect.get(t, prop);
				return typeof value === "function" ? value.bind(t) : value;
			},
		});
	}

	it("finishes the R2 and D1 cleanup on a later run after each fails", async () => {
		const mailboxId = await newMailbox();
		const m = await ingest(mailboxId, {
			messageId: `fail-${crypto.randomUUID()}@x`,
			attachment: "a.txt",
		});
		const keys = keysOf(await stored(mailboxId, m.messageLocalId));
		await upsertMessageIndex(testEnv.INDEX_DB, {
			mailbox_id: mailboxId,
			message_local_id: m.messageLocalId,
			thread_id: m.threadId!,
			rfc_message_id: null,
			subject: null,
			from_addr: "ana@example.net",
			to_json: "[]",
			snippet: null,
			received_at: new Date().toISOString(),
			has_attachments: 1,
			labels_json: "[]",
			state: "trash",
			raw_r2_key: m.rawR2Key,
			raw_sha256: "x",
			updated_at: new Date().toISOString(),
		});
		await trash(mailboxId, [m.messageLocalId]);
		const indexRows = () =>
			testEnv.INDEX_DB.prepare(
				"SELECT COUNT(*) AS n FROM message_index WHERE mailbox_id = ? AND message_local_id = ?",
			)
				.bind(mailboxId, m.messageLocalId)
				.first<{ n: number }>()
				.then((r) => r?.n ?? 0);
		const job = () =>
			sql(mailboxId, (s) =>
				s
					.exec<{ status: string; attempts: number; payload_json: string }>(
						"SELECT status, attempts, payload_json FROM jobs WHERE type = 'purge_message_objects'",
					)
					.one(),
			);

		// R2 down: the mail is gone from the mailbox at once, the job keeps the keys.
		const op = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			async (instance) => {
				const target = instance as unknown as Swappable;
				const original = target.env;
				target.env = {
					...original,
					MAIL_OBJECTS: failing(original.MAIL_OBJECTS, "delete"),
				} as Env;
				try {
					const response = await (instance as unknown as DurableObject).fetch(
						new Request("https://mailbox-do/purge", {
							method: "POST",
							body: JSON.stringify({ mailboxId, target: { messageIds: [m.messageLocalId] } }),
						}),
					);
					return (await response.json()) as PurgeOp;
				} finally {
					target.env = original;
				}
			},
		);
		expect(op).toMatchObject({ status: "done", deleted: 1 });
		expect(await count(mailboxId, "SELECT 1 FROM messages")).toBe(0);
		for (const key of keys) expect(await exists(key)).toBe(true);
		const afterR2 = await job();
		expect(afterR2.status).toBe("pending");
		expect(JSON.parse(afterR2.payload_json).keys.sort()).toEqual([...keys].sort());
		expect(await indexRows()).toBe(1);

		// R2 back, D1 down: the objects go, progress is saved, the D1 rows wait.
		await sql(mailboxId, (s) =>
			s.exec(
				"UPDATE jobs SET next_run_at = ? WHERE status = 'pending'",
				new Date(Date.now() - 1000).toISOString(),
			),
		);
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (instance) => {
			const target = instance as unknown as Swappable;
			const original = target.env;
			target.env = { ...original, INDEX_DB: failing(original.INDEX_DB, "prepare") } as Env;
			try {
				await (instance as unknown as DurableObject).alarm?.();
			} finally {
				target.env = original;
			}
		});
		for (const key of keys) expect(await exists(key)).toBe(false);
		const afterD1 = await job();
		expect(afterD1.status).toBe("pending");
		expect(JSON.parse(afterD1.payload_json)).toMatchObject({ r2Done: true, keys: [] });
		expect(await indexRows()).toBe(1);

		// Everything back: the next run finishes the job and reports once.
		await runAlarm(mailboxId);
		expect((await job()).status).toBe("done");
		expect(await indexRows()).toBe(0);
		const events = await testEnv.INDEX_DB.prepare(
			"SELECT COUNT(*) AS n FROM ops_events WHERE event_type = 'mailbox.messages_purged' AND subject = ?",
		)
			.bind(mailboxId)
			.first<{ n: number }>();
		expect(events?.n).toBe(1);
	});
});

describe("Empty trash on a large mailbox", () => {
	async function seedTrash(mailboxId: string, n: number): Promise<string[]> {
		const keys: string[] = [];
		const rows: Array<{ id: string; key: string; at: string }> = [];
		for (let i = 0; i < n; i++) {
			const id = `seed-${i}-${crypto.randomUUID().slice(0, 6)}`;
			const key = `raw/dev/${mailboxId}/seed/${id}.eml`;
			rows.push({ id, key, at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
			keys.push(key);
		}
		await Promise.all(rows.map((r) => testEnv.MAIL_OBJECTS.put(r.key, "x")));
		await sql(mailboxId, (s) => {
			for (const r of rows) {
				s.exec(
					`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
           VALUES (?, 'seed', ?, 1, 0, ?, ?)`,
					`t-${r.id}`,
					r.at,
					r.at,
					r.at,
				);
				s.exec(
					`INSERT INTO messages (id, idempotency_key, thread_id, direction, state, from_addr, to_json,
             subject, received_at, raw_r2_key, raw_sha256, raw_size, parse_status, is_read, created_at, updated_at)
           VALUES (?, ?, ?, 'inbound', 'trash', 'a@example.net', '[]', 'seed', ?, ?, 'x', 1, 'parsed', 1, ?, ?)`,
					r.id,
					`key-${r.id}`,
					`t-${r.id}`,
					r.at,
					r.key,
					r.at,
					r.at,
				);
				s.exec(
					"INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text) VALUES (?, 'seed', '', '', '', '')",
					r.id,
				);
			}
		});
		return rows.map((r) => r.id);
	}

	it("deletes in bounded batches, leaves a message restored meanwhile, and reports once", async () => {
		const mailboxId = await newMailbox();
		const total = PURGE_BATCH_MESSAGES * 2 + 20;
		const ids = await seedTrash(mailboxId, total);
		const keeper = await ingest(mailboxId, { messageId: `keep-${crypto.randomUUID()}@x` });

		// The request deletes one batch; the alarm continues. The newest seeded
		// message (last in line) is restored while the rest is still queued — in
		// the same DO turn, before the alarm can run, so the test is deterministic.
		const restored = ids.at(-1)!;
		const first = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			async (instance, state) => {
				const response = await (instance as unknown as DurableObject).fetch(
					new Request("https://mailbox-do/purge", {
						method: "POST",
						body: JSON.stringify({ mailboxId, target: { emptyTrash: {} } }),
					}),
				);
				const left = state.storage.sql
					.exec<{ n: number }>("SELECT COUNT(*) AS n FROM messages WHERE state = 'trash'")
					.one().n;
				state.storage.sql.exec("UPDATE messages SET state = 'inbox' WHERE id = ?", restored);
				return { op: (await response.json()) as PurgeOp, left };
			},
		);
		expect(first.op).toMatchObject({
			status: "running",
			requested: total,
			deleted: PURGE_BATCH_MESSAGES,
			remaining: total - PURGE_BATCH_MESSAGES,
		});
		expect(first.left).toBe(total - PURGE_BATCH_MESSAGES);

		let status = first.op;
		for (let i = 0; i < 10 && status.status !== "done"; i++) {
			await runAlarm(mailboxId);
			status = (await (await api(mailboxId, `/purge/${first.op.operationId}`)).json()) as PurgeOp;
		}
		expect(status).toMatchObject({ status: "done", deleted: total - 1, remaining: 0 });

		const jobs = await sql(mailboxId, (s) =>
			s
				.exec<{ status: string; payload_json: string }>(
					"SELECT status, payload_json FROM jobs WHERE type = 'purge_message_objects'",
				)
				.toArray(),
		);
		expect(jobs.length).toBe(3);
		for (const j of jobs) {
			expect(j.status).toBe("done");
			expect(JSON.parse(j.payload_json).messageIds.length).toBeLessThanOrEqual(
				PURGE_BATCH_MESSAGES,
			);
		}
		expect(await count(mailboxId, "SELECT 1 FROM messages")).toBe(2);
		expect(await count(mailboxId, "SELECT 1 FROM messages WHERE id = ?", restored)).toBe(1);
		expect(
			await count(mailboxId, "SELECT 1 FROM messages WHERE id = ?", keeper.messageLocalId),
		).toBe(1);
		expect(await count(mailboxId, "SELECT 1 FROM message_fts")).toBe(2);
		expect(await exists(`raw/dev/${mailboxId}/seed/${ids[0]}.eml`)).toBe(false);
		expect(await exists(`raw/dev/${mailboxId}/seed/${restored}.eml`)).toBe(true);
		const counts = (await (await api(mailboxId, "/counts")).json()) as {
			counts: { trash: { threads: number } };
		};
		expect(counts.counts.trash.threads).toBe(0);

		const events = await testEnv.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'mailbox.messages_purged' AND subject = ?",
		)
			.bind(mailboxId)
			.all<{ payload_json: string }>();
		expect(events.results).toHaveLength(1);
		expect(JSON.parse(events.results[0]!.payload_json)).toMatchObject({
			scope: "empty_trash",
			messages: total - 1,
			conversationsRemoved: total - 1,
		});
	});
});

describe("conversation tallies", () => {
	it("count a conversation whose trashed messages span two batches once", async () => {
		const mailboxId = await newMailbox();
		const total = PURGE_BATCH_MESSAGES + 10;
		const thread = "t-one-long-conversation";
		await sql(mailboxId, (s) => {
			const at = "2026-01-01T00:00:00.000Z";
			s.exec(
				`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, 'long', ?, ?, 0, ?, ?)`,
				thread,
				at,
				total,
				at,
				at,
			);
			for (let i = 0; i < total; i++) {
				const id = `long-${i}`;
				s.exec(
					`INSERT INTO messages (id, idempotency_key, thread_id, direction, state, from_addr, to_json,
             subject, received_at, raw_r2_key, raw_sha256, raw_size, parse_status, is_read, created_at, updated_at)
           VALUES (?, ?, ?, 'inbound', 'trash', 'a@example.net', '[]', 'long', ?, ?, 'x', 1, 'parsed', 1, ?, ?)`,
					id,
					`key-${id}`,
					thread,
					new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
					`raw/dev/${mailboxId}/long/${id}.eml`,
					at,
					at,
				);
			}
		});

		const first = await purge(mailboxId, { threadIds: [thread] });
		expect(first).toMatchObject({ status: "running", deleted: PURGE_BATCH_MESSAGES });
		expect(first).toMatchObject({ conversations: 1, conversationsRemoved: 0 });
		let status = first;
		for (let i = 0; i < 5 && status.status !== "done"; i++) {
			await runAlarm(mailboxId);
			status = (await (await api(mailboxId, `/purge/${first.operationId}`)).json()) as PurgeOp;
		}
		expect(status).toMatchObject({
			status: "done",
			deleted: total,
			conversations: 1,
			conversationsRemoved: 1,
		});
		// The per-operation conversation set does not outlive the operation.
		expect(await count(mailboxId, "SELECT 1 FROM purge_operation_threads")).toBe(0);

		const events = await testEnv.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'mailbox.messages_purged' AND subject = ?",
		)
			.bind(mailboxId)
			.all<{ payload_json: string }>();
		expect(events.results).toHaveLength(1);
		expect(JSON.parse(events.results[0]!.payload_json)).toMatchObject({
			messages: total,
			conversations: 1,
			conversationsRemoved: 1,
		});
	});
});

describe("a re-delivered copy of a deleted email", () => {
	it("stays deleted (and its new raw copy is removed), while new mail still arrives", async () => {
		const mailboxId = await newMailbox();
		const messageId = `again-${crypto.randomUUID()}@x`;
		const m = await ingest(mailboxId, { messageId, subject: "Once" });
		await trash(mailboxId, [m.messageLocalId]);
		await purge(mailboxId, { messageIds: [m.messageLocalId] });

		const redelivered = await ingest(mailboxId, { messageId, subject: "Once" });
		expect(redelivered).toMatchObject({
			status: "duplicate",
			purged: true,
			messageLocalId: m.messageLocalId,
		});
		expect(await count(mailboxId, "SELECT 1 FROM messages")).toBe(0);
		expect(await exists(redelivered.rawR2Key)).toBe(false);

		const fresh = await ingest(mailboxId, { messageId: `new-${crypto.randomUUID()}@x` });
		expect(fresh.status).toBe("inserted");
		expect(await count(mailboxId, "SELECT 1 FROM messages")).toBe(1);
	});
});

describe("who can delete forever", () => {
	it("requires the owner's web session: no session, a bearer token, a stranger or another site get nothing", async () => {
		const mailboxId = await newMailbox();
		const m = await ingest(mailboxId, { messageId: `auth-${crypto.randomUUID()}@x` });
		await trash(mailboxId, [m.messageLocalId]);
		const body = JSON.stringify({ emptyTrash: true });
		const remote = (headers: Record<string, string> = {}) =>
			fetchWorker(
				new Request(`https://reccado.example.com/api/mailboxes/${mailboxId}/purge`, {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body,
				}),
				{ ...env, BETTER_AUTH_SECRET: undefined } as Env,
			);

		expect((await remote()).status).toBe(401);
		// An MCP access token is a bearer token, not a web session: /api ignores it.
		expect((await remote({ authorization: "Bearer mcp-access-token" })).status).toBe(401);
		// Signed in, but not an owner.
		const stranger = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/purge`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
			{ ...env, OWNER_BOOTSTRAP_EMAILS: "someone-else@example.com" } as Env,
		);
		expect(stranger.status).toBe(403);
		// A cross-site form post.
		const crossSite = await api(mailboxId, "/purge", {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://evil.example" },
			body,
		});
		expect(crossSite.status).toBe(403);

		expect(await count(mailboxId, "SELECT 1 FROM messages")).toBe(1);
		expect(await exists(m.rawR2Key)).toBe(true);
	});

	it("is not reachable over MCP: no tool, facade path or control-plane kind", () => {
		for (const source of [
			toolsSource,
			adminToolsSource,
			facadeSource,
			controlPlaneRegistrySource,
		]) {
			expect(source).not.toMatch(/purge|delete_forever|empty_trash|emptyTrash/i);
		}
	});
});
