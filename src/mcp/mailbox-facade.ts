import { getMailboxForOwner, listMailboxesByOwner } from "../db/d1";
import type { DraftAttachmentDto } from "../do/mailbox-draft-attachments";
import { isInstanceAuthSender } from "../lib/auth-mail";
import { storeDraftUpload } from "../lib/draft-attachment-upload";
import { sanitizeOwnerHtml } from "../lib/html-sanitize";
import { mailboxStub } from "../lib/mailbox-stub";
import { renderMarkdown } from "../lib/markdown";
import {
	redactSensitive,
	type SensitiveKind,
	type StoredSensitiveKind,
	sensitiveKindForRead,
} from "../lib/sensitive-mail";
import { enqueueTelegramCardRefreshForAction, type TelegramCardAction } from "../telegram/cards";
import { assertScope, type McpAuthContext } from "./scopes";
import type { McpDraftResult, McpMessageDto, McpSearchResult, McpThread } from "./types";

const MCP_MAX_BODY_CHARS = 10_000;

/** What an agent may write a draft body as: exactly one of the two. */
export type McpDraftBody = { bodyText?: string; bodyMarkdown?: string };

/**
 * The stored bodies for an agent's draft. Plain text stays text-only (an
 * update clears any HTML a previous Markdown version left, so the two parts
 * never disagree). Markdown is rendered once into both parts: the HTML goes
 * through the same owner sanitiser as the web composer's, the text is the
 * Markdown's own plain rendering — never one derived from the other.
 */
export async function mcpDraftBodies(
	body: McpDraftBody,
): Promise<{ bodyText: string; bodyHtml: string | null }> {
	const hasText = typeof body.bodyText === "string" && body.bodyText.length > 0;
	const hasMarkdown = typeof body.bodyMarkdown === "string" && body.bodyMarkdown.length > 0;
	if (hasText === hasMarkdown) throw new Error("validation_error");
	if (hasText) return { bodyText: body.bodyText!, bodyHtml: null };
	const rendered = renderMarkdown(body.bodyMarkdown!);
	const bodyHtml = await sanitizeOwnerHtml(rendered.html);
	if (!rendered.text.trim() || !bodyHtml) throw new Error("validation_error");
	return { bodyText: rendered.text, bodyHtml };
}

type RawThread = {
	id: string;
	subject_norm: string | null;
	last_message_at: string;
	message_count: number;
	unread_count: number;
	created_at: string;
	updated_at: string;
	latest_subject: string | null;
	latest_from: string | null;
	latest_from_name?: string | null;
	latest_snippet: string | null;
	latest_received_at: string;
	latest_has_attachments: number;
	latest_is_read: number;
	latest_direction: string;
	latest_state: string;
};

type RawSearchHit = { message_id: string };

const MESSAGE_ACTIONS = new Set<TelegramCardAction>([
	"mark_read",
	"mark_unread",
	"archive",
	"restore_inbox",
	"trash",
]);

function isMessageAction(action: string): action is TelegramCardAction {
	return MESSAGE_ACTIONS.has(action as TelegramCardAction);
}

/** A draft file as the agent sees it (no R2 key). */
export type McpDraftAttachment = {
	attachment_id: string;
	filename: string;
	content_type: string;
	size: number;
	sha256: string;
	source: "upload" | "message";
};

export type McpDraftAttachmentsResult = {
	draft_id: string;
	added: McpDraftAttachment[];
	skipped: Array<{ id: string; filename: string; reason: string }>;
	attachments: McpDraftAttachment[];
};

function toMcpDraftAttachment(row: DraftAttachmentDto): McpDraftAttachment {
	return {
		attachment_id: row.id,
		filename: row.filename,
		content_type: row.content_type,
		size: row.size,
		sha256: row.sha256,
		source: row.source,
	};
}

/** Draft attachment refusals the agent can act on, by their DO error code. */
export const DRAFT_ATTACHMENT_ERRORS: ReadonlySet<string> = new Set([
	"draft_not_agent_owned",
	"draft_not_editable",
	"send_in_progress",
	"too_many_attachments",
	"attachment_too_large",
	"attachments_too_large",
]);

async function draftAttachmentError(response: Response): Promise<Error> {
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	const code = body?.error ?? "";
	if (DRAFT_ATTACHMENT_ERRORS.has(code)) return new Error(code);
	if (response.status === 404) return new Error("not_found");
	return new Error("internal_error");
}

async function draftMutationError(response: Response): Promise<Error> {
	const body = (await response.json().catch(() => null)) as {
		error?: string;
		currentStatus?: string | null;
	} | null;
	// The owner took the draft over (or it was never the agent's): no longer ours.
	if (response.status === 409 && body?.error === "draft_not_agent_owned")
		return new Error("draft_not_agent_owned");
	if (response.status === 409)
		return new Error(body?.currentStatus ? "draft_not_editable" : "not_found");
	if (response.status === 404) return new Error("not_found");
	return new Error("internal_error");
}

type RawMessage = {
	id: string;
	thread_id: string;
	direction: string;
	state: string;
	from_addr: string;
	/** Sanitised at ingest; absent/null on rows stored before display names. */
	from_name?: string | null;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	subject: string | null;
	snippet: string | null;
	date_header: string | null;
	received_at: string;
	is_read: number;
	has_attachments: number;
	body_text: string | null;
	body_html_r2_key: string | null;
	raw_r2_key: string;
	sensitive_kind: StoredSensitiveKind | null;
	sensitive_classified: number;
	parse_status?: string;
	attachments: Array<{
		id: string;
		filename: string | null;
		content_type: string | null;
		size: number;
		r2_key: string;
		sha256: string;
		content_id: string | null;
	}>;
};

/**
 * Closed-operation facade for MCP mailbox access. Only exposes read and
 * draft-creation operations. Send, action, raw, attachment-download, admin,
 * and debug endpoints are deliberately unreachable.
 */
export class McpMailboxFacade {
	constructor(
		private env: Env,
		private auth: McpAuthContext,
	) {}

	/**
	 * Resolve a mailbox ID for the authenticated owner. Returns the DO stub
	 * or throws if the mailbox doesn't exist or doesn't belong to the caller.
	 */
	private async resolveMailbox(mailboxId: string) {
		const mailbox = await getMailboxForOwner(this.env.INDEX_DB, mailboxId, this.auth.email);
		if (!mailbox) {
			throw new Error("not_found");
		}
		return mailboxStub(this.env, mailboxId);
	}

	async listThreads(
		mailboxId: string,
		limit: number,
		state?: string,
		unread?: boolean,
	): Promise<McpThread[]> {
		const stub = await this.resolveMailbox(mailboxId);
		const url = new URL("https://mailbox-do/threads");
		url.searchParams.set("limit", String(Math.min(limit, 50)));
		if (state) {
			url.searchParams.set("state", state);
		}
		if (unread !== undefined) url.searchParams.set("unread", String(unread));
		const response = await stub.fetch(url.toString());
		if (!response.ok) {
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { threads: RawThread[] };
		return Promise.all(
			data.threads.map(async (t) => {
				const response = await stub.fetch(`https://mailbox-do/threads/${encodeURIComponent(t.id)}`);
				if (!response.ok) throw new Error("internal_error");
				const full = (await response.json()) as { messages: RawMessage[] };
				const visible = full.messages
					.filter((message) => !this.isInstanceAuth(message))
					.sort((a, b) => a.received_at.localeCompare(b.received_at));
				const latest = visible[visible.length - 1];
				if (!latest) return null;
				const thread = { messages: visible };
				const kinds = this.auth.scopes.has("mail:read:sensitive")
					? []
					: await Promise.all(thread.messages.map((message) => this.sensitivity(message)));
				const kind = kinds.find((value) => value !== null) ?? null;
				const protect = (s: string | null) => (s && kind ? redactSensitive(s, kind).text : s);
				// Summary fields come from the latest *visible* message, never from a hidden one.
				const hiddenLatest = full.messages.length !== visible.length;
				return {
					id: t.id,
					subject_norm: protect(t.subject_norm),
					last_message_at: hiddenLatest ? latest.received_at : t.last_message_at,
					message_count: visible.length,
					unread_count: visible.filter((message) => !message.is_read).length,
					latest_subject: protect(hiddenLatest ? latest.subject : t.latest_subject),
					latest_from: protect(hiddenLatest ? latest.from_addr : t.latest_from),
					latest_from_name: protect((hiddenLatest ? latest.from_name : t.latest_from_name) ?? null),
					latest_snippet: protect(hiddenLatest ? latest.snippet : t.latest_snippet),
					latest_received_at: hiddenLatest ? latest.received_at : t.latest_received_at,
					latest_has_attachments: hiddenLatest ? latest.has_attachments : t.latest_has_attachments,
					latest_is_read: hiddenLatest ? latest.is_read : t.latest_is_read,
					latest_direction: hiddenLatest ? latest.direction : t.latest_direction,
					latest_state: hiddenLatest ? latest.state : t.latest_state,
				};
			}),
		).then((threads) => threads.filter((thread): thread is McpThread => thread !== null));
	}

	async searchMessages(
		mailboxId: string | undefined,
		query: string,
		limit: number,
	): Promise<McpSearchResult[]> {
		if (!mailboxId) {
			const owned = await listMailboxesByOwner(this.env.INDEX_DB, this.auth.email);
			const rows = await Promise.all(
				owned.map(async (mailbox) =>
					(await this.searchMessages(mailbox.mailbox_id, query, limit)).map((row) => ({
						...row,
						mailbox_id: mailbox.mailbox_id,
					})),
				),
			);
			return rows
				.flat()
				.sort((a, b) => b.received_at.localeCompare(a.received_at))
				.slice(0, limit);
		}
		const stub = await this.resolveMailbox(mailboxId);
		const url = new URL("https://mailbox-do/search");
		url.searchParams.set("q", query);
		url.searchParams.set("limit", String(Math.min(limit, 50)));
		// Without the sensitive scope the DO matches sensitive messages on subject,
		// sender and recipients only, so a hit is not an oracle for hidden bodies.
		if (this.auth.scopes.has("mail:read:sensitive")) url.searchParams.set("sensitive", "1");
		const response = await stub.fetch(url.toString());
		if (!response.ok) {
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { results: RawSearchHit[] };
		const hits: McpSearchResult[] = [];
		for (const hit of data.results) {
			let msg: RawMessage;
			try {
				msg = await this.messageRow(mailboxId, hit.message_id);
			} catch (error) {
				if (error instanceof Error && error.message === "not_found") continue;
				throw error;
			}
			const kind = await this.sensitivity(msg);
			const protect = (value: string | null) =>
				value && kind && !this.auth.scopes.has("mail:read:sensitive")
					? redactSensitive(value, kind).text
					: value;
			hits.push({
				message_id: msg.id,
				mailbox_id: mailboxId,
				subject: protect(msg.subject),
				from_addr: protect(msg.from_addr) ?? "",
				from_name: protect(msg.from_name ?? null),
				snippet: protect(msg.snippet),
				received_at: msg.received_at,
			});
		}
		return hits;
	}

	async readThread(mailboxId: string, threadId: string): Promise<McpMessageDto[]> {
		const stub = await this.resolveMailbox(mailboxId);
		const response = await stub.fetch(`https://mailbox-do/threads/${encodeURIComponent(threadId)}`);
		if (!response.ok) throw new Error("internal_error");
		const data = (await response.json()) as { thread?: unknown; messages: Array<RawMessage> };
		if (!data.thread) throw new Error("not_found");
		const visible = data.messages.filter((message) => !this.isInstanceAuth(message));
		if (data.messages.length && !visible.length) throw new Error("not_found");
		return Promise.all(visible.map((message) => this.readMessage(mailboxId, message.id)));
	}

	private async messageRow(mailboxId: string, messageId: string): Promise<RawMessage> {
		const stub = await this.resolveMailbox(mailboxId);
		const response = await stub.fetch(
			`https://mailbox-do/messages/${encodeURIComponent(messageId)}`,
		);
		if (!response.ok) {
			if (response.status === 404) throw new Error("not_found");
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { message: RawMessage | null };
		const msg = data.message;
		if (!msg?.id) throw new Error("not_found");
		// This instance's own authentication mail does not exist as far as MCP is
		// concerned, whatever the scope.
		if (this.isInstanceAuth(msg)) throw new Error("not_found");
		return msg;
	}

	/** Stored classification, or (rows ingested before it existed) the sender. */
	private isInstanceAuth(msg: Pick<RawMessage, "sensitive_kind" | "from_addr">): boolean {
		return msg.sensitive_kind === "instance_auth" || isInstanceAuthSender(this.env, msg.from_addr);
	}

	/**
	 * The draft must still be the agent's (origin 'mcp'): human drafts, and agent
	 * drafts the owner has since edited (taken over), are off limits. The mailbox
	 * DO checks this again atomically with the write.
	 */
	private async assertAgentDraft(stub: DurableObjectStub, draftId: string): Promise<void> {
		const response = await stub.fetch(`https://mailbox-do/drafts/${encodeURIComponent(draftId)}`);
		if (!response.ok) throw new Error("not_found");
		const data = (await response.json()) as { draft?: { origin?: string } | null };
		if (!data.draft) throw new Error("not_found");
		if (data.draft.origin !== "mcp") throw new Error("draft_not_agent_owned");
	}

	private async sensitivity(msg: RawMessage): Promise<SensitiveKind | null> {
		let html: string | null = null;
		if (msg.sensitive_classified !== 1 && !msg.body_text && msg.body_html_r2_key) {
			const object = await this.env.MAIL_OBJECTS.get(msg.body_html_r2_key);
			if (!object) throw new Error("internal_error");
			html = await object.text();
		}
		return sensitiveKindForRead(msg, html);
	}

	async readMessage(mailboxId: string, messageId: string): Promise<McpMessageDto> {
		const msg = await this.messageRow(mailboxId, messageId);
		const kind = await this.sensitivity(msg);
		const redacted = Boolean(kind && !this.auth.scopes.has("mail:read:sensitive"));
		const protect = (s: string) => (redacted ? redactSensitive(s, kind).text : s);

		const envVars = this.env as unknown as Record<string, unknown>;
		const rawMax = Number(envVars.MCP_MAX_BODY_CHARS as string | undefined);
		const maxBodyChars = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : MCP_MAX_BODY_CHARS;
		const bodyText = protect(msg.body_text ?? "");
		const truncated = bodyText.length > maxBodyChars;

		return {
			message_id: msg.id,
			thread_id: msg.thread_id,
			direction: msg.direction as "inbound" | "outbound",
			from_addr: protect(msg.from_addr),
			from_name: msg.from_name ? protect(msg.from_name) : null,
			to: (JSON.parse(msg.to_json) as string[]).map(protect),
			cc: (JSON.parse(msg.cc_json) as string[]).map(protect),
			subject: msg.subject === null ? null : protect(msg.subject),
			date: msg.date_header,
			received_at: msg.received_at,
			is_read: Boolean(msg.is_read),
			has_attachments: Boolean(msg.has_attachments),
			attachments: (msg.attachments ?? []).map((a) => ({
				filename: a.filename === null ? null : protect(a.filename),
				content_type: a.content_type,
				size: a.size,
			})),
			body_text: truncated ? bodyText.slice(0, maxBodyChars) : bodyText,
			body_truncated: truncated,
			body_original_length: (msg.body_text ?? "").length,
			sensitive_kind: kind,
			redacted,
			resource_links: [
				{
					uri: `reccado://mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}/raw`,
					name: "Raw MIME",
					mimeType: "message/rfc822",
				},
				...(msg.attachments ?? []).map((a) => ({
					uri: `reccado://mailboxes/${encodeURIComponent(mailboxId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.id)}`,
					name: a.filename ? protect(a.filename) : "Attachment",
					mimeType: a.content_type ?? "application/octet-stream",
				})),
			],
		};
	}

	/**
	 * Raw MIME and attachments carry the full content, so they need
	 * mail:read:sensitive whenever the message is sensitive — or cannot be shown
	 * not to be (never classified, or its body could not be parsed). Fail closed.
	 */
	private async assertFullContentReadable(msg: RawMessage): Promise<void> {
		if (
			msg.sensitive_classified !== 1 ||
			msg.parse_status === "failed" ||
			(await this.sensitivity(msg))
		)
			assertScope(this.auth, "mail:read:sensitive");
	}

	async readResource(mailboxId: string, messageId: string, attachmentId?: string) {
		assertScope(this.auth, "mail:read");
		const msg = await this.messageRow(mailboxId, messageId);
		await this.assertFullContentReadable(msg);
		const attachment = attachmentId
			? msg.attachments?.find((a) => a.id === attachmentId)
			: undefined;
		if (attachmentId && !attachment) throw new Error("not_found");
		const key = attachment?.r2_key ?? msg.raw_r2_key;
		const head = await this.env.MAIL_OBJECTS.head(key);
		if (!head) throw new Error("not_found");
		if (head.size > 5 * 1024 * 1024) throw new Error(`too_large: ${head.size}`);
		const object = await this.env.MAIL_OBJECTS.get(key);
		if (!object) throw new Error("not_found");
		if (object.size > 5 * 1024 * 1024) throw new Error(`too_large: ${object.size}`);
		const bytes = new Uint8Array(await object.arrayBuffer());
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 8192)
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
		return {
			blob: btoa(binary),
			mimeType:
				attachment?.content_type ?? (attachmentId ? "application/octet-stream" : "message/rfc822"),
		};
	}

	async createDraft(
		mailboxId: string,
		params: McpDraftBody & {
			to: string[];
			subject: string;
			threadId?: string;
			inReplyToMessageId?: string;
			idempotencyKey: string;
		},
	): Promise<McpDraftResult> {
		const bodies = await mcpDraftBodies(params);
		const stub = await this.resolveMailbox(mailboxId);
		if (Boolean(params.threadId) !== Boolean(params.inReplyToMessageId))
			throw new Error("validation_error");
		if (params.inReplyToMessageId) {
			const parent = await this.messageRow(mailboxId, params.inReplyToMessageId);
			if (parent.thread_id !== params.threadId) throw new Error("validation_error");
		}

		// Self-recipient exclusion: remove the mailbox's own primary address from 'to'.
		const mailbox = await getMailboxForOwner(this.env.INDEX_DB, mailboxId, this.auth.email);
		const ownAddress = mailbox?.primary_address?.toLowerCase() ?? "";
		const filteredTo = params.to.filter((addr) => addr.toLowerCase() !== ownAddress);
		if (filteredTo.length === 0) {
			throw new Error("validation_error");
		}

		const response = await stub.fetch("https://mailbox-do/drafts", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to: filteredTo,
				subject: params.subject,
				bodyText: bodies.bodyText,
				...(bodies.bodyHtml ? { bodyHtml: bodies.bodyHtml } : {}),
				threadId: params.threadId ?? null,
				parentMessageId: params.inReplyToMessageId ?? null,
				origin: "mcp",
				idempotencyKey: params.idempotencyKey,
				createdBy: this.auth.email,
			}),
		});
		if (!response.ok) {
			if (response.status === 400) throw new Error("validation_error");
			// A retried key that names a draft the owner wrote or took over.
			if (response.status === 409) throw new Error("draft_not_agent_owned");
			throw new Error("internal_error");
		}
		const result = (await response.json()) as {
			id: string;
			status: string;
			duplicate?: boolean;
		};
		return {
			draft_id: result.id,
			status: "draft",
			duplicate: Boolean(result.duplicate),
		};
	}

	async updateDraft(
		mailboxId: string,
		draftId: string,
		params: McpDraftBody & { to: string[]; subject: string },
	): Promise<McpDraftResult> {
		const bodies = await mcpDraftBodies(params);
		const stub = await this.resolveMailbox(mailboxId);
		await this.assertAgentDraft(stub, draftId);
		const mailbox = await getMailboxForOwner(this.env.INDEX_DB, mailboxId, this.auth.email);
		const to = params.to.filter(
			(addr) => addr.toLowerCase() !== mailbox?.primary_address.toLowerCase(),
		);
		if (!to.length) throw new Error("validation_error");
		const response = await stub.fetch(`https://mailbox-do/drafts/${encodeURIComponent(draftId)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				to,
				subject: params.subject,
				bodyText: bodies.bodyText,
				// "" clears an earlier Markdown version's HTML: a text update is text-only.
				bodyHtml: bodies.bodyHtml ?? "",
				allowedStatuses: ["draft"],
				origin: "mcp",
			}),
		});
		if (!response.ok) throw await draftMutationError(response);
		return { draft_id: draftId, status: "draft", duplicate: false };
	}

	async cancelDraft(mailboxId: string, draftId: string) {
		const stub = await this.resolveMailbox(mailboxId);
		await this.assertAgentDraft(stub, draftId);
		const response = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(draftId)}/cancel`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				// requester "mcp": the DO re-checks, atomically with the write, that the
				// draft is still the agent's (the owner may have taken it over since).
				body: JSON.stringify({
					allowedStatuses: ["draft", "pending_confirmation"],
					requester: "mcp",
				}),
			},
		);
		if (!response.ok) throw await draftMutationError(response);
		return { draft_id: draftId, status: "cancelled" };
	}

	/**
	 * Files on the agent's own draft. Each change is re-checked in the mailbox DO,
	 * atomically with the write, as `requester: "mcp"`: the draft must still be the
	 * agent's and still a plain draft (not waiting for approval). Everything
	 * attached becomes part of the payload the owner approves — the frozen
	 * snapshot and payload_hash cover the files, and the approval page lists them.
	 */
	async addDraftFile(
		mailboxId: string,
		draftId: string,
		file: { filename: string; contentType?: string; bytes: Uint8Array },
	): Promise<McpDraftAttachmentsResult> {
		const stub = await this.resolveMailbox(mailboxId);
		await this.assertAgentDraft(stub, draftId);
		const response = await storeDraftUpload(this.env, stub, {
			mailboxId,
			draftId,
			filename: file.filename,
			contentType: file.contentType,
			bytes: file.bytes,
			requester: "mcp",
		});
		if (!response.ok) throw await draftAttachmentError(response);
		const { attachment } = (await response.json()) as { attachment: DraftAttachmentDto };
		return {
			draft_id: draftId,
			added: [toMcpDraftAttachment(attachment)],
			skipped: [],
			attachments: await this.draftAttachments(stub, draftId),
		};
	}

	/**
	 * Attaches files of a message in this mailbox (a forward, by reference to the
	 * stored objects). The agent may attach only what it could download itself:
	 * the same read gate as the attachment resources.
	 */
	async addDraftAttachmentsFromMessage(
		mailboxId: string,
		draftId: string,
		messageId: string,
		attachmentIds?: string[],
	): Promise<McpDraftAttachmentsResult> {
		assertScope(this.auth, "mail:read");
		const stub = await this.resolveMailbox(mailboxId);
		await this.assertAgentDraft(stub, draftId);
		const msg = await this.messageRow(mailboxId, messageId);
		await this.assertFullContentReadable(msg);
		const known = new Set((msg.attachments ?? []).map((a) => a.id));
		if (attachmentIds?.some((id) => !known.has(id))) throw new Error("not_found");
		if (known.size === 0) throw new Error("not_found");
		const response = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(draftId)}/attachments/from-message`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messageId, attachmentIds, requester: "mcp" }),
			},
		);
		if (!response.ok) throw await draftAttachmentError(response);
		const result = (await response.json()) as {
			added: DraftAttachmentDto[];
			skipped: Array<{ id: string; filename: string; reason: string }>;
		};
		return {
			draft_id: draftId,
			added: result.added.map(toMcpDraftAttachment),
			skipped: result.skipped,
			attachments: await this.draftAttachments(stub, draftId),
		};
	}

	async removeDraftAttachment(
		mailboxId: string,
		draftId: string,
		attachmentId: string,
	): Promise<McpDraftAttachmentsResult> {
		const stub = await this.resolveMailbox(mailboxId);
		await this.assertAgentDraft(stub, draftId);
		const response = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
			{
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ requester: "mcp" }),
			},
		);
		if (!response.ok) throw await draftAttachmentError(response);
		return {
			draft_id: draftId,
			added: [],
			skipped: [],
			attachments: await this.draftAttachments(stub, draftId),
		};
	}

	private async draftAttachments(
		stub: DurableObjectStub,
		draftId: string,
	): Promise<McpDraftAttachment[]> {
		const response = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(draftId)}/attachments`,
		);
		if (!response.ok) throw new Error("internal_error");
		const { attachments } = (await response.json()) as { attachments: DraftAttachmentDto[] };
		return attachments.map(toMcpDraftAttachment);
	}

	async updateMessages(mailboxId: string, messageIds: string[], action: string) {
		if (!isMessageAction(action)) throw new Error("validation_error");
		const stub = await this.resolveMailbox(mailboxId);
		for (const id of messageIds) await this.messageRow(mailboxId, id);
		for (const id of messageIds) {
			const response = await stub.fetch(
				`https://mailbox-do/messages/${encodeURIComponent(id)}/actions`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action }),
				},
			);
			if (!response.ok) throw new Error("internal_error");
			// Same best-effort card edit as the HTTP actions route. A queue miss
			// must not undo a mutation the mailbox already accepted.
			await enqueueTelegramCardRefreshForAction(this.env, {
				mailboxId,
				messageLocalId: id,
				action,
			});
		}
		return { message_ids: messageIds, action };
	}
}
