/**
 * URL state of the unified inbox. Everything that defines "what am I looking
 * at" lives in the URL so it survives reloads, back/forward and sharing:
 *
 *   /inbox                              all mailboxes, Inbox folder
 *   /inbox?mailbox=<id>                 one mailbox (scope)
 *   /inbox?folder=approvals|drafts|sent|archive|trash|all|reports
 *   /inbox?q=<text>                     search (in the current scope + folder)
 *   /inbox?folder=approvals&approval=<id>
 *                                       an approval request with no thread (new message,
 *                                       control-plane change) open in the reading pane
 *   /inbox/<mailboxId>/<threadId>       open conversation (owning mailbox in the path,
 *                                       so it works in the "all mailboxes" scope too)
 *   ...&compose=true[&from=<mailboxId>&to=&subject=&threadId=&draftId=&quote=<messageId>&mode=reply|forward]
 *                                       compose dialog (new / reply / forward / open draft)
 *
 * Legacy URLs (/mailboxes, /mailboxes/<id>, /mailboxes/<id>/<threadId>,
 * /mailboxes/<id>/compose, ?folder=, ?compose=) redirect here.
 */
import { FOLDERS, type Folder, type FolderKey } from "./mail";

export type InboxFolderKey = FolderKey | "approvals";

export type InboxSearch = {
	/** Scope: a mailbox id, or absent for all mailboxes. */
	mailbox?: string;
	folder?: InboxFolderKey;
	q?: string;
	/** Approval request open in the reading pane (Approvals folder, no thread). */
	approval?: string;
	compose?: boolean;
	/** Mailbox the compose dialog sends from. */
	from?: string;
	to?: string;
	subject?: string;
	threadId?: string;
	draftId?: string;
	/** Message quoted below the cursor (reply) or forwarded with its headers. */
	quote?: string;
	mode?: "reply" | "forward";
};

const FOLDER_KEYS: InboxFolderKey[] = [
	"inbox",
	"approvals",
	"sent",
	"drafts",
	"archive",
	"trash",
	"all",
	"reports",
];

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

export function parseInboxSearch(search: Record<string, unknown>): InboxSearch {
	const folder = FOLDER_KEYS.includes(search.folder as InboxFolderKey)
		? (search.folder as InboxFolderKey)
		: undefined;
	return {
		mailbox: str(search.mailbox),
		folder: folder === "inbox" ? undefined : folder,
		q: str(search.q),
		approval: folder === "approvals" ? str(search.approval) : undefined,
		compose: search.compose === true || search.compose === "true" ? true : undefined,
		from: str(search.from),
		to: str(search.to),
		subject: str(search.subject),
		threadId: str(search.threadId),
		draftId: str(search.draftId),
		quote: str(search.quote),
		mode: search.mode === "reply" || search.mode === "forward" ? search.mode : undefined,
	};
}

/** Only the list state (scope, folder, query) — what a thread link should carry. */
export function listSearch(search: InboxSearch): InboxSearch {
	return { mailbox: search.mailbox, folder: search.folder, q: search.q };
}

/** Search params with the compose dialog closed. */
export function withoutCompose(search: InboxSearch): InboxSearch {
	return {
		...search,
		compose: undefined,
		from: undefined,
		to: undefined,
		subject: undefined,
		threadId: undefined,
		draftId: undefined,
		quote: undefined,
		mode: undefined,
	};
}

export type InboxFolder =
	| Folder
	| { key: "approvals"; label: string; state: null; kind: "approvals" };

export const APPROVALS_FOLDER: InboxFolder = {
	key: "approvals",
	label: "Approvals",
	state: null,
	kind: "approvals",
};

export function inboxFolderByKey(key: InboxFolderKey | undefined): InboxFolder {
	if (key === "approvals") return APPROVALS_FOLDER;
	return FOLDERS.find((f) => f.key === key) ?? FOLDERS[0]!;
}

/** Labels as drawn in the second bar. */
export const FOLDER_LABELS: Record<InboxFolderKey, string> = {
	inbox: "Inbox",
	approvals: "Approvals",
	drafts: "Drafts",
	sent: "Sent items",
	archive: "Archive",
	trash: "Trash",
	all: "All mail",
	reports: "DMARC reports",
};

/** Inbox search for a legacy per-mailbox URL (scope = that mailbox). */
export function legacyToInboxSearch(mailboxId: string, search: InboxSearch): InboxSearch {
	return {
		mailbox: mailboxId,
		folder: search.folder,
		q: search.q,
		...(search.compose
			? {
					compose: true,
					from: mailboxId,
					to: search.to,
					subject: search.subject,
					threadId: search.threadId,
					draftId: search.draftId,
				}
			: {}),
	};
}
