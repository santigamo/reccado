/**
 * Optimistic read/unread for the inbox. Opening a conversation or pressing
 * "Mark as read/unread" changes the row (and the unread figures) at once; the
 * server's answer replaces the guess only when it can no longer be stale.
 *
 * A guess lives until the write has finished AND a load that started after it
 * has landed — separately for the list and for the counts. That is what keeps
 * a row from flicking back: a background refresh that left before the write
 * reached the mailbox answers with the old state, and is simply outvoted.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	type ChangedMessage,
	type MailboxCounts,
	type MessageAction,
	moveThreads,
	runThreadAction,
	type ThreadScope,
} from "./mail";
import { forgetInflight, type UnifiedThreadRow } from "./use-unified-mail";

type Run = { appliedRun: number; startedRuns: () => number };

type Guess = {
	read: boolean;
	/** Change to the mailbox's Inbox unread figure while the counts are stale. */
	inboxDelta: number;
	mailboxId: string;
	/** Load ids after which the list / the counts can be trusted again; null while writing. */
	listAfter: number | null;
	countsAfter: number | null;
	listDone: boolean;
	countsDone: boolean;
};

const keyOf = (mailboxId: string, threadId: string) => `${mailboxId}:${threadId}`;

/** Unread while any message is (rows from older servers only know the latest one). */
export function rowIsUnread(row: {
	participants?: unknown[];
	unread_count: number;
	latest_is_read: number;
}): boolean {
	return row.participants ? row.unread_count > 0 : row.latest_is_read === 0;
}

/** A list row as it reads once the guess is applied. */
export function withReadState<T extends UnifiedThreadRow>(row: T, read: boolean): T {
	if (rowIsUnread(row) === !read) return row;
	if (read) {
		return {
			...row,
			unread_count: 0,
			latest_is_read: 1,
			participants: row.participants?.map((p) => ({ ...p, unread: false })),
		};
	}
	return { ...row, unread_count: Math.max(1, row.message_count), latest_is_read: 0 };
}

export function useReadState({
	rows,
	list,
	counts,
	refresh,
	countsInbox,
	scope,
}: {
	/** Rows of the list on screen, as the server sent them. */
	rows: UnifiedThreadRow[];
	list: Run;
	counts: Run;
	refresh: () => void;
	/** Does a row of this list count toward its mailbox's Inbox unread figure? */
	countsInbox: (row: UnifiedThreadRow) => boolean;
	/** The messages of a conversation the list's folder shows (thread-wide writes). */
	scope: ThreadScope;
}) {
	const [guesses, setGuesses] = useState<Record<string, Guess>>({});
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const runsRef = useRef({ list, counts });
	runsRef.current = { list, counts };

	// Retire guesses once a load newer than their write has landed.
	useEffect(() => {
		setGuesses((prev) => {
			let changed = false;
			const next: Record<string, Guess> = {};
			for (const [key, g] of Object.entries(prev)) {
				const listDone = g.listDone || (g.listAfter !== null && list.appliedRun > g.listAfter);
				const countsDone =
					g.countsDone || (g.countsAfter !== null && counts.appliedRun > g.countsAfter);
				if (listDone && countsDone) {
					changed = true;
					continue;
				}
				if (listDone !== g.listDone || countsDone !== g.countsDone) changed = true;
				next[key] = { ...g, listDone, countsDone };
			}
			return changed ? next : prev;
		});
	}, [list.appliedRun, counts.appliedRun]);

	/** Show the conversation as read/unread now; nothing is written. */
	const guess = useCallback(
		(mailboxId: string, threadId: string, read: boolean) => {
			const row = rowsRef.current.find((r) => r.mailbox_id === mailboxId && r.id === threadId);
			setGuesses((prev) => {
				const key = keyOf(mailboxId, threadId);
				const existing = prev[key];
				if (existing && existing.read === read && existing.listAfter === null) return prev;
				const wasUnread = row ? rowIsUnread(row) : !read;
				const counted = row ? countsInbox(row) : false;
				const inboxDelta = !counted ? 0 : read && wasUnread ? -1 : !read && !wasUnread ? 1 : 0;
				return {
					...prev,
					[key]: {
						read,
						inboxDelta: existing && existing.read === read ? existing.inboxDelta : inboxDelta,
						mailboxId,
						listAfter: null,
						countsAfter: null,
						listDone: false,
						countsDone: false,
					},
				};
			});
		},
		[countsInbox],
	);

	/**
	 * Mark conversations read or unread: the guesses at once, then the writes
	 * (`messageIds` when known for a single conversation, else the messages of
	 * each conversation the folder shows, one request per mailbox), then a reload that cannot
	 * reuse a request from before the write. Resolves to what changed (for Undo);
	 * rejects after rolling the guesses back when a write fails.
	 */
	const setManyRead = useCallback(
		async (
			items: ReadonlyArray<{ mailboxId: string; threadId: string; messageIds?: string[] }>,
			read: boolean,
			/** Writes something else than these conversations (e.g. a whole folder). */
			write?: () => Promise<ChangedMessage[]>,
		): Promise<ChangedMessage[]> => {
			for (const item of items) guess(item.mailboxId, item.threadId, read);
			const action: MessageAction = read ? "mark_read" : "mark_unread";
			const keys = items.map((item) => keyOf(item.mailboxId, item.threadId));
			const byMailbox = new Map<string, { threads: string[]; messages: string[] }>();
			for (const item of items) {
				const group = byMailbox.get(item.mailboxId) ?? { threads: [], messages: [] };
				if (item.messageIds) group.messages.push(...item.messageIds);
				else group.threads.push(item.threadId);
				byMailbox.set(item.mailboxId, group);
			}
			try {
				const changed: ChangedMessage[] = write ? await write() : [];
				for (const [mailboxId, group] of write ? [] : byMailbox) {
					if (group.messages.length > 0) {
						changed.push(...(await runThreadAction(mailboxId, group.messages, action)));
					}
					if (group.threads.length > 0) {
						changed.push(...(await moveThreads(mailboxId, group.threads, action, scope)));
					}
				}
				forgetInflight();
				const { list: l, counts: c } = runsRef.current;
				const listAfter = l.startedRuns();
				const countsAfter = c.startedRuns();
				setGuesses((prev) => {
					const next = { ...prev };
					for (const key of keys) {
						if (next[key] && next[key].read === read) {
							next[key] = { ...next[key], listAfter, countsAfter };
						}
					}
					return next;
				});
				return changed;
			} catch (error) {
				// The write failed: drop the guesses and show what the server has.
				setGuesses((prev) => {
					const next = { ...prev };
					for (const key of keys) delete next[key];
					return next;
				});
				forgetInflight();
				throw error;
			} finally {
				refresh();
			}
		},
		[guess, refresh, scope],
	);

	/** One conversation; see setManyRead. Never rejects (a failure rolls back). */
	const setThreadRead = useCallback(
		async (mailboxId: string, threadId: string, read: boolean, messageIds?: string[]) => {
			try {
				await setManyRead([{ mailboxId, threadId, messageIds }], read);
			} catch {
				// Rolled back in setManyRead.
			}
		},
		[setManyRead],
	);

	const applyRows = useMemo(() => {
		const active = Object.entries(guesses).filter(([, g]) => !g.listDone);
		if (active.length === 0) return rows;
		const byKey = new Map(active);
		return rows.map((row) => {
			const g = byKey.get(keyOf(row.mailbox_id, row.id));
			return g ? withReadState(row, g.read) : row;
		});
	}, [rows, guesses]);

	/** Counts with the pending guesses' effect on each mailbox's Inbox unread figure. */
	const applyCounts = useCallback(
		(mailboxId: string, value: MailboxCounts | undefined): MailboxCounts | undefined => {
			if (!value) return value;
			let delta = 0;
			for (const g of Object.values(guesses)) {
				if (g.mailboxId === mailboxId && !g.countsDone) delta += g.inboxDelta;
			}
			if (delta === 0) return value;
			return {
				...value,
				inbox: { ...value.inbox, unread: Math.max(0, value.inbox.unread + delta) },
			};
		},
		[guesses],
	);

	const isRead = useCallback(
		(mailboxId: string, threadId: string): boolean | undefined =>
			guesses[keyOf(mailboxId, threadId)]?.read,
		[guesses],
	);

	return { rows: applyRows, applyCounts, guess, setThreadRead, setManyRead, isRead };
}
