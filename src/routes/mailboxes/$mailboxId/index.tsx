import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Inbox, Trash2 } from "lucide-react";
import type { ReactElement } from "react";
import { useMemo } from "react";
import { ThreadListItem } from "#/components/mail/ThreadListItem";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
import type { Draft, ThreadRow } from "#/lib/mail";
import { cancelDraft, folderByKey, formatMailDate, moveThread, parseAddressList } from "#/lib/mail";
import { useDrafts, useThreads } from "#/lib/use-mail";

export const Route = createFileRoute("/mailboxes/$mailboxId/")({
	component: MailboxThreadListPage,
});

function MailboxThreadListPage(): ReactElement {
	const { mailboxId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const folder = folderByKey(search.folder);

	// Both hooks are called unconditionally (Rules of Hooks) — only the one
	// matching the active folder's `kind` is actually rendered from below.
	const q = search.q?.trim();
	const threads = useThreads(mailboxId, folder, folder.kind === "threads" ? q : undefined);
	const drafts = useDrafts(mailboxId);

	const filteredDrafts = useMemo(() => {
		if (!q) return drafts.data;
		const needle = q.toLowerCase();
		return drafts.data.filter((d) =>
			`${parseAddressList(d.to_json).join(" ")} ${d.subject ?? ""} ${d.body_text ?? ""}`
				.toLowerCase()
				.includes(needle),
		);
	}, [drafts.data, q]);

	function openThread(threadId: string) {
		navigate({
			to: "/mailboxes/$mailboxId/$threadId",
			params: { mailboxId, threadId },
			search: (prev) => ({ folder: prev.folder, q: prev.q }),
		});
	}

	function openDraft(draft: Draft) {
		navigate({
			search: (prev) => ({
				...prev,
				compose: true,
				draftId: draft.id,
				to: undefined,
				subject: undefined,
				threadId: undefined,
			}),
		});
	}

	async function handleArchive(thread: ThreadRow) {
		await moveThread(mailboxId, thread.id, "archive");
		threads.refetch();
	}

	async function handleTrash(thread: ThreadRow) {
		const restoring = folder.state === "archive" || folder.state === "trash";
		await moveThread(mailboxId, thread.id, restoring ? "restore_inbox" : "trash");
		threads.refetch();
	}

	async function handleToggleRead(thread: ThreadRow) {
		await moveThread(
			mailboxId,
			thread.id,
			thread.latest_is_read === 0 ? "mark_read" : "mark_unread",
		);
		threads.refetch();
	}

	async function handleDiscardDraft(draft: Draft) {
		await cancelDraft(mailboxId, draft.id);
		drafts.refetch();
	}

	if (folder.kind === "drafts") {
		if (drafts.loading) return <CenteredSpinner />;
		if (drafts.error) return <ErrorState message={drafts.error} onRetry={drafts.refetch} />;
		if (filteredDrafts.length === 0) {
			return (
				<EmptyState
					icon={<Inbox className="h-10 w-10" />}
					title={q ? "No matching drafts" : `No ${folder.label.toLowerCase()} messages`}
				/>
			);
		}
		return (
			<div className="h-full overflow-y-auto app-scroll">
				{filteredDrafts.map((d) => {
					const recipients = parseAddressList(d.to_json).join(", ") || "(no recipients)";
					return (
						<div
							key={d.id}
							className="group flex h-12 w-full min-w-0 items-center border-b border-[var(--app-border)] transition-colors hover:bg-[var(--app-hover)]"
						>
							{/* Real <button> for the open portion; the discard icon is a sibling
							    button so it never nests inside another button (invalid HTML). */}
							<button
								type="button"
								onClick={() => openDraft(d)}
								className="flex h-full min-w-0 flex-1 items-center gap-3 px-4 text-left text-sm outline-none"
							>
								<span className="w-44 shrink-0 truncate text-[var(--app-text-soft)]">
									{recipients}
								</span>
								<span className="min-w-0 flex-1 truncate text-[var(--app-text)]">
									{d.subject ?? "(no subject)"}
								</span>
								<span className="shrink-0 rounded-full bg-[var(--app-danger)] px-2 py-0.5 text-[11px] font-medium text-white">
									Draft
								</span>
								<span className="w-16 shrink-0 text-right text-xs text-[var(--app-text-faint)]">
									{formatMailDate(d.updated_at)}
								</span>
							</button>
							<IconButton
								title="Discard draft"
								size="sm"
								className="mr-4"
								onClick={(event) => {
									event.stopPropagation();
									void handleDiscardDraft(d);
								}}
							>
								<Trash2 className="h-4 w-4" />
							</IconButton>
						</div>
					);
				})}
			</div>
		);
	}

	if (threads.loading) return <CenteredSpinner />;
	if (threads.error) return <ErrorState message={threads.error} onRetry={threads.refetch} />;
	if (threads.data.length === 0) {
		return (
			<EmptyState
				icon={<Inbox className="h-10 w-10" />}
				title={q ? "No matching messages" : `No ${folder.label.toLowerCase()} messages`}
			/>
		);
	}

	return (
		<div className="h-full overflow-y-auto app-scroll">
			{threads.data.map((thread) => (
				<ThreadListItem
					key={thread.id}
					thread={thread}
					folder={folder}
					onOpen={() => openThread(thread.id)}
					onArchive={() => void handleArchive(thread)}
					onTrash={() => void handleTrash(thread)}
					onToggleRead={() => void handleToggleRead(thread)}
				/>
			))}
		</div>
	);
}
