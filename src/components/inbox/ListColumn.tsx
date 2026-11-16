import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	Check,
	FileChartColumn,
	FileText,
	Inbox,
	KeyRound,
	Loader2,
	RefreshCw,
	SearchX,
	ShieldCheck,
	Trash2,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { isThreadUnread, ThreadListItem } from "#/components/mail/ThreadListItem";
import { Avatar } from "#/components/ui/Avatar";
import { CenteredSpinner, EmptyState, ErrorState, InlineNotice } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
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
import { useInbox } from "./inbox-context";

type ResourceState<T> = { data: T; loading: boolean; error: string | null; refetch: () => void };

function ListFrame({
	heading,
	scopeLabel,
	onRefresh,
	children,
	notice,
	headingNote,
}: {
	heading: string;
	/** Shown after the heading instead of the scope ("oldest first"). */
	headingNote?: string;
	scopeLabel: string;
	onRefresh?: () => void;
	children: ReactNode;
	notice?: ReactNode;
}) {
	return (
		<section
			aria-label={`${heading} · ${scopeLabel}`}
			className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-t-card border border-b-0 border-border-card bg-panel"
		>
			<div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border-card pr-3 pl-5">
				<h2 className="m-0 min-w-0 flex-1 truncate text-sender font-normal tracking-[-0.01em] text-text-muted">
					{heading} <span className="text-text-faint">· {headingNote ?? scopeLabel}</span>
				</h2>
				{onRefresh ? (
					<IconButton title="Refresh" size="sm" onClick={onRefresh}>
						<RefreshCw />
					</IconButton>
				) : null}
			</div>
			{notice}
			<div className="app-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
		</section>
	);
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
	onAction,
}: {
	heading: string;
	scopeLabel: string;
	resource: ResourceState<Unified<UnifiedThreadRow>>;
	selected?: { mailboxId: string; threadId: string };
	query?: string;
	onAction: (row: UnifiedThreadRow, action: MessageAction) => void;
}) {
	const { folder, colorOf, mailboxById, approvals, search, noMailYet, folderTotal } = useInbox();
	const { data, loading, error, refetch } = resource;
	const folderState = folder.kind === "threads" ? folder.state : null;

	let body: ReactNode;
	if (loading) body = <CenteredSpinner label="Loading conversations…" />;
	else if (error)
		body = <ErrorState message={`Could not load mail (${error}).`} onRetry={refetch} />;
	else if (data.items.length === 0) {
		body = query ? (
			<EmptyState
				icon={<SearchX />}
				title="No matches"
				hint={`Nothing in ${heading.toLowerCase()} matches “${query}”.`}
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
				<ul className="m-0 list-none p-0">
					{data.items.map((row) => {
						const mailbox = mailboxById(row.mailbox_id);
						return (
							<ThreadListItem
								key={`${row.mailbox_id}:${row.id}`}
								thread={row}
								mailboxId={row.mailbox_id}
								search={search}
								color={colorOf(row.mailbox_id)}
								mailboxAddress={mailbox?.primary_address}
								selected={selected?.mailboxId === row.mailbox_id && selected.threadId === row.id}
								awaitingApproval={approvalsForThread(approvals, row.mailbox_id, row.id).length > 0}
								folderState={folderState}
								onArchive={() => onAction(row, "archive")}
								onTrash={() => onAction(row, "trash")}
								onRestore={() => onAction(row, "restore_inbox")}
								onToggleRead={() =>
									onAction(row, isThreadUnread(row) ? "mark_read" : "mark_unread")
								}
							/>
						);
					})}
				</ul>
				{data.truncated ? (
					<p className="m-0 px-5 py-4 text-center text-label text-text-muted">
						{folderTotal !== null && folderTotal > data.items.length
							? `Showing the latest ${formatCount(data.items.length)} of ${formatCount(folderTotal)} conversations. Search to find older mail.`
							: "Showing the latest conversations of each mailbox. Search to find older mail."}
					</p>
				) : null}
			</>
		);
	}

	return (
		<ListFrame
			heading={heading}
			scopeLabel={scopeLabel}
			onRefresh={refetch}
			notice={!loading && !error ? <FailedNotice failed={data.failed} onRetry={refetch} /> : null}
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
