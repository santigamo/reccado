/**
 * Paging a list merged from several mailboxes ("All mailboxes"). Each mailbox
 * pages on its own, newest first; the merged list may only show a row once no
 * mailbox can still have a newer one it has not sent yet. So the visible list
 * stops at the "frontier": the newest last-row among the mailboxes that have
 * more. Rows below it are held back until the mailbox at the frontier sends its
 * next page. Without this, "load more" would slot older mail of one mailbox
 * above newer mail of another that simply had not been fetched.
 */

export type SortKey = { latest_received_at: string; id: string };

export type MailboxPage<T extends SortKey> = {
	mailboxId: string;
	/** Rows loaded so far for this mailbox, in list order (newest first). */
	items: T[];
	/** The server may have older rows than the last one loaded. */
	hasMore: boolean;
};

/** List order: newest first, then thread id, so it is total and stable. */
export function compareRows(a: SortKey, b: SortKey): number {
	if (a.latest_received_at !== b.latest_received_at) {
		return a.latest_received_at < b.latest_received_at ? 1 : -1;
	}
	return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Where the next page of a mailbox starts: its last row's sort key. */
export function pageCursor(row: SortKey): string {
	return `${row.latest_received_at}|${row.id}`;
}

export type MergedPages<T> = {
	/** Rows that can be shown in order, newest first. */
	items: Array<T & { mailbox_id: string }>;
	/** Some mailbox has rows not shown yet (held back or not loaded). */
	hasMore: boolean;
	/** The mailbox whose next page moves the frontier (null when nothing more). */
	next: string | null;
};

export function mergePages<T extends SortKey>(
	pages: ReadonlyArray<MailboxPage<T>>,
): MergedPages<T> {
	let frontier: SortKey | null = null;
	let next: string | null = null;
	for (const page of pages) {
		if (!page.hasMore) continue;
		const last = page.items.at(-1);
		// A mailbox with more but nothing loaded blocks everything: load it first.
		if (!last) {
			return { items: [], hasMore: true, next: page.mailboxId };
		}
		if (!frontier || compareRows(last, frontier) < 0) {
			frontier = last;
			next = page.mailboxId;
		}
	}
	const all: Array<T & { mailbox_id: string }> = [];
	for (const page of pages) {
		for (const row of page.items) all.push({ ...row, mailbox_id: page.mailboxId });
	}
	all.sort(compareRows);
	const items = frontier ? all.filter((row) => compareRows(row, frontier) <= 0) : all;
	return { items, hasMore: next !== null, next };
}
