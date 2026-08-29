import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";

/**
 * Which thread an inbound mail joins. The header match (In-Reply-To/References) is
 * authoritative; the subject fallback is a guess, and this file is mostly about
 * keeping that guess narrow — production had a July "test" and an August "Test"
 * welded into one thread, and a catch-all address makes generic subjects endless.
 */

type TestEnv = Env & { MAIL_OBJECTS: R2Bucket; MAILBOX_DO: DurableObjectNamespace };
const testEnv = env as unknown as TestEnv;

const MAILBOX_ADDRESS = "hello@imsanti.dev";

function buildEml(input: {
	from: string;
	to: string;
	subject: string;
	messageId: string;
	inReplyTo?: string;
	references?: string[];
}): string {
	const lines = [
		`From: ${input.from}`,
		`To: ${input.to}`,
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
	];
	if (input.inReplyTo) lines.push(`In-Reply-To: <${input.inReplyTo}>`);
	if (input.references?.length) {
		lines.push(`References: ${input.references.map((id) => `<${id}>`).join(" ")}`);
	}
	lines.push("MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "Hola.", "");
	return lines.join("\n");
}

async function ingest(
	mailboxId: string,
	input: {
		from: string;
		to?: string;
		subject: string;
		messageId: string;
		receivedAt: string;
		inReplyTo?: string;
		references?: string[];
	},
): Promise<Record<string, unknown>> {
	const to = input.to ?? MAILBOX_ADDRESS;
	const rawBytes = new TextEncoder().encode(buildEml({ ...input, to }));
	const rawSha256 = await sha256Hex(rawBytes);
	const rawR2Key = rawEmailR2Key({
		mailboxId,
		receivedAt: new Date(input.receivedAt),
		rawSha256,
	});
	await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: input.receivedAt,
		receivedAt: input.receivedAt,
		mailboxId,
		domain: "imsanti.dev",
		recipient: to,
		sender: input.from,
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId: input.messageId,
		headers: {
			subject: input.subject,
			date: null,
			inReplyTo: input.inReplyTo ?? null,
			references: input.references ?? [],
		},
		routing: { ruleId: null, action: "store", matchedAlias: to },
		idempotencyKey: inboundIdempotencyKey({
			mailboxId,
			messageId: input.messageId,
			rawSha256,
		}),
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
	return (await response.json()) as Record<string, unknown>;
}

describe("subject fallback threading", () => {
	it("merges two same-subject mails from the same person inside the window", async () => {
		const mailboxId = "mbx_merge_window_in";
		const first = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Test",
			messageId: "merge-in-1@example.com",
			receivedAt: "2026-08-20T10:00:00.000Z",
		});
		// No References header: exactly the client behavior the fallback exists for.
		const second = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "test",
			messageId: "merge-in-2@example.com",
			receivedAt: "2026-08-28T10:00:00.000Z",
		});

		expect(second.threadId).toBe(first.threadId);
	});

	it("does not merge same-subject mails separated by more than the window", async () => {
		const mailboxId = "mbx_merge_window_out";
		const first = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "test",
			messageId: "merge-out-1@example.com",
			receivedAt: "2026-07-05T10:00:00.000Z",
		});
		const second = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Test",
			messageId: "merge-out-2@example.com",
			receivedAt: "2026-08-28T10:00:00.000Z",
		});

		expect(second.threadId).not.toBe(first.threadId);
	});

	it("does not merge same-subject mails from unrelated people inside the window", async () => {
		const mailboxId = "mbx_merge_no_participant";
		const first = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Factura",
			messageId: "merge-part-1@example.com",
			receivedAt: "2026-08-20T10:00:00.000Z",
		});
		const second = await ingest(mailboxId, {
			from: "otro@otra-empresa.com",
			subject: "Factura",
			messageId: "merge-part-2@example.com",
			receivedAt: "2026-08-28T10:00:00.000Z",
		});

		expect(second.threadId).not.toBe(first.threadId);
	});

	it("still merges when a shared participant is only a Cc of the earlier mail", async () => {
		const mailboxId = "mbx_merge_cc";
		const rawBytes = new TextEncoder().encode(
			[
				"From: alguien@example.com",
				`To: ${MAILBOX_ADDRESS}`,
				"Cc: socio@otra-empresa.com",
				"Subject: Presupuesto",
				"Message-ID: <merge-cc-1@example.com>",
				"MIME-Version: 1.0",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Hola.",
				"",
			].join("\n"),
		);
		const rawSha256 = await sha256Hex(rawBytes);
		const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
		await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
		const stub = testEnv.MAILBOX_DO.getByName(mailboxId);
		const firstResponse = await stub.fetch("https://mailbox-do/ingest", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				schemaVersion: 1,
				eventType: "email.received.v1",
				traceId: crypto.randomUUID(),
				enqueuedAt: "2026-08-20T10:00:00.000Z",
				receivedAt: "2026-08-20T10:00:00.000Z",
				mailboxId,
				domain: "imsanti.dev",
				recipient: MAILBOX_ADDRESS,
				sender: "alguien@example.com",
				rawR2Key,
				rawSha256,
				rawSize: rawBytes.byteLength,
				messageId: "merge-cc-1@example.com",
				headers: { subject: "Presupuesto", date: null, inReplyTo: null, references: [] },
				routing: { ruleId: null, action: "store", matchedAlias: MAILBOX_ADDRESS },
				idempotencyKey: inboundIdempotencyKey({
					mailboxId,
					messageId: "merge-cc-1@example.com",
					rawSha256,
				}),
			}),
		});
		const first = (await firstResponse.json()) as Record<string, unknown>;

		// The Cc'd party writes in later without quoting anything: same subject, and a
		// participant the thread already knows.
		const second = await ingest(mailboxId, {
			from: "socio@otra-empresa.com",
			subject: "Presupuesto",
			messageId: "merge-cc-2@example.com",
			receivedAt: "2026-08-28T10:00:00.000Z",
		});

		expect(second.threadId).toBe(first.threadId);
	});

	it("keeps threading on References even far outside the subject window", async () => {
		const mailboxId = "mbx_merge_references";
		const first = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Presupuesto anual",
			messageId: "ref-root@example.com",
			receivedAt: "2026-01-05T10:00:00.000Z",
		});
		const second = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Re: Presupuesto anual",
			messageId: "ref-reply@example.com",
			receivedAt: "2026-08-28T10:00:00.000Z",
			inReplyTo: "ref-root@example.com",
			references: ["ref-root@example.com"],
		});

		expect(second.threadId).toBe(first.threadId);
	});
});

describe("case-sensitive message-ids", () => {
	it("threads a reply whose In-Reply-To keeps the original case", async () => {
		const mailboxId = "mbx_case_roundtrip";
		const messageId = "CAHyeH21QU_oLHbS6X8oP9R9iSBKuh2W8-BSCbZ4Zcq8BMKcqZw@mail.gmail.com";
		const first = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Hola",
			messageId,
			receivedAt: "2026-08-28T10:00:00.000Z",
		});
		expect(first.rfcMessageId).toBe(messageId);

		const second = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Re: Hola",
			messageId: "case-reply@example.com",
			receivedAt: "2026-08-28T11:00:00.000Z",
			inReplyTo: messageId,
			references: [messageId],
		});
		expect(second.threadId).toBe(first.threadId);
	});

	it("threads a mixed-case In-Reply-To onto a row stored lowercase by an older version", async () => {
		const mailboxId = "mbx_case_legacy";
		const original = "CAHyeH21QU_oLHbS6X8oP9R9iSBKuh2W8-BSCbZ4Zcq8BMKcqZw@mail.gmail.com";
		const stub = testEnv.MAILBOX_DO.getByName(mailboxId);

		// Exactly what production holds: an id flattened to lowercase on ingest.
		const legacyThreadId = await runInDurableObject(stub, async (_instance, state) => {
			const threadId = crypto.randomUUID();
			const messageLocalId = crypto.randomUUID();
			const now = "2026-08-01T10:00:00.000Z";
			state.storage.sql.exec(
				`INSERT INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
         VALUES (?, 'hola', ?, 1, 1, ?, ?)`,
				threadId,
				now,
				now,
				now,
			);
			state.storage.sql.exec(
				`INSERT INTO messages
         (id, idempotency_key, thread_id, rfc_message_id, in_reply_to, references_json, direction, state,
          from_addr, to_json, cc_json, bcc_json, subject, snippet, received_at, raw_r2_key, raw_sha256,
          raw_size, parse_status, has_attachments, is_read, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, '[]', 'inbound', 'inbox', 'cliente@example.com', ?,
                 '[]', '[]', 'Hola', 'hola', ?, 'raw/legacy', 'sha-legacy', 10, 'parsed', 0, 0, ?, ?)`,
				messageLocalId,
				`legacy:${messageLocalId}`,
				threadId,
				original.toLowerCase(),
				JSON.stringify([MAILBOX_ADDRESS]),
				now,
				now,
				now,
			);
			return threadId;
		});

		const reply = await ingest(mailboxId, {
			from: "cliente@example.com",
			subject: "Re: Hola",
			messageId: "legacy-reply@example.com",
			receivedAt: "2026-08-28T10:00:00.000Z",
			inReplyTo: original,
			references: [original],
		});

		expect(reply.threadId).toBe(legacyThreadId);
	});
});
