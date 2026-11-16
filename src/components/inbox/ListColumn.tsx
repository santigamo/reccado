import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	Archive,
	ArchiveRestore,
	Check,
	CheckCheck,
	FileChartColumn,
	FileText,
	Inbox,
	KeyRound,
	Loader2,
	Mail,
	MailOpen,
	Minus,
	MoreHorizontal,
	PanelLeftClose,
	RefreshCw,
	SearchX,
	ShieldCheck,
	Trash2,
	X,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { isThreadUnread, ThreadListItem } from "#/components/mail/ThreadListItem";
import { Avatar } from "#/components/ui/Avatar";
import { Button } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState, InlineNotice } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
import { Menu } from "#/components/ui/Menu";
import { MailboxTag, Pill } from "#/components/ui/Pill";
import {
	approvalTitle,
	fieldLabel,
	formatWaiting,
	requester,
	STATUS_COPY,
} from "#/lib/approval-copy";
import { cn } from "#/lib/cn";
import { formatListDate } from "#/lib/dates";
import { type InboxSearch, listSearch } from "#/lib/inbox-search";
import { type MessageAction, parseAddressList } from "#/lib/mail";
import { stripQuotedText } from "#/lib/quoted-text";
import {
	type ApprovalItem,
	approvalsForThread,
	type PendingApproval,
	useNow,
} from "#/lib/use-approvals";
import {
	formatCount,
	type Unified,
	type UnifiedDraft,
	type UnifiedThreadRow,
} from "#/lib/use-unified-mail";
import { rowKey, useInbox } from "./inbox-context";

type ResourceState<T> = { data: T; loading: boolean; error: string | null; refetch: () => void };

type PagedResource<T> = ResourceState<T> & {
	loadMore: () => void;
	loadingMore: boolean;
	loadMoreError: string | null;
};

/** Scroll position of each list, kept across opening a conversation and coming back. */
const scrollMemory = new Map<string, number>();

function ListFrame({
	heading,
	scopeLabel,
	onRefresh,
	children,
	notice,
	headingNote,
	leading,
	trailing,
	bar,
	scrollRef,
	onScroll,
}: {
	heading: string;
	/** Shown after the heading instead of the scope ("oldest first"). */
	headingNote?: string;
	scopeLabel: string;
	onRefresh?: () => void;
	children: ReactNode;
	notice?: ReactNode;
	/** Before the heading (the select-all checkbox). */
	leading?: ReactNode;
	/** After the heading, before Refresh (filters, the list menu). */
	trailing?: ReactNode;
	/** Replaces the whole header row (the selection bar). */
	bar?: ReactNode;
	scrollRef?: React.Ref<HTMLDivElement>;
	onScroll?: () => void;
}) {
	return (
		<section
			aria-label={`${heading} · ${scopeLabel}`}
			className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-card border border-b-0 border-border-card bg-panel"
		>
			{bar ?? (
				<div
					className={cn(
						"flex h-12 shrink-0 items-center gap-1.5 border-b border-border-card pr-3",
						leading ? "pl-[27px]" : "pl-5",
					)}
				>
					{leading}
					<h2
						className={cn(
							"m-0 min-w-0 flex-1 truncate text-sender font-normal tracking-[-0.01em] text-text-muted",
							leading && "pl-1",
						)}
						title={`${heading} · ${headingNote ?? scopeLabel}`}
					>
						{heading} <span className="text-text-faint">· {headingNote ?? scopeLabel}</span>
					</h2>
					{trailing}
					{onRefresh ? (
						<IconButton title="Refresh" size="sm" onClick={onRefresh}>
							<RefreshCw />
						</IconButton>
					) : null}
				</div>
			)}
			{notice}
			<div
				ref={scrollRef}
				onScroll={onScroll}
				className="app-scroll min-h-0 flex-1 overflow-y-auto"
			>
				{children}
			</div>
		</section>
	);
}

/** Square checkbox drawn like the rows' (checked, mixed, or empty). */
function SelectBox({
	state,
	label,
	onClick,
}: {
	state: "on" | "off" | "mixed";
	label: string;
	onClick: () => void;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: drawn to match the rows; role and aria-checked carry the semantics.
		<button
			type="button"
			role="checkbox"
			aria-checked={state === "mixed" ? "mixed" : state === "on"}
			aria-label={label}
			title={label}
			onClick={onClick}
			className="-ml-[7px] flex size-8 shrink-0 items-center justify-center rounded-full outline-none hover:bg-hover focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-brand)_55%,transparent)]"
		>
			<span
				aria-hidden="true"
				className={cn(
					"flex size-[18px] items-center justify-center rounded-[5px] border-[1.5px]",
					state === "off" ? "border-[#9AA3B0] bg-panel" : "border-brand bg-brand text-white",
				)}
			>
				{state === "on" ? <Check className="size-3" strokeWidth={3} /> : null}
				{state === "mixed" ? <Minus className="size-3" strokeWidth={3} /> : null}
			</span>
		</button>
	);
}

/** True when a key press belongs to a field, not to the list shortcuts. */
function typingInto(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function FailedNotice({ failed, onRetry }: { failed: string[]; onRetry: () => void }) {
	const { mailboxById } = useInbox();
	if (failed.length === 0) return null;
	const names = failed.map((id) => mailboxById(id)?.primary_address ?? id).join(", ");
	return (
		<InlineNotice
			tone="danger"
			action={
				<button type="button" className="text-label font-medium underline" onClick={onRetry}>
					Retry
				</button>
			}
		>
			Could not load {names}. Showing the other mailboxes.
		</InlineNotice>
	);
}

/** Threads folder (Inbox, Sent, Archive, Trash, All mail) or search results. */
export function ThreadsList({
	heading,
	scopeLabel,
	resource,
	selected,
	query,
	unreadOnly,
	onToggleUnread,
	onMarkAllRead,
	onAction,
	onSelectionAction,
}: {
	heading: string;
	scopeLabel: string;
	resource: PagedResource<Unified<UnifiedThreadRow>>;
	selected?: { mailboxId: string; threadId: string };
	query?: string;
	/** The Unread filter is on. */
	unreadOnly: boolean;
	onToggleUnread: () => void;
	onMarkAllRead: () => void;
	onAction: (row: UnifiedThreadRow, action: MessageAction) => void;
	onSelectionAction: (action: MessageAction) => void;
}) {
	const {
		folder,
		colorOf,
		mailboxById,
		approvals,
		search,
		noMailYet,
		selection,
		toggleSelected,
		setSelection,
		searchEverywhere,
		layout,
		askDeleteForever,
		askEmptyTrash,
	} = useInbox();
	const { data, loading, error, refetch, loadMore, loadingMore, loadMoreError } = resource;
	const folderState = folder.kind === "threads" ? folder.state : null;
	const scrollRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const memoryKey = `${search.mailbox ?? ""}|${search.folder ?? "inbox"}|${query ?? ""}|${unreadOnly}`;
	const keys = data.items.map((row) => rowKey(row.mailbox_id, row.id));
	const selectedCount = keys.filter((k) => selection.has(k)).length;
	const selecting = selection.size > 0;
	const restorable = folderState === "archive" || folderState === "trash";
	const inTrash = folderState === "trash" && folder.key === "trash";
	/** The selected conversations, as refs (Delete forever acts on them). */
	const selectedRefs = () =>
		[...selection].map((key) => {
			const at = key.indexOf(":");
			return { mailboxId: key.slice(0, at), threadId: key.slice(at + 1) };
		});

	// Come back to where you were: the list's scroll survives opening a
	// conversation (and the phone layout hiding the list), and the open row
	// stays in view as j/k / next / previous move through the list.
	const selectedKey = selected ? rowKey(selected.mailboxId, selected.threadId) : null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: closing a conversation (selectedKey) is when a phone shows the list again.
	useLayoutEffect(() => {
		const box = scrollRef.current;
		if (!box || loading) return;
		const saved = scrollMemory.get(memoryKey);
		if (saved !== undefined && box.scrollTop === 0 && box.offsetParent !== null)
			box.scrollTop = saved;
	}, [memoryKey, loading, selectedKey]);
	useEffect(() => {
		if (!selectedKey) return;
		const box = scrollRef.current;
		if (!box || box.offsetParent === null) return;
		box.querySelector(`[data-row-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({
			block: "nearest",
		});
	}, [selectedKey]);

	// Infinite scroll, with a button as the fallback.
	const hasMore = data.truncated && !query;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a longer list re-arms the observer (the sentinel may still be in view).
	useEffect(() => {
		const box = scrollRef.current;
		const sentinel = sentinelRef.current;
		if (!box || !sentinel || !hasMore || loadMoreError) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) loadMore();
			},
			{ root: box, rootMargin: "400px 0px" },
		);
		observer.observe(sentinel);
		return () => observer.disconnect();
	}, [hasMore, loadMore, loadMoreError, data.items.length]);

	// List keyboard (no conversation open): j/k move, x select, e / # act on the
	// selection or the focused row, Shift+I / Shift+U read state, Esc clears.
	const keysRef = useRef<(event: KeyboardEvent) => void>(() => {});
	keysRef.current = (event) => {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		if (typingInto(event.target) || search.compose || document.querySelector('[role="dialog"]'))
			return;
		const box = scrollRef.current;
		if (!box || box.offsetParent === null) return;
		const links = Array.from(box.querySelectorAll<HTMLAnchorElement>("[data-thread-link]"));
		const focused = links.findIndex((a) => a.closest("li")?.contains(document.activeElement));
		const focusedKey =
			focused >= 0 ? (links[focused]!.closest("li")?.getAttribute("data-row-key") ?? null) : null;
		const key = event.key;
		if (key === "Escape" && selecting) {
			setSelection([]);
		} else if (selected) {
			return; // The open conversation owns the other keys.
		} else if (key === "j" || key === "k") {
			const next =
				links[
					focused < 0
						? 0
						: Math.min(links.length - 1, Math.max(0, focused + (key === "j" ? 1 : -1)))
				];
			next?.focus();
			next?.scrollIntoView({ block: "nearest" });
		} else if (key === "x" && focusedKey) {
			toggleSelected(focusedKey);
		} else if (
			(key === "e" || key === "#" || key === "I" || key === "U") &&
			(selecting || focusedKey)
		) {
			const action: MessageAction =
				key === "e"
					? restorable
						? "restore_inbox"
						: "archive"
					: key === "#"
						? "trash"
						: key === "I"
							? "mark_read"
							: "mark_unread";
			// In the Trash, # means "Delete forever", and that always asks first.
			if (key === "#" && folderState === "trash") {
				if (!inTrash) return;
				if (selecting) askDeleteForever(selectedRefs());
				else {
					const row = data.items.find((r) => rowKey(r.mailbox_id, r.id) === focusedKey);
					if (row) askDeleteForever([{ mailboxId: row.mailbox_id, threadId: row.id }]);
				}
			} else if (selecting) onSelectionAction(action);
			else {
				const row = data.items.find((r) => rowKey(r.mailbox_id, r.id) === focusedKey);
				if (row) {
					// Keep the keyboard place: the next row takes the focus.
					if (action !== "mark_read" && action !== "mark_unread") {
						(links[focused + 1] ?? links[focused - 1])?.focus();
					}
					onAction(row, action);
				}
			}
		} else return;
		event.preventDefault();
	};
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => keysRef.current(event);
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	let body: ReactNode;
	if (loading) body = <CenteredSpinner label="Loading conversations…" />;
	else if (error)
		body = <ErrorState message={`Could not load mail (${error}).`} onRetry={refetch} />;
	else if (data.items.length === 0) {
		const everywhere = Boolean(search.mailbox) || folder.key !== "all";
		body = query ? (
			<EmptyState
				icon={<SearchX />}
				title="No matches"
				hint={`Nothing in ${heading.replace(/^Results in /, "")} of ${scopeLabel} matches “${query}”${unreadOnly ? " and is unread" : ""}.`}
				action={
					everywhere ? (
						<Button variant="secondary" size="sm" onClick={searchEverywhere}>
							Search all mail in every mailbox
						</Button>
					) : undefined
				}
			/>
		) : unreadOnly ? (
			<EmptyState
				icon={<CheckCheck />}
				className="justify-start pt-24"
				title="No unread conversations"
				action={
					<Button variant="secondary" size="sm" onClick={onToggleUnread}>
						Show all
					</Button>
				}
			/>
		) : folder.key === "reports" ? (
			<EmptyState
				icon={<FileChartColumn />}
				className="justify-start pt-24"
				title="No DMARC reports"
				hint="Daily aggregate reports from receivers like Google, Yahoo and Microsoft are kept here, out of your inbox and its counts."
			/>
		) : (
			<EmptyState
				icon={folder.key === "trash" ? <Trash2 /> : <Inbox />}
				className="justify-start pt-24"
				title={
					folder.key !== "inbox"
						? `Nothing in ${heading.toLowerCase()}`
						: noMailYet
							? "Nothing has arrived yet"
							: "You're all caught up"
				}
				hint={
					folder.key === "inbox"
						? "New mail shows up here on its own, a few seconds after it is delivered."
						: undefined
				}
			/>
		);
	} else {
		body = (
			<>
				<ul className="m-0 list-none p-0" aria-label={heading}>
					{data.items.map((row) => {
						const mailbox = mailboxById(row.mailbox_id);
						const key = rowKey(row.mailbox_id, row.id);
						return (
							<ThreadListItem
								key={key}
								thread={row}
								mailboxId={row.mailbox_id}
								search={search}
								color={colorOf(row.mailbox_id)}
								mailboxAddress={mailbox?.primary_address}
								selected={selected?.mailboxId === row.mailbox_id && selected.threadId === row.id}
								awaitingApproval={approvalsForThread(approvals, row.mailbox_id, row.id).length > 0}
								folderState={folderState}
								checked={selection.has(key)}
								selecting={selecting}
								onCheck={(range) => toggleSelected(key, range)}
								onArchive={() => onAction(row, "archive")}
								onTrash={() => onAction(row, "trash")}
								onRestore={() => onAction(row, "restore_inbox")}
								onDeleteForever={
									inTrash
										? () => askDeleteForever([{ mailboxId: row.mailbox_id, threadId: row.id }])
										: undefined
								}
								onToggleRead={() =>
									onAction(row, isThreadUnread(row) ? "mark_read" : "mark_unread")
								}
							/>
						);
					})}
				</ul>
				{hasMore ? (
					<div ref={sentinelRef} className="flex justify-center px-5 py-4">
						{loadMoreError ? (
							<p className="m-0 text-center text-label text-danger">
								Could not load older conversations.{" "}
								<button type="button" className="font-medium underline" onClick={loadMore}>
									Retry
								</button>
							</p>
						) : (
							<Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
								{loadingMore ? "Loading…" : "Load older conversations"}
							</Button>
						)}
					</div>
				) : data.items.length > 8 && !query ? (
					<p className="m-0 px-5 py-4 text-center text-label text-text-faint">
						That's everything{unreadOnly ? " unread" : ""} in {heading.toLowerCase()}.
					</p>
				) : null}
			</>
		);
	}

	const allState = selectedCount === 0 ? "off" : selectedCount === keys.length ? "on" : "mixed";
	const selectAll = () => setSelection(allState === "on" ? [] : keys);
	const selectionBar = selecting ? (
		<div
			role="toolbar"
			aria-label="Selected conversations"
			className="flex h-12 shrink-0 items-center gap-1 border-b border-border-card bg-row-current pr-2 pl-[27px]"
		>
			<SelectBox
				state={allState}
				label={allState === "on" ? "Clear selection" : "Select all in view"}
				onClick={selectAll}
			/>
			<span
				aria-live="polite"
				className="min-w-0 flex-1 truncate pl-1 text-body font-medium text-ink"
			>
				{formatCount(selection.size)} selected
			</span>
			{restorable ? (
				<IconButton
					title="Move to inbox"
					size="sm"
					onClick={() => onSelectionAction("restore_inbox")}
				>
					<ArchiveRestore />
				</IconButton>
			) : (
				<IconButton
					title="Archive (e)"
					aria-label="Archive"
					size="sm"
					onClick={() => onSelectionAction("archive")}
				>
					<Archive />
				</IconButton>
			)}
			{folderState !== "trash" ? (
				<IconButton
					title="Delete (#)"
					aria-label="Delete"
					size="sm"
					onClick={() => onSelectionAction("trash")}
				>
					<Trash2 />
				</IconButton>
			) : inTrash ? (
				<IconButton
					title="Delete forever (#)"
					aria-label="Delete forever"
					size="sm"
					className="text-danger hover:text-danger"
					onClick={() => askDeleteForever(selectedRefs())}
				>
					<Trash2 />
				</IconButton>
			) : null}
			<IconButton title="Mark as read" size="sm" onClick={() => onSelectionAction("mark_read")}>
				<MailOpen />
			</IconButton>
			<IconButton title="Mark as unread" size="sm" onClick={() => onSelectionAction("mark_unread")}>
				<Mail />
			</IconButton>
			<IconButton
				title="Clear selection (Esc)"
				aria-label="Clear selection"
				size="sm"
				onClick={() => setSelection([])}
			>
				<X />
			</IconButton>
		</div>
	) : undefined;

	return (
		<ListFrame
			heading={heading}
			scopeLabel={scopeLabel}
			onRefresh={refetch}
			scrollRef={scrollRef}
			onScroll={() => {
				const box = scrollRef.current;
				if (box && box.offsetParent !== null) scrollMemory.set(memoryKey, box.scrollTop);
			}}
			bar={selectionBar}
			leading={
				data.items.length > 0 ? (
					<SelectBox state="off" label="Select all in view" onClick={selectAll} />
				) : undefined
			}
			trailing={
				<>
					<button
						type="button"
						aria-pressed={unreadOnly}
						onClick={onToggleUnread}
						title={unreadOnly ? "Show all conversations" : "Show only unread conversations"}
						className={cn(
							"inline-flex h-7 shrink-0 items-center rounded-pill px-2.5 text-label font-medium",
							unreadOnly
								? "bg-brand text-white hover:bg-brand-hover"
								: "text-text-muted hover:bg-hover hover:text-text",
						)}
					>
						Unread
					</button>
					<Menu
						label="List actions"
						align="end"
						triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-control text-icon hover:bg-hover hover:text-text [&_svg]:size-4"
						trigger={<MoreHorizontal />}
						items={[
							{
								key: "read-all",
								label: "Mark all as read",
								icon: <CheckCheck />,
								onSelect: onMarkAllRead,
							},
							...(inTrash && data.items.length > 0
								? [
										{
											key: "empty-trash",
											label: "Empty trash",
											icon: <Trash2 />,
											onSelect: askEmptyTrash,
										},
									]
								: []),
						]}
					/>
					{selected ? (
						<IconButton
							title="Hide the list (])"
							aria-label="Hide the list"
							size="sm"
							className="max-[719px]:hidden"
							onClick={layout.toggleList}
						>
							<PanelLeftClose />
						</IconButton>
					) : null}
				</>
			}
			notice={
				!loading && !error ? (
					<>
						<FailedNotice failed={data.failed} onRetry={refetch} />
						{inTrash && !query && data.items.length > 0 ? (
							<InlineNotice
								className="border-b border-border-card"
								action={
									<Button variant="danger" size="sm" onClick={askEmptyTrash}>
										Empty trash
									</Button>
								}
							>
								Conversations in Trash stay until you delete them forever.
							</InlineNotice>
						) : null}
					</>
				) : null
			}
		>
			{body}
		</ListFrame>
	);
}

/** Drafts folder: every open draft across the scope. Opening one opens Compose. */
export function DraftsList({
	scopeLabel,
	resource,
	query,
	onDiscard,
}: {
	scopeLabel: string;
	resource: ResourceState<Unified<UnifiedDraft>>;
	query?: string;
	onDiscard: (draft: UnifiedDraft) => void;
}) {
	const { colorOf, mailboxById, search } = useInbox();
	const { data, loading, error, refetch } = resource;
	const needle = query?.toLowerCase();
	const drafts = data.items.filter((d) => {
		if (d.status !== "draft" && d.status !== "pending_confirmation") return false;
		if (!needle) return true;
		return `${parseAddressList(d.to_json).join(" ")} ${d.subject ?? ""} ${d.body_text ?? ""}`
			.toLowerCase()
			.includes(needle);
	});

	let body: ReactNode;
	if (loading) body = <CenteredSpinner label="Loading drafts…" />;
	else if (error)
		body = <ErrorState message={`Could not load drafts (${error}).`} onRetry={refetch} />;
	else if (drafts.length === 0) {
		body = (
			<EmptyState
				icon={<FileText />}
				title={query ? "No matching drafts" : "No drafts"}
				hint={query ? undefined : "Drafts you save, and drafts an agent writes, show up here."}
			/>
		);
	} else {
		body = (
			<ul className="m-0 list-none p-0">
				{drafts.map((d) => {
					const color = colorOf(d.mailbox_id);
					const recipients = parseAddressList(d.to_json);
					// What you wrote, not the conversation quoted under it.
					const preview = stripQuotedText(d.body_text ?? "")
						.replace(/\s+/g, " ")
						.trim();
					return (
						<li
							key={`${d.mailbox_id}:${d.id}`}
							className="group relative flex border-b border-border-card bg-panel hover:bg-[#FAFBFC]"
							style={{ boxShadow: `inset 3px 0 0 ${color.css}` }}
						>
							<Link
								to="/inbox"
								search={{
									...search,
									compose: true,
									from: d.mailbox_id,
									draftId: d.id,
									to: undefined,
									subject: undefined,
									threadId: undefined,
									quote: undefined,
									mode: undefined,
								}}
								className="flex min-w-0 flex-1 items-start gap-3 pt-4 pr-5 pb-3.5 pl-[18px] no-underline outline-none focus-visible:bg-row-selected"
							>
								<Avatar from={recipients[0] ?? null} size="md" />
								<div className="flex min-w-0 flex-1 flex-col gap-0.5">
									<div className="flex items-center gap-1.5">
										<span className="truncate text-sender font-medium tracking-[-0.01em] text-text">
											To: {recipients.join(", ") || "(no recipients)"}
										</span>
										<span className="min-w-2 flex-1" />
										<span className="shrink-0 text-label leading-5 text-text-secondary transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
											{formatListDate(d.updated_at)}
										</span>
									</div>
									<p className="m-0 line-clamp-2 text-body text-text-secondary">
										<span className="text-text">{d.subject ?? "(no subject)"}</span>
										{preview ? <span> · {preview}</span> : null}
									</p>
									<div className="flex min-h-[26px] items-center gap-1.5 pt-1.5">
										<MailboxTag color={color}>
											{mailboxById(d.mailbox_id)?.primary_address ?? d.mailbox_id}
										</MailboxTag>
										<span className="flex-1" />
										{d.origin === "mcp" ? <Pill tone="neutral">Written by the agent</Pill> : null}
										<Pill tone={d.status === "pending_confirmation" ? "approval" : "neutral"}>
											{d.status === "pending_confirmation" ? "Pending send" : "Draft"}
										</Pill>
									</div>
								</div>
							</Link>
							<div className="pointer-events-none absolute top-3 right-3 rounded-control bg-panel opacity-0 shadow-card transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
								<IconButton title="Discard draft" size="sm" onClick={() => onDiscard(d)}>
									<Trash2 />
								</IconButton>
							</div>
						</li>
					);
				})}
			</ul>
		);
	}

	return (
		<ListFrame
			heading="Drafts"
			scopeLabel={scopeLabel}
			onRefresh={refetch}
			notice={!loading && !error ? <FailedNotice failed={data.failed} onRetry={refetch} /> : null}
		>
			{body}
		</ListFrame>
	);
}

/** Who/what a request is about, for the list ("Reply to" rico@…, "Create an API key"). */
function approvalHeadline(a: ApprovalItem): { lead: string; target: string } {
	if (a.kind === "send" && a.send) {
		const first = a.send.to[0] ?? "(no recipients)";
		const more = a.send.to.length > 1 ? ` +${a.send.to.length - 1}` : "";
		return { lead: a.send.threadId ? "Reply to" : "New message to", target: `${first}${more}` };
	}
	return { lead: "", target: approvalTitle(a) };
}

/** First two rendered fields of a control-plane request, as one line. */
function controlSummary(a: ApprovalItem): string {
	return a.fields
		.slice(0, 2)
		.map((f) => `${fieldLabel(f.label)}: ${f.value === "(vacío)" ? "—" : f.value}`)
		.join(" · ");
}

function isToday(iso: string | null, now: number): boolean {
	if (!iso) return false;
	const d = new Date(iso);
	const t = new Date(now);
	return (
		d.getFullYear() === t.getFullYear() &&
		d.getMonth() === t.getMonth() &&
		d.getDate() === t.getDate()
	);
}

function DecidedIcon({ status }: { status: ApprovalItem["status"] }) {
	if (status === "sent" || status === "executed")
		return <Check aria-hidden="true" className="size-4 text-agent-on" strokeWidth={2.2} />;
	if (status === "failed")
		return <AlertTriangle aria-hidden="true" className="size-4 text-danger" />;
	if (status === "approved") return <Loader2 aria-hidden="true" className="size-4 text-icon" />;
	return <X aria-hidden="true" className="size-4 text-text-faint" strokeWidth={2.2} />;
}

function decidedLabel(a: ApprovalItem): string {
	const at = a.decidedAt ? formatListDate(a.decidedAt) : "";
	switch (a.status) {
		case "sent":
			return `Sent ${at}`.trim();
		case "executed":
			return `Applied ${at}`.trim();
		case "denied":
			return "Discarded";
		case "failed":
			return "Failed";
		case "approved":
			return "Approved";
		default:
			return STATUS_COPY[a.status].label;
	}
}

/**
 * Approvals folder (Paper "Approvals — Desktop"): every pending request, all
 * kinds, oldest first; then what was decided today. A reply opens its thread
 * with the approval card; anything else opens the request in the reading pane.
 */
export function ApprovalsList({
	scopeLabel,
	selectedApprovalId,
	selectedThread,
}: {
	scopeLabel: string;
	selectedApprovalId?: string;
	selectedThread?: { mailboxId: string; threadId: string };
}) {
	const {
		approvals,
		decidedApprovals,
		approvalsLoading,
		approvalsError,
		refetchApprovals,
		colorOf,
		mailboxById,
		search,
	} = useInbox();
	const now = useNow(30_000, approvals.length > 0);
	const decidedToday = decidedApprovals.filter((a) => isToday(a.decidedAt, now));

	let body: ReactNode;
	if (approvalsLoading && approvals.length === 0)
		body = <CenteredSpinner label="Loading approvals…" />;
	else if (approvalsError && approvals.length === 0)
		body = (
			<ErrorState
				message={`Could not load approvals (${approvalsError}).`}
				onRetry={refetchApprovals}
			/>
		);
	else
		body = (
			<>
				{approvals.length === 0 ? (
					<EmptyState
						icon={<ShieldCheck />}
						title="Nothing waiting for you"
						hint="When an agent asks to send a message or make a sensitive change, it waits here until you approve it. Agents never send on their own."
						className={decidedToday.length ? "min-h-48" : undefined}
					/>
				) : (
					<ul className="m-0 list-none p-0">
						{approvals.map((a) => {
							const color = a.mailboxId ? colorOf(a.mailboxId) : null;
							const { lead, target } = approvalHeadline(a);
							const selected =
								a.id === selectedApprovalId ||
								(!!a.threadId &&
									selectedThread?.mailboxId === a.mailboxId &&
									selectedThread.threadId === a.threadId);
							return (
								<li
									key={a.id}
									className={cn(
										"border-b border-border-card",
										selected ? "bg-row-selected" : "bg-panel hover:bg-[#FAFBFC]",
									)}
									style={{
										boxShadow: `inset 3px 0 0 ${color ? color.css : "var(--color-approval-border)"}`,
									}}
								>
									<Link
										{...approvalLink(a, search)}
										aria-current={selected ? "true" : undefined}
										className="flex items-start gap-3 pt-4 pr-5 pb-3.5 pl-[18px] no-underline outline-none focus-visible:bg-row-selected"
									>
										{a.send ? (
											<Avatar from={a.send.to[0] ?? null} size="md" />
										) : (
											<span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-approval-border bg-approval-surface text-approval [&_svg]:size-4">
												{a.kind.startsWith("api_key") ? <KeyRound /> : <ShieldCheck />}
											</span>
										)}
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<div className="flex items-center gap-1.5">
												<span className="truncate text-sender font-medium tracking-[-0.01em] text-text">
													{lead ? (
														<span className="font-normal text-text-muted">{lead} </span>
													) : null}
													{target}
												</span>
												<span className="min-w-2 flex-1" />
												<span className="shrink-0 text-label leading-5 text-text-secondary">
													{formatListDate(a.createdAt)}
												</span>
											</div>
											<p className="m-0 truncate text-body tracking-[-0.005em] text-text">
												{a.send
													? a.send.subject || "(no subject)"
													: `Requested by ${requester(a).replace(/^The /, "the ")}`}
											</p>
											<p className="m-0 truncate text-body tracking-[-0.005em] text-text-secondary">
												{a.send
													? a.send.snippet || "(no text body)"
													: controlSummary(a) || STATUS_COPY.pending.detail}
											</p>
											<div className="flex min-h-[22px] items-center gap-1.5 pt-1.5">
												{color && a.mailboxId ? (
													<MailboxTag color={color}>
														{mailboxById(a.mailboxId)?.primary_address ?? a.mailboxId}
													</MailboxTag>
												) : (
													<span className="text-meta text-text-muted">
														{a.revealsSecret ? "Approve on the request page" : "Account change"}
													</span>
												)}
												<span className="flex-1" />
												{a.status === "stale" ? (
													<span className="shrink-0 text-meta font-medium text-text-muted">
														{STATUS_COPY.stale.label}
													</span>
												) : (
													<span className="shrink-0 text-meta font-medium text-approval">
														Waiting {formatWaiting(a.createdAt, now)}
													</span>
												)}
											</div>
										</div>
									</Link>
								</li>
							);
						})}
					</ul>
				)}
				{decidedToday.length > 0 ? (
					<section aria-label="Decided today">
						<h3 className="m-0 flex h-11 items-center px-5 pt-2 text-meta font-medium tracking-[0.02em] text-text-muted">
							Decided today
						</h3>
						<ul className="m-0 list-none p-0">
							{decidedToday.map((a) => {
								const { lead, target } = approvalHeadline(a);
								return (
									<li
										key={a.id}
										className="flex h-12 items-center gap-3 border-t border-[#F1F1F1] pr-5 pl-[18px]"
									>
										<span className="flex w-8 shrink-0 justify-center">
											<DecidedIcon status={a.status} />
										</span>
										<span className="min-w-0 flex-1 truncate text-body tracking-[-0.005em] text-text-secondary">
											{lead ? `${lead} ${target}` : target}
										</span>
										<span className="shrink-0 text-right text-label text-text-muted">
											{decidedLabel(a)}
										</span>
									</li>
								);
							})}
						</ul>
					</section>
				) : null}
			</>
		);

	return (
		<ListFrame
			heading="Awaiting your approval"
			headingNote="oldest first"
			scopeLabel={scopeLabel}
			onRefresh={refetchApprovals}
		>
			{body}
		</ListFrame>
	);
}

/**
 * Where an approval row goes: its thread when it has one, else the request
 * itself in the Approvals folder (same targets as `openApproval`).
 */
function approvalLink(a: PendingApproval, search: InboxSearch) {
	if (a.threadId && a.mailboxId) {
		return {
			to: "/inbox/$mailboxId/$threadId",
			params: { mailboxId: a.mailboxId, threadId: a.threadId },
			search: listSearch(search),
		} as const;
	}
	return {
		to: "/inbox",
		search: { mailbox: search.mailbox, folder: "approvals", q: search.q, approval: a.id },
	} as const;
}
