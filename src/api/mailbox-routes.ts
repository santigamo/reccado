import type { Hono } from "hono";
import { getMailbox } from "../db/d1";
import * as keys from "../lib/admin/api-keys";
import { adminResponse } from "../lib/admin/errors";
import * as ops from "../lib/admin/ops";
import * as suppressions from "../lib/admin/suppressions";
import * as templates from "../lib/admin/templates";
import { isPreviewableImage } from "../lib/attachment-preview";
import { AppError } from "../lib/errors";
import { sanitizeOwnerHtml } from "../lib/html-sanitize";
import { mailboxStub } from "../lib/mailbox-stub";
import { confirmDraftSend } from "../lib/outbound-send";
import { htmlToPlainText } from "../lib/rich-text";
import { enqueueTelegramCardRefreshForAction } from "../telegram/cards";
import { assertMailboxAccess } from "./auth";
import type { ApiBindings } from "./hono";
import {
	bulkActionSchema,
	confirmSendSchema,
	createDraftSchema,
	messageActionSchema,
	searchQuerySchema,
	threadListQuerySchema,
	updateDraftSchema,
} from "./schemas";

// CSP applied to rendered email HTML. `default-src 'none'` denies everything by
// default (scripts, fetch, frames, forms — no script-src is defined, so scripts
// fall through to the deny); we then re-allow only what mail needs to display:
// remote/inline images and inline styles. Kept in sync with the iframe `sandbox`
// attribute on the client (defense in depth — either alone blocks script execution).
//
// Remote content (images, CSS backgrounds, fonts, media) is blocked unless the
// reader asked for it (`?images=1`, the "Show images" button): a remote image is
// how a sender learns that, when and where a message was opened. Inline (data:)
// images and the message's own attachments (cid:, served from this origin)
// always show.
export function emailHtmlCsp(remoteImages: boolean): string {
	const remote = remoteImages ? " https: http:" : "";
	return [
		"default-src 'none'",
		`img-src 'self' data:${remote}`,
		"style-src 'unsafe-inline'",
		`font-src data:${remoteImages ? " https:" : ""}`,
		`media-src data:${remoteImages ? " https:" : ""}`,
		"form-action 'none'",
		"frame-ancestors 'self'",
	].join("; ");
}

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

/**
 * Last touches on a stored email body before it is framed: every link opens a
 * new tab without an opener or a referrer, and cid: images resolve to this
 * message's own attachments. Scripts, forms and remote frames are not touched
 * here — the CSP (default-src 'none', no script-src, form-action 'none') and the
 * iframe sandbox are what block them.
 */
async function prepareEmailHtml(html: string, cidMap: Map<string, string>): Promise<string> {
	const rewriter = new HTMLRewriter()
		.on("a[href], area[href]", {
			element(el) {
				el.setAttribute("target", "_blank");
				el.setAttribute("rel", "noopener noreferrer");
			},
		})
		.on("img[src]", {
			element(el) {
				const src = el.getAttribute("src") ?? "";
				const match = /^cid:(.+)$/i.exec(src.trim());
				if (!match) return;
				let cid = match[1]!;
				try {
					cid = decodeURIComponent(cid);
				} catch {
					// Not percent-encoded after all: use it as written.
				}
				const target = cidMap.get(cid.replace(/^<|>$/g, "").trim().toLowerCase());
				if (target) el.setAttribute("src", target);
				else el.removeAttribute("src");
			},
		});
	return rewriter.transform(new Response(html)).text();
}

/**
 * Owner HTML is sanitised before the mailbox DO ever stores it (allowlist in
 * lib/rich-text.ts), and its text/plain alternative is derived from that clean
 * markup, so the two parts of the multipart/alternative always say the same
 * thing. An empty body after cleaning is stored as "" — a text-only send.
 */
async function withCleanHtml<T extends { bodyHtml?: string; bodyText?: string }>(
	body: T,
): Promise<T> {
	if (body.bodyHtml === undefined) return body;
	const bodyHtml = await sanitizeOwnerHtml(body.bodyHtml);
	const derived = bodyHtml ? htmlToPlainText(bodyHtml) : "";
	return { ...body, bodyHtml, bodyText: bodyHtml ? derived : (body.bodyText ?? "") };
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
			unread: c.req.query("unread"),
			q: c.req.query("q"),
			label: c.req.query("label"),
			state: c.req.query("state"),
			reports: c.req.query("reports"),
		});
		const stub = await requireMailboxStub(c.env, mailboxId);
		const url = new URL("https://mailbox-do/threads");
		url.searchParams.set("limit", String(query.limit));
		if (query.state) {
			url.searchParams.set("state", query.state);
		}
		if (query.cursor) url.searchParams.set("before", query.cursor);
		if (query.unread) url.searchParams.set("unread", "true");
		// Automated reports stay out of every web folder; the reports view asks for them.
		url.searchParams.set("reports", query.reports ?? "exclude");
		return stub.fetch(url.toString());
	});

	// Real totals for the web UI (header subtitle, folder badges, "1 of N"),
	// computed by the mailbox DO from its own tables, automated reports apart
	// (`counts.reports`). Same gate as the thread list.
	api.get("/api/mailboxes/:mailboxId/counts", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		const upstream = await stub.fetch("https://mailbox-do/counts");
		if (!upstream.ok) return upstream;
		const { counts } = (await upstream.json()) as { counts: unknown };
		return c.json({ mailbox_id: mailboxId, counts });
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
		const messageId = c.req.param("messageId");
		const stub = await requireMailboxStub(c.env, mailboxId);
		const upstream = await stub.fetch(`https://mailbox-do/messages/${messageId}/html`);
		if (!upstream.ok) return c.json({ error: "html_not_found" }, 404);
		// Inline images (cid:) point at this message's own attachments; anything
		// else that is not http(s)/data stays unresolvable under the CSP.
		const cidMap = new Map<string, string>();
		const raw = await upstream.text();
		if (/\bcid:/i.test(raw)) {
			const meta = await stub.fetch(`https://mailbox-do/messages/${messageId}`);
			if (meta.ok) {
				const payload = (await meta.json()) as {
					message?: {
						attachments?: Array<{ id: string; content_id?: string | null; content_type?: string }>;
					};
				};
				for (const att of payload.message?.attachments ?? []) {
					const cid = att.content_id?.replace(/^<|>$/g, "").trim().toLowerCase();
					if (cid && isPreviewableImage(att.content_type)) {
						cidMap.set(
							cid,
							`/api/mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(att.id)}?inline=1`,
						);
					}
				}
			}
		}
		const html = await prepareEmailHtml(injectBaseTarget(raw), cidMap);
		return new Response(html, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"content-security-policy": emailHtmlCsp(c.req.query("images") === "1"),
				// The one HTML response the app frames itself. The global middleware
				// leaves this exact value alone for this route only (see api/hono.ts);
				// every other response keeps DENY. A DENY here conflicts with
				// frame-ancestors 'self', and browsers that honour X-Frame-Options over
				// CSP then show an empty frame instead of the message.
				"x-frame-options": "SAMEORIGIN",
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
			await enqueueTelegramCardRefreshForAction(c.env, {
				mailboxId,
				messageLocalId: messageId,
				action: body.action,
			});
		}
		return response;
	});

	// Many messages at once: bulk archive / delete / read state on conversations,
	// an exact undo on messages, or "Mark all as read" on a folder (automated
	// reports stay out unless the reports view asks). Answers what each changed
	// message was before, which is what the client's Undo replays.
	api.post("/api/mailboxes/:mailboxId/bulk-actions", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const body = bulkActionSchema.parse(await c.req.json());
		const target = body.threadIds
			? { threadIds: body.threadIds }
			: body.messageIds
				? { messageIds: body.messageIds }
				: {
						folder: {
							state: body.folder!.state,
							reports: body.folder!.reports ?? ("exclude" as const),
						},
					};
		const stub = await requireMailboxStub(c.env, mailboxId);
		const response = await stub.fetch("https://mailbox-do/bulk-actions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: body.action, target }),
		});
		if (!response.ok) return response;
		const result = (await response.json()) as {
			action: string;
			changed: Array<{ id: string; thread_id: string; state: string; is_read: number }>;
		};
		// Same follow-up as the single-message route: the Telegram cards of the
		// messages that changed stop claiming their old state. Bounded; a card for
		// mail older than that is refreshed the next time it is touched.
		await Promise.all(
			result.changed.slice(0, 100).map((m) =>
				enqueueTelegramCardRefreshForAction(c.env, {
					mailboxId,
					messageLocalId: m.id,
					action: body.action,
				}),
			),
		);
		return c.json(result);
	});

	api.get("/api/mailboxes/:mailboxId/search", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const query = searchQuerySchema.parse({
			q: c.req.query("q"),
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
			reports: c.req.query("reports"),
		});
		const stub = await requireMailboxStub(c.env, mailboxId);
		const url = new URL("https://mailbox-do/search");
		url.searchParams.set("q", query.q);
		url.searchParams.set("limit", String(query.limit));
		url.searchParams.set("reports", query.reports ?? "exclude");
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
		const body = await withCleanHtml(createDraftSchema.parse(await c.req.json()));
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
		const body = await withCleanHtml(updateDraftSchema.parse(await c.req.json()));
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
		const mailbox = await getMailbox(c.env.INDEX_DB, mailboxId);
		if (!mailbox) throw new AppError("Mailbox not found", "mailbox_not_found", 404);
		const stub = mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/request-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				mailboxAddress: mailbox.primary_address,
				displayName: mailbox.display_name,
			}),
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

	// Undo for "Discard draft": your own discarded draft comes back as a draft.
	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/restore", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/restore`, {
			method: "POST",
		});
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
