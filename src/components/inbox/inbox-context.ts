import { createContext, useContext } from "react";
import type { InboxFolder, InboxSearch } from "#/lib/inbox-search";
import type { Mailbox, MessageAction } from "#/lib/mail";
import type { MailboxColor } from "#/lib/mailbox-color";
import type { AgentStatus } from "#/lib/use-agent-status";
import type { ApprovalItem, PendingApproval } from "#/lib/use-approvals";
import type { UnifiedThreadRow } from "#/lib/use-unified-mail";

export type ComposePrefill = {
	from?: string;
	to?: string;
	cc?: string;
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
	/**
	 * Archive / delete / move to inbox: the rows leave at once, a toast offers
	 * Undo, a failure puts them back. Resolves true when written.
	 */
	moveThreads: (refs: ThreadRef[], action: MessageAction) => Promise<boolean>;
	/** Read / unread with an Undo toast (when `announce`), rolled back on failure. */
	markThreadsRead: (
		items: Array<ThreadRef & { messageIds?: string[] }>,
		read: boolean,
		announce?: boolean,
	) => Promise<boolean>;
	/**
	 * "Delete forever" (Trash only): asks for confirmation, then deletes the
	 * conversations' trashed messages for good. No Undo.
	 */
	askDeleteForever: (refs: ThreadRef[]) => void;
	/** "Empty trash" for the current scope: asks for confirmation first. */
	askEmptyTrash: () => void;
	/** Every address of the owner (mailboxes and aliases), lowercased: never a reply-all recipient. */
	ownAddresses: string[];
	/** Selected conversations of the list ("<mailboxId>:<threadId>"). */
	selection: ReadonlySet<string>;
	/** Toggle one row; `range` selects from the last toggled row to this one (shift-click). */
	toggleSelected: (key: string, range?: boolean) => void;
	setSelection: (keys: Iterable<string>) => void;
	/** Search the current query in every mailbox and every folder. */
	searchEverywhere: () => void;
	/** Folded columns (persisted per browser) and their toggles. */
	layout: {
		mailboxesFolded: boolean;
		listFolded: boolean;
		toggleMailboxes: () => void;
		toggleList: () => void;
		toggleWide: () => void;
	};
};

export type ThreadRef = { mailboxId: string; threadId: string };

export const rowKey = (mailboxId: string, threadId: string) => `${mailboxId}:${threadId}`;

export const InboxContext = createContext<InboxContextValue | null>(null);

export function useInbox(): InboxContextValue {
	const value = useContext(InboxContext);
	if (!value) throw new Error("useInbox must be used inside the /inbox layout");
	return value;
}
