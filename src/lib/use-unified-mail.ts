/**
 * "All mailboxes" on the client. There is no cross-mailbox endpoint (D1 is an
 * index, the mailbox Durable Object owns the data), so the unified inbox fans
 * out one request per mailbox with the existing per-mailbox API and merges the
 * results by date. The number of mailboxes is small, so this stays cheap.
 *
 * Partial failure is surfaced, not hidden: rows from the mailboxes that
 * answered are shown and `failed` lists the ones that did not.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type Draft,
	type Folder,
	type FolderCounts,
	fetchCounts,
	fetchDrafts,
	fetchThreads,
	type MailboxCounts,
	searchThreads,
	type ThreadRow,
} from "./mail";
import { type MailboxPage, mergePages, pageCursor } from "./thread-paging";
import { useAsyncResource, useMailSyncToken } from "./use-mail";

/** Page size per mailbox for the list. The API caps `limit` at 100. */
export const THREADS_PER_MAILBOX = 50;

export type UnifiedThreadRow = ThreadRow & { mailbox_id: string };
export type UnifiedDraft = Draft & { mailbox_id: string };

export type Unified<T> = {
	items: T[];
	/** Mailbox ids whose request failed. */
	failed: string[];
	/** More rows exist than are shown (older pages not loaded yet). */
	truncated: boolean;
};

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

type ThreadQuery = {
	folder: Folder;
	q: string | undefined;
	unread: boolean;
};

/** One page of a mailbox's list, newest first, after `cursor`; `hasMore` read off one extra row. */
async function threadPage(
	mailboxId: string,
	query: ThreadQuery,
	cursor: string | undefined,
): Promise<{ items: ThreadRow[]; hasMore: boolean }> {
	const { folder, unread } = query;
	const key = `threads|${mailboxId}|${folder.state ?? "all"}|${folder.mail ?? "people"}|${unread}|${cursor ?? ""}`;
	const rows = await dedupe(key, () =>
		fetchThreads(mailboxId, {
			state: folder.state,
			mail: folder.mail,
			limit: THREADS_PER_MAILBOX + 1,
			cursor,
			unread,
		}),
	);
	return { items: rows.slice(0, THREADS_PER_MAILBOX), hasMore: rows.length > THREADS_PER_MAILBOX };
}

/**
 * A mailbox's list from the top, at least `want` rows deep when it has them (a
 * refresh reloads as far as the person had scrolled). Search has no pages: it
 * answers its best matches once.
 */
async function loadMailboxPages(
	mailboxId: string,
	query: ThreadQuery,
	want: number,
): Promise<MailboxPage<ThreadRow>> {
	const text = query.q?.trim();
	if (text) {
		const rows = await searchThreads(mailboxId, text, {
			state: query.folder.state,
			limit: THREADS_PER_MAILBOX,
			mail: query.folder.mail,
		});
		const items = query.unread ? rows.filter((r) => r.unread_count > 0) : rows;
		return { mailboxId, items, hasMore: false };
	}
	const items: ThreadRow[] = [];
	let hasMore = true;
	while (hasMore && (items.length === 0 || items.length < want)) {
		const last = items.at(-1);
		const page = await threadPage(mailboxId, query, last ? pageCursor(last) : undefined);
		items.push(...page.items);
		hasMore = page.hasMore;
		if (page.items.length === 0) break;
	}
	return { mailboxId, items, hasMore };
}

type PagedState = {
	pages: Array<MailboxPage<ThreadRow>>;
	failed: string[];
};

const EMPTY_PAGED: PagedState = { pages: [], failed: [] };

export type ThreadsResource = {
	data: Unified<UnifiedThreadRow>;
	loading: boolean;
	error: string | null;
	refetch: () => void;
	appliedRun: number;
	startedRuns: () => number;
	/** Load the next rows of the merged list (no-op while one is loading or at the end). */
	loadMore: () => void;
	loadingMore: boolean;
	/** The last "load more" failed (the rows on screen stay). */
	loadMoreError: string | null;
};

/**
 * Threads of one folder across `mailboxIds`, newest first, paged (search when
 * `q` is set). Each mailbox pages on its own and the merged list only shows
 * rows no mailbox can still precede (see thread-paging.ts). A refresh (new
 * mail, an action) reloads every mailbox as deep as it had been loaded, so the
 * list never shrinks under the reader.
 */
export function useUnifiedThreads(
	mailboxIds: readonly string[],
	folder: Folder,
	q?: string,
	unread = false,
): ThreadsResource {
	const [state, setState] = useState<PagedState>(EMPTY_PAGED);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	const [appliedRun, setAppliedRun] = useState(0);
	const [loadingMore, setLoadingMore] = useState(false);
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
	const runRef = useRef(0);
	const stateRef = useRef(state);
	stateRef.current = state;
	const loadingMoreRef = useRef(false);
	const syncToken = useMailSyncToken();
	const query: ThreadQuery = { folder, q, unread };
	const queryRef = useRef(query);
	queryRef.current = query;
	const idsRef = useRef(mailboxIds);
	idsRef.current = mailboxIds;
	const depsKey = JSON.stringify([mailboxIds.join(","), folder.key, q ?? "", unread]);
	const lastDepsKeyRef = useRef<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` and `syncToken` are deliberate re-run triggers; the query is read via refs keyed by depsKey.
	useEffect(() => {
		let alive = true;
		const reset = lastDepsKeyRef.current !== depsKey;
		if (reset) {
			lastDepsKeyRef.current = depsKey;
			setState(EMPTY_PAGED);
			setLoading(true);
			setLoadMoreError(null);
		}
		setError(null);
		const run = ++runRef.current;
		const ids = idsRef.current;
		const deep = new Map(
			reset ? [] : stateRef.current.pages.map((p) => [p.mailboxId, p.items.length] as const),
		);
		(async () => {
			if (ids.length === 0) return EMPTY_PAGED;
			const results = await Promise.allSettled(
				ids.map((id) => loadMailboxPages(id, queryRef.current, deep.get(id) ?? 0)),
			);
			const pages: Array<MailboxPage<ThreadRow>> = [];
			const failed: string[] = [];
			results.forEach((r, i) => {
				if (r.status === "fulfilled") pages.push(r.value);
				else failed.push(ids[i]!);
			});
			if (failed.length === ids.length) {
				const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
				throw first.reason instanceof Error ? first.reason : new Error("Could not load mail");
			}
			return { pages, failed };
		})()
			.then((result) => {
				if (!alive) return;
				setState(result);
				setAppliedRun(run);
			})
			.catch((err: unknown) => {
				if (alive) setError(err instanceof Error ? err.message : "Something went wrong");
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [depsKey, nonce, syncToken]);

	const merged = useMemo(() => mergePages(state.pages), [state.pages]);

	const loadMore = useCallback(() => {
		if (loadingMoreRef.current) return;
		const startRun = runRef.current;
		loadingMoreRef.current = true;
		setLoadingMore(true);
		setLoadMoreError(null);
		(async () => {
			let pages = stateRef.current.pages;
			const shownBefore = mergePages(pages).items.length;
			// Keep going until a page's worth of rows is showable, or the end.
			for (let round = 0; round < 6; round++) {
				const { next, items } = mergePages(pages);
				if (!next || items.length - shownBefore >= THREADS_PER_MAILBOX) break;
				const current = pages.find((p) => p.mailboxId === next)!;
				const last = current.items.at(-1);
				const page = await threadPage(next, queryRef.current, last ? pageCursor(last) : undefined);
				pages = pages.map((p) =>
					p.mailboxId === next
						? { ...p, items: [...p.items, ...page.items], hasMore: page.hasMore }
						: p,
				);
			}
			// A refresh that started meanwhile reloads from the top: keep its answer.
			if (runRef.current !== startRun) return;
			setState((prev) => ({ ...prev, pages }));
		})()
			.catch((err: unknown) => {
				setLoadMoreError(err instanceof Error ? err.message : "Could not load more");
			})
			.finally(() => {
				loadingMoreRef.current = false;
				setLoadingMore(false);
			});
	}, []);

	const data = useMemo<Unified<UnifiedThreadRow>>(
		() => ({ items: merged.items, failed: state.failed, truncated: merged.hasMore }),
		[merged, state.failed],
	);
	const refetch = useCallback(() => setNonce((n) => n + 1), []);
	const startedRuns = useCallback(() => runRef.current, []);
	return {
		data,
		loading,
		error,
		refetch,
		appliedRun,
		startedRuns,
		loadMore,
		loadingMore,
		loadMoreError,
	};
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
