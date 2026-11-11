import { getMailboxForOwner, listMailboxesByOwner } from "../db/d1";
import type { McpDraftResult, McpMessageDto, McpSearchResult, McpThread } from "./types";
import { mailboxStub } from "../lib/mailbox-stub";
import { redactSensitive, sensitiveKindForRead, type SensitiveKind } from "../lib/sensitive-mail";
import { enqueueTelegramCardRefreshForAction, type TelegramCardAction } from "../telegram/cards";
import { assertScope, type McpAuthContext } from "./scopes";

const MCP_MAX_BODY_CHARS = 10_000;

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

async function draftMutationError(response: Response): Promise<Error> {
	const body = (await response.json().catch(() => null)) as { currentStatus?: string | null } | null;
	if (response.status === 409) return new Error(body?.currentStatus ? "draft_not_editable" : "not_found");
	if (response.status === 404) return new Error("not_found");
	return new Error("internal_error");
}

type RawMessage = {
	id: string;
	thread_id: string;
	direction: string;
	state: string;
	from_addr: string;
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
	sensitive_kind: SensitiveKind | null;
	sensitive_classified: number;
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
				const thread = (await response.json()) as { messages: RawMessage[] };
				const kinds = this.auth.scopes.has("mail:read:sensitive")
					? []
					: await Promise.all(thread.messages.map((message) => this.sensitivity(message)));
				const kind = kinds.find((value) => value !== null) ?? null;
				const protect = (s: string | null) => (s && kind ? redactSensitive(s, kind).text : s);
				return {
					id: t.id,
					subject_norm: protect(t.subject_norm),
					last_message_at: t.last_message_at,
					message_count: t.message_count,
					unread_count: t.unread_count,
					latest_subject: protect(t.latest_subject),
					latest_from: protect(t.latest_from),
					latest_snippet: protect(t.latest_snippet),
					latest_received_at: t.latest_received_at,
					latest_has_attachments: t.latest_has_attachments,
					latest_is_read: t.latest_is_read,
					latest_direction: t.latest_direction,
					latest_state: t.latest_state,
				};
			}),
		);
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
		const response = await stub.fetch(url.toString());
		if (!response.ok) {
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { results: RawSearchHit[] };
		const hits: McpSearchResult[] = [];
		for (const hit of data.results) {
			const msg = await this.messageRow(mailboxId, hit.message_id);
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
		const data = (await response.json()) as { thread?: unknown; messages: Array<{ id: string }> };
		if (!data.thread) throw new Error("not_found");
		return Promise.all(data.messages.map((message) => this.readMessage(mailboxId, message.id)));
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
		return msg;
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

	async readResource(mailboxId: string, messageId: string, attachmentId?: string) {
		assertScope(this.auth, "mail:read");
		const msg = await this.messageRow(mailboxId, messageId);
		if (await this.sensitivity(msg)) assertScope(this.auth, "mail:read:sensitive");
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
		params: {
			to: string[];
			subject: string;
			bodyText: string;
			threadId?: string;
			inReplyToMessageId?: string;
			idempotencyKey: string;
		},
	): Promise<McpDraftResult> {
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
				bodyText: params.bodyText,
				threadId: params.threadId ?? null,
				parentMessageId: params.inReplyToMessageId ?? null,
				origin: "mcp",
				idempotencyKey: params.idempotencyKey,
				createdBy: this.auth.email,
			}),
		});
		if (!response.ok) {
			if (response.status === 400) throw new Error("validation_error");
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
		params: { to: string[]; subject: string; bodyText: string },
	): Promise<McpDraftResult> {
		const stub = await this.resolveMailbox(mailboxId);
		const mailbox = await getMailboxForOwner(this.env.INDEX_DB, mailboxId, this.auth.email);
		const to = params.to.filter(
			(addr) => addr.toLowerCase() !== mailbox?.primary_address.toLowerCase(),
		);
		if (!to.length) throw new Error("validation_error");
		const response = await stub.fetch(`https://mailbox-do/drafts/${encodeURIComponent(draftId)}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...params, to, allowedStatuses: ["draft"], origin: "mcp" }),
		});
		if (!response.ok) throw await draftMutationError(response);
		return { draft_id: draftId, status: "draft", duplicate: false };
	}

	async cancelDraft(mailboxId: string, draftId: string) {
		const stub = await this.resolveMailbox(mailboxId);
		const response = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(draftId)}/cancel`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ allowedStatuses: ["draft", "pending_confirmation"] }),
			},
		);
		if (!response.ok) throw await draftMutationError(response);
		return { draft_id: draftId, status: "cancelled" };
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
