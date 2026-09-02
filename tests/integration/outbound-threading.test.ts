import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { confirmSendDraft, resolveReplyIdentity } from "#/do/mailbox-do";

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

/**
 * Catch-all routing means the address a mail was sent to is usually NOT the
 * mailbox's primary_address, and that the thread's newest message is not
 * necessarily the one being answered. Both decide what goes on the wire.
 */
type ReplySeed = {
	threadId: string;
	draftId: string;
	oldMessageId: string;
	newMessageId: string;
};

async function seedThreadForReply(
	state: DurableObjectState,
	options: {
		/** Recipients of the message being answered — the alias lives in here. */
		parentTo: string[];
		oldRfcId: string;
		newRfcId: string;
		/** What the draft records as the message it answers, if anything. */
		parentMessageId?: "old" | "new" | null;
		newTo?: string[];
	},
): Promise<ReplySeed> {
	const sql = state.storage.sql;
	const threadId = crypto.randomUUID();
	const oldMessageId = crypto.randomUUID();
	const newMessageId = crypto.randomUUID();
	const draftId = crypto.randomUUID();
	const older = "2026-08-01T10:00:00.000Z";
	const newer = "2026-08-20T10:00:00.000Z";

	sql.exec(
		`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
     VALUES (?, 'consulta', ?, 2, 2, ?, ?)`,
		threadId,
		newer,
		older,
		newer,
	);
	const insertMessage = (
		id: string,
		rfcId: string,
		to: string[],
		receivedAt: string,
		references: string[],
	) => {
		sql.exec(
			`INSERT INTO messages
       (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
        from_addr, to_json, cc_json, bcc_json, subject, snippet, received_at, raw_r2_key, raw_sha256,
        raw_size, parse_status, has_attachments, is_read, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, 'inbound', 'inbox', 'cliente@example.com', ?, '[]', '[]',
               'Consulta', 'hola', ?, 'raw/x', ?, 10, 'parsed', 0, 0, ?, ?)`,
			id,
			`ingest:${id}`,
			threadId,
			rfcId,
			JSON.stringify(references),
			JSON.stringify(to),
			receivedAt,
			`sha-${id}`,
			receivedAt,
			receivedAt,
		);
	};
	insertMessage(oldMessageId, options.oldRfcId, options.parentTo, older, []);
	insertMessage(newMessageId, options.newRfcId, options.newTo ?? options.parentTo, newer, [
		options.oldRfcId,
	]);

	const parentMessageId =
		options.parentMessageId === "old"
			? oldMessageId
			: options.parentMessageId === "new"
				? newMessageId
				: null;
	sql.exec(
		`INSERT INTO outbound_drafts
     (id, thread_id, parent_message_id, to_json, cc_json, bcc_json, subject, body_text, body_html,
      status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, '["cliente@example.com"]', '[]', '[]', 'Re: Consulta', 'Te cuento.', NULL,
             'pending_confirmation', 'telegram:1', ?, ?)`,
		draftId,
		threadId,
		parentMessageId,
		newer,
		newer,
	);
	return { threadId, draftId, oldMessageId, newMessageId };
}

const VERIFIED_ENV = {
	MAIL_FROM_ADDRESS: "noreply@send.imsanti.dev",
	MAIL_SENDING_DOMAINS: "imsanti.dev",
};
const UNVERIFIED_ENV = { MAIL_FROM_ADDRESS: "noreply@send.example.com" };

describe("reply sender identity", () => {
	it("answers from the alias the original mail was delivered to, not the canonical address", async () => {
		const sent: SentEmail[] = [];
		const identity = await withMailbox("mbx-alias-1", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["shop@imsanti.dev"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
			});
			const resolved = resolveReplyIdentity(
				VERIFIED_ENV,
				state.storage.sql,
				seed.draftId,
				"hello@imsanti.dev",
			);
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(sent),
					fromAddress: resolved.from,
					replyToAddress: resolved.replyTo,
				},
				seed.draftId,
				`attempt-${seed.draftId}`,
			);
			return resolved;
		});

		expect(identity).toEqual({ from: "shop@imsanti.dev", fromName: null, replyTo: null });
		expect(sent[0]?.from).toBe("shop@imsanti.dev");
	});

	it("puts the alias in Reply-To when its domain is not verified for sending", async () => {
		const identity = await withMailbox("mbx-alias-2", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["shop@imsanti.dev"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
			});
			return resolveReplyIdentity(
				UNVERIFIED_ENV,
				state.storage.sql,
				seed.draftId,
				"hello@imsanti.dev",
			);
		});

		// Never the canonical address: the person wrote to shop@, the reply comes back there.
		expect(identity).toEqual({
			from: "noreply@send.example.com",
			fromName: null,
			replyTo: "shop@imsanti.dev",
		});
	});

	it("keeps the mailbox address when no recipient of the parent belongs to us", async () => {
		const identity = await withMailbox("mbx-alias-3", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["otro@example.com"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
			});
			return resolveReplyIdentity(
				VERIFIED_ENV,
				state.storage.sql,
				seed.draftId,
				"hello@imsanti.dev",
			);
		});

		expect(identity).toEqual({ from: "hello@imsanti.dev", fromName: null, replyTo: null });
	});

	it("reads the alias off the message being answered, not the newest in the thread", async () => {
		const identity = await withMailbox("mbx-alias-4", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["shop@imsanti.dev"],
				newTo: ["ventas@imsanti.dev"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
				parentMessageId: "old",
			});
			return resolveReplyIdentity(
				VERIFIED_ENV,
				state.storage.sql,
				seed.draftId,
				"hello@imsanti.dev",
			);
		});

		expect(identity.from).toBe("shop@imsanti.dev");
	});
});

describe("reply parent selection", () => {
	it("points In-Reply-To at the message the draft answers, not the newest one", async () => {
		const sent: SentEmail[] = [];
		await withMailbox("mbx-parent-1", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["hello@imsanti.dev"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
				parentMessageId: "old",
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

		expect(sent[0]?.headers?.["In-Reply-To"]).toBe("<old@example.com>");
		expect(sent[0]?.headers?.References).toBe("<old@example.com>");
	});

	it("falls back to the newest message with a Message-ID when the draft names no parent", async () => {
		const sent: SentEmail[] = [];
		await withMailbox("mbx-parent-2", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["hello@imsanti.dev"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
				parentMessageId: null,
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

		expect(sent[0]?.headers?.["In-Reply-To"]).toBe("<new@example.com>");
	});

	it("emits In-Reply-To with the parent's exact case", async () => {
		const sent: SentEmail[] = [];
		// The real Gmail id from the reported bug: lowercasing it is why the reply
		// arrived as a new conversation.
		const gmailId = "CAHyeH21QU_oLHbS6X8oP9R9iSBKuh2W8-BSCbZ4Zcq8BMKcqZw@mail.gmail.com";
		await withMailbox("mbx-parent-3", async (state) => {
			const seed = await seedThreadForReply(state, {
				parentTo: ["hello@imsanti.dev"],
				oldRfcId: "Root-ID@Mail.Gmail.com",
				newRfcId: gmailId,
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

		expect(sent[0]?.headers?.["In-Reply-To"]).toBe(`<${gmailId}>`);
		expect(sent[0]?.headers?.References).toBe(`<Root-ID@Mail.Gmail.com> <${gmailId}>`);
	});
});

describe("draft creation carries the parent", () => {
	it("persists parentMessageId from the create-draft endpoint", async () => {
		const stub = testEnv.MAILBOX_DO.getByName("mbx-parent-create");
		const seed = await runInDurableObject(stub, async (_instance, state) =>
			seedThreadForReply(state, {
				parentTo: ["shop@imsanti.dev"],
				oldRfcId: "old@example.com",
				newRfcId: "new@example.com",
			}),
		);

		const response = await stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				threadId: seed.threadId,
				parentMessageId: seed.oldMessageId,
				to: ["cliente@example.com"],
				subject: "Re: Consulta",
				bodyText: "Va.",
				createdBy: "telegram:1",
			}),
		});
		const created = (await response.json()) as { id: string };

		const stored = await runInDurableObject(
			stub,
			async (_instance, state) =>
				state.storage.sql
					.exec<{ parent_message_id: string | null }>(
						"SELECT parent_message_id FROM outbound_drafts WHERE id = ?",
						created.id,
					)
					.toArray()[0],
		);
		expect(stored?.parent_message_id).toBe(seed.oldMessageId);
	});
});
