import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { confirmSendDraft } from "#/do/mailbox-do";

/**
 * The copy of a sent message has to show what was sent. The viewer renders the
 * HTML body when `body_html_r2_key` is set, then `body_text`, then the
 * "(no text content)" placeholder, so a sent copy written without either one
 * looks empty even though the mail went out intact.
 *
 * Two halves: new sends store the bodies, and mailboxes that already hold sent
 * copies without one get them filled in from the draft each came from (schema v7).
 */

const testEnv = env as unknown as Env;

function fakeEmailSender() {
	return {
		send: async () => ({ messageId: "<sent-body@cloudflare.email>" }),
	} as unknown as Env["EMAIL"];
}

async function withMailbox<T>(
	name: string,
	fn: (instance: unknown, state: DurableObjectState) => Promise<T>,
): Promise<T> {
	const stub = testEnv.MAILBOX_DO.getByName(name);
	return runInDurableObject(stub, async (instance, state) => fn(instance, state));
}

type SentMessageRow = {
	id: string;
	body_text: string | null;
	body_html_r2_key: string | null;
	raw_r2_key: string;
};

function seedDraft(
	state: DurableObjectState,
	options: { bodyText: string | null; bodyHtml?: string | null },
): string {
	const now = new Date().toISOString();
	const draftId = crypto.randomUUID();
	state.storage.sql.exec(
		`INSERT INTO outbound_drafts
     (id, thread_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
     VALUES (?, NULL, '["cliente@example.com"]', '[]', '[]', 'Re: Propuesta', ?, ?,
             'pending_confirmation', 'telegram:1', ?, ?)`,
		draftId,
		options.bodyText,
		options.bodyHtml ?? null,
		now,
		now,
	);
	return draftId;
}

function readSentCopy(state: DurableObjectState): SentMessageRow {
	const row = state.storage.sql
		.exec<SentMessageRow>(
			"SELECT id, body_text, body_html_r2_key, raw_r2_key FROM messages WHERE direction = 'outbound'",
		)
		.toArray()[0];
	if (!row) throw new Error("no sent copy was stored");
	return row;
}

describe("confirmSendDraft stores the sent copy's body", () => {
	it("keeps the draft's text on the sent copy", async () => {
		const stored = await withMailbox("mbx-sent-body-text", async (_instance, state) => {
			const draftId = seedDraft(state, { bodyText: "Olá, equipe Vérith!\n\nSegue a proposta." });
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				draftId,
				`attempt-${draftId}`,
			);
			return readSentCopy(state);
		});

		expect(stored.body_text).toBe("Olá, equipe Vérith!\n\nSegue a proposta.");
		expect(stored.body_html_r2_key).toBeNull();
	});

	it("returns the body through the thread view the UI reads", async () => {
		const stub = testEnv.MAILBOX_DO.getByName("mbx-sent-body-thread");
		const threadId = await runInDurableObject(stub, async (_instance, state) => {
			const draftId = seedDraft(state, { bodyText: "Gracias, lo reviso hoy." });
			const outcome = await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
				},
				draftId,
				`attempt-${draftId}`,
			);
			return String(outcome.threadId);
		});

		const response = await stub.fetch(`https://mailbox-do/threads/${threadId}`);
		const body = (await response.json()) as { messages: SentMessageRow[] };
		expect(body.messages).toHaveLength(1);
		expect(body.messages[0]?.body_text).toBe("Gracias, lo reviso hoy.");
	});

	it("stores the HTML body in R2 and serves it from the /html route", async () => {
		const stub = testEnv.MAILBOX_DO.getByName("mbx-sent-body-html");
		const stored = await runInDurableObject(stub, async (_instance, state) => {
			const draftId = seedDraft(state, {
				bodyText: "Hola, texto plano.",
				bodyHtml: "<p>Hola, <b>html</b>.</p>",
			});
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
					r2: testEnv.MAIL_OBJECTS,
					mailboxId: "mbx-sent-body-html",
				},
				draftId,
				`attempt-${draftId}`,
			);
			return readSentCopy(state);
		});

		expect(stored.body_text).toBe("Hola, texto plano.");
		// Same key shape an inbound message gets, so the existing route finds it.
		expect(stored.body_html_r2_key).toBe(`body/dev/mbx-sent-body-html/${stored.id}/html.html`);
		const html = await stub.fetch(`https://mailbox-do/messages/${stored.id}/html`);
		expect(html.status).toBe(200);
		expect(await html.text()).toBe("<p>Hola, <b>html</b>.</p>");
	});

	it("keeps the text body and still records the send when the R2 write fails", async () => {
		const stored = await withMailbox("mbx-sent-body-r2-fail", async (_instance, state) => {
			const draftId = seedDraft(state, {
				bodyText: "Texto que sí salió.",
				bodyHtml: "<p>html</p>",
			});
			const outcome = await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: fakeEmailSender(),
					fromAddress: "hello@imsanti.dev",
					replyToAddress: null,
					r2: {
						put: async () => {
							throw new Error("R2 unavailable");
						},
					},
					mailboxId: "mbx-sent-body-r2-fail",
				},
				draftId,
				`attempt-${draftId}`,
			);
			return { outcome, copy: readSentCopy(state) };
		});

		// The mail left before R2 was touched; the send must not read as failed.
		expect(stored.outcome.sent).toBe(true);
		expect(stored.copy.body_text).toBe("Texto que sí salió.");
		expect(stored.copy.body_html_r2_key).toBeNull();
	});
});

type SeedSentOptions = {
	draftId: string;
	direction?: "inbound" | "outbound";
	bodyText?: string | null;
	rawR2Key?: string;
	createdAt: string;
};

/** A message row shaped like the ones the send path wrote before v7: no body. */
function seedMessage(state: DurableObjectState, options: SeedSentOptions): string {
	const id = crypto.randomUUID();
	const direction = options.direction ?? "outbound";
	state.storage.sql.exec(
		`INSERT INTO messages
     (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
      from_addr, to_json, cc_json, bcc_json, subject, snippet, received_at, raw_r2_key, raw_sha256,
      raw_size, body_text, parse_status, has_attachments, is_read, created_at, updated_at)
     VALUES (?, ?, ?, NULL, NULL, '[]', ?, ?, 'hello@imsanti.dev', '["cliente@example.com"]',
             '[]', '[]', 'Re: Propuesta', 'snippet', ?, ?, 'sha', 0, ?, 'parsed', 0, 1, ?, ?)`,
		id,
		`idem:${id}`,
		crypto.randomUUID(),
		direction,
		direction === "outbound" ? "sent" : "inbox",
		options.createdAt,
		options.rawR2Key ?? `sent/${options.draftId}`,
		options.bodyText ?? null,
		options.createdAt,
		options.createdAt,
	);
	return id;
}

function bodyOf(state: DurableObjectState, messageId: string): string | null {
	return (
		state.storage.sql
			.exec<{ body_text: string | null }>("SELECT body_text FROM messages WHERE id = ?", messageId)
			.toArray()[0]?.body_text ?? null
	);
}

type Backfiller = { backfillSentBodyText: () => void };

describe("sent copy body backfill (schema v7)", () => {
	it("fills sent copies that have no body from the draft they were sent from", async () => {
		const body = await withMailbox("mbx-backfill-fill", async (instance, state) => {
			const draftId = seedDraft(state, { bodyText: "Olá, equipe Vérith!" });
			const draftRow = state.storage.sql
				.exec<{ updated_at: string }>(
					"SELECT updated_at FROM outbound_drafts WHERE id = ?",
					draftId,
				)
				.toArray()[0];
			// The send path stamps the draft and the copy with the same instant.
			const messageId = seedMessage(state, {
				draftId,
				createdAt: draftRow?.updated_at ?? "",
			});
			expect(bodyOf(state, messageId)).toBeNull();
			(instance as Backfiller).backfillSentBodyText();
			return bodyOf(state, messageId);
		});

		expect(body).toBe("Olá, equipe Vérith!");
	});

	it("never touches inbound messages, even one that points at a sent/ key", async () => {
		const result = await withMailbox("mbx-backfill-inbound", async (instance, state) => {
			const draftId = seedDraft(state, { bodyText: "borrador" });
			const createdAt = new Date().toISOString();
			const plainInbound = seedMessage(state, {
				draftId,
				direction: "inbound",
				rawR2Key: "raw/dev/mbx/2026/10/26/1-abc.eml",
				createdAt,
			});
			// Not a shape the product produces; it proves the direction guard on its own.
			const strayInbound = seedMessage(state, {
				draftId,
				direction: "inbound",
				rawR2Key: `sent/${draftId}`,
				createdAt,
			});
			(instance as Backfiller).backfillSentBodyText();
			return { plain: bodyOf(state, plainInbound), stray: bodyOf(state, strayInbound) };
		});

		expect(result.plain).toBeNull();
		expect(result.stray).toBeNull();
	});

	it("keeps a body the copy already has and skips drafts it cannot trust", async () => {
		const result = await withMailbox("mbx-backfill-skip", async (instance, state) => {
			const createdAt = "2026-10-26T10:00:00.000Z";

			const keptDraft = seedDraft(state, { bodyText: "texto del borrador" });
			const kept = seedMessage(state, {
				draftId: keptDraft,
				bodyText: "texto que ya estaba",
				createdAt,
			});

			const emptyDraft = seedDraft(state, { bodyText: null, bodyHtml: "<p>solo html</p>" });
			const htmlOnly = seedMessage(state, { draftId: emptyDraft, createdAt });

			// Edited after the send: the draft's text is no longer what went out.
			const editedDraft = seedDraft(state, { bodyText: "editado despues del envio" });
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET updated_at = '2026-10-27T09:00:00.000Z' WHERE id = ?",
				editedDraft,
			);
			const edited = seedMessage(state, { draftId: editedDraft, createdAt });

			const orphan = seedMessage(state, { draftId: "no-such-draft", createdAt });

			(instance as Backfiller).backfillSentBodyText();
			return {
				kept: bodyOf(state, kept),
				htmlOnly: bodyOf(state, htmlOnly),
				edited: bodyOf(state, edited),
				orphan: bodyOf(state, orphan),
			};
		});

		expect(result.kept).toBe("texto que ya estaba");
		expect(result.htmlOnly).toBeNull();
		expect(result.edited).toBeNull();
		expect(result.orphan).toBeNull();
	});

	it("is a no-op when run twice", async () => {
		const result = await withMailbox("mbx-backfill-twice", async (instance, state) => {
			const draftId = seedDraft(state, { bodyText: "primera version" });
			const draftRow = state.storage.sql
				.exec<{ updated_at: string }>(
					"SELECT updated_at FROM outbound_drafts WHERE id = ?",
					draftId,
				)
				.toArray()[0];
			const messageId = seedMessage(state, { draftId, createdAt: draftRow?.updated_at ?? "" });

			(instance as Backfiller).backfillSentBodyText();
			const afterFirst = bodyOf(state, messageId);
			// A second pass must neither rewrite the body it filled in nor error.
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET body_text = 'otra version' WHERE id = ?",
				draftId,
			);
			(instance as Backfiller).backfillSentBodyText();
			return { afterFirst, afterSecond: bodyOf(state, messageId) };
		});

		expect(result.afterFirst).toBe("primera version");
		expect(result.afterSecond).toBe("primera version");
	});

	it("runs once when a mailbox that predates v7 starts up", async () => {
		const name = "mbx-backfill-coldstart";
		const stub = testEnv.MAILBOX_DO.getByName(name);
		const messageId = await runInDurableObject(stub, async (_instance, state) => {
			const draftId = seedDraft(state, { bodyText: "Cuerpo del envio antiguo" });
			const draftRow = state.storage.sql
				.exec<{ updated_at: string }>(
					"SELECT updated_at FROM outbound_drafts WHERE id = ?",
					draftId,
				)
				.toArray()[0];
			const id = seedMessage(state, { draftId, createdAt: draftRow?.updated_at ?? "" });
			// Put the mailbox back at the version production is on today.
			state.storage.sql.exec("DELETE FROM schema_migrations WHERE version >= 7");
			return id;
		});

		// A stub from before the abort is dead; the next one builds a fresh instance,
		// and its constructor does the work.
		await abortAllDurableObjects();
		const freshStub = testEnv.MAILBOX_DO.getByName(name);
		const after = await runInDurableObject(freshStub, async (_instance, state) => ({
			body: bodyOf(state, messageId),
			version: state.storage.sql
				.exec<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations")
				.toArray()[0]?.v,
		}));

		expect(after.body).toBe("Cuerpo del envio antiguo");
		expect(after.version).toBe(7);
	});
});
