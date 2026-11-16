import { createFileRoute, Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderBar } from "#/components/inbox/FolderBar";
import {
	type ComposePrefill,
	InboxContext,
	type InboxContextValue,
} from "#/components/inbox/inbox-context";
import { ApprovalsList, DraftsList, ThreadsList } from "#/components/inbox/ListColumn";
import { MailboxColumn } from "#/components/inbox/MailboxColumn";
import { ScopeSwitcher } from "#/components/inbox/ScopeSwitcher";
import { SearchField } from "#/components/inbox/SearchField";
import { ComposeModal } from "#/components/mail/ComposeModal";
import { AppShell } from "#/components/shell/AppShell";
import { buttonClassName } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { cn } from "#/lib/cn";
import {
	FOLDER_LABELS,
	type InboxFolderKey,
	type InboxSearch,
	inboxFolderByKey,
	listSearch,
	parseInboxSearch,
	withoutCompose,
} from "#/lib/inbox-search";
import { cancelDraft, FOLDERS, type MessageAction, moveThread } from "#/lib/mail";
import { useMailboxColors } from "#/lib/mailbox-color";
import { useAgentStatus } from "#/lib/use-agent-status";
import { type PendingApproval, usePendingApprovals } from "#/lib/use-approvals";
import {
	type MailSocketEvent,
	MailSyncProvider,
	useMailboxes,
	useMailboxSocket,
} from "#/lib/use-mail";
import { useReadState } from "#/lib/use-read-state";
import {
	formatCount,
	sumCounts,
	type UnifiedDraft,
	type UnifiedThreadRow,
	useInboxSummary,
	useUnifiedDrafts,
	useUnifiedThreads,
} from "#/lib/use-unified-mail";

export const Route = createFileRoute("/inbox")({
	validateSearch: (search: Record<string, unknown>): InboxSearch => parseInboxSearch(search),
	head: () => ({ meta: [{ title: "Inbox · Reccado" }] }),
	component: InboxLayout,
});

/** One WebSocket per mailbox; renders nothing. */
function MailboxSocket({
	mailboxId,
	onEvent,
}: {
	mailboxId: string;
	onEvent: (event: MailSocketEvent) => void;
}) {
	useMailboxSocket(mailboxId, onEvent);
	return null;
}

const THREADS_FOLDER = FOLDERS[0]!;
const ALL_MAIL_FOLDER = FOLDERS.find((f) => f.key === "all")!;

function InboxLayout() {
	const search = Route.useSearch();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as { mailboxId?: string; threadId?: string };
	const openId =
		params.mailboxId && params.threadId
			? { mailboxId: params.mailboxId, threadId: params.threadId }
			: undefined;

	// Revalidation token: bumped on new inbound mail and after actions, so the
	// counts, the list and the open conversation refresh together.
	const [syncToken, setSyncToken] = useState(0);
	const refresh = useCallback(() => setSyncToken((n) => n + 1), []);
	const onSocketEvent = useCallback(
		(event: MailSocketEvent) => {
			if (event.type === "message.created") refresh();
		},
		[refresh],
	);

	const [drawerOpen, setDrawerOpen] = useState(false);
	useEffect(() => {
		if (!drawerOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setDrawerOpen(false);
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [drawerOpen]);

	return (
		<MailSyncProvider token={syncToken}>
			<InboxScreen
				search={search}
				openId={openId}
				refresh={refresh}
				onSocketEvent={onSocketEvent}
				drawerOpen={drawerOpen}
				setDrawerOpen={setDrawerOpen}
				navigate={navigate}
			/>
		</MailSyncProvider>
	);
}

type Navigate = ReturnType<typeof useNavigate>;

function InboxScreen({
	search,
	openId,
	refresh,
	onSocketEvent,
	drawerOpen,
	setDrawerOpen,
	navigate,
}: {
	search: InboxSearch;
	openId?: { mailboxId: string; threadId: string };
	refresh: () => void;
	onSocketEvent: (event: MailSocketEvent) => void;
	drawerOpen: boolean;
	setDrawerOpen: (open: boolean) => void;
	navigate: Navigate;
}) {
	const mailboxesRes = useMailboxes();
	const mailboxes = mailboxesRes.data;
	const colorOf = useMailboxColors(mailboxes);
	const allIds = useMemo(() => mailboxes.map((m) => m.mailbox_id), [mailboxes]);
	const scopeValid = !search.mailbox || allIds.includes(search.mailbox);
	const scopeIds = useMemo(
		() => (search.mailbox ? allIds.filter((id) => id === search.mailbox) : allIds),
		[allIds, search.mailbox],
	);

	const folder = inboxFolderByKey(search.folder);
	const folderKey: InboxFolderKey = search.folder ?? "inbox";
	const q = search.q;

	const threads = useUnifiedThreads(
		folder.kind === "threads" ? scopeIds : [],
		folder.kind === "threads" ? folder : THREADS_FOLDER,
		q,
	);
	const drafts = useUnifiedDrafts(folder.kind === "drafts" ? scopeIds : []);
	// Empty Inbox: is it a brand-new mailbox (nothing in All mail either)?
	const inboxEmpty =
		folderKey === "inbox" &&
		!q &&
		!threads.loading &&
		!threads.error &&
		threads.data.items.length === 0;
	const allMail = useUnifiedThreads(inboxEmpty ? scopeIds : [], ALL_MAIL_FOLDER);
	const noMailYet =
		inboxEmpty && !allMail.loading && !allMail.error && allMail.data.items.length === 0;
	const rawSummary = useInboxSummary(allIds);
	const approvals = usePendingApprovals();

	// Read/unread changes show at once (row, badges, mailbox column) and never
	// flick back while the write and the reloads catch up; see use-read-state.
	const readState = useReadState({
		rows: threads.data.items,
		list: threads,
		counts: rawSummary,
		refresh,
		countsInbox: useCallback(
			(row: UnifiedThreadRow) =>
				folder.key !== "reports" && (folder.key === "inbox" || row.latest_state === "inbox"),
			[folder.key],
		),
	});
	const { applyCounts } = readState;
	const summary = useMemo(() => {
		const byMailbox: typeof rawSummary.data.byMailbox = {};
		for (const [id, value] of Object.entries(rawSummary.data.byMailbox)) {
			const adjusted = applyCounts(id, value);
			if (adjusted) byMailbox[id] = adjusted;
		}
		return { ...rawSummary, data: { ...rawSummary.data, byMailbox } };
	}, [rawSummary, applyCounts]);
	const listResource = useMemo(
		() => ({ ...threads, data: { ...threads.data, items: readState.rows } }),
		[threads, readState.rows],
	);
	const agent = useAgentStatus();

	const scopedApprovals = useMemo(
		() =>
			search.mailbox
				? approvals.data.filter((a) => !a.mailboxId || a.mailboxId === search.mailbox)
				: approvals.data,
		[approvals.data, search.mailbox],
	);
	const scopedDecided = useMemo(
		() =>
			search.mailbox
				? approvals.decided.filter((a) => !a.send || a.send.mailboxId === search.mailbox)
				: approvals.decided,
		[approvals.decided, search.mailbox],
	);

	// Real totals (GET /counts per mailbox). Null while loading or when a mailbox
	// in scope failed: then no number is shown rather than a wrong one.
	const unreadOf = useCallback(
		(id: string) => summary.data.byMailbox[id]?.inbox.unread ?? 0,
		[summary.data],
	);
	const totalUnread = useMemo(
		() => allIds.reduce((n, id) => n + (summary.data.byMailbox[id]?.inbox.unread ?? 0), 0),
		[allIds, summary.data],
	);
	const scopeCounts = useMemo(() => sumCounts(summary.data, scopeIds), [summary.data, scopeIds]);
	const scopeUnread = scopeCounts?.inbox.unread ?? 0;
	const scopeDrafts = scopeCounts?.drafts ?? 0;
	// The folder being listed, as counted by the server (threads folders only).
	const folderCounts =
		scopeCounts && folder.kind === "threads"
			? folder.key === "reports"
				? scopeCounts.reports
				: scopeCounts[folder.state ?? "all"]
			: undefined;

	const mailboxById = useCallback(
		(id: string) => mailboxes.find((m) => m.mailbox_id === id),
		[mailboxes],
	);

	const openThread = useCallback(
		(mailboxId: string, threadId: string) => {
			navigate({
				to: "/inbox/$mailboxId/$threadId",
				params: { mailboxId, threadId },
				search: listSearch(search),
			});
		},
		[navigate, search],
	);

	const openApproval = useCallback(
		(approval: PendingApproval) => {
			if (approval.mailboxId && approval.threadId) {
				openThread(approval.mailboxId, approval.threadId);
				return;
			}
			navigate({
				to: "/inbox",
				search: {
					mailbox: search.mailbox,
					folder: "approvals",
					q: search.q,
					approval: approval.id,
				},
			});
		},
		[navigate, openThread, search.mailbox, search.q],
	);

	const closeThread = useCallback(() => {
		navigate({ to: "/inbox", search: listSearch(search) });
	}, [navigate, search]);

	const openCompose = useCallback(
		(prefill?: ComposePrefill) => {
			navigate({
				to: ".",
				search: (prev: InboxSearch) => ({
					...withoutCompose(prev),
					compose: true,
					from: prefill?.from ?? prev.mailbox,
					to: prefill?.to,
					subject: prefill?.subject,
					threadId: prefill?.threadId,
					draftId: prefill?.draftId,
					quote: prefill?.quote,
					mode: prefill?.mode,
				}),
			});
		},
		[navigate],
	);

	const closeCompose = useCallback(() => {
		navigate({ to: ".", search: (prev: InboxSearch) => withoutCompose(prev) });
		// An autosaved draft shows up in its thread and in Drafts right away.
		refresh();
	}, [navigate, refresh]);

	const selectFolder = useCallback(
		(key: InboxFolderKey) => {
			navigate({
				to: "/inbox",
				search: { mailbox: search.mailbox, folder: key === "inbox" ? undefined : key },
			});
		},
		[navigate, search.mailbox],
	);

	const setScope = useCallback(
		(mailboxId: string | undefined) => {
			navigate({
				to: "/inbox",
				search: { mailbox: mailboxId, folder: search.folder, q: search.q },
			});
		},
		[navigate, search.folder, search.q],
	);

	const setQuery = useCallback(
		(value: string) => {
			navigate({
				to: "/inbox",
				search: { ...listSearch(search), q: value || undefined },
				replace: Boolean(search.q) === Boolean(value),
			});
		},
		[navigate, search],
	);

	const { setThreadRead } = readState;
	const onThreadAction = useCallback(
		async (row: UnifiedThreadRow, action: MessageAction) => {
			if (action === "mark_read" || action === "mark_unread") {
				await setThreadRead(row.mailbox_id, row.id, action === "mark_read");
				return;
			}
			try {
				await moveThread(row.mailbox_id, row.id, action);
			} finally {
				if (openId?.mailboxId === row.mailbox_id && openId.threadId === row.id) {
					closeThread();
				}
				refresh();
			}
		},
		[refresh, openId, closeThread, setThreadRead],
	);

	const onDiscardDraft = useCallback(
		async (draft: UnifiedDraft) => {
			try {
				await cancelDraft(draft.mailbox_id, draft.id);
			} finally {
				refresh();
			}
		},
		[refresh],
	);

	const ctx: InboxContextValue = {
		mailboxes,
		mailboxById,
		colorOf,
		search,
		folder,
		threads: readState.rows,
		folderTotal: !q && folderCounts ? folderCounts.threads : null,
		noMailYet,
		agent,
		approvals: scopedApprovals,
		decidedApprovals: scopedDecided,
		approvalsLoading: approvals.loading,
		approvalsError: approvals.error,
		refetchApprovals: approvals.refetch,
		openApproval,
		refresh,
		openThread,
		closeThread,
		openCompose,
		setThreadRead: readState.setThreadRead,
		guessThreadRead: readState.guess,
	};

	const scopeMailbox = search.mailbox ? mailboxById(search.mailbox) : undefined;
	const scopeLabel = scopeMailbox ? scopeMailbox.primary_address : "all mailboxes";
	const heading = q
		? `Results in ${folderKey === "reports" ? FOLDER_LABELS[folderKey] : FOLDER_LABELS[folderKey].toLowerCase()}`
		: FOLDER_LABELS[folderKey];

	let subtitle: string | undefined;
	if (noMailYet) {
		subtitle = "No mail yet";
	} else if (folder.kind === "threads" && q) {
		if (!threads.loading && !threads.error) {
			const n = threads.data.items.length;
			subtitle = `${formatCount(n)} ${n === 1 ? "result" : "results"}`;
		}
	} else if (folder.kind === "threads" && folderCounts) {
		// What still needs reading, not the size of the folder. Sent mail has no
		// unread state, so it counts conversations instead.
		if (folderKey === "sent") {
			const n = folderCounts.threads;
			subtitle = `${formatCount(n)} ${n === 1 ? "conversation" : "conversations"}`;
		} else {
			const n = folderCounts.unread;
			subtitle = n > 0 ? `${formatCount(n)} unread` : "All read";
		}
	} else if (folder.kind === "drafts" && scopeCounts) {
		const n = scopeCounts.drafts;
		subtitle = `${formatCount(n)} ${n === 1 ? "draft" : "drafts"}`;
	} else if (folder.kind === "approvals") {
		subtitle = `${formatCount(scopedApprovals.length)} awaiting you`;
	}

	const mailboxColumnProps = {
		mailboxes,
		search,
		colorOf,
		unreadOf,
		totalUnread,
		pendingApprovals: approvals.data.length,
	};

	let body: React.ReactNode;
	// Loading / error / empty states take the whole content area.
	let fullArea = true;
	if (mailboxesRes.loading) {
		body = <CenteredSpinner label="Loading mailboxes…" />;
	} else if (mailboxesRes.error) {
		body = (
			<ErrorState
				message={`Could not load your mailboxes (${mailboxesRes.error}).`}
				onRetry={mailboxesRes.refetch}
			/>
		);
	} else if (mailboxes.length === 0) {
		body = (
			<EmptyState
				icon={<Globe />}
				title="Add your first domain"
				hint="Pick a zone from your Cloudflare account and Reccado sets up receiving and sending. Then add a mailbox, and its mail shows up here."
				action={
					<Link
						to="/settings/domains"
						search={{ add: "domain" }}
						className={buttonClassName("primary")}
					>
						<Plus />
						Add a domain
					</Link>
				}
			/>
		);
	} else if (!scopeValid) {
		body = (
			<EmptyState
				title="Mailbox not found"
				hint="It may have been removed, or you no longer have access to it."
				action={
					<button
						type="button"
						className={buttonClassName("secondary")}
						onClick={() => setScope(undefined)}
					>
						Show all mailboxes
					</button>
				}
			/>
		);
	} else {
		fullArea = false;
		const list =
			folder.kind === "drafts" ? (
				<DraftsList
					scopeLabel={scopeLabel}
					resource={drafts}
					query={q}
					onDiscard={(d) => void onDiscardDraft(d)}
				/>
			) : folder.kind === "approvals" ? (
				<ApprovalsList
					scopeLabel={scopeLabel}
					selectedApprovalId={search.approval}
					selectedThread={openId}
				/>
			) : (
				<ThreadsList
					heading={heading}
					scopeLabel={scopeLabel}
					resource={listResource}
					selected={openId}
					query={q}
					onAction={(row, action) => void onThreadAction(row, action)}
				/>
			);
		body = (
			<>
				<MailboxColumn {...mailboxColumnProps} className="hidden lg:flex" />
				<div
					className={cn(
						"flex min-h-0 w-full shrink-0 flex-col min-[720px]:w-[340px] xl:w-[436px]",
						(openId || search.approval) && "max-[719px]:hidden",
					)}
				>
					{list}
				</div>
				<div
					className={cn(
						"flex min-h-0 min-w-0 flex-1",
						!openId && !search.approval && "max-[719px]:hidden",
					)}
				>
					<Outlet />
				</div>
			</>
		);
	}

	return (
		<InboxContext.Provider value={ctx}>
			{allIds.map((id) => (
				<MailboxSocket key={id} mailboxId={id} onEvent={onSocketEvent} />
			))}
			<AppShell
				title={q ? "Search" : FOLDER_LABELS[folderKey]}
				subtitle={subtitle}
				headerExtra={
					mailboxes.length > 0 ? (
						<div className="hidden sm:block">
							<ScopeSwitcher
								mailboxes={mailboxes}
								scope={search.mailbox}
								colorOf={colorOf}
								unreadOf={unreadOf}
								onChange={setScope}
							/>
						</div>
					) : null
				}
				searchActive={Boolean(q)}
				search={
					<SearchField
						value={q ?? ""}
						onCommit={setQuery}
						placeholder={
							scopeMailbox ? `Search ${scopeMailbox.primary_address}` : "Search every mailbox"
						}
						className="w-full max-w-[320px] max-sm:max-w-none max-sm:flex-1 sm:w-[240px] lg:w-[320px]"
					/>
				}
				toolbar={
					<FolderBar
						search={search}
						active={folderKey}
						counts={{
							inbox: scopeUnread > 0 ? formatCount(scopeUnread) : undefined,
							drafts: scopeDrafts > 0 ? formatCount(scopeDrafts) : undefined,
							approvals: scopedApprovals.length,
						}}
						agent={agent}
						onCompose={() => openCompose()}
						onSelectFolder={selectFolder}
						onOpenDrawer={() => setDrawerOpen(true)}
					/>
				}
			>
				{fullArea ? <div className="flex min-w-0 flex-1 flex-col">{body}</div> : body}
			</AppShell>

			{drawerOpen ? (
				<div className="fixed inset-0 z-40 lg:hidden">
					<button
						type="button"
						aria-label="Close mailboxes"
						className="absolute inset-0 bg-[var(--scrim)]"
						onClick={() => setDrawerOpen(false)}
					/>
					<div className="absolute inset-y-0 left-0 flex w-[264px] max-w-[85vw] flex-col gap-3 bg-content p-4 shadow-dialog">
						{mailboxes.length > 0 ? (
							<div className="sm:hidden">
								<ScopeSwitcher
									mailboxes={mailboxes}
									scope={search.mailbox}
									colorOf={colorOf}
									unreadOf={unreadOf}
									onChange={(id) => {
										setScope(id);
										setDrawerOpen(false);
									}}
								/>
							</div>
						) : null}
						<MailboxColumn
							{...mailboxColumnProps}
							className="min-h-0 w-full flex-1"
							onNavigate={() => setDrawerOpen(false)}
						/>
					</div>
				</div>
			) : null}

			{search.compose ? (
				<ComposeModal
					key={`${search.from ?? ""}|${search.draftId ?? ""}|${search.threadId ?? ""}|${search.quote ?? ""}|${search.mode ?? ""}`}
					mailboxes={mailboxes}
					defaultMailboxId={search.from ?? search.mailbox}
					prefill={{
						to: search.to,
						subject: search.subject,
						threadId: search.threadId,
						draftId: search.draftId,
						quote: search.quote,
						mode: search.mode,
					}}
					onClose={closeCompose}
					onSent={refresh}
				/>
			) : null}
		</InboxContext.Provider>
	);
}
