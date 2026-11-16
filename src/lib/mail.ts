import { sanitizeDisplayName } from "./display-name";
import { buildParticipants, type ThreadParticipant } from "./thread-summary";

/**
 * Frontend contract for the mail client: the exact data shapes the Reccado API
 * returns, the folder model, a thin typed fetch client, and presentation
 * helpers (Gmail-style dates, sender parsing, initials) shared across the UI.
 *
 * Backend reality this mirrors (see src/api + src/do/mailbox-do.ts):
 *  - GET /api/mailboxes                              -> { mailboxes }
 *  - GET /api/mailboxes/:id/threads?state=&limit=    -> { threads } (enriched rows; no
 *                                                       automated reports unless &reports=only)
 *  - GET /api/mailboxes/:id/threads/:threadId        -> { thread, messages }
 *  - GET /api/mailboxes/:id/messages/:messageId      -> { message }
 *  - POST .../messages/:messageId/actions            -> { ok, messageId, action }
 *  - GET /api/mailboxes/:id/search?q=&limit=         -> { results: [{ message_id }] }
 *  - GET /api/mailboxes/:id/counts                   -> { mailbox_id, counts } (real folder totals)
 *  - drafts lifecycle under .../drafts               -> create/patch/request-send/confirm-send/cancel
 */

export type Mailbox = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
	status: "active" | "disabled";
	/** Present on GET /api/mailboxes; used for stable colour/column order. */
	created_at?: string;
};

export type MessageState = "inbox" | "archive" | "trash" | "sent" | "draft";

/** A row from GET /threads — enriched so it renders a full Gmail row alone. */
export type ThreadRow = {
	id: string;
	subject_norm: string | null;
	last_message_at: string;
	message_count: number;
	unread_count: number;
	created_at: string;
	updated_at: string;
	latest_subject: string | null;
	latest_from: string;
	/** Sender display name (sanitised at ingest); null/absent for older rows. */
	latest_from_name?: string | null;
	latest_snippet: string | null;
	latest_received_at: string;
	latest_has_attachments: number; // 0 | 1
	latest_is_read: number; // 0 | 1
	latest_direction: "inbound" | "outbound";
	latest_state: MessageState;
	/** Recipients of the representative message (JSON string[]): the "To: …" of an outbound-only row. */
	latest_to_json?: string | null;
	latest_recipient_names_json?: string | null;
	/** Senders of the conversation, oldest first ("Rico, me"). */
	participants?: ThreadParticipant[];
};

export type Attachment = {
	id: string;
	message_id: string;
	filename: string | null;
	content_type: string | null;
	disposition: string | null;
	size: number;
	sha256: string;
	r2_key: string;
};

export type Message = {
	id: string;
	thread_id: string;
	rfc_message_id: string | null;
	in_reply_to: string | null;
	direction: "inbound" | "outbound";
	state: MessageState;
	from_addr: string;
	/** Sender display name (sanitised at ingest); null/absent for older rows. */
	from_name?: string | null;
	to_json: string; // JSON string[]
	cc_json: string; // JSON string[]
	bcc_json: string; // JSON string[]
	/** JSON {"lowercased address": "name"} for named To/Cc recipients, or null. */
	recipient_names_json?: string | null;
	/** JSON string[] of Reply-To addresses ("[]" when none); null/absent when not known yet. */
	reply_to_json?: string | null;
	subject: string | null;
	snippet: string | null;
	date_header: string | null;
	received_at: string;
	body_text: string | null;
	/** R2 key for the stored HTML body, or null for text-only mail. Presence means the message has an HTML rendering (served via `messageHtmlUrl`). */
	body_html_r2_key: string | null;
	has_attachments: number; // 0 | 1
	is_read: number; // 0 | 1
	/** "dmarc_report" for automated mail the web lists only under "DMARC reports". */
	automated_kind?: string | null;
	created_at: string;
	updated_at: string;
};

export type ThreadDetail = {
	thread: {
		id: string;
		subject_norm: string | null;
		last_message_at: string;
		message_count: number;
		unread_count: number;
		created_at: string;
		updated_at: string;
	} | null;
	messages: Array<Message & { attachments?: Attachment[] }>;
};

export type Draft = {
	id: string;
	thread_id: string | null;
	/** The message a reply answers, when the draft is a reply. */
	parent_message_id?: string | null;
	to_json: string;
	cc_json: string;
	bcc_json: string;
	subject: string | null;
	body_text: string | null;
	body_html: string | null;
	status: "draft" | "pending_confirmation" | "sent" | "cancelled";
	/** Who created it: "mcp" drafts can only be sent through an owner approval. */
	origin?: "web" | "telegram" | "mcp";
	/** Files on the draft (GET /drafts/:id). */
	attachments?: DraftAttachment[];
	/** How many files (GET /drafts list rows). */
	attachment_count?: number;
	created_by: string;
	created_at: string;
	updated_at: string;
};

/** A file on a draft: an upload, or (forward) a reference to a message's file. */
export type DraftAttachment = {
	id: string;
	filename: string;
	content_type: string;
	size: number;
	sha256: string;
	source: "upload" | "message";
	source_attachment_id?: string | null;
	created_at: string;
};

export type MessageAction = "mark_read" | "mark_unread" | "archive" | "trash" | "restore_inbox";

/**
 * Folders the backend actually supports. `drafts` is special (own table);
 * `reports` lists the automated DMARC reports every other folder leaves out.
 */
export type FolderKey = "inbox" | "sent" | "drafts" | "archive" | "trash" | "all" | "reports";

/** Which messages a folder is made of: people's mail (default) or automated reports. */
export type FolderMail = "people" | "reports";

export type Folder = {
	key: FolderKey;
	label: string;
	/** state param for /threads, or null for "all mail" / the drafts pseudo-folder */
	state: Exclude<MessageState, "draft"> | null;
	/** drafts uses the /drafts endpoint instead of /threads */
	kind: "threads" | "drafts";
	/** Set on the reports view only. */
	mail?: FolderMail;
};

export const FOLDERS: Folder[] = [
	{ key: "inbox", label: "Inbox", state: "inbox", kind: "threads" },
	{ key: "sent", label: "Sent", state: "sent", kind: "threads" },
	{ key: "drafts", label: "Drafts", state: null, kind: "drafts" },
	{ key: "archive", label: "Archive", state: "archive", kind: "threads" },
	{ key: "trash", label: "Trash", state: "trash", kind: "threads" },
	{ key: "all", label: "All mail", state: null, kind: "threads" },
	{ key: "reports", label: "DMARC reports", state: null, kind: "threads", mail: "reports" },
];

/** Is this message one the folder lists? Mirrors the server's `reports` filter. */
export function inFolderMail(message: Pick<Message, "automated_kind">, mail?: FolderMail): boolean {
	return mail === "reports" ? Boolean(message.automated_kind) : !message.automated_kind;
}

// --------------------------------------------------------------------------
// Fetch client — all same-origin; the browser attaches the Access session
// cookie and an Origin header (required by the API's CSRF guard) automatically.
// --------------------------------------------------------------------------

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) {
		// No session: nothing on this page can work, and an "HTTP 401" card with a
		// retry button is a dead end — there is no session to sign out of either.
		// Send the person to the one page that can fix it.
		if (res.status === 401 && typeof window !== "undefined") {
			window.location.assign("/login");
		}
		throw new Error(`HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

const base = (mailboxId: string) => `/api/mailboxes/${encodeURIComponent(mailboxId)}`;

export async function fetchMailboxes(): Promise<Mailbox[]> {
	const data = await json<{ mailboxes: Mailbox[] }>(await fetch("/api/mailboxes"));
	return data.mailboxes ?? [];
}

export async function fetchThreads(
	mailboxId: string,
	opts: {
		state?: Exclude<MessageState, "draft"> | null;
		limit?: number;
		mail?: FolderMail;
		/** Start after this row (`<latest_received_at>|<id>`, see thread-paging.ts). */
		cursor?: string;
		/** Only conversations with something unread. */
		unread?: boolean;
	} = {},
): Promise<ThreadRow[]> {
	const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
	if (opts.state) params.set("state", opts.state);
	if (opts.mail === "reports") params.set("reports", "only");
	if (opts.cursor) params.set("cursor", opts.cursor);
	if (opts.unread) params.set("unread", "true");
	const data = await json<{ threads: ThreadRow[] }>(
		await fetch(`${base(mailboxId)}/threads?${params.toString()}`),
	);
	return data.threads ?? [];
}

/**
 * One conversation. Opening it also fills older rows' sender names and
 * Reply-To from their raw headers (once, server side); `backfill: false` reads
 * it as stored, for callers that only summarise it (search).
 */
export async function fetchThread(
	mailboxId: string,
	threadId: string,
	opts: { backfill?: boolean } = {},
): Promise<ThreadDetail> {
	const query = opts.backfill === false ? "?backfill=0" : "";
	return json<ThreadDetail>(
		await fetch(`${base(mailboxId)}/threads/${encodeURIComponent(threadId)}${query}`),
	);
}

/** Requests a search keeps in flight at once (per mailbox). */
export const SEARCH_FETCH_CONCURRENCY = 6;

/** `fn` over `items` with at most `limit` running at once; results in input order. */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export async function fetchMessage(
	mailboxId: string,
	messageId: string,
): Promise<Message & { attachments: Attachment[] }> {
	const data = await json<{ message: Message & { attachments: Attachment[] } }>(
		await fetch(`${base(mailboxId)}/messages/${encodeURIComponent(messageId)}`),
	);
	return data.message;
}

export async function runMessageAction(
	mailboxId: string,
	messageId: string,
	action: MessageAction,
): Promise<void> {
	const res = await fetch(`${base(mailboxId)}/messages/${encodeURIComponent(messageId)}/actions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action }),
	});
	if (!res.ok) throw new Error(`Action failed (HTTP ${res.status})`);
}

/** A message a bulk action changed, as it was before (what Undo restores). */
export type ChangedMessage = { id: string; thread_id: string; state: string; is_read: number };

/**
 * Which messages of a conversation a thread action reaches: what the folder it
 * is taken from shows. Outside the Trash, never the trashed ones; in the
 * Trash, only those; All mail (and its reports view), every one.
 */
export type ThreadScope = "live" | "trash" | "all";

export function folderScope(folder: { state: MessageState | null }): ThreadScope {
	if (folder.state === "trash") return "trash";
	if (folder.state === null) return "all";
	return "live";
}

/** The messages of an open conversation a thread action from `scope` reaches. */
export function inScope<T extends { state: string }>(
	messages: readonly T[],
	scope: ThreadScope,
): T[] {
	if (scope === "all") return [...messages];
	return messages.filter((m) => (scope === "trash" ? m.state === "trash" : m.state !== "trash"));
}

export type BulkTarget =
	| { threadIds: string[]; scope: ThreadScope }
	| { messageIds: string[] }
	| { folder: { state: Exclude<MessageState, "draft"> | null; reports?: "only" } };

/**
 * One action on many messages of a mailbox in one request: whole conversations,
 * exact messages, or every unread message of a folder (mark_read only).
 * Answers which messages changed and what they were before.
 */
export async function runBulkAction(
	mailboxId: string,
	action: MessageAction,
	target: BulkTarget,
): Promise<ChangedMessage[]> {
	const data = await json<{ changed: ChangedMessage[] }>(
		await fetch(`${base(mailboxId)}/bulk-actions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, ...target }),
		}),
	);
	return data.changed ?? [];
}

/** Apply an action to the given messages (folder moves are per-message). */
export async function runThreadAction(
	mailboxId: string,
	messageIds: string[],
	action: MessageAction,
): Promise<ChangedMessage[]> {
	const changed: ChangedMessage[] = [];
	for (let i = 0; i < messageIds.length; i += 1000) {
		changed.push(
			...(await runBulkAction(mailboxId, action, { messageIds: messageIds.slice(i, i + 1000) })),
		);
	}
	return changed;
}

/**
 * Move whole conversations (by id) to a folder, or set their read state, in one
 * request per hundred, touching only the messages `scope` reaches (see
 * ThreadScope). Returns what changed, for Undo.
 */
export async function moveThreads(
	mailboxId: string,
	threadIds: string[],
	action: MessageAction,
	scope: ThreadScope,
): Promise<ChangedMessage[]> {
	const changed: ChangedMessage[] = [];
	for (let i = 0; i < threadIds.length; i += 100) {
		changed.push(
			...(await runBulkAction(mailboxId, action, {
				threadIds: threadIds.slice(i, i + 100),
				scope,
			})),
		);
	}
	return changed;
}

/** Move one conversation (by id). Returns what changed, for Undo. */
export async function moveThread(
	mailboxId: string,
	threadId: string,
	action: MessageAction,
	scope: ThreadScope,
): Promise<ChangedMessage[]> {
	return moveThreads(mailboxId, [threadId], action, scope);
}

/** "Mark all as read" for a folder of one mailbox. */
export async function markFolderRead(
	mailboxId: string,
	folder: { state: Exclude<MessageState, "draft"> | null; mail?: FolderMail },
): Promise<ChangedMessage[]> {
	return runBulkAction(mailboxId, "mark_read", {
		folder: { state: folder.state, ...(folder.mail === "reports" ? { reports: "only" } : {}) },
	});
}

/** Where a permanent deletion is (POST/GET …/purge). */
export type PurgeOperation = {
	operationId: string;
	status: "running" | "done";
	/** Messages queued when it started. */
	requested: number;
	/** Messages deleted so far. */
	deleted: number;
	remaining: number;
};

/** Something in the request was not in the Trash: nothing was deleted. */
export class NotInTrashError extends Error {
	constructor() {
		super("not_in_trash");
	}
}

async function startPurge(
	mailboxId: string,
	target: { threadIds: string[] } | { emptyTrash: true },
): Promise<PurgeOperation> {
	const res = await fetch(`${base(mailboxId)}/purge`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(target),
	});
	if (res.status === 409) throw new NotInTrashError();
	return json<PurgeOperation>(res);
}

/**
 * Delete forever, and wait until it is done: the server deletes in batches,
 * the first one inside the request and the rest in the background, so a large
 * Trash is followed here until its queue is empty. `onProgress` gets the
 * messages deleted so far and the total queued.
 */
async function purgeToEnd(
	mailboxId: string,
	target: { threadIds: string[] } | { emptyTrash: true },
	onProgress?: (deleted: number, total: number) => void,
): Promise<PurgeOperation> {
	let op = await startPurge(mailboxId, target);
	onProgress?.(op.deleted, op.requested);
	while (op.status !== "done") {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		op = await json<PurgeOperation>(
			await fetch(`${base(mailboxId)}/purge/${encodeURIComponent(op.operationId)}`),
		);
		onProgress?.(op.deleted, op.requested);
	}
	return op;
}

/** "Delete forever" for conversations in the Trash (their trashed messages). */
export async function purgeThreads(
	mailboxId: string,
	threadIds: string[],
	onProgress?: (deleted: number, total: number) => void,
): Promise<number> {
	let deleted = 0;
	for (let i = 0; i < threadIds.length; i += 100) {
		const op = await purgeToEnd(mailboxId, { threadIds: threadIds.slice(i, i + 100) }, (d, t) =>
			onProgress?.(deleted + d, deleted + t),
		);
		deleted += op.deleted;
	}
	return deleted;
}

/** "Empty trash" for one mailbox. Resolves with the messages deleted. */
export async function emptyTrash(
	mailboxId: string,
	onProgress?: (deleted: number, total: number) => void,
): Promise<number> {
	return (await purgeToEnd(mailboxId, { emptyTrash: true }, onProgress)).deleted;
}

export async function fetchDrafts(mailboxId: string): Promise<Draft[]> {
	const data = await json<{ drafts: Draft[] }>(await fetch(`${base(mailboxId)}/drafts`));
	return data.drafts ?? [];
}

export async function fetchDraft(mailboxId: string, draftId: string): Promise<Draft> {
	const data = await json<{ draft: Draft }>(
		await fetch(`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}`),
	);
	return data.draft;
}

export type DraftPayload = {
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	bodyText?: string;
	/** Rich body; the server sanitises it and derives bodyText from it. */
	bodyHtml?: string;
	threadId?: string;
	/** The message being answered (In-Reply-To), for replies. */
	parentMessageId?: string;
};

export async function createDraft(mailboxId: string, payload: DraftPayload): Promise<string> {
	const data = await json<{ id: string }>(
		await fetch(`${base(mailboxId)}/drafts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		}),
	);
	return data.id;
}

export async function updateDraft(
	mailboxId: string,
	draftId: string,
	payload: DraftPayload,
): Promise<void> {
	const res = await fetch(`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!res.ok) throw new Error(`Could not update draft (HTTP ${res.status})`);
}

export async function cancelDraft(mailboxId: string, draftId: string): Promise<void> {
	const res = await fetch(`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/cancel`, {
		method: "POST",
	});
	if (!res.ok) throw new Error(`Could not discard draft (HTTP ${res.status})`);
}

/** Why the server refused a file, in words (limits are in lib/attachment-limits.ts). */
export function attachmentErrorText(code: string | undefined): string {
	switch (code) {
		case "attachment_too_large":
			return "File is too large";
		case "attachments_too_large":
			return "Over the total size limit";
		case "too_many_attachments":
			return "Too many files";
		case "attachment_empty":
			return "File is empty";
		case "agent_draft_attachments":
			return "Agent drafts can't take files";
		case "draft_not_editable":
			return "The draft can no longer be changed";
		case "send_in_progress":
			return "The message is being sent";
		case "aborted":
			return "Upload cancelled";
		default:
			return "Upload failed";
	}
}

export class AttachmentUploadError extends Error {
	constructor(readonly code: string) {
		super(attachmentErrorText(code));
	}
}

/**
 * Uploads one file to a draft as a raw body (its type in Content-Type, its name
 * in ?filename=). XHR rather than fetch for the upload progress events.
 */
export function uploadDraftAttachment(
	mailboxId: string,
	draftId: string,
	file: File,
	opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<DraftAttachment> {
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		const url = `${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/attachments?filename=${encodeURIComponent(file.name)}`;
		xhr.open("POST", url);
		xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) opts.onProgress?.(event.loaded / event.total);
		};
		xhr.onload = () => {
			let body: { attachment?: DraftAttachment; error?: string } = {};
			try {
				body = JSON.parse(xhr.responseText) as typeof body;
			} catch {
				// Not JSON: reported by status below.
			}
			if (xhr.status === 401 && typeof window !== "undefined") window.location.assign("/login");
			if (xhr.status >= 200 && xhr.status < 300 && body.attachment) resolve(body.attachment);
			else reject(new AttachmentUploadError(body.error ?? `http_${xhr.status}`));
		};
		xhr.onerror = () => reject(new AttachmentUploadError("network"));
		xhr.onabort = () => reject(new AttachmentUploadError("aborted"));
		opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
		xhr.send(file);
	});
}

export async function deleteDraftAttachment(
	mailboxId: string,
	draftId: string,
	attachmentId: string,
): Promise<void> {
	const res = await fetch(
		`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`,
		{ method: "DELETE" },
	);
	// Already gone is what we wanted.
	if (!res.ok && res.status !== 404)
		throw new Error(`Could not remove the file (HTTP ${res.status})`);
}

/** Forward: attach a message's files to the draft by reference (no bytes move). */
export async function attachMessageFiles(
	mailboxId: string,
	draftId: string,
	messageId: string,
	attachmentIds: string[],
): Promise<{
	added: DraftAttachment[];
	skipped: Array<{ id: string; filename: string; reason: string }>;
}> {
	return json(
		await fetch(
			`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/attachments/from-message`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messageId, attachmentIds }),
			},
		),
	);
}

export function draftAttachmentUrl(mailboxId: string, draftId: string, attachmentId: string) {
	return `${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Undo a discard: your own discarded draft becomes a draft again. */
export async function restoreDraft(mailboxId: string, draftId: string): Promise<void> {
	const res = await fetch(`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/restore`, {
		method: "POST",
	});
	if (!res.ok) throw new Error(`Could not restore the draft (HTTP ${res.status})`);
}

/**
 * One-click send: the backend keeps the draft -> request-send -> confirm-send
 * state machine (the human-confirmation gate for agent-initiated sends), so the
 * UI walks the whole chain in one call since a person is composing here.
 */
export async function sendDraft(
	mailboxId: string,
	draftId: string,
	idempotencyKey: string,
): Promise<{ sent: boolean; reason?: string; threadId?: string }> {
	const reqRes = await fetch(
		`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/request-send`,
		{ method: "POST" },
	);
	if (!reqRes.ok) throw new Error(`Send request failed (HTTP ${reqRes.status})`);
	const res = await fetch(`${base(mailboxId)}/drafts/${encodeURIComponent(draftId)}/confirm-send`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ idempotencyKey }),
	});
	let data: {
		sent?: boolean;
		duplicate?: boolean;
		reason?: string;
		error?: string;
		threadId?: string;
	};
	try {
		data = (await res.json()) as typeof data;
	} catch {
		data = {};
	}
	if (res.ok && (data.sent || data.duplicate)) {
		return { sent: true, ...(data.threadId ? { threadId: data.threadId } : {}) };
	}
	return { sent: false, reason: data.reason ?? data.error ?? `HTTP ${res.status}` };
}

export type FolderCounts = { threads: number; unread: number; messages: number };

/** GET /counts: real totals per folder, computed by the mailbox Durable Object. */
export type MailboxCounts = {
	inbox: FolderCounts;
	sent: FolderCounts;
	archive: FolderCounts;
	trash: FolderCounts;
	all: FolderCounts;
	/** Open drafts (editable or awaiting confirmation). */
	drafts: number;
	/** Automated DMARC reports, kept out of every figure above. Older servers omit it. */
	reports?: FolderCounts;
};

export async function fetchCounts(mailboxId: string): Promise<MailboxCounts> {
	const data = await json<{ counts: MailboxCounts }>(await fetch(`${base(mailboxId)}/counts`));
	return data.counts;
}

export async function searchMessageIds(
	mailboxId: string,
	q: string,
	limit = 25,
	mail?: FolderMail,
): Promise<string[]> {
	const params = new URLSearchParams({ q, limit: String(limit) });
	if (mail === "reports") params.set("reports", "only");
	const data = await json<{ results: Array<{ message_id: string }> }>(
		await fetch(`${base(mailboxId)}/search?${params.toString()}`),
	);
	return (data.results ?? []).map((r) => r.message_id);
}

export async function searchThreads(
	mailboxId: string,
	q: string,
	opts: { state?: Exclude<MessageState, "draft"> | null; limit?: number; mail?: FolderMail } = {},
): Promise<ThreadRow[]> {
	const messageIds = await searchMessageIds(mailboxId, q, opts.limit ?? 50, opts.mail);
	// The hits, a few at a time; then each conversation once, by its first hit in
	// this folder. Read as stored: summarising a result is not opening it, so it
	// never waits on (or triggers) the header backfill.
	const messages = await mapWithConcurrency(messageIds, SEARCH_FETCH_CONCURRENCY, (id) =>
		fetchMessage(mailboxId, id),
	);
	const firstHit = new Map<string, (typeof messages)[number]>();
	for (const message of messages) {
		if (opts.state && message.state !== opts.state) continue;
		if (!firstHit.has(message.thread_id)) firstHit.set(message.thread_id, message);
	}
	const hits = [...firstHit.values()];
	const details = await mapWithConcurrency(hits, SEARCH_FETCH_CONCURRENCY, (message) =>
		fetchThread(mailboxId, message.thread_id, { backfill: false }),
	);
	const rows: ThreadRow[] = [];
	hits.forEach((message, i) => {
		const detail = details[i]!;
		// A detail that came back without messages still has the hit itself.
		const row = summarizeThread(
			detail.messages.length > 0 ? detail : { ...detail, messages: [message] },
			opts.state ?? null,
			opts.mail,
		);
		if (row) rows.push(row);
	});

	// Newest activity first, like every other list.
	return rows.sort(byLatestActivity);
}

/** Newest representative message first; thread id breaks ties so the order is total. */
export function byLatestActivity(
	a: { latest_received_at: string; id: string },
	b: { latest_received_at: string; id: string },
): number {
	if (a.latest_received_at !== b.latest_received_at) {
		return a.latest_received_at < b.latest_received_at ? 1 : -1;
	}
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * A list row from a full thread, with the same rules the mailbox DO applies to
 * GET /threads: a folder shows the conversation's messages outside the trash
 * (Trash shows the trashed ones), and the newest of those represents it.
 * Automated reports count only in the reports view, as on the server.
 */
export function summarizeThread(
	detail: ThreadDetail,
	state: Exclude<MessageState, "draft"> | null,
	mail?: FolderMail,
): ThreadRow | null {
	const visible = detail.messages.filter(
		(m) =>
			inFolderMail(m, mail) &&
			(state === "trash" ? m.state === "trash" : state ? m.state !== "trash" : true),
	);
	const latest = visible.at(-1);
	if (!latest) return null;
	return {
		id: latest.thread_id,
		subject_norm: detail.thread?.subject_norm ?? latest.subject,
		last_message_at: detail.thread?.last_message_at ?? latest.received_at,
		message_count: visible.length,
		unread_count: visible.filter((m) => m.is_read === 0).length,
		created_at: detail.thread?.created_at ?? latest.created_at,
		updated_at: detail.thread?.updated_at ?? latest.updated_at,
		latest_subject: latest.subject,
		latest_from: latest.from_addr,
		latest_from_name: latest.from_name ?? null,
		latest_snippet: latest.snippet,
		latest_received_at: latest.received_at,
		latest_has_attachments: latest.has_attachments,
		latest_is_read: latest.is_read,
		latest_direction: latest.direction,
		latest_state: latest.state,
		latest_to_json: latest.to_json,
		latest_recipient_names_json: latest.recipient_names_json ?? null,
		participants: buildParticipants(visible),
	};
}

export function rawMessageUrl(mailboxId: string, messageId: string): string {
	return `${base(mailboxId)}/messages/${encodeURIComponent(messageId)}/raw`;
}

/** Sandboxed HTML body endpoint — safe to use as the `src` of a sandboxed iframe. */
export function messageHtmlUrl(mailboxId: string, messageId: string): string {
	return `${base(mailboxId)}/messages/${encodeURIComponent(messageId)}/html`;
}

export function attachmentUrl(mailboxId: string, messageId: string, attachmentId: string): string {
	return `${base(mailboxId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

// --------------------------------------------------------------------------
// Presentation helpers (kept here so every component formats identically)
// --------------------------------------------------------------------------

export function parseAddressList(jsonStr: string | null | undefined): string[] {
	if (!jsonStr) return [];
	try {
		const parsed = JSON.parse(jsonStr);
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

/**
 * What to call a sender: the stored display name when there is a trustworthy
 * one ("Noor Haddad"), else the address's local part ("noor"). The name is
 * re-sanitised here (rows can predate ingest-time sanitising), and a name that
 * names a different address is ignored. Callers must still show the real
 * address somewhere reachable (a header line or a `title`).
 */
export function displayName(fromAddr: string | null | undefined, name?: string | null): string {
	const addr = extractEmail(fromAddr);
	const stored = sanitizeDisplayName(name, addr);
	if (stored) return stored;
	if (!fromAddr) return "Unknown";
	const named = fromAddr.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
	const fromHeader = sanitizeDisplayName(named?.[1], addr);
	if (fromHeader) return fromHeader;
	const local = addr.split("@")[0] ?? addr;
	return local || addr;
}

/** `{ address: name }` from `recipient_names_json`; {} when absent or malformed. */
export function parseAddressNames(jsonStr: string | null | undefined): Record<string, string> {
	if (!jsonStr) return {};
	try {
		const parsed = JSON.parse(jsonStr) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, string> = {};
		for (const [address, name] of Object.entries(parsed)) {
			if (typeof name === "string") out[address.toLowerCase()] = name;
		}
		return out;
	} catch {
		return {};
	}
}

/** A recipient as drawn in a header: "Noor Haddad <noor@haddad.dev>", or the bare address. */
export function recipientLabel(address: string, names: Record<string, string>): string {
	const name = sanitizeDisplayName(names[address.toLowerCase()], address);
	return name ? `${name} <${address}>` : address;
}

/** Pull the bare email out of "Name <email>" or a plain address. */
export function extractEmail(fromAddr: string | null | undefined): string {
	if (!fromAddr) return "";
	const angled = fromAddr.match(/<([^>]+)>/);
	return (angled?.[1] ?? fromAddr).trim();
}

export function initials(fromAddr: string | null | undefined, storedName?: string | null): string {
	const name = displayName(fromAddr, storedName);
	const parts = name.split(/[\s._-]+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
	return ((parts[0]![0] ?? "") + (parts[1]![0] ?? "")).toUpperCase();
}

/**
 * Deterministic avatar hue from an address, so a given sender is always the
 * same color. Avoids Math.random (stable across renders/SSR). Deliberately keyed
 * on the address, never the display name: the name is the sender's free choice,
 * so a stranger calling themselves "Noor Haddad" must not get Noor's colour.
 */
export function avatarHue(fromAddr: string | null | undefined): number {
	const s = extractEmail(fromAddr) || "?";
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
	return h;
}

export function formatBytes(bytes: number): string {
	if (!bytes) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
