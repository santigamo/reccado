/**
 * Folder moves and read state on conversations, the way mail clients do them:
 * the change shows at once (a moved row leaves the list, a read row goes
 * grey), the write follows, a toast says what happened with an "Undo" that
 * replays exactly what changed, and a failed write puts everything back and
 * says so. Shared by row buttons, the selection bar, the reading pane and the
 * keyboard.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "#/components/ui/Toast";
import type { InboxFolder } from "#/lib/inbox-search";
import {
	type ChangedMessage,
	type MessageAction,
	markFolderRead,
	moveThreads,
	runThreadAction,
} from "#/lib/mail";
import { actionToast, undoSteps } from "#/lib/undo";
import { forgetInflight, type UnifiedThreadRow } from "#/lib/use-unified-mail";

export type ThreadRef = { mailboxId: string; threadId: string };

type Run = { appliedRun: number; startedRuns: () => number };

type SetManyRead = (
	items: ReadonlyArray<{ mailboxId: string; threadId: string; messageIds?: string[] }>,
	read: boolean,
	write?: () => Promise<ChangedMessage[]>,
) => Promise<ChangedMessage[]>;

const keyOf = (ref: ThreadRef) => `${ref.mailboxId}:${ref.threadId}`;

/** Does `action` take a conversation out of the folder being listed? */
export function leavesFolder(folder: InboxFolder, action: MessageAction): boolean {
	if (action === "mark_read" || action === "mark_unread") return false;
	if (folder.kind !== "threads" || folder.state === null) return false; // All mail, reports
	if (folder.state === "sent") return action === "trash";
	if (action === "restore_inbox") return folder.state !== "inbox";
	return folder.state !== action;
}

function byMailbox(refs: readonly ThreadRef[]): Map<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const ref of refs) {
		const list = groups.get(ref.mailboxId) ?? [];
		if (!list.includes(ref.threadId)) list.push(ref.threadId);
		groups.set(ref.mailboxId, list);
	}
	return groups;
}

/** Changed messages per mailbox, from what each mailbox answered. */
type Changes = Array<{ mailboxId: string; changed: ChangedMessage[] }>;

const VERB: Record<MessageAction, string> = {
	archive: "archive",
	trash: "delete",
	restore_inbox: "move",
	mark_read: "mark as read",
	mark_unread: "mark as unread",
};

export function useThreadActions({
	folder,
	list,
	refresh,
	setManyRead,
}: {
	folder: InboxFolder;
	list: Run;
	refresh: () => void;
	setManyRead: SetManyRead;
}) {
	const toast = useToast();
	// Rows moved out of this folder: hidden until a list load newer than the write.
	const [hidden, setHidden] = useState<Record<string, number | null>>({});
	const listRef = useRef(list);
	listRef.current = list;

	useEffect(() => {
		setHidden((prev) => {
			let changed = false;
			const next: Record<string, number | null> = {};
			for (const [key, after] of Object.entries(prev)) {
				if (after !== null && list.appliedRun > after) {
					changed = true;
					continue;
				}
				next[key] = after;
			}
			return changed ? next : prev;
		});
	}, [list.appliedRun]);

	const hide = useCallback((keys: string[]) => {
		setHidden((prev) => {
			const next = { ...prev };
			for (const key of keys) next[key] = null;
			return next;
		});
	}, []);
	const unhide = useCallback((keys: string[]) => {
		setHidden((prev) => {
			const next = { ...prev };
			for (const key of keys) delete next[key];
			return next;
		});
	}, []);
	const settle = useCallback((keys: string[]) => {
		const after = listRef.current.startedRuns();
		setHidden((prev) => {
			const next = { ...prev };
			for (const key of keys) if (key in next) next[key] = after;
			return next;
		});
	}, []);

	const replay = useCallback(async (action: MessageAction, changes: Changes) => {
		for (const { mailboxId, changed } of changes) {
			for (const step of undoSteps(action, changed)) {
				await runThreadAction(mailboxId, step.messageIds, step.action);
			}
		}
	}, []);

	/**
	 * Archive / delete / move to inbox. Resolves true when it was written.
	 * `undoable: false` for actions the caller confirms itself.
	 */
	const move = useCallback(
		async (refs: readonly ThreadRef[], action: MessageAction): Promise<boolean> => {
			if (refs.length === 0) return true;
			const keys = refs.map(keyOf);
			const leaves = leavesFolder(folder, action);
			if (leaves) hide(keys);
			const changes: Changes = [];
			try {
				for (const [mailboxId, threadIds] of byMailbox(refs)) {
					changes.push({ mailboxId, changed: await moveThreads(mailboxId, threadIds, action) });
				}
			} catch {
				unhide(keys);
				forgetInflight();
				refresh();
				toast.show({
					tone: "danger",
					message: `Could not ${VERB[action]} ${refs.length === 1 ? "the conversation" : `${refs.length} conversations`}. Check your connection and try again.`,
				});
				// What was written before the failure is shown as it is now.
				return false;
			}
			forgetInflight();
			settle(keys);
			refresh();
			toast.show({
				message: actionToast(action, refs.length),
				action: {
					label: "Undo",
					onClick: async () => {
						try {
							await replay(action, changes);
							unhide(keys);
							toast.show({ message: "Action undone" });
						} catch {
							toast.show({ tone: "danger", message: "Could not undo. Try again." });
						} finally {
							forgetInflight();
							refresh();
						}
					},
				},
			});
			return true;
		},
		[folder, hide, unhide, settle, refresh, toast, replay],
	);

	/** Read / unread, with Undo (said in a toast when `announce`). */
	const markRead = useCallback(
		async (
			items: ReadonlyArray<ThreadRef & { messageIds?: string[] }>,
			read: boolean,
			announce = true,
		): Promise<boolean> => {
			if (items.length === 0) return true;
			let changed: ChangedMessage[];
			try {
				changed = await setManyRead(items, read);
			} catch {
				toast.show({
					tone: "danger",
					message: `Could not ${read ? "mark as read" : "mark as unread"}. Check your connection and try again.`,
				});
				return false;
			}
			if (!announce || changed.length === 0) return true;
			toast.show({
				message: actionToast(read ? "mark_read" : "mark_unread", items.length),
				action: {
					label: "Undo",
					onClick: async () => {
						try {
							await setManyRead(undoItems(items, changed), !read);
						} catch {
							toast.show({ tone: "danger", message: "Could not undo. Try again." });
						}
					},
				},
			});
			return true;
		},
		[setManyRead, toast],
	);

	/** "Mark all as read" for the folder in every mailbox of the scope. */
	const markAllRead = useCallback(
		async (mailboxIds: readonly string[], rows: readonly UnifiedThreadRow[]) => {
			if (folder.kind !== "threads") return;
			const visible = rows
				.filter((r) => mailboxIds.includes(r.mailbox_id))
				.map((r) => ({ mailboxId: r.mailbox_id, threadId: r.id }));
			const changes: Changes = [];
			try {
				await setManyRead(visible, true, async () => {
					const all: ChangedMessage[] = [];
					for (const mailboxId of mailboxIds) {
						const changed = await markFolderRead(mailboxId, folder);
						changes.push({ mailboxId, changed });
						all.push(...changed);
					}
					return all;
				});
			} catch {
				toast.show({
					tone: "danger",
					message: "Could not mark everything as read. Check your connection and try again.",
				});
				return;
			}
			const threads = new Set(
				changes.flatMap((c) => c.changed.map((m) => `${c.mailboxId}:${m.thread_id}`)),
			);
			if (threads.size === 0) {
				toast.show({ message: "Nothing unread here" });
				return;
			}
			toast.show({
				message: `${threads.size === 1 ? "1 conversation" : `${threads.size} conversations`} marked as read`,
				action: {
					label: "Undo",
					onClick: async () => {
						try {
							await setManyRead(
								changes.flatMap(({ mailboxId, changed }) =>
									undoItems(
										changed.map((m) => ({ mailboxId, threadId: m.thread_id })),
										changed,
									),
								),
								false,
							);
						} catch {
							toast.show({ tone: "danger", message: "Could not undo. Try again." });
						}
					},
				},
			});
		},
		[folder, setManyRead, toast],
	);

	const hiddenKeys = useMemo(() => new Set(Object.keys(hidden)), [hidden]);
	return { hidden: hiddenKeys, move, markRead, markAllRead };
}

/** The exact messages to flip back, grouped by conversation. */
function undoItems(
	items: ReadonlyArray<ThreadRef>,
	changed: readonly ChangedMessage[],
): Array<ThreadRef & { messageIds: string[] }> {
	const out: Array<ThreadRef & { messageIds: string[] }> = [];
	for (const item of items) {
		if (out.some((o) => o.mailboxId === item.mailboxId && o.threadId === item.threadId)) continue;
		const messageIds = changed.filter((m) => m.thread_id === item.threadId).map((m) => m.id);
		if (messageIds.length > 0) out.push({ ...item, messageIds });
	}
	return out;
}
