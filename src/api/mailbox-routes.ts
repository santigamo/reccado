import type { Hono } from "hono";
import {
	deleteMessageIndexForMailbox,
	getMailbox,
	getMailboxForOwner,
	insertOpsEvent,
	listIngestFailures,
	listOpsEvents,
	upsertApiKeyProjection,
	upsertMessageIndex,
} from "../db/d1";
import { AppError } from "../lib/errors";
import { confirmDraftSend } from "../lib/outbound-send";
import { backupManifestR2Key } from "../lib/r2-keys";
import { assertMailboxAccess } from "./auth";
import type { ApiBindings } from "./hono";
import {
	adminMailboxActionSchema,
	confirmSendSchema,
	createDraftSchema,
	createTransactionalApiKeySchema,
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
		assertMailboxAccess(auth, mailboxId, c.env);
		const query = threadListQuerySchema.parse({
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
			q: c.req.query("q"),
			label: c.req.query("label"),
			state: c.req.query("state"),
		});
		const stub = await mailboxStub(c.env, mailboxId);
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
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/threads/${c.req.param("threadId")}`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/messages/${c.req.param("messageId")}`);
	});

	api.get("/api/mailboxes/:mailboxId/messages/:messageId/raw", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await mailboxStub(c.env, mailboxId);
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
		const stub = await mailboxStub(c.env, mailboxId);
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
		const stub = await mailboxStub(c.env, mailboxId);
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
		return new Response(object.body, {
			headers: {
				"content-type": attachment.content_type ?? "application/octet-stream",
				"content-disposition": `attachment; filename="${safeFilename}"`,
				"x-content-type-options": "nosniff",
				"content-security-policy": "default-src 'none'; sandbox",
			},
		});
	});

	api.post("/api/mailboxes/:mailboxId/messages/:messageId/actions", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
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
		assertMailboxAccess(auth, mailboxId, c.env);
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
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/drafts");
	});

	api.get("/api/mailboxes/:mailboxId/drafts/:draftId", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}`);
	});

	api.post("/api/mailboxes/:mailboxId/drafts", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
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
		assertMailboxAccess(auth, mailboxId, c.env);
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
		assertMailboxAccess(auth, mailboxId, c.env);
		const stub = await mailboxStub(c.env, mailboxId);
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
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch(`https://mailbox-do/drafts/${c.req.param("draftId")}/cancel`, {
			method: "POST",
		});
	});

	// --- Transactional API key management (Access-protected, owner-gated) ---

	/**
	 * Best-effort D1 projection write. Catches and logs failures — D1 is a
	 * rebuildable index, never the source of truth for API key state.
	 */
	async function projectApiKey(
		env: Env,
		row: {
			key_id: string;
			mailbox_id: string;
			sender: string;
			display_suffix: string;
			environment: string;
			scopes: string[];
			template_allowlist: string[] | null;
			recipient_policy: string | null;
			status: string;
			quota_max: number | null;
			expires_at: string | null;
			created_at: string;
			updated_at: string;
			revoked_at: string | null;
		},
	): Promise<void> {
		try {
			await upsertApiKeyProjection(env.INDEX_DB, {
				key_id: row.key_id,
				mailbox_id: row.mailbox_id,
				sender: row.sender,
				display_suffix: row.display_suffix,
				environment: row.environment as "test" | "live",
				scopes_json: JSON.stringify(row.scopes),
				template_allowlist_json: row.template_allowlist
					? JSON.stringify(row.template_allowlist)
					: null,
				recipient_policy: row.recipient_policy,
				quota_max: row.quota_max,
				quota_used: 0,
				expires_at: row.expires_at,
				status: row.status as "active" | "revoked",
				created_at: row.created_at,
				updated_at: row.updated_at,
				revoked_at: row.revoked_at,
			});
		} catch (error) {
			console.error("api_key_projection_failed", {
				keyId: row.key_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async function enforceMailboxOwnership(
		env: Env,
		mailboxId: string,
		email: string,
	): Promise<Response | null> {
		const mailbox = await getMailboxForOwner(env.INDEX_DB, mailboxId, email);
		if (!mailbox) {
			return Response.json(
				{ error: "forbidden" },
				{ status: 403, headers: { "content-type": "application/json" } },
			);
		}
		return null;
	}

	api.post("/api/mailboxes/:mailboxId/transactional/api-keys", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const ownershipError = await enforceMailboxOwnership(c.env, mailboxId, auth.email);
		if (ownershipError) return ownershipError;
		const body = createTransactionalApiKeySchema.parse(await c.req.json());
		const stub = await mailboxStub(c.env, mailboxId);
		const doResponse = await stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		if (doResponse.ok) {
			const data = (await doResponse.json()) as {
				key?: {
					keyId?: string;
					mailboxId?: string;
					sender?: string;
					displaySuffix?: string;
					environment?: string;
					scopes?: string[];
					templateAllowlist?: string[] | null;
					recipientPolicy?: string | null;
					status?: string;
					quotaMax?: number | null;
					expiresAt?: string | null;
					createdAt?: string;
					updatedAt?: string;
					revokedAt?: string | null;
				};
				plaintextKey?: string;
				projection?: unknown;
			};
			if (data.projection) {
				await projectApiKey(c.env, data.projection as Parameters<typeof projectApiKey>[1]);
			} else if (data.key) {
				const k = data.key;
				await projectApiKey(c.env, {
					key_id: k.keyId!,
					mailbox_id: k.mailboxId!,
					sender: k.sender!,
					display_suffix: k.displaySuffix!,
					environment: k.environment!,
					scopes: k.scopes!,
					template_allowlist: k.templateAllowlist ?? null,
					recipient_policy: k.recipientPolicy ?? null,
					status: k.status!,
					quota_max: k.quotaMax ?? null,
					expires_at: k.expiresAt ?? null,
					created_at: k.createdAt!,
					updated_at: k.updatedAt!,
					revoked_at: k.revokedAt ?? null,
				});
			}
		}
		return doResponse;
	});

	api.get("/api/mailboxes/:mailboxId/transactional/api-keys", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const ownershipError = await enforceMailboxOwnership(c.env, mailboxId, auth.email);
		if (ownershipError) return ownershipError;
		const stub = await mailboxStub(c.env, mailboxId);
		return stub.fetch("https://mailbox-do/transactional/api-keys", {
			method: "GET",
		});
	});

	api.post("/api/mailboxes/:mailboxId/transactional/api-keys/:keyId/revoke", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const ownershipError = await enforceMailboxOwnership(c.env, mailboxId, auth.email);
		if (ownershipError) return ownershipError;
		const keyId = c.req.param("keyId");
		const stub = await mailboxStub(c.env, mailboxId);
		const doResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${keyId}/revoke`,
			{
				method: "POST",
			},
		);
		if (doResponse.ok) {
			const data = (await doResponse.json()) as {
				key?: { key?: Record<string, unknown>; projection?: unknown };
			};
			if (data.key?.projection) {
				await projectApiKey(c.env, data.key.projection as Parameters<typeof projectApiKey>[1]);
			}
		}
		return doResponse;
	});

	api.post("/api/mailboxes/:mailboxId/transactional/api-keys/:keyId/rotate", async (c) => {
		const auth = c.get("auth")!;
		const mailboxId = c.req.param("mailboxId");
		assertMailboxAccess(auth, mailboxId, c.env);
		const ownershipError = await enforceMailboxOwnership(c.env, mailboxId, auth.email);
		if (ownershipError) return ownershipError;
		const keyId = c.req.param("keyId");
		const stub = await mailboxStub(c.env, mailboxId);
		const doResponse = await stub.fetch(
			`https://mailbox-do/transactional/api-keys/${keyId}/rotate`,
			{
				method: "POST",
			},
		);
		if (doResponse.ok) {
			const data = (await doResponse.json()) as {
				key?: {
					keyId?: string;
					mailboxId?: string;
					sender?: string;
					displaySuffix?: string;
					environment?: string;
					scopes?: string[];
					templateAllowlist?: string[] | null;
					recipientPolicy?: string | null;
					status?: string;
					quotaMax?: number | null;
					expiresAt?: string | null;
					createdAt?: string;
					updatedAt?: string;
					revokedAt?: string | null;
				};
				previousKeyId?: string;
				previousKeyProjection?: Parameters<typeof projectApiKey>[1];
			};
			// Project old (revoked) key
			if (data.previousKeyProjection) {
				await projectApiKey(c.env, data.previousKeyProjection);
			}
			// Project new (active) key
			if (data.key) {
				const k = data.key;
				await projectApiKey(c.env, {
					key_id: k.keyId!,
					mailbox_id: k.mailboxId!,
					sender: k.sender!,
					display_suffix: k.displaySuffix!,
					environment: k.environment!,
					scopes: k.scopes!,
					template_allowlist: k.templateAllowlist ?? null,
					recipient_policy: k.recipientPolicy ?? null,
					status: k.status!,
					quota_max: k.quotaMax ?? null,
					expires_at: k.expiresAt ?? null,
					created_at: k.createdAt!,
					updated_at: k.updatedAt!,
					revoked_at: k.revokedAt ?? null,
				});
			}
		}
		return doResponse;
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
		const body = adminMailboxActionSchema.parse(await c.req.json());
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
		const body = adminMailboxActionSchema.parse(await c.req.json());
		const date = new Date().toISOString().slice(0, 10);
		const stub = c.env.MAILBOX_DO.getByName(body.mailboxId);
		const exportResponse = await stub.fetch("https://mailbox-do/export-index");
		if (!exportResponse.ok) {
			return c.json({ error: "export_failed" }, 500);
		}
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
