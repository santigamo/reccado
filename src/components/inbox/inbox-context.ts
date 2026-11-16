import { createContext, useContext } from "react";
import type { InboxFolder, InboxSearch } from "#/lib/inbox-search";
import type { Mailbox } from "#/lib/mail";
import type { MailboxColor } from "#/lib/mailbox-color";
import type { AgentStatus } from "#/lib/use-agent-status";
import type { ApprovalItem, PendingApproval } from "#/lib/use-approvals";
import type { UnifiedThreadRow } from "#/lib/use-unified-mail";

export type ComposePrefill = {
	from?: string;
	to?: string;
	subject?: string;
	threadId?: string;
	draftId?: string;
	quote?: string;
	mode?: "reply" | "forward";
};

/** What the inbox layout shares with the list and the reading pane. */
export type InboxContextValue = {
	mailboxes: Mailbox[];
	mailboxById: (id: string) => Mailbox | undefined;
	colorOf: (mailboxId: string) => MailboxColor;
	/** Current list search state (scope, folder, query). */
	search: InboxSearch;
	folder: InboxFolder;
	/** Threads currently in the list (for "i of N" and prev/next). */
	threads: UnifiedThreadRow[];
	/**
	 * Real number of conversations in the listed folder and scope (server
	 * counts), or null when unknown (loading, a failed mailbox, or a search).
	 */
	folderTotal: number | null;
	/**
	 * The scope has never received mail (Inbox empty and All mail empty, no
	 * search): the list and reading pane show the "mailbox is ready" first run.
	 */
	noMailYet: boolean;
	agent: AgentStatus;
	/** Pending approvals in the current scope, oldest first. */
	approvals: PendingApproval[];
	/** Approvals decided in the last 24 h in the current scope, newest first. */
	decidedApprovals: ApprovalItem[];
	approvalsLoading: boolean;
	approvalsError: string | null;
	refetchApprovals: () => void;
	/** Open an approval: its thread when it has one, else the request itself. */
	openApproval: (approval: PendingApproval) => void;
	/** Revalidate every mail resource on screen (lists, counts, open thread). */
	refresh: () => void;
	openThread: (mailboxId: string, threadId: string) => void;
	closeThread: () => void;
	openCompose: (prefill?: ComposePrefill) => void;
	/**
	 * Mark a conversation read/unread: shown at once, then written (`messageIds`
	 * when known, else every message of the thread). See use-read-state.
	 */
	setThreadRead: (
		mailboxId: string,
		threadId: string,
		read: boolean,
		messageIds?: string[],
	) => Promise<void>;
	/** Show a conversation as read/unread now, before anything is written. */
	guessThreadRead: (mailboxId: string, threadId: string, read: boolean) => void;
};

export const InboxContext = createContext<InboxContextValue | null>(null);

export function useInbox(): InboxContextValue {
	const value = useContext(InboxContext);
	if (!value) throw new Error("useInbox must be used inside the /inbox layout");
	return value;
}
