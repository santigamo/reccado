import type { Hono } from "hono";
import { getMailbox, insertOpsEvent } from "../db/d1";
import * as keys from "../lib/admin/api-keys";
import { adminResponse } from "../lib/admin/errors";
import * as ops from "../lib/admin/ops";
import * as suppressions from "../lib/admin/suppressions";
import * as templates from "../lib/admin/templates";
import { MAX_ATTACHMENT_BYTES } from "../lib/attachment-limits";
import { isPreviewableImage } from "../lib/attachment-preview";
import { storeDraftUpload } from "../lib/draft-attachment-upload";
import { EMAIL_BASE_STYLE, injectIntoHead, prepareEmailHtml } from "../lib/email-html";
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
	draftAttachmentsFromMessageSchema,
	messageActionSchema,
	purgeSchema,
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
		// 'self': the copy of Inter the base style loads (lib/email-html.ts).
		`font-src 'self' data:${remoteImages ? " https:" : ""}`,
		`media-src data:${remoteImages ? " https:" : ""}`,
		"form-action 'none'",
		"frame-ancestors 'self'",
	].join("; ");
}

// Force links inside the (sandboxed) email frame to open in a new tab rather than
// replacing the framed document. The sender's own <base> was removed by
// prepareEmailHtml; this one only sets `target`, never `href`.
function injectBaseTarget(html: string, extra = ""): string {
	return injectIntoHead(
		html,
		`<base target="_blank" rel="noopener noreferrer">${EMAIL_BASE_STYLE}${extra}`,
	);
}

/**
 * A body already through prepareEmailHtml, as the response the app frames:
 * strict CSP, framable by this origin only, never cached. `extraHead` is
 * trusted markup of ours added after the base style.
 */
export function framedEmailResponse(
	prepared: string,
	remoteImages: boolean,
	extraHead = "",
): Response {
	return new Response(injectBaseTarget(prepared, extraHead), {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": emailHtmlCsp(remoteImages),
			// The HTML responses the app frames itself. The global middleware leaves
			// this exact value alone for these routes only (see api/hono.ts); every
			// other response keeps DENY. A DENY here conflicts with frame-ancestors
			// 'self', and browsers that honour X-Frame-Options over CSP then show an
			// empty frame instead of the message.
			"x-frame-options": "SAMEORIGIN",
			"x-content-type-options": "nosniff",
			"referrer-policy": "no-referrer",
			"cache-control": "private, no-store",
		},
	});
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
		// `?backfill=0`: read as stored (search summaries), without the lazy header
		// backfill that opening a conversation runs.
		const backfill = c.req.query("backfill") === "0" ? "?backfill=0" : "";
		return stub.fetch(`https://mailbox-do/threads/${c.req.param("threadId")}${backfill}`);
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
	// allows only inline styles (and remote images once the reader asks), and a
	// nosniff header prevents content-type games. prepareEmailHtml (lib/email-html.ts)
	// removes what the CSP does not govern (meta refresh, referrer overrides, <link>
	// prefetches, the sender's <base>) and, with images off, every remote source.
	// A <base target="_blank"> is injected so links open in a new tab instead of
	// navigating the framed document; the parent page's CSP (`frame-src 'self'`,
	// server.ts) keeps the frame itself from being navigated off this origin.
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
		const remoteImages = c.req.query("images") === "1";
		let prepared: string;
		try {
			prepared = await prepareEmailHtml(raw, cidMap, remoteImages);
		} catch {
			// Markup the streaming parser refuses (e.g. a <frameset> before a
			// <script>). Nothing unvetted is served: the client shows the text part.
			return c.json({ error: "html_unrenderable" }, 422);
		}
		return framedEmailResponse(prepared, remoteImages);
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
			? { threadIds: body.threadIds, scope: body.scope ?? ("live" as const) }
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

	// Delete forever, only from the Trash: the selected conversations, exact
	// messages, or the whole Trash of this mailbox. Owner web session only, like
	// every /api route (an MCP token never reaches /api, and no MCP tool or
	// control-plane kind exposes this). The mailbox DO deletes the first batch
	// now and the rest from its alarm; the answer says how far it got, and
	// GET …/purge/:operationId follows a large "Empty trash" to the end. No Undo:
	// the client asks for confirmation first.
	api.post("/api/mailboxes/:mailboxId/purge", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const body = purgeSchema.parse(await c.req.json());
		const target = body.threadIds
			? { threadIds: body.threadIds }
			: body.messageIds
				? { messageIds: body.messageIds }
				: // The Trash as the web lists and counts it: automated reports apart.
					{ emptyTrash: { reports: "exclude" as const } };
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/purge", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mailboxId, target }),
		});
	});

	api.get("/api/mailboxes/:mailboxId/purge/:operationId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/purge/${encodeURIComponent(c.req.param("operationId"))}`);
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
		const draftId = c.req.param("draftId");
		const body = await withCleanHtml(updateDraftSchema.parse(await c.req.json()));
		const stub = await requireMailboxStub(c.env, mailboxId);
		// origin "web": the owner editing. Saving an agent's draft takes it over —
		// it becomes the owner's, the agent can no longer change or cancel it, and
		// any approval request frozen from the agent's version is superseded.
		const response = await stub.fetch(`https://mailbox-do/drafts/${draftId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, origin: "web" }),
		});
		if (!response.ok) return response;
		const result = (await response.json()) as Record<string, unknown>;
		if (result.takenOver === true) {
			const { supersedePendingSendApprovals } = await import("../lib/approvals");
			await supersedePendingSendApprovals(c.env, {
				mailboxId,
				draftId,
				reason: "owner_takeover",
			}).catch(() => undefined);
			await insertOpsEvent(c.env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "draft.owner_takeover",
				severity: "info",
				subject: mailboxId,
				payload_json: JSON.stringify({ draftId, actor: auth.email }),
			}).catch(() => undefined);
		}
		return c.json(result);
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
				// The owner pressing Send again after an edit (body or files) re-freezes
				// the draft as it is now; without this a stale intent could never be
				// replaced from the web and every retry answered intent_stale. Freezing
				// an agent's draft sends nothing by itself: confirm-send then needs either
				// an approval bound to the new hash or the owner's own send carrying the
				// fingerprint of what they were shown.
				replaceStale: true,
			}),
		});
	});

	api.post("/api/mailboxes/:mailboxId/drafts/:draftId/confirm-send", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const draftId = c.req.param("draftId");
		const body = confirmSendSchema.parse(await c.req.json());
		// The owner sending an agent's draft directly carries the fingerprint of the
		// content the browser showed. That send is held to the approve endpoint's
		// bar: the session was already re-read with the cookie cache off (hono.ts
		// bypasses it for this path), and the Origin must be present and ours — a
		// missing Origin is a refusal here, not a pass.
		if (body.draftFingerprint) {
			const origin = c.req.header("Origin");
			if (!origin || origin !== new URL(c.req.url).origin) {
				return c.json({ error: "origin_mismatch" }, 403);
			}
		}
		const { status, body: result } = await confirmDraftSend(c.env, {
			mailboxId,
			draftId,
			attemptKey: body.idempotencyKey,
			...(body.draftFingerprint
				? { ownerWebSend: { fingerprint: body.draftFingerprint, actor: auth.email } }
				: {}),
		});
		return Response.json(result, { status });
	});

	registerDraftAttachmentRoutes(api);

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

/**
 * Files on a draft. Same gate as the other draft routes (the owner's web
 * session; MCP never reaches /api). The bytes go straight from the request to
 * R2 under a draft-scoped key; the mailbox DO only records their metadata and
 * decides whether the draft may take them (limits, status, never an agent's
 * draft). A file the DO refuses is deleted again, so no request leaves an
 * object nobody points at.
 */
function registerDraftAttachmentRoutes(api: Hono<ApiBindings>): void {
	const path = "/api/mailboxes/:mailboxId/drafts/:draftId/attachments";

	// Raw body upload: the file's bytes, its type in Content-Type and its name in
	// ?filename= (URL-encoded). A raw body keeps the browser's upload progress
	// simple and lets the size be refused from Content-Length before reading.
	api.post(path, async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		const draftId = c.req.param("draftId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const declared = Number(c.req.header("content-length") ?? "NaN");
		if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
			return c.json({ error: "attachment_too_large", maxBytes: MAX_ATTACHMENT_BYTES }, 413);
		}
		const stub = await requireMailboxStub(c.env, mailboxId);
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
			return c.json({ error: "attachment_too_large", maxBytes: MAX_ATTACHMENT_BYTES }, 413);
		}
		if (bytes.byteLength === 0) return c.json({ error: "attachment_empty" }, 400);
		return storeDraftUpload(c.env, stub, {
			mailboxId,
			draftId,
			filename: c.req.query("filename") ?? "",
			contentType: c.req.header("content-type"),
			bytes,
		});
	});

	api.post(`${path}/from-message`, async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const body = draftAttachmentsFromMessageSchema.parse(await c.req.json());
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(c.req.param("draftId"))}/attachments/from-message`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		);
	});

	api.delete(`${path}/:attachmentId`, async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await requireMailboxStub(c.env, mailboxId);
		return stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(c.req.param("draftId"))}/attachments/${encodeURIComponent(c.req.param("attachmentId"))}`,
			{ method: "DELETE" },
		);
	});

	// Download one of the draft's files. Always as a download, never rendered:
	// whatever the upload claimed to be, it is served nosniff, sandboxed and with
	// Content-Disposition: attachment — the same headers as a message attachment.
	api.get(`${path}/:attachmentId`, async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const attachmentId = c.req.param("attachmentId");
		const stub = await requireMailboxStub(c.env, mailboxId);
		const meta = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(c.req.param("draftId"))}/attachments/${encodeURIComponent(attachmentId)}`,
		);
		if (!meta.ok) return meta;
		const { attachment } = (await meta.json()) as {
			attachment: { r2_key: string; filename: string; content_type: string };
		};
		const object = await c.env.MAIL_OBJECTS.get(attachment.r2_key);
		if (!object) return c.json({ error: "attachment_missing" }, 404);
		return new Response(object.body, {
			headers: {
				"content-type": attachment.content_type || "application/octet-stream",
				"content-disposition": `attachment; filename="${sanitizeAttachmentFilename(attachment.filename, attachmentId)}"`,
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; sandbox",
				"cache-control": "private, no-store",
			},
		});
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
