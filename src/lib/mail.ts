/**
 * Frontend contract for the mail client: the exact data shapes the Reccado API
 * returns, the folder model, a thin typed fetch client, and presentation
 * helpers (Gmail-style dates, sender parsing, initials) shared across the UI.
 *
 * Backend reality this mirrors (see src/api + src/do/mailbox-do.ts):
 *  - GET /api/mailboxes                              -> { mailboxes }
 *  - GET /api/mailboxes/:id/threads?state=&limit=    -> { threads } (enriched rows)
 *  - GET /api/mailboxes/:id/threads/:threadId        -> { thread, messages }
 *  - GET /api/mailboxes/:id/messages/:messageId      -> { message }
 *  - POST .../messages/:messageId/actions            -> { ok, messageId, action }
 *  - GET /api/mailboxes/:id/search?q=&limit=         -> { results: [{ message_id }] }
 *  - drafts lifecycle under .../drafts               -> create/patch/request-send/confirm-send/cancel
 */

export type Mailbox = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
	status: "active" | "disabled";
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
	latest_snippet: string | null;
	latest_received_at: string;
	latest_has_attachments: number; // 0 | 1
	latest_is_read: number; // 0 | 1
	latest_direction: "inbound" | "outbound";
	latest_state: MessageState;
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
	to_json: string; // JSON string[]
	cc_json: string; // JSON string[]
	bcc_json: string; // JSON string[]
	subject: string | null;
	snippet: string | null;
	date_header: string | null;
	received_at: string;
	body_text: string | null;
	has_attachments: number; // 0 | 1
	is_read: number; // 0 | 1
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
	to_json: string;
	cc_json: string;
	bcc_json: string;
	subject: string | null;
	body_text: string | null;
	body_html: string | null;
	status: "draft" | "pending_confirmation" | "sent" | "cancelled";
	created_by: string;
	created_at: string;
	updated_at: string;
};

export type MessageAction = "mark_read" | "mark_unread" | "archive" | "trash" | "restore_inbox";

/** Folders the backend actually supports. `drafts` is special (own table). */
export type FolderKey = "inbox" | "sent" | "drafts" | "archive" | "trash" | "all";

export type Folder = {
	key: FolderKey;
	label: string;
	/** state param for /threads, or null for "all mail" / the drafts pseudo-folder */
	state: Exclude<MessageState, "draft"> | null;
	/** drafts uses the /drafts endpoint instead of /threads */
	kind: "threads" | "drafts";
};

export const FOLDERS: Folder[] = [
	{ key: "inbox", label: "Inbox", state: "inbox", kind: "threads" },
	{ key: "sent", label: "Sent", state: "sent", kind: "threads" },
	{ key: "drafts", label: "Drafts", state: null, kind: "drafts" },
	{ key: "archive", label: "Archive", state: "archive", kind: "threads" },
	{ key: "trash", label: "Trash", state: "trash", kind: "threads" },
	{ key: "all", label: "All mail", state: null, kind: "threads" },
];

export function folderByKey(key: string | undefined): Folder {
	return FOLDERS.find((f) => f.key === key) ?? FOLDERS[0]!;
}

// --------------------------------------------------------------------------
// Fetch client — all same-origin; the browser attaches the Access session
// cookie and an Origin header (required by the API's CSRF guard) automatically.
// --------------------------------------------------------------------------

async function json<T>(res: Response): Promise<T> {
	if (!res.ok) {
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
	opts: { state?: Exclude<MessageState, "draft"> | null; limit?: number } = {},
): Promise<ThreadRow[]> {
	const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
	if (opts.state) params.set("state", opts.state);
	const data = await json<{ threads: ThreadRow[] }>(
		await fetch(`${base(mailboxId)}/threads?${params.toString()}`),
	);
	return data.threads ?? [];
}

export async function fetchThread(mailboxId: string, threadId: string): Promise<ThreadDetail> {
	return json<ThreadDetail>(
		await fetch(`${base(mailboxId)}/threads/${encodeURIComponent(threadId)}`),
	);
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

/** Apply an action to every message in a thread (folder moves are per-message). */
export async function runThreadAction(
	mailboxId: string,
	messageIds: string[],
	action: MessageAction,
): Promise<void> {
	await Promise.all(messageIds.map((id) => runMessageAction(mailboxId, id, action)));
}

/**
 * Move a whole thread to a folder from a context (e.g. a list row) that only
 * knows the thread id: resolve its messages, then apply the action to each.
 */
export async function moveThread(
	mailboxId: string,
	threadId: string,
	action: MessageAction,
): Promise<void> {
	const { messages } = await fetchThread(mailboxId, threadId);
	await runThreadAction(
		mailboxId,
		messages.map((m) => m.id),
		action,
	);
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
	threadId?: string;
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

/**
 * One-click send: the backend keeps the draft -> request-send -> confirm-send
 * state machine (the human-confirmation gate for agent-initiated sends), so the
 * UI walks the whole chain in one call since a person is composing here.
 */
export async function sendDraft(
	mailboxId: string,
	draftId: string,
	idempotencyKey: string,
): Promise<{ sent: boolean; reason?: string }> {
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
	const data = (await res.json()) as { sent?: boolean; duplicate?: boolean; reason?: string };
	if (res.ok && (data.sent || data.duplicate)) return { sent: true };
	return { sent: false, reason: data.reason ?? `HTTP ${res.status}` };
}

export async function searchMessageIds(
	mailboxId: string,
	q: string,
	limit = 25,
): Promise<string[]> {
	const params = new URLSearchParams({ q, limit: String(limit) });
	const data = await json<{ results: Array<{ message_id: string }> }>(
		await fetch(`${base(mailboxId)}/search?${params.toString()}`),
	);
	return (data.results ?? []).map((r) => r.message_id);
}

export async function searchThreads(
	mailboxId: string,
	q: string,
	opts: { state?: Exclude<MessageState, "draft"> | null; limit?: number } = {},
): Promise<ThreadRow[]> {
	const messageIds = await searchMessageIds(mailboxId, q, opts.limit ?? 50);
	const seenThreads = new Set<string>();
	const rows: ThreadRow[] = [];

	for (const messageId of messageIds) {
		const message = await fetchMessage(mailboxId, messageId);
		if (opts.state && message.state !== opts.state) continue;
		if (seenThreads.has(message.thread_id)) continue;
		seenThreads.add(message.thread_id);

		const detail = await fetchThread(mailboxId, message.thread_id);
		rows.push({
			id: message.thread_id,
			subject_norm: detail.thread?.subject_norm ?? message.subject,
			last_message_at: detail.thread?.last_message_at ?? message.received_at,
			message_count: detail.thread?.message_count ?? 1,
			unread_count: detail.thread?.unread_count ?? (message.is_read === 0 ? 1 : 0),
			created_at: detail.thread?.created_at ?? message.created_at,
			updated_at: detail.thread?.updated_at ?? message.updated_at,
			latest_subject: message.subject,
			latest_from: message.from_addr,
			latest_snippet: message.snippet,
			latest_received_at: message.received_at,
			latest_has_attachments: message.has_attachments,
			latest_is_read: message.is_read,
			latest_direction: message.direction,
			latest_state: message.state,
		});
	}

	return rows;
}

export function rawMessageUrl(mailboxId: string, messageId: string): string {
	return `${base(mailboxId)}/messages/${encodeURIComponent(messageId)}/raw`;
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

/** "Ada Lovelace <ada@x.com>" -> "Ada Lovelace"; "ada@x.com" -> "ada". */
export function displayName(fromAddr: string | null | undefined): string {
	if (!fromAddr) return "Unknown";
	const named = fromAddr.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
	if (named?.[1]) return named[1].trim();
	const addr = extractEmail(fromAddr);
	const local = addr.split("@")[0] ?? addr;
	return local || addr;
}

/** Pull the bare email out of "Name <email>" or a plain address. */
export function extractEmail(fromAddr: string | null | undefined): string {
	if (!fromAddr) return "";
	const angled = fromAddr.match(/<([^>]+)>/);
	return (angled?.[1] ?? fromAddr).trim();
}

export function initials(fromAddr: string | null | undefined): string {
	const name = displayName(fromAddr);
	const parts = name.split(/[\s._-]+/).filter(Boolean);
	if (parts.length === 0) return "?";
	if (parts.length === 1) return (parts[0]![0] ?? "?").toUpperCase();
	return ((parts[0]![0] ?? "") + (parts[1]![0] ?? "")).toUpperCase();
}

/**
 * Deterministic avatar hue from an address, so a given sender is always the
 * same color. Avoids Math.random (stable across renders/SSR).
 */
export function avatarHue(fromAddr: string | null | undefined): number {
	const s = extractEmail(fromAddr) || "?";
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
	return h;
}

/**
 * Gmail-style relative timestamp: time for today, "Mon D" this year, else
 * "M/D/YY". Falls back gracefully on unparseable input.
 */
export function formatMailDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const sameDay =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	if (sameDay) {
		return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	}
	if (d.getFullYear() === now.getFullYear()) {
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
	}
	return d.toLocaleDateString(undefined, { year: "2-digit", month: "numeric", day: "numeric" });
}

/** Full timestamp for the open-conversation header. */
export function formatFullDate(iso: string | null | undefined): string {
	if (!iso) return "";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(undefined, {
		weekday: "short",
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

export function formatBytes(bytes: number): string {
	if (!bytes) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
