import { Link } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Check, Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import type { MouseEvent, ReactElement } from "react";
import { Avatar } from "#/components/ui/Avatar";
import { IconButton } from "#/components/ui/IconButton";
import { MailboxTag, Pill } from "#/components/ui/Pill";
import { cn } from "#/lib/cn";
import { formatFullDate, formatListDate } from "#/lib/dates";
import { type InboxSearch, listSearch } from "#/lib/inbox-search";
import {
	displayName,
	type MessageState,
	parseAddressList,
	parseAddressNames,
	type ThreadRow,
} from "#/lib/mail";
import type { MailboxColor } from "#/lib/mailbox-color";
import { participantLabel, recipientsLabel } from "#/lib/thread-summary";
import { rowIsUnread } from "#/lib/use-read-state";

/** Unread while any message is (rows from older servers only know the latest one). */
export function isThreadUnread(thread: ThreadRow): boolean {
	return rowIsUnread(thread);
}

/**
 * The unread mark, Apple Mail style: an 8px brand dot in a fixed slot left of
 * the avatar, so read and unread rows keep the same alignment. Shared with the
 * collapsed messages of an open conversation.
 */
export function UnreadDot({ unread, className }: { unread: boolean; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("flex w-2 shrink-0 items-center justify-center", className)}
		>
			{unread ? <span className="size-2 rounded-full bg-brand" /> : null}
		</span>
	);
}

/**
 * Who a row names, Gmail style. A conversation that is only your own mail says
 * whom it went to ("To: Noor"), read off the real recipients — never this
 * mailbox's own address. Otherwise its senders, oldest first, with "me" for you
 * ("Rico, me"); each part carries its own unread flag for bolding.
 */
function senderLine(
	thread: ThreadRow,
): string | Array<{ text: string; unread: boolean; separator: string }> {
	const participants = thread.participants ?? [];
	const onlyMine =
		participants.length > 0
			? participants.every((p) => p.me)
			: thread.latest_direction === "outbound";
	if (onlyMine) {
		return recipientsLabel(
			parseAddressList(thread.latest_to_json),
			parseAddressNames(thread.latest_recipient_names_json),
		);
	}
	if (participants.length > 0) return participantLabel(participants);
	return displayName(thread.latest_from, thread.latest_from_name);
}

/**
 * One conversation in the list (Paper "Inbox — Desktop" list column): a 3px
 * stripe in the mailbox colour, the unread slot, avatar, sender + time, a
 * two-line preview (subject, then snippet), and the mailbox tag.
 *
 * Read state is visible at a glance, Gmail / Apple Mail style: an unread row is
 * white with a navy dot, sender and subject semibold in ink and the time in
 * ink; a read row sits on a quiet grey, everything at regular weight in the
 * secondary/muted text colours, and its dot slot stays empty. The open
 * conversation's row is a blue-grey with a wider stripe, distinct from both.
 *
 * The row is a real link (open in new tab works); hover / keyboard focus
 * reveals archive, delete (or "move to inbox" in Archive/Trash) and read/unread
 * over the timestamp. Those are sibling buttons, never nested in the link.
 */
export function ThreadListItem({
	thread,
	mailboxId,
	search,
	color,
	mailboxAddress,
	selected = false,
	awaitingApproval = false,
	folderState,
	onArchive,
	onTrash,
	onRestore,
	onDeleteForever,
	onToggleRead,
	checked = false,
	selecting = false,
	onCheck,
}: {
	thread: ThreadRow;
	/** Owning mailbox: the row links to /inbox/<mailboxId>/<threadId>. */
	mailboxId: string;
	/** Current list state, carried into the link (scope, folder, query). */
	search: InboxSearch;
	color: MailboxColor;
	/** Shown in the tag line; omit to hide the tag (single-mailbox scope can keep it). */
	mailboxAddress?: string;
	selected?: boolean;
	awaitingApproval?: boolean;
	/** State of the folder being listed (null for "All mail"). */
	folderState: Exclude<MessageState, "draft"> | null;
	onArchive: () => void;
	onTrash: () => void;
	onRestore: () => void;
	/** In the Trash: "Delete forever" (the caller asks for confirmation). */
	onDeleteForever?: () => void;
	onToggleRead: () => void;
	/** In the selection. */
	checked?: boolean;
	/** Some row is selected: every checkbox shows, not only on hover. */
	selecting?: boolean;
	/** Toggle selection; `range` for shift-click. Omit to hide the checkbox. */
	onCheck?: (range: boolean) => void;
}): ReactElement {
	// Gmail: a conversation is unread while any of its messages is.
	const isUnread = isThreadUnread(thread);
	const state = folderState ?? thread.latest_state;
	const isRestorable = state === "archive" || state === "trash";
	const subject = thread.latest_subject ?? thread.subject_norm ?? "(no subject)";
	const outbound = thread.latest_direction === "outbound";
	const who = senderLine(thread);
	// The avatar is the other person: the newest sender who isn't you, or, for a
	// conversation that is only your own mail, whom you wrote to.
	const other = [...(thread.participants ?? [])].reverse().find((p) => !p.me);
	const face = !outbound
		? { from: thread.latest_from, name: thread.latest_from_name ?? null }
		: other
			? { from: other.address, name: other.name }
			: { from: parseAddressList(thread.latest_to_json)[0] ?? thread.latest_from, name: null };
	const whoTitle = outbound
		? parseAddressList(thread.latest_to_json).join(", ") || thread.latest_from
		: thread.latest_from;

	const showCheck = Boolean(onCheck) && (checked || selecting);
	// Selecting text in a row (to copy a subject) is not a click on it.
	function onLinkClick(event: MouseEvent<HTMLAnchorElement>) {
		const selection = typeof window !== "undefined" ? window.getSelection() : null;
		if (
			selection &&
			!selection.isCollapsed &&
			selection.toString().trim() &&
			selection.anchorNode &&
			event.currentTarget.contains(selection.anchorNode)
		) {
			event.preventDefault();
			return;
		}
		// While selecting, a click on a row adds it (Gmail on phones); modifier
		// clicks keep the browser's open-in-new-tab.
		if (selecting && onCheck && !event.metaKey && !event.ctrlKey && event.button === 0) {
			event.preventDefault();
			onCheck(event.shiftKey);
		}
	}

	return (
		<li
			data-row-key={`${mailboxId}:${thread.id}`}
			className={cn(
				"group relative flex border-b border-border-card",
				checked
					? "bg-row-current"
					: selected
						? "bg-row-current"
						: isUnread
							? "bg-panel hover:bg-[#FAFBFC]"
							: "bg-row-read hover:bg-row-read-hover",
			)}
			style={{ boxShadow: `inset ${selected ? 4 : 3}px 0 0 ${color.css}` }}
		>
			<Link
				to="/inbox/$mailboxId/$threadId"
				params={{ mailboxId, threadId: thread.id }}
				search={listSearch(search)}
				aria-current={selected ? "true" : undefined}
				data-thread-link=""
				onClick={onLinkClick}
				className="flex min-w-0 flex-1 items-start gap-3 pt-4 pr-5 pb-3.5 pl-[11px] text-left no-underline outline-none focus-visible:shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--color-brand)_55%,transparent)]"
			>
				<UnreadDot unread={isUnread} className="-mr-1 h-5" />
				<Avatar
					from={face.from}
					name={face.name}
					size="md"
					className={cn(
						onCheck && "transition-opacity",
						showCheck
							? "opacity-0"
							: onCheck &&
									"pointer-fine:group-hover:opacity-0 group-has-[[data-row-check]:focus-visible]:opacity-0",
					)}
				/>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<div className="flex items-center gap-1.5">
						<span
							className={cn(
								"truncate text-sender tracking-[-0.01em]",
								isUnread ? "font-semibold text-ink" : "font-normal text-text-secondary",
							)}
							title={whoTitle}
						>
							{typeof who === "string"
								? who
								: who.map((part) => (
										<span key={`${part.separator}${part.text}`}>
											{part.separator}
											<span
												className={cn(
													isUnread && !part.unread && "font-normal text-text-secondary",
												)}
											>
												{part.text}
											</span>
										</span>
									))}
						</span>
						{thread.message_count > 1 ? (
							<span className="shrink-0 text-label text-text-muted">{thread.message_count}</span>
						) : null}
						<span className="min-w-2 flex-1" />
						{isUnread ? <span className="sr-only">Unread.</span> : null}
						<time
							dateTime={thread.latest_received_at}
							title={formatFullDate(thread.latest_received_at)}
							className={cn(
								"shrink-0 text-label leading-5 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0",
								isUnread ? "font-semibold text-ink" : "text-text-muted",
							)}
						>
							{formatListDate(thread.latest_received_at)}
						</time>
					</div>
					<p
						className={cn(
							"m-0 line-clamp-2 text-body tracking-[-0.005em]",
							isUnread ? "text-text-secondary" : "text-text-muted",
						)}
					>
						<span className={cn(isUnread ? "font-semibold text-ink" : "text-text-secondary")}>
							{subject}
						</span>
						{thread.latest_snippet ? <span> · {thread.latest_snippet}</span> : null}
					</p>
					<div className="flex min-h-[26px] items-center gap-1.5 pt-1.5">
						{mailboxAddress ? <MailboxTag color={color}>{mailboxAddress}</MailboxTag> : null}
						{thread.latest_has_attachments === 1 ? (
							<Paperclip aria-label="Has attachments" className="size-3.5 shrink-0 text-icon" />
						) : null}
						<span className="flex-1" />
						{awaitingApproval ? <Pill tone="approval">Draft awaiting approval</Pill> : null}
					</div>
				</div>
			</Link>

			{onCheck ? (
				// biome-ignore lint/a11y/useSemanticElements: drawn over the avatar (Gmail); role and aria-checked carry the semantics.
				<button
					type="button"
					role="checkbox"
					aria-checked={checked}
					aria-label={`Select conversation: ${subject}`}
					data-row-check=""
					onClick={(event) => onCheck(event.shiftKey)}
					className={cn(
						"absolute top-4 left-[27px] flex size-8 items-center justify-center rounded-full outline-none transition-opacity focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-brand)_55%,transparent)]",
						showCheck
							? "opacity-100"
							: "opacity-0 focus-visible:opacity-100 pointer-fine:group-hover:opacity-100",
					)}
				>
					<span
						aria-hidden="true"
						className={cn(
							"flex size-[18px] items-center justify-center rounded-[5px] border-[1.5px]",
							checked ? "border-brand bg-brand text-white" : "border-[#9AA3B0] bg-panel",
						)}
					>
						{checked ? <Check className="size-3" strokeWidth={3} /> : null}
					</span>
				</button>
			) : null}

			<div className="pointer-events-none absolute top-3 right-3 flex items-center gap-0.5 rounded-control border border-border-card bg-panel opacity-0 shadow-card transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
				{isRestorable ? (
					<IconButton title="Move to inbox" size="sm" onClick={onRestore}>
						<ArchiveRestore />
					</IconButton>
				) : (
					<IconButton title="Archive" size="sm" onClick={onArchive}>
						<Archive />
					</IconButton>
				)}
				{state !== "trash" ? (
					<IconButton title="Delete" size="sm" onClick={onTrash}>
						<Trash2 />
					</IconButton>
				) : onDeleteForever ? (
					<IconButton
						title="Delete forever"
						size="sm"
						className="text-danger hover:text-danger"
						onClick={onDeleteForever}
					>
						<Trash2 />
					</IconButton>
				) : null}
				<IconButton
					title={isUnread ? "Mark as read" : "Mark as unread"}
					size="sm"
					onClick={onToggleRead}
				>
					{isUnread ? <MailOpen /> : <Mail />}
				</IconButton>
			</div>
		</li>
	);
}
