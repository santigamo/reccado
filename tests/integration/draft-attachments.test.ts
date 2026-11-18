import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { confirmSendDraft } from "#/do/mailbox-do";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT } from "#/lib/attachment-limits";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import worker from "#/server";
import attachmentImageEml from "../../fixtures/mime/attachment-image.eml?raw";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { applyMigrations } from "../helpers/migrations";

/**
 * Files on drafts, end to end: the owner-session routes that put them in R2 and
 * on the draft, the limits, the send that carries them (and the sent copy that
 * lists them), the payload hash that covers them, forwarding by reference, and
 * what happens to the R2 objects when a draft is discarded, restored or sent.
 */

type TestEnv = Env & { MAIL_OBJECTS: R2Bucket; INDEX_DB: D1Database };
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyMigrations(
		testEnv.INDEX_DB,
		migrationInitial,
		migrationMessageIndex,
		migrationMailboxOwner,
	);
});

type DraftAttachmentDto = {
	id: string;
	filename: string;
	content_type: string;
	size: number;
	sha256: string;
	source: "upload" | "message";
	source_attachment_id: string | null;
};

async function fetchWorker(request: Request, workerEnv: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, workerEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function newMailbox(): Promise<string> {
	const mailboxId = `mbx_att_${crypto.randomUUID().slice(0, 8)}`;
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

async function createDraft(mailboxId: string, body: Record<string, unknown> = {}): Promise<string> {
	const response = await api(mailboxId, "/drafts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			to: ["client@example.net"],
			subject: "Files",
			bodyText: "Attached.",
			...body,
		}),
	});
	expect(response.status).toBe(201);
	return ((await response.json()) as { id: string }).id;
}

function upload(
	mailboxId: string,
	draftId: string,
	filename: string,
	bytes: Uint8Array,
	type = "application/pdf",
): Promise<Response> {
	return api(mailboxId, `/drafts/${draftId}/attachments?filename=${encodeURIComponent(filename)}`, {
		method: "POST",
		headers: { "content-type": type },
		body: bytes as Uint8Array<ArrayBuffer>,
	});
}

async function uploaded(
	mailboxId: string,
	draftId: string,
	filename: string,
	bytes: Uint8Array,
	type?: string,
): Promise<DraftAttachmentDto> {
	const response = await upload(mailboxId, draftId, filename, bytes, type);
	expect(response.status).toBe(201);
	return ((await response.json()) as { attachment: DraftAttachmentDto }).attachment;
}

async function getDraft(mailboxId: string, draftId: string) {
	const response = await api(mailboxId, `/drafts/${draftId}`);
	return (
		(await response.json()) as {
			draft: { status: string; attachments: DraftAttachmentDto[] };
		}
	).draft;
}

async function draftObjects(mailboxId: string, draftId: string): Promise<string[]> {
	const listed = await testEnv.MAIL_OBJECTS.list({ prefix: `drafts/dev/${mailboxId}/${draftId}/` });
	return listed.objects.map((o) => o.key);
}

function arm(mailboxId: string, draftId: string, replaceStale = false) {
	return testEnv.MAILBOX_DO.getByName(mailboxId)
		.fetch(`https://mailbox-do/drafts/${draftId}/request-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mailboxAddress: `${mailboxId}@example.com`, replaceStale }),
		})
		.then((r) => r.json() as Promise<{ payload_hash?: string; error?: string; status: string }>);
}

type Sent = {
	attachments?: Array<{ filename: string; type: string; disposition: string; content: string }>;
};

function confirm(mailboxId: string, draftId: string, key: string, sent: Sent[]) {
	return runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (_i, state) =>
		confirmSendDraft(
			{
				sql: state.storage.sql,
				transactionSync: (fn) => state.storage.transactionSync(fn),
				email: {
					send: async (mail: Sent) => {
						sent.push(mail);
						return { messageId: `<${crypto.randomUUID()}@cloudflare.email>` };
					},
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

function fromBase64(value: string): Uint8Array {
	return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

const PDF = new TextEncoder().encode("%PDF-1.4 fake invoice");

describe("uploading files to a draft", () => {
	it("stores the bytes in R2 under the draft and lists the file with the draft", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const attachment = await uploaded(mailboxId, draftId, "Factura año 2026.pdf", PDF);

		expect(attachment).toMatchObject({
			filename: "Factura año 2026.pdf",
			content_type: "application/pdf",
			size: PDF.byteLength,
			sha256: await sha256Hex(PDF),
			source: "upload",
		});
		const keys = await draftObjects(mailboxId, draftId);
		expect(keys).toEqual([
			`drafts/dev/${mailboxId}/${draftId}/${attachment.id}-Factura_a_o_2026.pdf`,
		]);

		const draft = await getDraft(mailboxId, draftId);
		expect(draft.attachments.map((a) => a.id)).toEqual([attachment.id]);
		const list = (await (await api(mailboxId, "/drafts")).json()) as {
			drafts: Array<{ id: string; attachment_count: number }>;
		};
		expect(list.drafts.find((d) => d.id === draftId)?.attachment_count).toBe(1);
	});

	it("serves a draft file back only as a hardened download, whatever it claims to be", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const html = new TextEncoder().encode("<script>alert(1)</script>");
		const attachment = await uploaded(mailboxId, draftId, "page.html", html, "text/html");

		const response = await api(mailboxId, `/drafts/${draftId}/attachments/${attachment.id}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-disposition")).toBe('attachment; filename="page.html"');
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(html);
	});

	it("keeps a traversal-shaped name inside the draft prefix", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const attachment = await uploaded(mailboxId, draftId, "../../../etc/passwd", PDF, "text/plain");
		expect(attachment.filename).toBe("passwd");
		expect(await draftObjects(mailboxId, draftId)).toEqual([
			`drafts/dev/${mailboxId}/${draftId}/${attachment.id}-passwd`,
		]);
	});

	it("refuses a file over the size limit before storing anything", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const response = await upload(
			mailboxId,
			draftId,
			"big.bin",
			new Uint8Array(MAX_ATTACHMENT_BYTES + 1),
		);
		expect(response.status).toBe(413);
		expect(((await response.json()) as { error: string }).error).toBe("attachment_too_large");
		expect(await draftObjects(mailboxId, draftId)).toEqual([]);
	});

	it("refuses an empty file", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const response = await upload(mailboxId, draftId, "empty.txt", new Uint8Array(0));
		expect(response.status).toBe(400);
	});

	it("refuses the file that would break the count or the total, and deletes its object", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		for (let i = 0; i < MAX_ATTACHMENT_COUNT; i++) {
			await uploaded(
				mailboxId,
				draftId,
				`f${i}.txt`,
				new TextEncoder().encode(`file ${i}`),
				"text/plain",
			);
		}
		const over = await upload(mailboxId, draftId, "one-more.txt", new TextEncoder().encode("x"));
		expect(over.status).toBe(413);
		expect(((await over.json()) as { error: string }).error).toBe("too_many_attachments");
		expect(await draftObjects(mailboxId, draftId)).toHaveLength(MAX_ATTACHMENT_COUNT);

		const second = await createDraft(mailboxId);
		const half = new Uint8Array(Math.floor(MAX_ATTACHMENT_BYTES / 2) + 1);
		await uploaded(mailboxId, second, "half-1.bin", half);
		const total = await upload(mailboxId, second, "half-2.bin", half);
		expect(total.status).toBe(413);
		expect(((await total.json()) as { error: string }).error).toBe("attachments_too_large");
		expect(await draftObjects(mailboxId, second)).toHaveLength(1);
	});

	it("never attaches files to a draft that is still the agent's", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		// An agent can no longer claim an owner draft, so mark it as the agent's directly.
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (_instance, state) => {
			state.storage.sql.exec("UPDATE outbound_drafts SET origin = 'mcp' WHERE id = ?", draftId);
		});
		const response = await upload(mailboxId, draftId, "a.pdf", PDF);
		expect(response.status).toBe(409);
		expect(((await response.json()) as { error: string }).error).toBe("agent_draft_attachments");
		expect(await draftObjects(mailboxId, draftId)).toEqual([]);
	});

	it("removes a file from the draft and its object from R2", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const attachment = await uploaded(mailboxId, draftId, "a.pdf", PDF);
		const response = await api(mailboxId, `/drafts/${draftId}/attachments/${attachment.id}`, {
			method: "DELETE",
		});
		expect(response.status).toBe(200);
		expect((await getDraft(mailboxId, draftId)).attachments).toEqual([]);
		expect(await draftObjects(mailboxId, draftId)).toEqual([]);
	});

	it("requires the owner web session", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const remote = (path: string, init?: RequestInit) =>
			fetchWorker(
				new Request(`https://reccado.example.com/api/mailboxes/${mailboxId}${path}`, init),
				{ ...env, BETTER_AUTH_SECRET: undefined } as Env,
			);
		const post = await remote(`/drafts/${draftId}/attachments?filename=a.pdf`, {
			method: "POST",
			headers: { "content-type": "application/pdf" },
			body: PDF,
		});
		expect(post.status).toBe(401);
		expect(await draftObjects(mailboxId, draftId)).toEqual([]);
		const attachment = await uploaded(mailboxId, draftId, "a.pdf", PDF);
		expect((await remote(`/drafts/${draftId}/attachments/${attachment.id}`)).status).toBe(401);
		expect(
			(await remote(`/drafts/${draftId}/attachments/${attachment.id}`, { method: "DELETE" }))
				.status,
		).toBe(401);
	});
});

describe("sending a draft with files", () => {
	it("hands every file to the provider and the sent copy lists them like received mail", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
		const a = await uploaded(mailboxId, draftId, "Factura año.pdf", PDF);
		const b = await uploaded(mailboxId, draftId, "pixel.png", png, "image/png");
		await arm(mailboxId, draftId);

		const sent: Sent[] = [];
		const result = await confirm(mailboxId, draftId, `attempt-${draftId}`, sent);
		expect(result.sent).toBe(true);
		expect(result.hasAttachments).toBe(true);
		expect(sent).toHaveLength(1);
		const parts = sent[0]!.attachments!;
		expect(parts.map((p) => [p.filename, p.type, p.disposition])).toEqual([
			["Factura año.pdf", "application/pdf", "attachment"],
			["pixel.png", "image/png", "attachment"],
		]);
		expect(fromBase64(parts[0]!.content)).toEqual(PDF);
		expect(fromBase64(parts[1]!.content)).toEqual(png);

		// Idempotent: the same key never sends twice.
		const again = await confirm(mailboxId, draftId, `attempt-${draftId}`, sent);
		expect(again.duplicate).toBe(true);
		expect(sent).toHaveLength(1);

		// The sent copy: has_attachments, rows on the same objects, served by the
		// ordinary message attachment route. The draft rows are gone; the objects
		// stay, now owned by the message.
		const messageId = String(result.messageLocalId);
		const message = (await (await api(mailboxId, `/messages/${messageId}`)).json()) as {
			message: {
				has_attachments: number;
				attachments: Array<{ id: string; filename: string; r2_key: string; sha256: string }>;
			};
		};
		expect(message.message.has_attachments).toBe(1);
		expect(message.message.attachments.map((x) => x.filename)).toEqual([
			"Factura año.pdf",
			"pixel.png",
		]);
		expect(message.message.attachments.map((x) => x.sha256)).toEqual([a.sha256, b.sha256]);
		const download = await api(
			mailboxId,
			`/messages/${messageId}/attachments/${message.message.attachments[1]!.id}`,
		);
		expect(download.status).toBe(200);
		expect(new Uint8Array(await download.arrayBuffer())).toEqual(png);
		const leftovers = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			(_i, state) =>
				state.storage.sql
					.exec("SELECT id FROM draft_attachments WHERE draft_id = ?", draftId)
					.toArray(),
		);
		expect(leftovers).toEqual([]);
		expect(await draftObjects(mailboxId, draftId)).toHaveLength(2);
	});

	it("sends nothing when a confirmed file disappeared, and frees the attempt for a retry", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const attachment = await uploaded(mailboxId, draftId, "a.pdf", PDF);
		await arm(mailboxId, draftId);
		for (const key of await draftObjects(mailboxId, draftId))
			await testEnv.MAIL_OBJECTS.delete(key);

		const sent: Sent[] = [];
		const failed = await confirm(mailboxId, draftId, "attempt-missing", sent);
		expect(failed).toMatchObject({ sent: false, error: "attachment_missing" });
		expect(sent).toHaveLength(0);

		await api(mailboxId, `/drafts/${draftId}/attachments/${attachment.id}`, { method: "DELETE" });
		await arm(mailboxId, draftId, true);
		const retried = await confirm(mailboxId, draftId, "attempt-missing", sent);
		expect(retried.sent).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0]!.attachments).toBeUndefined();
	});
});

describe("the payload hash covers the files", () => {
	async function twin(mailboxId: string) {
		return createDraft(mailboxId, { subject: "Twin", bodyText: "Same body." });
	}

	it("leaves a draft without files hashing exactly as before attachments existed", async () => {
		const mailboxId = await newMailbox();
		const draftId = await twin(mailboxId);
		const armed = await arm(mailboxId, draftId);
		const intent = (await (
			await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
				`https://mailbox-do/drafts/${draftId}/send-intent`,
			)
		).json()) as { snapshot: Record<string, unknown>; payload_hash: string };
		// The snapshot shape every pre-existing intent froze: attachments: [] last.
		expect(intent.snapshot.attachments).toEqual([]);
		expect(Object.keys(intent.snapshot).at(-1)).toBe("attachments");
		expect(armed.payload_hash).toBe(
			await sha256Hex(new TextEncoder().encode(JSON.stringify(intent.snapshot))),
		);
	});

	it("differs with a file, with another type, and with another order", async () => {
		const mailboxId = await newMailbox();
		const one = new TextEncoder().encode("one");
		const two = new TextEncoder().encode("two");
		const plain = await twin(mailboxId);
		const withFile = await twin(mailboxId);
		await uploaded(mailboxId, withFile, "one.txt", one, "text/plain");
		const otherType = await twin(mailboxId);
		await uploaded(mailboxId, otherType, "one.txt", one, "application/octet-stream");
		const ab = await twin(mailboxId);
		await uploaded(mailboxId, ab, "one.txt", one, "text/plain");
		await uploaded(mailboxId, ab, "two.txt", two, "text/plain");
		const ba = await twin(mailboxId);
		await uploaded(mailboxId, ba, "two.txt", two, "text/plain");
		await uploaded(mailboxId, ba, "one.txt", one, "text/plain");

		const hashes = await Promise.all(
			[plain, withFile, otherType, ab, ba].map(
				async (id) => (await arm(mailboxId, id)).payload_hash,
			),
		);
		expect(new Set(hashes).size).toBe(5);
	});

	it("makes an armed intent stale when a file is added or removed, until it is re-armed", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const before = await arm(mailboxId, draftId);
		const attachment = await uploaded(mailboxId, draftId, "late.pdf", PDF);

		const sent: Sent[] = [];
		const stale = await confirm(mailboxId, draftId, "attempt-stale", sent);
		expect(stale.error).toBe("intent_stale");
		expect(sent).toHaveLength(0);

		const after = await arm(mailboxId, draftId, true);
		expect(after.payload_hash).not.toBe(before.payload_hash);

		await api(mailboxId, `/drafts/${draftId}/attachments/${attachment.id}`, { method: "DELETE" });
		const staleAgain = await confirm(mailboxId, draftId, "attempt-stale-2", sent);
		expect(staleAgain.error).toBe("intent_stale");
		const rearmed = await arm(mailboxId, draftId, true);
		expect(rearmed.payload_hash).toBe(before.payload_hash);
		expect((await confirm(mailboxId, draftId, "attempt-stale-3", sent)).sent).toBe(true);
	});

	it("the web request-send re-freezes a stale draft so Send works again", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		const first = (await (
			await api(mailboxId, `/drafts/${draftId}/request-send`, { method: "POST" })
		).json()) as { payload_hash: string };
		await uploaded(mailboxId, draftId, "late.pdf", PDF);
		const second = (await (
			await api(mailboxId, `/drafts/${draftId}/request-send`, { method: "POST" })
		).json()) as { payload_hash: string };
		expect(second.payload_hash).not.toBe(first.payload_hash);
	});
});

async function ingestFixture(mailboxId: string): Promise<string> {
	const rawBytes = new TextEncoder().encode(attachmentImageEml as string);
	const rawSha256 = await sha256Hex(rawBytes);
	const receivedAt = new Date().toISOString();
	const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(receivedAt), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const messageId = `fwd-${crypto.randomUUID()}@example.com`;
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: receivedAt,
		receivedAt,
		mailboxId,
		domain: "example.com",
		recipient: `${mailboxId}@example.com`,
		sender: "sender@example.com",
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId,
		headers: { subject: "Files", date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: `${mailboxId}@example.com` },
		idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
	};
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		"https://mailbox-do/ingest",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		},
	);
	return ((await response.json()) as { messageLocalId: string }).messageLocalId;
}

describe("forwarding a message with files", () => {
	it("attaches the original's files by reference and sends their bytes", async () => {
		const mailboxId = await newMailbox();
		const originalId = await ingestFixture(mailboxId);
		const original = (await (await api(mailboxId, `/messages/${originalId}`)).json()) as {
			message: { attachments: Array<{ id: string; filename: string; r2_key: string }> };
		};
		expect(original.message.attachments.map((a) => a.filename)).toEqual(["pixel.png", "note.txt"]);

		const draftId = await createDraft(mailboxId, { subject: "Fwd: Files" });
		const response = await api(mailboxId, `/drafts/${draftId}/attachments/from-message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messageId: originalId,
				attachmentIds: original.message.attachments.map((a) => a.id),
			}),
		});
		expect(response.status).toBe(200);
		const { added, skipped } = (await response.json()) as {
			added: DraftAttachmentDto[];
			skipped: unknown[];
		};
		expect(skipped).toEqual([]);
		expect(added.map((a) => [a.filename, a.source])).toEqual([
			["pixel.png", "message"],
			["note.txt", "message"],
		]);
		// No bytes moved: nothing was written under the draft.
		expect(await draftObjects(mailboxId, draftId)).toEqual([]);

		// Dropping one from the forward never deletes the original's object.
		await api(mailboxId, `/drafts/${draftId}/attachments/${added[1]!.id}`, { method: "DELETE" });
		expect(await testEnv.MAIL_OBJECTS.head(original.message.attachments[1]!.r2_key)).not.toBeNull();

		await arm(mailboxId, draftId);
		const sent: Sent[] = [];
		const result = await confirm(mailboxId, draftId, "attempt-fwd", sent);
		expect(result.sent).toBe(true);
		const pixel = await testEnv.MAIL_OBJECTS.get(original.message.attachments[0]!.r2_key);
		expect(fromBase64(sent[0]!.attachments![0]!.content)).toEqual(
			new Uint8Array(await pixel!.arrayBuffer()),
		);
		expect(sent[0]!.attachments!.map((p) => p.filename)).toEqual(["pixel.png"]);
	});
});

describe("discarding a draft with files", () => {
	async function runPurgeNow(mailboxId: string) {
		const stub = testEnv.MAILBOX_DO.getByName(mailboxId);
		await runInDurableObject(stub, (_i, state) => {
			state.storage.sql.exec(
				"UPDATE jobs SET next_run_at = ? WHERE status = 'pending'",
				new Date(Date.now() - 1000).toISOString(),
			);
		});
		await stub.fetch("https://mailbox-do/alarm", { method: "POST" });
	}

	it("keeps the files through the Undo window, and Undo brings them back", async () => {
		const mailboxId = await newMailbox();
		const draftId = await createDraft(mailboxId);
		await uploaded(mailboxId, draftId, "a.pdf", PDF);
		await api(mailboxId, `/drafts/${draftId}/cancel`, { method: "POST" });
		expect(await draftObjects(mailboxId, draftId)).toHaveLength(1);

		const restored = await api(mailboxId, `/drafts/${draftId}/restore`, { method: "POST" });
		expect(restored.status).toBe(200);
		expect((await getDraft(mailboxId, draftId)).attachments).toHaveLength(1);

		// The purge queued by the discard finds a live draft and leaves it alone.
		await runPurgeNow(mailboxId);
		expect(await draftObjects(mailboxId, draftId)).toHaveLength(1);
		expect((await getDraft(mailboxId, draftId)).attachments).toHaveLength(1);
	});

	it("deletes the uploads of a draft still discarded once the window has passed", async () => {
		const mailboxId = await newMailbox();
		const originalId = await ingestFixture(mailboxId);
		const draftId = await createDraft(mailboxId);
		await uploaded(mailboxId, draftId, "a.pdf", PDF);
		await api(mailboxId, `/drafts/${draftId}/attachments/from-message`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ messageId: originalId }),
		});
		await api(mailboxId, `/drafts/${draftId}/cancel`, { method: "POST" });
		const jobs = await runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), (_i, state) =>
			state.storage.sql.exec("SELECT type, status FROM jobs").toArray(),
		);
		expect(jobs).toEqual([{ type: "purge_draft_attachments", status: "pending" }]);

		await runPurgeNow(mailboxId);
		expect(await draftObjects(mailboxId, draftId)).toEqual([]);
		expect((await getDraft(mailboxId, draftId)).attachments).toEqual([]);
		// The forwarded reference was dropped, but the original's object is untouched.
		const original = (await (await api(mailboxId, `/messages/${originalId}`)).json()) as {
			message: { attachments: Array<{ r2_key: string }> };
		};
		for (const a of original.message.attachments) {
			expect(await testEnv.MAIL_OBJECTS.head(a.r2_key)).not.toBeNull();
		}
	});
});
