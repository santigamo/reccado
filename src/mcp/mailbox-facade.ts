import type { AuthContext } from "../api/auth";
import { getMailboxForOwner } from "../db/d1";
import type {
	McpDraftResult,
	McpMessageDto,
	McpSearchResult,
	McpThread,
} from "./types";

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

type RawSearchResult = {
	message_id: string;
	subject: string | null;
	from_addr: string;
	snippet: string | null;
	received_at: string;
};

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
	date_header: string | null;
	received_at: string;
	is_read: number;
	has_attachments: number;
	body_text: string | null;
	attachments: Array<{
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
		private auth: AuthContext,
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
		return this.env.MAILBOX_DO.getByName(mailboxId);
	}

	async listThreads(
		mailboxId: string,
		limit: number,
		state?: string,
	): Promise<McpThread[]> {
		const stub = await this.resolveMailbox(mailboxId);
		const url = new URL("https://mailbox-do/threads");
		url.searchParams.set("limit", String(Math.min(limit, 50)));
		if (state) {
			url.searchParams.set("state", state);
		}
		const response = await stub.fetch(url.toString());
		if (!response.ok) {
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { threads: RawThread[] };
		return data.threads.map((t) => ({
			id: t.id,
			subject_norm: t.subject_norm,
			last_message_at: t.last_message_at,
			message_count: t.message_count,
			unread_count: t.unread_count,
			latest_subject: t.latest_subject,
			latest_from: t.latest_from,
			latest_snippet: t.latest_snippet,
			latest_received_at: t.latest_received_at,
			latest_has_attachments: t.latest_has_attachments,
			latest_is_read: t.latest_is_read,
			latest_direction: t.latest_direction,
			latest_state: t.latest_state,
		}));
	}

	async searchMessages(
		mailboxId: string,
		query: string,
		limit: number,
	): Promise<McpSearchResult[]> {
		const stub = await this.resolveMailbox(mailboxId);
		const url = new URL("https://mailbox-do/search");
		url.searchParams.set("q", query);
		url.searchParams.set("limit", String(Math.min(limit, 50)));
		const response = await stub.fetch(url.toString());
		if (!response.ok) {
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { results: RawSearchResult[] };
		return data.results.map((r) => ({
			message_id: r.message_id,
			subject: r.subject,
			from_addr: r.from_addr,
			snippet: r.snippet,
			received_at: r.received_at,
		}));
	}

	async readMessage(mailboxId: string, messageId: string): Promise<McpMessageDto> {
		const stub = await this.resolveMailbox(mailboxId);
		const response = await stub.fetch(`https://mailbox-do/messages/${messageId}`);
		if (!response.ok) {
			if (response.status === 404) throw new Error("not_found");
			throw new Error("internal_error");
		}
		const data = (await response.json()) as { message: RawMessage | null };
		const msg = data.message;
		if (!msg?.id) throw new Error("not_found");

		const envVars = this.env as unknown as Record<string, unknown>;
		const rawMax = Number(envVars.MCP_MAX_BODY_CHARS as string | undefined);
		const maxBodyChars = Number.isFinite(rawMax) && rawMax > 0 ? rawMax : MCP_MAX_BODY_CHARS;
		const bodyText = msg.body_text ?? "";
		const truncated = bodyText.length > maxBodyChars;

		return {
			message_id: msg.id,
			thread_id: msg.thread_id,
			direction: msg.direction as "inbound" | "outbound",
			from_addr: msg.from_addr,
			to: JSON.parse(msg.to_json) as string[],
			cc: JSON.parse(msg.cc_json) as string[],
			subject: msg.subject,
			date: msg.date_header,
			received_at: msg.received_at,
			is_read: Boolean(msg.is_read),
			has_attachments: Boolean(msg.has_attachments),
			attachments: (msg.attachments ?? []).map((a) => ({
				filename: a.filename,
				content_type: a.content_type,
				size: a.size,
			})),
			body_text: truncated ? bodyText.slice(0, maxBodyChars) : bodyText,
			body_truncated: truncated,
			body_original_length: bodyText.length,
		};
	}

	async createDraft(
		mailboxId: string,
		params: {
			to: string[];
			subject: string;
			bodyText: string;
			threadId?: string;
			idempotencyKey: string;
		},
	): Promise<McpDraftResult> {
		const stub = await this.resolveMailbox(mailboxId);

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
}
