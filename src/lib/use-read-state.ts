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
import { type MailboxCounts, type MessageAction, moveThread, runThreadAction } from "./mail";
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
}: {
	/** Rows of the list on screen, as the server sent them. */
	rows: UnifiedThreadRow[];
	list: Run;
	counts: Run;
	refresh: () => void;
	/** Does a row of this list count toward its mailbox's Inbox unread figure? */
	countsInbox: (row: UnifiedThreadRow) => boolean;
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
	 * Mark a conversation read or unread: the guess at once, then the write
	 * (`messageIds` when known, else every message of the thread), then a reload
	 * that cannot reuse a request from before the write.
	 */
	const setThreadRead = useCallback(
		async (mailboxId: string, threadId: string, read: boolean, messageIds?: string[]) => {
			guess(mailboxId, threadId, read);
			const action: MessageAction = read ? "mark_read" : "mark_unread";
			const key = keyOf(mailboxId, threadId);
			try {
				if (messageIds) {
					if (messageIds.length > 0) await runThreadAction(mailboxId, messageIds, action);
				} else {
					await moveThread(mailboxId, threadId, action);
				}
				forgetInflight();
				const { list: l, counts: c } = runsRef.current;
				const listAfter = l.startedRuns();
				const countsAfter = c.startedRuns();
				setGuesses((prev) =>
					prev[key] && prev[key].read === read
						? { ...prev, [key]: { ...prev[key], listAfter, countsAfter } }
						: prev,
				);
			} catch {
				// The write failed: drop the guess and show what the server has.
				setGuesses((prev) => {
					if (!prev[key]) return prev;
					const { [key]: _dropped, ...rest } = prev;
					return rest;
				});
				forgetInflight();
			} finally {
				refresh();
			}
		},
		[guess, refresh],
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

	return { rows: applyRows, applyCounts, guess, setThreadRead, isRead };
}
