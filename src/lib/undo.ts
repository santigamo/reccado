/**
 * Undo for mailbox actions, replayed through the same actions: the server says
 * what each message it changed was before (POST …/bulk-actions), and undo puts
 * every one of them back with the action that leads there. No message the
 * action did not touch is moved by its undo.
 */
import type { ChangedMessage, MessageAction } from "./mail";

export type { ChangedMessage };

export type UndoStep = { action: MessageAction; messageIds: string[] };

/** The action that returns a message to `state` (your replies land in Sent either way). */
function actionBackTo(state: string): MessageAction | null {
	if (state === "inbox" || state === "sent") return "restore_inbox";
	if (state === "archive") return "archive";
	if (state === "trash") return "trash";
	return null;
}

export function undoSteps(action: MessageAction, changed: readonly ChangedMessage[]): UndoStep[] {
	if (changed.length === 0) return [];
	if (action === "mark_read" || action === "mark_unread") {
		return [
			{
				action: action === "mark_read" ? "mark_unread" : "mark_read",
				messageIds: changed.map((m) => m.id),
			},
		];
	}
	const groups = new Map<MessageAction, string[]>();
	for (const m of changed) {
		const back = actionBackTo(m.state);
		if (!back) continue;
		const ids = groups.get(back) ?? [];
		ids.push(m.id);
		groups.set(back, ids);
	}
	return [...groups].map(([back, messageIds]) => ({ action: back, messageIds }));
}

/** "Conversation archived", "3 conversations moved to Trash", "Marked as unread". */
export function actionToast(action: MessageAction, conversations: number): string {
	const what = conversations === 1 ? "Conversation" : `${conversations} conversations`;
	switch (action) {
		case "archive":
			return `${what} archived`;
		case "trash":
			return `${what} moved to Trash`;
		case "restore_inbox":
			return `${what} moved to Inbox`;
		case "mark_read":
			return conversations === 1 ? "Marked as read" : `${what} marked as read`;
		case "mark_unread":
			return conversations === 1 ? "Marked as unread" : `${what} marked as unread`;
	}
}
