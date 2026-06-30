import { Hono } from "hono";
import type { ApiBindings } from "./hono";
import { assertMailboxAccess } from "./auth";
import {
	createDraftSchema,
	confirmSendSchema,
	messageActionSchema,
	searchQuerySchema,
	threadListQuerySchema,
	updateDraftSchema,
} from "./schemas";
import {
	createOutboundSendIfMissing,
	deleteMessageIndexForMailbox,
	getMailbox,
	getOutboundSendByIdempotency,
	insertOpsEvent,
	listIngestFailures,
	listOpsEvents,
	updateOutboundSendStatus,
	upsertMessageIndex,
} from "../db/d1";
import { backupManifestR2Key } from "../lib/r2-keys";
import { outboundSendIdempotencyKey } from "../lib/idempotency";
import { AppError } from "../lib/errors";

async function mailboxStub(env: Env, mailboxId: string) {
	const mailbox = await getMailbox(env.INDEX_DB, mailboxId);
	if (!mailbox) {
		throw new AppError("Mailbox not found", "mailbox_not_found", 404);
	}
	return env.MAILBOX_DO.getByName(mailboxId);
}

export function registerMailboxRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/mailboxes/:mailboxId/threads", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		threadListQuerySchema.parse({
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
			q: c.req.query("q"),
			label: c.req.query("label"),
		});
		const stub = await mailboxStub(c.env, mailboxId);
		const url = new URL("https://mailbox-do/threads");
		url.searchParams.set("limit", c.req.query("limit") ?? "25");
		return stub.fetch(url.toString());
	});

	api.get("/api/mailboxes/:mailboxId/threads/:threadId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/threads/${c.req.param("threadId")}`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/messages/${c.req.param("messageId")}`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId/raw", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/messages/${c.req.param("messageId")}/raw`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId", async (c) => {
		const messageId = c.req.param("messageId");
		const attachmentId = c.req.param("attachmentId");
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		const messageResponse = await stub.fetch(`https://mailbox-do/messages/${messageId}`);
		if (!messageResponse.ok) return messageResponse;
		const payload = (await messageResponse.json()) as {
			message?: { attachments?: Array<{ id: string; r2_key: string; content_type?: string }> };
		};
		const attachment = payload.message?.attachments?.find((row) => row.id === attachmentId);
		if (!attachment) {
			return c.json({ error: "attachment_not_found" }, 404);
		}
		const object = await c.env.MAIL_OBJECTS.get(attachment.r2_key);
		if (!object) {
			return c.json({ error: "attachment_missing" }, 404);
		}
		return new Response(object.body, {
			headers: {
				"content-type": attachment.content_type ?? "application/octet-stream",
			},
		});
	});

	api.post("/api/mailboxes/:mailboxId/messages/:messageId/actions", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const body = messageActionSchema.parse(await c.req.json());
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/messages/${c.req.param("messageId")}/actions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	});

	api.get("/api/mailboxes/:mailboxId/search", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const query = searchQuerySchema.parse({
			q: c.req.query("q"),
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
		});
		const stub = await mailboxStub(c.env, mailboxId);
		const url = new URL("https://mailbox-do/search");
		url.searchParams.set("q", query.q);
		url.searchParams.set("limit", String(query.limit));
		return stub.fetch(url.toString());
	});

	api.get("/api/mailboxes/:mailboxId/drafts", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/drafts");
	});

	api.post("/api/mailboxes/:mailboxId/drafts", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const body = createDraftSchema.parse(await c.req.json());
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, createdBy: auth.email }),
		});
	});

	api.patch("/api/mailboxes/:mailboxId/drafts/:draftId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const body = updateDraftSchema.parse(await c.req.json());
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/request-send", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/request-send`, {
			method: "POST",
		});
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/confirm-send", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const draftId = c.req.param("draftId");
		const body = confirmSendSchema.parse(await c.req.json());
		const stub = await mailboxStub(c.env, mailboxId);
		const outboundIdempotencyKey = outboundSendIdempotencyKey(draftId, body.idempotencyKey);
		const existingSend = await getOutboundSendByIdempotency(c.env.INDEX_DB, outboundIdempotencyKey);
		if (existingSend?.status === "sent") {
			return c.json({
				id: draftId,
				status: "sent",
				sent: false,
				duplicate: true,
				providerMessageId: existingSend.provider_message_id,
			});
		}
		await createOutboundSendIfMissing(c.env.INDEX_DB, {
			id: crypto.randomUUID(),
			mailbox_id: mailboxId,
			draft_id: draftId,
			idempotency_key: outboundIdempotencyKey,
			status: "sending",
		});
		let response: Response;
		try {
			response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/confirm-send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (error) {
			await updateOutboundSendStatus(c.env.INDEX_DB, {
				idempotencyKey: outboundIdempotencyKey,
				status: "failed",
				errorCode: error instanceof Error ? error.message.slice(0, 120) : "send_failed",
			});
			throw error;
		}
		if (response.ok) {
			const result = (await response.json()) as {
				sent?: boolean;
				status?: string;
				messageLocalId?: string;
				threadId?: string;
				duplicate?: boolean;
				providerMessageId?: string | null;
				subject?: string | null;
				fromAddr?: string;
				toJson?: string;
				snippet?: string | null;
				receivedAt?: string;
				rawR2Key?: string;
				rawSha256?: string;
				reason?: string;
			};
			if (result.sent && result.messageLocalId) {
				await updateOutboundSendStatus(c.env.INDEX_DB, {
					idempotencyKey: outboundIdempotencyKey,
					status: "sent",
					providerMessageId: result.providerMessageId ?? outboundIdempotencyKey,
					errorCode: null,
				});
				await upsertMessageIndex(c.env.INDEX_DB, {
					mailbox_id: mailboxId,
					message_local_id: result.messageLocalId,
					thread_id: result.threadId ?? result.messageLocalId,
					rfc_message_id: null,
					subject: result.subject ?? null,
					from_addr: result.fromAddr ?? "noreply@mail.example.com",
					to_json: result.toJson ?? "[]",
					snippet: result.snippet ?? null,
					received_at: result.receivedAt ?? new Date().toISOString(),
					has_attachments: 0,
					labels_json: "[]",
					state: "sent",
					raw_r2_key: result.rawR2Key ?? `sent/${draftId}`,
					raw_sha256: result.rawSha256 ?? outboundIdempotencyKey,
					updated_at: new Date().toISOString(),
				});
			} else if (result.duplicate) {
				await updateOutboundSendStatus(c.env.INDEX_DB, {
					idempotencyKey: outboundIdempotencyKey,
					status: result.status === "sending" ? "sending" : "sent",
					providerMessageId:
						result.status === "sending" ? null : (result.providerMessageId ?? outboundIdempotencyKey),
					errorCode: null,
				});
			} else {
				await updateOutboundSendStatus(c.env.INDEX_DB, {
					idempotencyKey: outboundIdempotencyKey,
					status: "failed",
					errorCode: result.reason ?? "not_sent",
				});
			}
			return Response.json(result, { status: response.status });
		}
		await updateOutboundSendStatus(c.env.INDEX_DB, {
			idempotencyKey: outboundIdempotencyKey,
			status: "failed",
			errorCode: `http_${response.status}`,
		});
		return response;
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/cancel", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/cancel`, {
			method: "POST",
		});
	});
}

export function registerAdminRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/admin/ops-events", async (c) => {
		return c.json({ events: await listOpsEvents(c.env.INDEX_DB) });
	});

	api.get("/api/admin/dlq", async (c) => {
		const failures = await listIngestFailures(c.env.INDEX_DB);
		return c.json({
			note: "Cloudflare DLQ messages are inspected via dashboard or wrangler; ingest failures listed here.",
			ingestFailures: failures,
		});
	});

	api.post("/api/admin/reindex", async (c) => {
		const body = (await c.req.json()) as { mailboxId: string };
		const stub = c.env.MAILBOX_DO.getByName(body.mailboxId);
		const exportResponse = await stub.fetch("https://mailbox-do/export-index");
		if (!exportResponse.ok) {
			return c.json({ error: "export_failed" }, 500);
		}
		const exported = (await exportResponse.json()) as {
			messages: Array<{
				message_local_id: string;
				thread_id: string;
				rfc_message_id: string | null;
				subject: string | null;
				from_addr: string;
				to_json: string;
				snippet: string | null;
				received_at: string;
				has_attachments: number;
				state: string;
				raw_r2_key: string;
				raw_sha256: string;
			}>;
		};
		await deleteMessageIndexForMailbox(c.env.INDEX_DB, body.mailboxId);
		for (const row of exported.messages) {
			await upsertMessageIndex(c.env.INDEX_DB, {
				mailbox_id: body.mailboxId,
				message_local_id: row.message_local_id,
				thread_id: row.thread_id,
				rfc_message_id: row.rfc_message_id,
				subject: row.subject,
				from_addr: row.from_addr,
				to_json: row.to_json,
				snippet: row.snippet,
				received_at: row.received_at,
				has_attachments: row.has_attachments,
				labels_json: "[]",
				state: row.state as "inbox" | "archive" | "trash" | "sent" | "draft",
				raw_r2_key: row.raw_r2_key,
				raw_sha256: row.raw_sha256,
				updated_at: new Date().toISOString(),
			});
		}
		await insertOpsEvent(c.env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "admin.reindex",
			severity: "info",
			subject: body.mailboxId,
			payload_json: JSON.stringify({ count: exported.messages.length }),
		});
		return c.json({ ok: true, count: exported.messages.length });
	});

	api.post("/api/admin/backups/run", async (c) => {
		const body = (await c.req.json()) as { mailboxId: string };
		const date = new Date().toISOString().slice(0, 10);
		const stub = c.env.MAILBOX_DO.getByName(body.mailboxId);
		const exportResponse = await stub.fetch("https://mailbox-do/export-index");
		const exported = await exportResponse.json();
		const key = backupManifestR2Key({ date, mailboxId: body.mailboxId });
		await c.env.MAIL_OBJECTS.put(key, JSON.stringify(exported, null, 2), {
			httpMetadata: { contentType: "application/json" },
		});
		await insertOpsEvent(c.env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "backup.completed",
			severity: "info",
			subject: body.mailboxId,
			payload_json: JSON.stringify({ key }),
		});
		return c.json({ ok: true, key });
	});
}
