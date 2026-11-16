import { Link } from "@tanstack/react-router";
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	Check,
	ChevronLeft,
	ChevronRight,
	Copy,
	FileCode2,
	Forward,
	Mail,
	MoreHorizontal,
	Reply,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { MessageItem } from "#/components/mail/MessageItem";
import { isThreadUnread } from "#/components/mail/ThreadListItem";
import { Button } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
import { Menu } from "#/components/ui/Menu";
import { Pill } from "#/components/ui/Pill";
import { cn } from "#/lib/cn";
import {
	cancelDraft,
	type Draft,
	extractEmail,
	fetchDrafts,
	type Mailbox,
	type Message,
	type MessageAction,
	moveThread,
	parseAddressList,
	rawMessageUrl,
} from "#/lib/mail";
import { tint } from "#/lib/mailbox-color";
import { approvalsForThread } from "#/lib/use-approvals";
import { useAsyncResource, useThread } from "#/lib/use-mail";
import { formatCount } from "#/lib/use-unified-mail";
import { ApprovalActionBarSlot, ApprovalCardSlot } from "./ApprovalSlot";
import { useInbox } from "./inbox-context";
import { ThreadDraftRow } from "./ThreadDraftRow";

/** White card that holds the reading pane (toolbar + content). */
export function ReadingPaneFrame({ children }: { children: ReactNode }) {
	return (
		<section
			aria-label="Conversation"
			className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-t-card border border-b-0 border-border-card bg-panel"
		>
			{children}
		</section>
	);
}

export function SelectConversation() {
	const { folder, noMailYet, search, mailboxes, mailboxById } = useInbox();
	const ready = search.mailbox
		? mailboxById(search.mailbox)
		: mailboxes.length === 1
			? mailboxes[0]
			: undefined;
	if (noMailYet && ready) return <MailboxReady mailbox={ready} />;
	return (
		<ReadingPaneFrame>
			<EmptyState
				icon={<Mail />}
				title={
					folder.kind === "drafts"
						? "Pick a draft to keep writing"
						: folder.kind === "approvals"
							? "Select a request"
							: "Select a conversation"
				}
				hint={
					folder.kind === "drafts"
						? "Drafts open in the compose window."
						: folder.kind === "approvals"
							? "Review what the agent asked for, then approve or discard it."
							: "Choose a conversation from the list to read it here."
				}
			/>
		</ReadingPaneFrame>
	);
}

/**
 * First run of a mailbox that has never received mail (Paper "Inbox — Empty ·
 * mailbox ready, no mail yet"): what to do next, and what is already wired.
 */
function MailboxReady({ mailbox }: { mailbox: Mailbox }) {
	const { colorOf, openCompose, agent } = useInbox();
	const [copied, setCopied] = useState(false);
	const color = colorOf(mailbox.mailbox_id);
	const address = mailbox.primary_address;

	async function copy() {
		try {
			await navigator.clipboard.writeText(address);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1600);
		} catch {
			// Clipboard refused (insecure context, permissions): the address is on screen.
		}
	}

	const active = mailbox.status === "active";
	return (
		<ReadingPaneFrame>
			<div className="app-scroll flex min-h-0 flex-1 flex-col gap-7 overflow-y-auto px-5 pt-10 pb-8 sm:px-18 sm:pt-18">
				<div className="flex flex-col gap-2.5">
					<Pill mailbox={color} dot className="self-start">
						{address}
					</Pill>
					<h2 className="m-0 text-[28px] leading-[34px] font-semibold tracking-[-0.02em] text-ink">
						Your mailbox is ready.
						<br />
						Send it something.
					</h2>
					<p className="m-0 max-w-120 text-sender leading-[23px] text-text-secondary">
						Write to {address} from any other account. It lands here within a few seconds, and that
						is the whole test.
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button variant="primary" onClick={() => void copy()} className="pr-4 pl-3.5">
						{copied ? <Check /> : <Copy />}
						{copied ? "Copied" : "Copy address"}
					</Button>
					<Button
						variant="secondary"
						onClick={() => openCompose({ from: mailbox.mailbox_id })}
						className="px-[15px]"
					>
						Write the first message
					</Button>
				</div>
				<ul className="m-0 flex max-w-130 list-none flex-col overflow-hidden rounded-card border border-border-card p-0">
					<ReadyRow
						tone={active ? "success" : "muted"}
						label="Receiving"
						detail={active ? "Mail to this address is routed here" : "This mailbox is disabled"}
					/>
					<ReadyRow
						tone={active ? "success" : "muted"}
						label="Sending"
						detail={active ? `Goes out as ${address}` : "Sending is off while disabled"}
					/>
					{agent.state === "unknown" ? null : (
						<ReadyRow
							tone={agent.state === "connected" ? "success" : "muted"}
							label="Agent"
							detail={
								agent.state === "connected"
									? "Connected. It reads and drafts; every send waits for you."
									: "None connected. Agents read and draft only."
							}
							action={
								agent.state === "connected" ? null : (
									<Link
										to="/settings/agent-access"
										className="shrink-0 text-label font-medium text-text underline decoration-1"
									>
										Connect one
									</Link>
								)
							}
						/>
					)}
				</ul>
			</div>
		</ReadingPaneFrame>
	);
}

function ReadyRow({
	tone,
	label,
	detail,
	action,
}: {
	tone: "success" | "muted";
	label: string;
	detail: string;
	action?: ReactNode;
}) {
	return (
		<li className="flex min-h-11.5 items-center gap-3 border-t border-border-card px-4 py-2 first:border-t-0">
			<span
				aria-hidden="true"
				className={cn(
					"size-1.75 shrink-0 rounded-[4px]",
					tone === "success" ? "bg-success" : "bg-disabled",
				)}
			/>
			<span className="w-23 shrink-0 text-label font-medium text-text">{label}</span>
			<span className="min-w-0 flex-1 text-label text-text-muted">{detail}</span>
			{action}
		</li>
	);
}

/**
 * Where a conversation is, for the toolbar: Trash only when every message is
 * trashed, Inbox while any received message is in it, then Archive. Your own
 * replies sit in Sent and never decide it.
 */
export function conversationState(messages: readonly Message[]): Message["state"] | undefined {
	if (messages.length === 0) return undefined;
	if (messages.every((m) => m.state === "trash")) return "trash";
	if (messages.some((m) => m.state === "inbox")) return "inbox";
	if (messages.some((m) => m.state === "archive")) return "archive";
	return messages.at(-1)?.state;
}

/** Collapsed messages shown before they fold into a "N older messages" bar. */
const FOLD_AFTER = 3;

/** True when a key press belongs to a field, not to the inbox shortcuts. */
function typingInto(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	return (
		el.isContentEditable ||
		el.tagName === "INPUT" ||
		el.tagName === "TEXTAREA" ||
		el.tagName === "SELECT"
	);
}

/** Reply targets the last inbound message; falls back to the latest one. */
function findReplyTarget(messages: Message[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.direction === "inbound") return m;
	}
	return messages.at(-1);
}

/** An open conversation: toolbar, tinted header, messages, approval slots. */
export function ThreadView({ mailboxId, threadId }: { mailboxId: string; threadId: string }) {
	const inbox = useInbox();
	const {
		colorOf,
		mailboxById,
		threads,
		folderTotal,
		refresh,
		openThread,
		closeThread,
		openCompose,
		approvals,
		setThreadRead,
		guessThreadRead,
	} = inbox;
	const { data, loading, error, refetch } = useThread(mailboxId, threadId);
	const draftsRes = useAsyncResource<Draft[]>(() => fetchDrafts(mailboxId), [], [mailboxId]);
	const color = colorOf(mailboxId);
	const mailbox = mailboxById(mailboxId);
	const scrollRef = useRef<HTMLDivElement>(null);
	const newestRef = useRef<HTMLDivElement>(null);
	const [unfolded, setUnfolded] = useState(false);

	const index = threads.findIndex((t) => t.mailbox_id === mailboxId && t.id === threadId);

	// Opening a thread clears its unread state: the list row, the badges and the
	// mailbox column go read at once (before the thread has even loaded), and the
	// write follows for the messages that are unread. Once per loaded set of ids.
	const listRowUnread = index >= 0 && isThreadUnread(threads[index]!);
	const guessedRef = useRef("");
	useEffect(() => {
		if (!listRowUnread || guessedRef.current === `${mailboxId}:${threadId}`) return;
		guessedRef.current = `${mailboxId}:${threadId}`;
		guessThreadRead(mailboxId, threadId, true);
	}, [listRowUnread, mailboxId, threadId, guessThreadRead]);
	const markedKeyRef = useRef("");
	useEffect(() => {
		if (!data) return;
		const unread = data.messages.filter((m) => m.is_read === 0);
		const key = `${threadId}:${data.messages.map((m) => m.id).join(",")}`;
		if (markedKeyRef.current === key) return;
		markedKeyRef.current = key;
		// Nothing to write, but a guess made from the list still has to settle.
		const guessed = guessedRef.current === `${mailboxId}:${threadId}`;
		if (unread.length === 0 && !guessed) return;
		void setThreadRead(
			mailboxId,
			threadId,
			true,
			unread.map((m) => m.id),
		);
	}, [data, mailboxId, threadId, setThreadRead]);

	// Messages that were unread when the conversation opened keep their "new"
	// emphasis while it stays open, though they are already marked read.
	const newOnOpenRef = useRef<{ threadId: string; ids: Set<string> } | null>(null);
	if (data && newOnOpenRef.current?.threadId !== threadId) {
		newOnOpenRef.current = {
			threadId,
			ids: new Set(data.messages.filter((m) => m.is_read === 0).map((m) => m.id)),
		};
	}
	const newOnOpen = newOnOpenRef.current?.threadId === threadId ? newOnOpenRef.current.ids : null;
	const prev = index > 0 ? threads[index - 1] : undefined;
	const next = index >= 0 ? threads[index + 1] : undefined;

	const messages = data?.messages ?? [];
	const latest = messages.at(-1);
	const state = conversationState(messages);
	const isRestorable = state === "archive" || state === "trash";
	const threadApprovals = approvalsForThread(approvals, mailboxId, threadId);
	// Drafts of this conversation, shown under it (Gmail). A draft an approval is
	// already presenting is left to the approval card.
	const approvalDraftIds = new Set(threadApprovals.map((a) => a.send?.draftId).filter(Boolean));
	const threadDrafts = draftsRes.data.filter(
		(d) =>
			d.thread_id === threadId &&
			(d.status === "draft" || d.status === "pending_confirmation") &&
			!approvalDraftIds.has(d.id),
	);
	// The reply you were writing: reopened instead of starting a second one.
	const ownReplyDraft = threadDrafts.find((d) => d.origin !== "mcp" && d.status === "draft");

	// Open on the newest message, not on the top of a long thread. Once per
	// conversation, so a background refresh never yanks the view.
	const scrolledFor = useRef("");
	useEffect(() => {
		if (!data || data.messages.length < 2 || scrolledFor.current === threadId) return;
		scrolledFor.current = threadId;
		const box = scrollRef.current;
		const newest = newestRef.current;
		if (!box || !newest) return;
		const top = newest.offsetTop - box.offsetTop;
		// Only when the newest message would start below the fold.
		if (top + 48 > box.clientHeight) box.scrollTop = Math.max(0, top - 56);
	}, [data, threadId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a different conversation starts folded again.
	useEffect(() => {
		setUnfolded(false);
	}, [threadId]);

	/** Apply to every message, then move on: to the neighbour, or back to the list. */
	async function act(action: MessageAction, then: "next" | "close") {
		await moveThread(mailboxId, threadId, action);
		const target = then === "next" ? (next ?? prev) : undefined;
		if (target) openThread(target.mailbox_id, target.id);
		else closeThread();
		refresh();
	}

	function reply() {
		if (ownReplyDraft) {
			openCompose({ from: mailboxId, draftId: ownReplyDraft.id });
			return;
		}
		const target = findReplyTarget(messages);
		const subject = target?.subject ?? "";
		// Replying to your own last message follows up with the same people.
		const to =
			target?.direction === "outbound"
				? parseAddressList(target.to_json).join(", ")
				: extractEmail(target?.from_addr);
		openCompose({
			from: mailboxId,
			threadId,
			to,
			subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
			quote: target?.id,
			mode: "reply",
		});
	}

	function forward() {
		const subject = latest?.subject ?? "";
		openCompose({
			from: mailboxId,
			threadId,
			subject: /^fwd?:/i.test(subject) ? subject : `Fwd: ${subject}`,
			quote: latest?.id,
			mode: "forward",
		});
	}

	// Gmail's keyboard basics. Ignored while typing, with a modifier held, or with
	// the compose dialog open (it owns the keyboard then).
	const keysRef = useRef<(event: globalThis.KeyboardEvent) => void>(() => {});
	keysRef.current = (event) => {
		if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
		if (typingInto(event.target) || inbox.search.compose) return;
		if (document.querySelector('[role="dialog"]')) return;
		const key = event.key;
		if (key === "Escape" || key === "u") closeThread();
		else if (key === "j" && next) openThread(next.mailbox_id, next.id);
		else if (key === "k" && prev) openThread(prev.mailbox_id, prev.id);
		else if (!data) return;
		else if (key === "e") void act(isRestorable ? "restore_inbox" : "archive", "next");
		else if (key === "#" && state !== "trash") void act("trash", "next");
		else if (key === "r" && threadApprovals.length === 0) reply();
		else if (key === "f" && threadApprovals.length === 0) forward();
		else return;
		event.preventDefault();
	};
	useEffect(() => {
		const onKey = (event: globalThis.KeyboardEvent) => keysRef.current(event);
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, []);

	const toolbar = (
		<div className="flex h-12 shrink-0 items-center gap-1 border-b border-[#EFEFEF] pr-[18px] pl-2 sm:pl-4">
			<IconButton title="Back to list" className="min-[720px]:hidden" onClick={closeThread}>
				<ArrowLeft />
			</IconButton>
			{data ? (
				<>
					{isRestorable ? (
						<IconButton title="Move to inbox" onClick={() => void act("restore_inbox", "next")}>
							<ArchiveRestore />
						</IconButton>
					) : (
						<IconButton title="Archive" onClick={() => void act("archive", "next")}>
							<Archive />
						</IconButton>
					)}
					{state !== "trash" ? (
						<IconButton title="Delete" onClick={() => void act("trash", "next")}>
							<Trash2 />
						</IconButton>
					) : null}
					<IconButton
						title="Mark as unread"
						onClick={() => {
							void setThreadRead(
								mailboxId,
								threadId,
								false,
								messages.map((m) => m.id),
							);
							closeThread();
						}}
					>
						<Mail />
					</IconButton>
					<Menu
						label="More actions"
						triggerClassName="inline-flex h-8 w-8 items-center justify-center rounded-control text-icon hover:bg-hover hover:text-text [&_svg]:size-[17px]"
						trigger={<MoreHorizontal />}
						items={[
							{ key: "reply", label: "Reply", icon: <Reply />, onSelect: reply },
							{ key: "forward", label: "Forward", icon: <Forward />, onSelect: forward },
							...(latest
								? [
										{
											key: "raw",
											label: "View original",
											icon: <FileCode2 />,
											href: rawMessageUrl(mailboxId, latest.id),
										},
									]
								: []),
						]}
					/>
				</>
			) : null}
			<div className="flex-1" />
			{index >= 0 ? (
				<span className="text-label text-text-muted tabular-nums">
					{formatCount(index + 1)} of {formatCount(Math.max(folderTotal ?? 0, threads.length))}
				</span>
			) : null}
			<IconButton
				title="Newer conversation"
				size="sm"
				disabled={!prev}
				onClick={() => prev && openThread(prev.mailbox_id, prev.id)}
			>
				<ChevronLeft />
			</IconButton>
			<IconButton
				title="Older conversation"
				size="sm"
				disabled={!next}
				onClick={() => next && openThread(next.mailbox_id, next.id)}
			>
				<ChevronRight />
			</IconButton>
		</div>
	);

	let content: ReactNode;
	if (loading && !data) content = <CenteredSpinner label="Loading conversation…" />;
	else if (error && !data) {
		content = (
			<ErrorState message={`Could not load this conversation (${error}).`} onRetry={refetch} />
		);
	} else if (!data || messages.length === 0) {
		content = <EmptyState icon={<Mail />} title="This conversation is empty" />;
	} else {
		const subject = messages[0]?.subject ?? "(no subject)";
		const isNew = (m: Message | undefined) =>
			Boolean(m && (m.is_read === 0 || newOnOpen?.has(m.id)));
		// Newest first: the latest message sits right under the subject, older
		// ones follow below it, as the owner reads a conversation top-down.
		const view = [...messages].reverse();
		const openAt = (i: number) => i === 0 || isNew(view[i]);
		// A long run of read, older messages folds into one "N older messages"
		// bar; the line right after the open ones and the very first message stay.
		let lastOpen = 0;
		view.forEach((_, i) => {
			if (openAt(i)) lastOpen = i;
		});
		const foldFrom = lastOpen + 2;
		const foldTo = view.length - 2;
		const hidden = foldTo - foldFrom + 1;
		const fold = !unfolded && hidden >= FOLD_AFTER;
		content = (
			<div ref={scrollRef} className="app-scroll min-h-0 flex-1 overflow-y-auto">
				<header
					className="flex flex-col gap-2 border-b px-4 pt-5 pb-[18px] sm:px-7"
					style={{ backgroundColor: tint(color, 7), borderBottomColor: tint(color, 16) }}
				>
					<h2 className="m-0 text-title font-semibold tracking-[-0.015em] text-[#1F1F1F]">
						{subject}
					</h2>
					<div className="flex flex-wrap items-center gap-2">
						<Pill mailbox={color} dot size="md">
							{mailbox?.primary_address ?? mailboxId}
						</Pill>
						<span className="text-label text-text-muted">
							{messages.length === 1 ? "1 message" : `${messages.length} messages`}
							{threadApprovals.length > 0 ? ` · ${threadApprovals.length} awaiting approval` : null}
						</span>
					</div>
				</header>
				{threadDrafts.map((draft) => (
					<ThreadDraftRow
						key={draft.id}
						draft={draft}
						onOpen={() => openCompose({ from: mailboxId, draftId: draft.id })}
						onDiscard={async () => {
							await cancelDraft(mailboxId, draft.id).catch(() => undefined);
							draftsRes.refetch();
							refresh();
						}}
					/>
				))}
				<div className="px-5 py-5 empty:hidden">
					<ApprovalCardSlot mailboxId={mailboxId} threadId={threadId} approvals={threadApprovals} />
				</div>
				{view.map((message, i) => {
					if (fold && i >= foldFrom && i <= foldTo) {
						if (i !== foldFrom) return null;
						return (
							<button
								key="fold"
								type="button"
								onClick={() => setUnfolded(true)}
								className="flex h-9 w-full items-center gap-3 border-b border-[#F1F1F1] px-4 text-left hover:bg-[#FAFBFC] sm:px-7"
							>
								<span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border-card text-meta font-medium text-text-secondary">
									{hidden}
								</span>
								<span className="text-label text-text-muted">
									{hidden === 1 ? "1 older message" : `${hidden} older messages`}
								</span>
							</button>
						);
					}
					return (
						<div key={message.id} ref={i === 0 ? newestRef : undefined}>
							<MessageItem
								message={message}
								mailboxId={mailboxId}
								defaultOpen={openAt(i)}
								isNew={isNew(message)}
							/>
						</div>
					);
				})}
			</div>
		);
	}

	return (
		<ReadingPaneFrame>
			{toolbar}
			{content}
			<ApprovalActionBarSlot
				mailboxId={mailboxId}
				threadId={threadId}
				approvals={threadApprovals}
			/>
			{data && messages.length > 0 && threadApprovals.length === 0 ? (
				<div className="flex h-16 shrink-0 items-center gap-2 border-t border-[#ECECEC] bg-panel pr-6 pl-5 shadow-sticky max-sm:px-3 pointer-coarse:h-[72px]">
					<Button
						variant="primary"
						onClick={reply}
						className="pr-4 pl-3.5"
						title={ownReplyDraft ? "Continue your draft (r)" : "Reply (r)"}
					>
						<Reply />
						{ownReplyDraft ? "Continue draft" : "Reply"}
					</Button>
					<Button variant="secondary" onClick={forward} className="pr-[15px] pl-[13px]">
						<Forward />
						Forward
					</Button>
					<span className="min-w-0 flex-1" />
					<span className="flex min-w-0 items-center gap-[7px] text-label text-text-muted">
						<span
							aria-hidden="true"
							className="size-[7px] shrink-0 rounded-[4px]"
							style={{ background: color.css }}
						/>
						<span className="truncate max-sm:hidden">
							Replies go out from {mailbox?.primary_address ?? "this mailbox"}
						</span>
						<span className="truncate sm:hidden">{mailbox?.primary_address}</span>
					</span>
				</div>
			) : null}
		</ReadingPaneFrame>
	);
}
