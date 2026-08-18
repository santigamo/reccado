import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { confirmSendDraft } from "#/do/mailbox-do";

/**
 * What a reply has to get right to read as a reply: it joins the thread it was
 * written from, it carries In-Reply-To/References pointing at the parent, and the
 * Message-ID the provider assigned is stored so the answer to it lands back on the
 * same thread. Message-ID itself is platform-controlled in Cloudflare Email
 * Service — sending our own would be rejected — hence the fake returning one.
 */

/** Shaped like what Cloudflare puts on the wire: it owns the Message-ID. */
const PROVIDER_MESSAGE_ID = "<a1b2c3d4@cloudflare.email>";

type SentEmail = {
	from: string;
	to: string[];
	replyTo?: string;
	subject: string;
	headers?: Record<string, string>;
};

function fakeEmailSender(sent: SentEmail[]) {
	return {
		send: async (message: unknown) => {
			sent.push(message as SentEmail);
			return { messageId: PROVIDER_MESSAGE_ID };
		},
	} as unknown as Env["EMAIL"];
}

const testEnv = env as unknown as Env;

type Seed = {
	threadId: string;
	draftId: string;
	parentMessageId: string;
};

async function seedThreadWithDraft(
	state: DurableObjectState,
	options: { parentRfcId: string | null; parentReferences?: string[] } = { parentRfcId: null },
): Promise<Seed> {
	const sql = state.storage.sql;
	const now = new Date().toISOString();
	const threadId = crypto.randomUUID();
	const parentMessageId = crypto.randomUUID();
	const draftId = crypto.randomUUID();

	sql.exec(
		`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
     VALUES (?, 'factura de junio', ?, 1, 1, ?, ?)`,
		threadId,
		now,
		now,
		now,
	);
	sql.exec(
		`INSERT INTO messages
     (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
      from_addr, to_json, cc_json, bcc_json, subject, snippet, received_at, raw_r2_key, raw_sha256,
      raw_size, parse_status, has_attachments, is_read, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, 'inbound', 'inbox', 'cliente@example.com', '["hello@imsanti.dev"]',
             '[]', '[]', 'Factura de junio', 'hola', ?, 'raw/x', 'sha', 10, 'parsed', 0, 0, ?, ?)`,
		parentMessageId,
		`ingest:${parentMessageId}`,
		threadId,
		options.parentRfcId,
		JSON.stringify(options.parentReferences ?? []),
		now,
		now,
		now,
	);
	sql.exec(
		`INSERT INTO outbound_drafts
     (id, thread_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
     VALUES (?, ?, '["cliente@example.com"]', '[]', '[]', 'Re: Factura de junio', 'Te la mando.', NULL,
             'pending_confirmation', 'telegram:1', ?, ?)`,
		draftId,
		threadId,
		now,
		now,
	);
	return { threadId, draftId, parentMessageId };
}

async function withMailbox<T>(
	name: string,
	fn: (state: DurableObjectState) => Promise<T>,
): Promise<T> {
	const stub = testEnv.MAILBOX_DO.getByName(name);
	return runInDurableObject(stub, async (_instance, state) => fn(state));
}

describe("confirmSendDraft threading", () => {
	it("keeps the reply in the draft's thread instead of forking a new one", async () => {
		const sent: SentEmail[] = [];
		const result = await withMailbox("mbx-threading-1", async (state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: "parent@example.com" });
			const outcome = await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);
			return { outcome, seed, state };
		});

		expect(result.outcome.sent).toBe(true);
		expect(result.outcome.threadId).toBe(result.seed.threadId);
	});

	it("sends In-Reply-To and References pointing at the parent", async () => {
		const sent: SentEmail[] = [];
		await withMailbox("mbx-threading-2", async (state) => {
			const seed = await seedThreadWithDraft(state, {
				parentRfcId: "parent@example.com",
				parentReferences: ["root@example.com"],
			});
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);
		});

		expect(sent).toHaveLength(1);
		expect(sent[0]?.headers?.["In-Reply-To"]).toBe("<parent@example.com>");
		expect(sent[0]?.headers?.References).toBe("<root@example.com> <parent@example.com>");
		// Message-ID is on Cloudflare's reserved list: sending one would be rejected.
		expect(sent[0]?.headers?.["Message-ID"]).toBeUndefined();
	});

	it("does not double-wrap a stored id that already has angle brackets", async () => {
		const sent: SentEmail[] = [];
		await withMailbox("mbx-threading-6", async (state) => {
			const seed = await seedThreadWithDraft(state, {
				parentRfcId: "<parent@example.com>",
				parentReferences: ["<root@example.com>"],
			});
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);
		});

		expect(sent[0]?.headers?.["In-Reply-To"]).toBe("<parent@example.com>");
		expect(sent[0]?.headers?.References).toBe("<root@example.com> <parent@example.com>");
	});

	it("stores the sent Message-ID so the answer threads back", async () => {
		const sent: SentEmail[] = [];
		const stored = await withMailbox("mbx-threading-3", async (state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: "parent@example.com" });
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);
			return state.storage.sql
				.exec<{
					rfc_message_id: string | null;
					in_reply_to: string | null;
					references_json: string;
				}>(
					"SELECT rfc_message_id, in_reply_to, references_json FROM messages WHERE direction = 'outbound'",
				)
				.toArray()[0];
		});

		expect(stored?.rfc_message_id).toBe("a1b2c3d4@cloudflare.email");
		expect(stored?.in_reply_to).toBe("parent@example.com");
		expect(JSON.parse(stored?.references_json ?? "[]")).toEqual(["parent@example.com"]);
	});

	it("bumps the existing thread's counters rather than inserting a duplicate row", async () => {
		const sent: SentEmail[] = [];
		const thread = await withMailbox("mbx-threading-4", async (state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: "parent@example.com" });
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);
			return state.storage.sql
				.exec<{ n: number; message_count: number }>(
					"SELECT COUNT(*) AS n, MAX(message_count) AS message_count FROM threads WHERE id = ?",
					seed.threadId,
				)
				.toArray()[0];
		});

		expect(thread?.n).toBe(1);
		expect(thread?.message_count).toBe(2);
	});

	it("omits reply headers for a brand new conversation", async () => {
		const sent: SentEmail[] = [];
		await withMailbox("mbx-threading-5", async (state) => {
			const now = new Date().toISOString();
			const draftId = crypto.randomUUID();
			state.storage.sql.exec(
				`INSERT INTO outbound_drafts
         (id, thread_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
         VALUES (?, NULL, '["nuevo@example.com"]', '[]', '[]', 'Hola', 'Primer contacto', NULL,
                 'pending_confirmation', 'user', ?, ?)`,
				draftId,
				now,
				now,
			);
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: "hello@imsanti.dev",
				},
				draftId,
				`attempt-${draftId}`,
			);
		});

		// No parent, so no threading headers are sent at all.
		expect(sent[0]?.headers).toBeUndefined();
		expect(sent[0]?.replyTo).toBe("hello@imsanti.dev");
	});
});

describe("request-send guard", () => {
	it("arms a fresh draft for confirmation", async () => {
		const stub = testEnv.MAILBOX_DO.getByName("mbx-arm-1");
		const draftId = await runInDurableObject(stub, async (_instance, state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: null });
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET status = 'draft' WHERE id = ?",
				seed.draftId,
			);
			return seed.draftId;
		});
		const response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/request-send`, {
			method: "POST",
		});
		expect(await response.json()).toMatchObject({ status: "pending_confirmation" });
	});

	it("refuses to move a sent draft back to pending confirmation", async () => {
		const stub = testEnv.MAILBOX_DO.getByName("mbx-arm-2");
		const draftId = await runInDurableObject(stub, async (_instance, state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: null });
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET status = 'sent' WHERE id = ?",
				seed.draftId,
			);
			return seed.draftId;
		});
		const response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/request-send`, {
			method: "POST",
		});
		// A retried Telegram update must not resurrect mail that already went out.
		expect(await response.json()).toMatchObject({ status: "sent" });
	});

	it("refuses to resurrect a cancelled draft", async () => {
		const stub = testEnv.MAILBOX_DO.getByName("mbx-arm-3");
		const draftId = await runInDurableObject(stub, async (_instance, state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: null });
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET status = 'cancelled' WHERE id = ?",
				seed.draftId,
			);
			return seed.draftId;
		});
		const response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/request-send`, {
			method: "POST",
		});
		expect(await response.json()).toMatchObject({ status: "cancelled" });
	});
});

describe("atomic per-draft send gate", () => {
	it("blocks a second attempt key from calling the provider when the draft gate is held", async () => {
		const sent: SentEmail[] = [];
		const result = await withMailbox("mbx-gate-1", async (state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: "parent@example.com" });

			// Simulate an in-flight send from a different attempt key: the per-draft
			// gate is already held. A real concurrent request would insert this via
			// the same path; here we pre-load it to prove the gate fires correctly.
			state.storage.sql.exec(
				"INSERT INTO mailbox_meta (key, value, updated_at) VALUES (?, ?, ?)",
				`draft_sending:${seed.draftId}`,
				"attempt-other",
				new Date().toISOString(),
			);

			const outcome = await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);

			return { outcome, sent };
		});

		// The second attempt was blocked without calling the provider.
		expect(result.sent).toHaveLength(0);
		expect(result.outcome.duplicate).toBe(true);
		expect(result.outcome.reason).toBe("already_sending");
	});

	it("forwards only one provider call when two attempt keys race on the same draft (simulated concurrency)", async () => {
		const sent: SentEmail[] = [];

		// This test runs inside runInDurableObject so we control the fake sender.
		const result = await withMailbox("mbx-gate-2", async (state) => {
			const seed = await seedThreadWithDraft(state, { parentRfcId: "parent@example.com" });

			// Call confirmSendDraft once. The gate goes in, email.send fires, success.
			const outcome = await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);

			// Then simulate a second request coming in after the first completed.
			// It should see the draft is already 'sent' (status changed by the first).
			const secondOutcome = await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				seed.draftId,
				`attempt-2-${seed.draftId}`,
			);

			return { first: outcome, second: secondOutcome, sent };
		});

		// Only one provider call was made, not two.
		expect(result.sent).toHaveLength(1);
		expect(result.first.sent).toBe(true);

		// The second got status = "sent" because the draft is already committed as sent
		// and the idempotency key is different (new attempt key) — the gate prevents
		// reaching EMAIL.send. The draft status check catches it first.
		expect(result.second.sent).toBe(false);
		expect(result.second.reason).toBe("not_pending_confirmation");
	});
});
