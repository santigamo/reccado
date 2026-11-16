/**
 * "All mailboxes" on the client. There is no cross-mailbox endpoint (D1 is an
 * index, the mailbox Durable Object owns the data), so the unified inbox fans
 * out one request per mailbox with the existing per-mailbox API and merges the
 * results by date. The number of mailboxes is small, so this stays cheap.
 *
 * Partial failure is surfaced, not hidden: rows from the mailboxes that
 * answered are shown and `failed` lists the ones that did not.
 */
import {
	byLatestActivity,
	type Draft,
	type Folder,
	type FolderCounts,
	type FolderMail,
	fetchCounts,
	fetchDrafts,
	fetchThreads,
	type MailboxCounts,
	type MessageState,
	searchThreads,
	type ThreadRow,
} from "./mail";
import { useAsyncResource } from "./use-mail";

/** Page size per mailbox for the list. The API caps `limit` at 100. */
export const THREADS_PER_MAILBOX = 50;

export type UnifiedThreadRow = ThreadRow & { mailbox_id: string };
export type UnifiedDraft = Draft & { mailbox_id: string };

export type Unified<T> = {
	items: T[];
	/** Mailbox ids whose request failed. */
	failed: string[];
	/** True when at least one mailbox returned a full page (more exist server-side). */
	truncated: boolean;
};

const EMPTY_THREADS: Unified<UnifiedThreadRow> = { items: [], failed: [], truncated: false };
const EMPTY_DRAFTS: Unified<UnifiedDraft> = { items: [], failed: [], truncated: false };

// Collapse identical concurrent requests (several resources ask for the same
// mailbox's data on first paint).
const inflight = new Map<string, Promise<unknown>>();
/**
 * Drop the in-flight requests, so the next load asks the server again instead
 * of joining a request that started before a write it must reflect.
 */
export function forgetInflight(): void {
	inflight.clear();
}

function dedupe<T>(key: string, run: () => Promise<T>): Promise<T> {
	const existing = inflight.get(key) as Promise<T> | undefined;
	if (existing) return existing;
	const p: Promise<T> = run().finally(() => {
		// Only our own entry: forgetInflight() may have let a newer request take the key.
		if (inflight.get(key) === p) inflight.delete(key);
	});
	inflight.set(key, p);
	return p;
}

function threadsFor(
	mailboxId: string,
	state: Exclude<MessageState, "draft"> | null,
	limit: number,
	mail: FolderMail | undefined,
): Promise<ThreadRow[]> {
	return dedupe(`threads|${mailboxId}|${state ?? "all"}|${limit}|${mail ?? "people"}`, () =>
		fetchThreads(mailboxId, { state, limit, mail }),
	);
}

async function loadUnifiedThreads(
	mailboxIds: readonly string[],
	folder: Folder,
	q: string | undefined,
): Promise<Unified<UnifiedThreadRow>> {
	const query = q?.trim();
	const results = await Promise.allSettled(
		mailboxIds.map(async (mailboxId) => {
			const rows = query
				? await searchThreads(mailboxId, query, {
						state: folder.state,
						limit: THREADS_PER_MAILBOX,
						mail: folder.mail,
					})
				: await threadsFor(mailboxId, folder.state, THREADS_PER_MAILBOX, folder.mail);
			return rows.map((row) => ({ ...row, mailbox_id: mailboxId }));
		}),
	);
	const items: UnifiedThreadRow[] = [];
	const failed: string[] = [];
	let truncated = false;
	results.forEach((r, i) => {
		if (r.status === "fulfilled") {
			items.push(...r.value);
			if (!query && r.value.length >= THREADS_PER_MAILBOX) truncated = true;
		} else {
			failed.push(mailboxIds[i]!);
		}
	});
	if (failed.length === mailboxIds.length && failed.length > 0) {
		const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
		throw first.reason instanceof Error ? first.reason : new Error("Could not load mail");
	}
	items.sort(byLatestActivity);
	return { items, failed, truncated };
}

/** Threads of one folder across `mailboxIds`, newest first (search when `q` is set). */
export function useUnifiedThreads(mailboxIds: readonly string[], folder: Folder, q?: string) {
	return useAsyncResource<Unified<UnifiedThreadRow>>(
		() =>
			mailboxIds.length === 0
				? Promise.resolve(EMPTY_THREADS)
				: loadUnifiedThreads(mailboxIds, folder, q),
		EMPTY_THREADS,
		[mailboxIds.join(","), folder.key, q ?? ""],
	);
}

async function loadUnifiedDrafts(mailboxIds: readonly string[]): Promise<Unified<UnifiedDraft>> {
	const results = await Promise.allSettled(
		mailboxIds.map(async (mailboxId) => {
			const drafts = await dedupe(`drafts|${mailboxId}`, () => fetchDrafts(mailboxId));
			return drafts.map((d) => ({ ...d, mailbox_id: mailboxId }));
		}),
	);
	const items: UnifiedDraft[] = [];
	const failed: string[] = [];
	results.forEach((r, i) => {
		if (r.status === "fulfilled") items.push(...r.value);
		else failed.push(mailboxIds[i]!);
	});
	if (failed.length === mailboxIds.length && failed.length > 0) {
		throw new Error("Could not load drafts");
	}
	items.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
	return { items, failed, truncated: false };
}

/** Drafts across `mailboxIds`, most recently edited first. */
export function useUnifiedDrafts(mailboxIds: readonly string[]) {
	return useAsyncResource<Unified<UnifiedDraft>>(
		() => (mailboxIds.length === 0 ? Promise.resolve(EMPTY_DRAFTS) : loadUnifiedDrafts(mailboxIds)),
		EMPTY_DRAFTS,
		[mailboxIds.join(",")],
	);
}

export type InboxSummary = {
	/** Real folder totals per mailbox, from GET /counts. */
	byMailbox: Record<string, MailboxCounts>;
	/** Mailbox ids whose counts request failed. */
	failed: string[];
};

const EMPTY_SUMMARY: InboxSummary = { byMailbox: {}, failed: [] };

async function loadSummary(mailboxIds: readonly string[]): Promise<InboxSummary> {
	const results = await Promise.allSettled(
		mailboxIds.map((mailboxId) => dedupe(`counts|${mailboxId}`, () => fetchCounts(mailboxId))),
	);
	const summary: InboxSummary = { byMailbox: {}, failed: [] };
	results.forEach((r, i) => {
		const id = mailboxIds[i]!;
		if (r.status === "fulfilled") summary.byMailbox[id] = r.value;
		else summary.failed.push(id);
	});
	return summary;
}

/**
 * Per-mailbox folder totals for the header, the folder tabs, the mailbox column
 * and "1 of N". Exact: each mailbox's Durable Object counts its own tables
 * (GET /api/mailboxes/:id/counts). Revalidates with the mail sync token, so new
 * mail and actions refresh it with the list.
 */
export function useInboxSummary(mailboxIds: readonly string[]) {
	return useAsyncResource<InboxSummary>(
		() => (mailboxIds.length === 0 ? Promise.resolve(EMPTY_SUMMARY) : loadSummary(mailboxIds)),
		EMPTY_SUMMARY,
		[mailboxIds.join(",")],
	);
}

const ZERO = (): FolderCounts => ({ threads: 0, unread: 0, messages: 0 });

/**
 * Totals across `mailboxIds`, or null when any of them has no counts (still
 * loading or failed): a partial sum would be a wrong number, not a lower bound.
 */
export function sumCounts(
	summary: InboxSummary,
	mailboxIds: readonly string[],
): MailboxCounts | null {
	const total: MailboxCounts = {
		inbox: ZERO(),
		sent: ZERO(),
		archive: ZERO(),
		trash: ZERO(),
		all: ZERO(),
		drafts: 0,
		reports: ZERO(),
	};
	for (const id of mailboxIds) {
		const c = summary.byMailbox[id];
		if (!c) return null;
		for (const key of ["inbox", "sent", "archive", "trash", "all"] as const) {
			total[key].threads += c[key].threads;
			total[key].unread += c[key].unread;
			total[key].messages += c[key].messages;
		}
		total.drafts += c.drafts;
		const reports = total.reports!;
		reports.threads += c.reports?.threads ?? 0;
		reports.unread += c.reports?.unread ?? 0;
		reports.messages += c.reports?.messages ?? 0;
	}
	return total;
}

// Fixed locale: the design writes "14,171", whatever the browser's language is.
const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** "14,171": English thousands separators regardless of the browser locale. */
export function formatCount(n: number): string {
	return COUNT_FORMAT.format(n);
}
