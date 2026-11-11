import type { Hono } from "hono";
import { getMailbox } from "../db/d1";
import { isPreviewableImage } from "../lib/attachment-preview";
import * as templates from "../lib/admin/templates";
import * as keys from "../lib/admin/api-keys";
import * as suppressions from "../lib/admin/suppressions";
import * as ops from "../lib/admin/ops";
import { adminResponse } from "../lib/admin/errors";
import { AppError } from "../lib/errors";
import { confirmDraftSend } from "../lib/outbound-send";
import { CARD_STATUS_FOR_ACTION, enqueueTelegramCardRefresh } from "../telegram/cards";
import { assertMailboxAccess } from "./auth";
import type { ApiBindings } from "./hono";
import {
	confirmSendSchema,
	createDraftSchema,
	messageActionSchema,
	searchQuerySchema,
	threadListQuerySchema,
	updateDraftSchema,
} from "./schemas";
import { mailboxStub } from "../lib/mailbox-stub";

// CSP applied to rendered email HTML. `default-src 'none'` denies everything by
// default (scripts, fetch, frames, forms — no script-src is defined, so scripts
// fall through to the deny); we then re-allow only what mail needs to display:
// remote/inline images and inline styles. Kept in sync with the iframe `sandbox`
// attribute on the client (defense in depth — either alone blocks script execution).
const EMAIL_HTML_CSP = [
	"default-src 'none'",
	"img-src https: http: data:",
	"style-src 'unsafe-inline'",
	"font-src https: data:",
	"media-src https: data:",
	"form-action 'none'",
	"frame-ancestors 'self'",
].join("; ");

// Force links inside the (sandboxed) email frame to open in a new tab rather than
// replacing the framed document. Injected into the existing <head> when present so
// it doesn't disturb the email's own base URL (we only set `target`, never `href`).
function injectBaseTarget(html: string): string {
	const baseTag = '<base target="_blank" rel="noopener noreferrer">';
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/(<head[^>]*>)/i, `$1${baseTag}`);
	}
	if (/<html[^>]*>/i.test(html)) {
		return html.replace(/(<html[^>]*>)/i, `$1<head>${baseTag}</head>`);
	}
	return `${baseTag}${html}`;
}

function sanitizeAttachmentFilename(
	filename: string | null | undefined,
	attachmentId: string,
): string {
	const trimmed = filename?.trim();
	if (!trimmed) {
		return attachmentId;
	}
	const safe = trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
	return safe || attachmentId;
}

async function requireMailboxStub(env: Env, mailboxId: string) {
	const mailbox = await getMailbox(env.INDEX_DB, mailboxId);
	if (!mailbox) {
		throw new AppError("Mailbox not found", "mailbox_not_found", 404);
	}
	return mailboxStub(env, mailboxId);
}

export function registerMailboxRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/mailboxes/:mailboxId/threads", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const query = threadListQuerySchema.parse({
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
			q: c.req.query("q"),
			label: c.req.query("label"),
			state: c.req.query("state"),
		});
		const stub = await requireMailboxStub(c.env, mailboxId);
		const url = new URL("https://mailbox-do/threads");
		url.searchParams.set("limit", String(query.limit));
		if (query.state) {
			url.searchParams.set("state", query.state);
		}
		return stub.fetch(url.toString());
	});

	api.get("/api/mailboxes/:mailboxId/threads/:threadId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/threads/${c.req.param("threadId")}`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/messages/${c.req.param("messageId")}`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId/raw", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/messages/${c.req.param("messageId")}/raw`);
	});

	// Sanitized HTML body, meant to be embedded in a sandboxed iframe by the client.
	// The email HTML is attacker-controlled, so we lock it down at the response edge:
	// a strict CSP blocks scripts/forms/frames (default-src 'none' + no script-src),
	// allows only inline styles and remote images so the mail still renders, and a
	// nosniff header prevents content-type games. A <base target="_blank"> is injected
	// so links open in a new tab instead of navigating the framed document.
	api.get("/api/mailboxes/:mailboxId/messages/:messageId/html", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		const upstream = await stub.fetch(
			`https://mailbox-do/messages/${c.req.param("messageId")}/html`,
		);
		if (!upstream.ok) return c.json({ error: "html_not_found" }, 404);
		const html = injectBaseTarget(await upstream.text());
		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": EMAIL_HTML_CSP,
				"x-content-type-options": "nosniff",
				"referrer-policy": "no-referrer",
				"cache-control": "private, no-store",
			},
		});
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId/attachments/:attachmentId", async (c) => {
		const messageId = c.req.param("messageId");
		const attachmentId = c.req.param("attachmentId");
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		const messageResponse = await stub.fetch(`https://mailbox-do/messages/${messageId}`);
		if (!messageResponse.ok) return messageResponse;
		const payload = (await messageResponse.json()) as {
			message?: {
				attachments?: Array<{
					id: string;
					r2_key: string;
					content_type?: string;
					filename?: string | null;
				}>;
			};
		};
		const attachment = payload.message?.attachments?.find((row) => row.id === attachmentId);
		if (!attachment) {
			return c.json({ error: "attachment_not_found" }, 404);
		}
		const object = await c.env.MAIL_OBJECTS.get(attachment.r2_key);
		if (!object) {
			return c.json({ error: "attachment_missing" }, 404);
		}
		const safeFilename = sanitizeAttachmentFilename(attachment.filename, attachmentId);
		const disposition =
			c.req.query("inline") === "1" && isPreviewableImage(attachment.content_type)
				? "inline"
				: "attachment";
		return new Response(object.body, {
			headers: {
				"content-type": attachment.content_type ?? "application/octet-stream",
				"content-disposition": `${disposition}; filename="${safeFilename}"`,
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; sandbox",
			},
		});
	});

	api.post("/api/mailboxes/:mailboxId/messages/:messageId/actions", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const messageId = c.req.param("messageId");
		const body = messageActionSchema.parse(await c.req.json());
		const stub = await requireMailboxStub(c.env, mailboxId);
		const response = await stub.fetch(`https://mailbox-do/messages/${messageId}/actions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		// Only after the DO agreed, and never inline: the card that announced this
		// email in Telegram would otherwise go on claiming it is pending, which is
		// the reconciliation gap that made two surfaces disagree about the same
		// inbox. Queued, so the edit waits behind Telegram's per-chat rate limit
		// instead of this request doing so.
		if (response.ok) {
			await enqueueTelegramCardRefresh(c.env, {
				mailboxId,
				messageLocalId: messageId,
				threadId: null,
				status: CARD_STATUS_FOR_ACTION[body.action],
			});
		}
		return response;
	});

	api.get("/api/mailboxes/:mailboxId/search", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const query = searchQuerySchema.parse({
			q: c.req.query("q"),
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
		});
		const stub = await requireMailboxStub(c.env, mailboxId);
		const url = new URL("https://mailbox-do/search");
		url.searchParams.set("q", query.q);
		url.searchParams.set("limit", String(query.limit));
		return stub.fetch(url.toString());
	});

	api.get("/api/mailboxes/:mailboxId/drafts", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/drafts");
	});

	api.get("/api/mailboxes/:mailboxId/drafts/:draftId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}`);
	});

	api.post("/api/mailboxes/:mailboxId/drafts", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const body = createDraftSchema.parse(await c.req.json());
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, createdBy: auth.email }),
		});
	});

	api.patch("/api/mailboxes/:mailboxId/drafts/:draftId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const body = updateDraftSchema.parse(await c.req.json());
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/request-send", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/request-send`, {
			method: "POST",
		});
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/confirm-send", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const draftId = c.req.param("draftId");
		const body = confirmSendSchema.parse(await c.req.json());
		const { status, body: result } = await confirmDraftSend(c.env, {
			mailboxId,
			draftId,
			attemptKey: body.idempotencyKey,
		});
		return Response.json(result, { status });
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/cancel", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/cancel`, {
			method: "POST",
		});
	});

	api.post("/api/mailboxes/:mailboxId/transactional/api-keys", async (c) =>
		adminResponse(
			await keys.createKey(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				get body() {
					return c.req.json();
				},
			}),
		),
	);
	api.get("/api/mailboxes/:mailboxId/transactional/api-keys", async (c) =>
		adminResponse(
			await keys.listKeys(c.env, c.get("auth")!, { mailboxId: c.req.param("mailboxId") }),
		),
	);
	api.post("/api/mailboxes/:mailboxId/transactional/api-keys/:keyId/revoke", async (c) =>
		adminResponse(
			await keys.revokeKey(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				keyId: c.req.param("keyId"),
			}),
		),
	);
	api.patch("/api/mailboxes/:mailboxId/transactional/api-keys/:keyId", async (c) =>
		adminResponse(
			await keys.patchKey(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				keyId: c.req.param("keyId"),
				get body() {
					return c.req.json();
				},
			}),
		),
	);
	api.post("/api/mailboxes/:mailboxId/transactional/api-keys/:keyId/rotate", async (c) =>
		adminResponse(
			await keys.rotateKey(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				keyId: c.req.param("keyId"),
			}),
		),
	);
	api.put("/api/mailboxes/:mailboxId/transactional/templates", async (c) =>
		adminResponse(
			await templates.syncTemplates(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				get body() {
					return c.req.json();
				},
			}),
		),
	);
	api.post("/api/mailboxes/:mailboxId/transactional/reconcile-stale", async (c) => {
		const result = await ops.reconcile(c.env, c.get("auth")!, {
			mailboxId: c.req.param("mailboxId"),
		});
		return result ? c.json(result) : c.json({ error: "reconcile_failed" }, 500);
	});
}

export function registerMailboxSuppressionRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/mailboxes/:mailboxId/suppressions", async (c) =>
		adminResponse(
			await suppressions.listSuppressions(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
			}),
		),
	);
	api.post("/api/mailboxes/:mailboxId/suppressions/remove", async (c) =>
		adminResponse(
			await suppressions.removeSuppression(c.env, c.get("auth")!, {
				mailboxId: c.req.param("mailboxId"),
				get body() {
					return c.req.json() as Promise<{ email: string; allowProviderRemoval?: boolean }>;
				},
			}),
		),
	);
}

export function registerAdminRoutes(api: Hono<ApiBindings>): void {
	api.get("/api/admin/ops-events", async (c) => c.json(await ops.opsEvents(c.env, c.get("auth")!)));
	api.get("/api/admin/dlq", async (c) => c.json(await ops.dlq(c.env, c.get("auth")!)));
	api.post("/api/admin/reindex", async (c) => {
		const result = await ops.reindex(c.env, c.get("auth")!, await c.req.json());
		return result ? c.json(result) : c.json({ error: "export_failed" }, 500);
	});
	api.post("/api/admin/backups/run", async (c) => {
		const result = await ops.backup(c.env, c.get("auth")!, await c.req.json());
		return result ? c.json(result) : c.json({ error: "export_failed" }, 500);
	});
}
