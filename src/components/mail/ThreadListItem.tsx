import { Archive, ArchiveRestore, Mail, MailOpen, Paperclip, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { Avatar } from "#/components/ui/Avatar";
import { IconButton } from "#/components/ui/IconButton";
import { cn } from "#/lib/cn";
import type { Folder, ThreadRow } from "#/lib/mail";
import { displayName, formatMailDate } from "#/lib/mail";

/**
 * Single dense Gmail-style thread row. Hovering (or focusing, for keyboard
 * users) swaps the trailing timestamp for row actions — archive/trash (or a
 * single "restore" when already in the archive/trash folder) plus a
 * read/unread toggle. The whole row opens the conversation; action buttons
 * stop propagation so they don't also trigger that.
 */
export function ThreadListItem({
	thread,
	folder,
	onOpen,
	onArchive,
	onTrash,
	onToggleRead,
}: {
	thread: ThreadRow;
	folder: Folder;
	onOpen: () => void;
	onArchive: () => void;
	onTrash: () => void;
	onToggleRead: () => void;
}): ReactElement {
	const isUnread = thread.latest_is_read === 0;
	const isRestoreFolder = folder.state === "archive" || folder.state === "trash";
	const subject = thread.latest_subject ?? thread.subject_norm ?? "(no subject)";
	const snippet = thread.latest_snippet;

	return (
		<div
			className={cn(
				"group flex h-12 w-full min-w-0 items-center border-b border-[var(--app-border)] transition-colors hover:bg-[var(--app-hover)]",
				isUnread ? "bg-[var(--app-surface)]" : "bg-transparent",
			)}
		>
			{/*
			 * A real <button> covers the open-conversation portion of the row (native
			 * keyboard support for free, no custom key handling needed). The trailing
			 * timestamp/actions column is a sibling — not a child — so its own
			 * <button> action icons never nest inside another button (invalid HTML).
			 */}
			<button
				type="button"
				onClick={onOpen}
				aria-label={`Conversation with ${displayName(thread.latest_from)}: ${subject}`}
				className="flex h-full min-w-0 flex-1 items-center gap-3 px-4 text-left text-sm outline-none"
			>
				<span
					aria-hidden="true"
					className={cn(
						"h-2 w-2 shrink-0 rounded-full",
						isUnread ? "bg-[var(--app-accent)]" : "bg-transparent",
					)}
				/>

				<Avatar from={thread.latest_from} size="sm" />

				<span
					className={cn(
						"w-44 shrink-0 truncate",
						isUnread ? "font-semibold text-[var(--app-text)]" : "text-[var(--app-text-soft)]",
					)}
				>
					{displayName(thread.latest_from)}
				</span>

				<span className="min-w-0 flex-1 truncate">
					<span
						className={cn(
							isUnread ? "font-semibold text-[var(--app-text)]" : "text-[var(--app-text-soft)]",
						)}
					>
						{subject}
					</span>
					{snippet ? <span className="text-[var(--app-text-faint)]"> — {snippet}</span> : null}
				</span>

				{thread.latest_has_attachments === 1 ? (
					<Paperclip className="h-4 w-4 shrink-0 text-[var(--app-text-faint)]" aria-hidden="true" />
				) : null}
			</button>

			<div className="relative mr-4 ml-2 h-8 w-28 shrink-0">
				<span
					className={cn(
						"absolute inset-y-0 right-0 flex items-center text-xs transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
						isUnread ? "font-semibold text-[var(--app-text)]" : "text-[var(--app-text-faint)]",
					)}
				>
					{formatMailDate(thread.latest_received_at)}
				</span>

				<div className="pointer-events-none absolute inset-y-0 right-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
					{isRestoreFolder ? (
						<IconButton
							title="Move to inbox"
							size="sm"
							onClick={(event) => {
								event.stopPropagation();
								onTrash();
							}}
						>
							<ArchiveRestore className="h-4 w-4" />
						</IconButton>
					) : (
						<>
							<IconButton
								title="Archive"
								size="sm"
								onClick={(event) => {
									event.stopPropagation();
									onArchive();
								}}
							>
								<Archive className="h-4 w-4" />
							</IconButton>
							<IconButton
								title="Delete"
								size="sm"
								onClick={(event) => {
									event.stopPropagation();
									onTrash();
								}}
							>
								<Trash2 className="h-4 w-4" />
							</IconButton>
						</>
					)}
					<IconButton
						title={isUnread ? "Mark as read" : "Mark as unread"}
						size="sm"
						onClick={(event) => {
							event.stopPropagation();
							onToggleRead();
						}}
					>
						{isUnread ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
					</IconButton>
				</div>
			</div>
		</div>
	);
}
