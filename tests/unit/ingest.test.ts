import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import attachmentSmallEml from "../../fixtures/mime/attachment-small.eml?raw";
import duplicateAEml from "../../fixtures/mime/duplicate-message-id-a.eml?raw";
import duplicateBEml from "../../fixtures/mime/duplicate-message-id-b.eml?raw";
import missingMessageIdEml from "../../fixtures/mime/missing-message-id.eml?raw";
import multipartAlternativeEml from "../../fixtures/mime/multipart-alternative.eml?raw";

type TestEnv = Env & { MAIL_OBJECTS: R2Bucket; MAILBOX_DO: DurableObjectNamespace };

const testEnv = env as unknown as TestEnv;

function mailboxStub(mailboxId: string) {
	return testEnv.MAILBOX_DO.getByName(mailboxId);
}

async function putRaw(
	mailboxId: string,
	bytes: Uint8Array,
): Promise<{ rawR2Key: string; rawSha256: string }> {
	const rawSha256 = await sha256Hex(bytes);
	const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, bytes);
	return { rawR2Key, rawSha256 };
}

function buildQueueMessage(input: {
	mailboxId: string;
	rawBytes: Uint8Array;
	rawR2Key: string;
	rawSha256: string;
	messageId: string | null;
	subject: string | null;
}): InboundEmailQueueMessage {
	return {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: new Date().toISOString(),
		receivedAt: new Date().toISOString(),
		mailboxId: input.mailboxId,
		domain: "example.com",
		recipient: "test@example.com",
		sender: "sender@example.com",
		rawR2Key: input.rawR2Key,
		rawSha256: input.rawSha256,
		rawSize: input.rawBytes.byteLength,
		messageId: input.messageId,
		headers: {
			subject: input.subject,
			date: null,
			inReplyTo: null,
			references: [],
		},
		routing: {
			ruleId: null,
			action: "store",
			matchedAlias: "test@example.com",
		},
		idempotencyKey: inboundIdempotencyKey({
			mailboxId: input.mailboxId,
			messageId: input.messageId,
			rawSha256: input.rawSha256,
		}),
	};
}

async function ingestFixture(
	mailboxId: string,
	fixtureText: string,
	messageId: string | null,
	subject: string,
): Promise<{ status: number; result: Record<string, unknown> }> {
	const rawBytes = new TextEncoder().encode(fixtureText);
	const { rawR2Key, rawSha256 } = await putRaw(mailboxId, rawBytes);
	const message = buildQueueMessage({
		mailboxId,
		rawBytes,
		rawR2Key,
		rawSha256,
		messageId,
		subject,
	});
	const response = await mailboxStub(mailboxId).fetch("https://mailbox-do/ingest", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(message),
	});
	return { status: response.status, result: (await response.json()) as Record<string, unknown> };
}

async function getDoMessage(
	mailboxId: string,
	messageLocalId: string,
): Promise<Record<string, unknown>> {
	const response = await mailboxStub(mailboxId).fetch(
		`https://mailbox-do/messages/${messageLocalId}`,
	);
	const payload = (await response.json()) as { message: Record<string, unknown> };
	return payload.message;
}

// Generates a multipart/mixed MIME structure nested past PostalMime's
// maxNestingDepth (256), causing parseMimeBytes() to throw deterministically.
// This exercises the ingest parse-failure fallback path with realistic
// "deliberately malformed" bytes rather than a contrived parser error.
function buildDeeplyNestedMimeBytes(depth: number, messageId: string): Uint8Array {
	let body = "Final part.\n";
	for (let i = depth; i >= 1; i--) {
		const boundary = `level-${i}`;
		body = `Content-Type: multipart/mixed; boundary="${boundary}"\n\n--${boundary}\n${body}\n--${boundary}--\n`;
	}
	const text = `From: sender@example.com\nTo: test@example.com\nSubject: Deeply nested bomb\nMessage-ID: <${messageId}>\n${body}`;
	return new TextEncoder().encode(text);
}

describe("mailbox DO ingest", () => {
	it("dedups a redelivery of the same message-id and raw bytes as duplicate", async () => {
		const mailboxId = "mbx_ingest_dedupe";

		const first = await ingestFixture(
			mailboxId,
			duplicateAEml as string,
			"duplicate-shared-id@example.com",
			"Duplicate Message-ID A",
		);
		expect(first.status).toBe(200);
		expect(first.result.status).toBe("inserted");
		expect(first.result.messageLocalId).toBeTruthy();

		const second = await ingestFixture(
			mailboxId,
			duplicateAEml as string,
			"duplicate-shared-id@example.com",
			"Duplicate Message-ID A",
		);
		expect(second.status).toBe(200);
		expect(second.result.status).toBe("duplicate");
		expect(second.result.messageLocalId).toBe(first.result.messageLocalId);

		const debugResp = await mailboxStub(mailboxId).fetch("https://mailbox-do/debug");
		const debug = (await debugResp.json()) as { messageCount: number };
		expect(debug.messageCount).toBe(1);
	});

	it("resolves a shared message-id with a different raw sha256 as a conflict", async () => {
		const mailboxId = "mbx_ingest_conflict";

		const first = await ingestFixture(
			mailboxId,
			duplicateAEml as string,
			"duplicate-shared-id@example.com",
			"Duplicate Message-ID A",
		);
		expect(first.result.status).toBe("inserted");

		const second = await ingestFixture(
			mailboxId,
			duplicateBEml as string,
			"duplicate-shared-id@example.com",
			"Duplicate Message-ID B",
		);
		expect(second.status).toBe(200);
		expect(second.result.status).toBe("conflict");
		expect(second.result.errorCode).toBe("message_id_conflict");
		expect(second.result.messageLocalId).toBe("");

		const debugResp = await mailboxStub(mailboxId).fetch("https://mailbox-do/debug");
		const debug = (await debugResp.json()) as { messageCount: number };
		expect(debug.messageCount).toBe(1);
	});

	it("falls back to a raw-sha256 idempotency key when Message-ID is missing, and still dedups retries", async () => {
		const mailboxId = "mbx_ingest_missing_id";

		const first = await ingestFixture(
			mailboxId,
			missingMessageIdEml as string,
			null,
			"Missing Message-ID",
		);
		expect(first.result.status).toBe("inserted");
		expect(first.result.idempotencyKey).toMatch(
			/^email:v1:mbx_ingest_missing_id:raw-sha256:[0-9a-f]{64}$/,
		);
		expect(first.result.rfcMessageId).toBeNull();

		const retry = await ingestFixture(
			mailboxId,
			missingMessageIdEml as string,
			null,
			"Missing Message-ID",
		);
		expect(retry.result.status).toBe("duplicate");
		expect(retry.result.messageLocalId).toBe(first.result.messageLocalId);
	});

	it("stores the parsed body for a multipart/alternative message", async () => {
		const mailboxId = "mbx_ingest_multipart_alt";

		const { result } = await ingestFixture(
			mailboxId,
			multipartAlternativeEml as string,
			"multipart-alternative-fixture@example.com",
			"Multipart alternative",
		);
		expect(result.status).toBe("inserted");
		expect(result.parseStatus).toBe("parsed");

		const message = await getDoMessage(mailboxId, result.messageLocalId as string);
		expect(message.parse_status).toBe("parsed");
		expect(message.body_text).toContain("Plain part of multipart alternative");
		expect(message.body_html_r2_key).toBeTruthy();

		const htmlObject = await testEnv.MAIL_OBJECTS.get(message.body_html_r2_key as string);
		expect(htmlObject).not.toBeNull();
		const html = await htmlObject?.text();
		expect(html).toContain("HTML part of multipart alternative");
	});

	it("persists attachments to R2 and marks has_attachments on the message row", async () => {
		const mailboxId = "mbx_ingest_attachment";

		const { result } = await ingestFixture(
			mailboxId,
			attachmentSmallEml as string,
			"attachment-small-fixture@example.com",
			"Attachment small",
		);
		expect(result.status).toBe("inserted");
		expect(result.hasAttachments).toBe(true);

		const message = await getDoMessage(mailboxId, result.messageLocalId as string);
		expect(message.has_attachments).toBe(1);
		const attachments = message.attachments as Array<{ filename: string; r2_key: string }>;
		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.filename).toBe("note.txt");

		const attachmentObject = await testEnv.MAIL_OBJECTS.get(attachments[0]!.r2_key);
		expect(attachmentObject).not.toBeNull();
		const text = await attachmentObject?.text();
		expect(text).toContain("Hello attachment content.");
	});

	it("falls back to a parse_status=failed row when MIME parsing throws on malformed bytes", async () => {
		const mailboxId = "mbx_ingest_parse_failure";
		const messageId = "deeply-nested-bomb@example.com";
		const rawBytes = buildDeeplyNestedMimeBytes(300, messageId);
		const { rawR2Key, rawSha256 } = await putRaw(mailboxId, rawBytes);
		const message = buildQueueMessage({
			mailboxId,
			rawBytes,
			rawR2Key,
			rawSha256,
			messageId,
			subject: "Deeply nested bomb",
		});

		const response = await mailboxStub(mailboxId).fetch("https://mailbox-do/ingest", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		});
		expect(response.status).toBe(200);
		const result = (await response.json()) as Record<string, unknown>;

		// The DO never surfaces the parser error as an HTTP failure: it records a
		// best-effort row with parse_status="failed" instead of dropping the email.
		expect(result.status).toBe("inserted");
		expect(result.parseStatus).toBe("failed");

		const row = await getDoMessage(mailboxId, result.messageLocalId as string);
		expect(row.parse_status).toBe("failed");
		expect(row.has_attachments).toBe(0);
	});

	it("resolves two concurrent ingests of the same idempotency key to exactly one inserted and one duplicate", async () => {
		const mailboxId = "mbx_ingest_concurrent";
		const rawBytes = new TextEncoder().encode(duplicateAEml as string);
		const { rawR2Key, rawSha256 } = await putRaw(mailboxId, rawBytes);
		const message = buildQueueMessage({
			mailboxId,
			rawBytes,
			rawR2Key,
			rawSha256,
			messageId: "duplicate-shared-id@example.com",
			subject: "Duplicate Message-ID A",
		});
		const body = JSON.stringify(message);

		// Two requests for the same idempotency key racing through the await
		// points in ingestInboundEmail (R2 get, MIME parse) before either has
		// committed its insert. This is the TOCTOU window the unique-constraint
		// fallback in mailbox-ingest.ts guards against.
		const [responseA, responseB] = await Promise.all([
			mailboxStub(mailboxId).fetch("https://mailbox-do/ingest", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
			mailboxStub(mailboxId).fetch("https://mailbox-do/ingest", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
			}),
		]);

		expect(responseA.status).toBe(200);
		expect(responseB.status).toBe(200);
		const resultA = (await responseA.json()) as { status: string; messageLocalId: string };
		const resultB = (await responseB.json()) as { status: string; messageLocalId: string };

		const statuses = [resultA.status, resultB.status].sort();
		expect(statuses).toEqual(["duplicate", "inserted"]);
		// Both responses must agree on which message actually won the race.
		const winner = resultA.status === "inserted" ? resultA : resultB;
		const loser = resultA.status === "inserted" ? resultB : resultA;
		expect(loser.messageLocalId).toBe(winner.messageLocalId);

		const debugResp = await mailboxStub(mailboxId).fetch("https://mailbox-do/debug");
		const debug = (await debugResp.json()) as { messageCount: number };
		expect(debug.messageCount).toBe(1);
	});

	it("returns thread detail with a top-level messages array (not double-wrapped)", async () => {
		const mailboxId = "mbx_thread_detail_shape";

		const ingest = await ingestFixture(
			mailboxId,
			attachmentSmallEml as string,
			"thread-detail-shape@example.com",
			"Thread detail shape",
		);
		expect(ingest.result.status).toBe("inserted");

		const threadsResp = await mailboxStub(mailboxId).fetch("https://mailbox-do/threads?limit=50");
		const { threads } = (await threadsResp.json()) as { threads: Array<{ id: string }> };
		const firstThread = threads[0];
		if (!firstThread) throw new Error("expected at least one thread after ingest");

		const detailResp = await mailboxStub(mailboxId).fetch(
			`https://mailbox-do/threads/${firstThread.id}`,
		);
		const detail = (await detailResp.json()) as {
			thread?: unknown;
			messages?: Array<{ id: string }>;
		};

		// Regression: the handler used to double-wrap as { thread: { thread, messages } },
		// so the reading pane's data.messages was undefined and stayed empty on click.
		expect(Array.isArray(detail.messages)).toBe(true);
		expect(detail.messages?.length).toBeGreaterThan(0);
		expect(detail.thread).toBeTruthy();
	});
});
