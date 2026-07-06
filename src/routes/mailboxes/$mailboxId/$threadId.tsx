import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Archive, ArrowLeft, Mail, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";
import { MessageItem } from "#/components/mail/MessageItem";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
import { extractEmail, type Message, moveThread, runMessageAction } from "#/lib/mail";
import { useThread } from "#/lib/use-mail";

export const Route = createFileRoute("/mailboxes/$mailboxId/$threadId")({
	component: ThreadPage,
});

/** Reply targets the last inbound message; falls back to the latest message if the whole thread is outbound. */
function findReplyTarget(messages: Message[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m && m.direction === "inbound") return m;
	}
	return messages.at(-1);
}

function ThreadPage() {
	const { mailboxId, threadId } = Route.useParams();
	const navigate = useNavigate({ from: Route.fullPath });
	const { data, loading, error, refetch } = useThread(mailboxId, threadId);

	// Opening a thread clears its unread state, like Gmail. Guarded by the set
	// of message ids so it only fires once per loaded set, not on every render.
	const markedKeyRef = useRef<string>("");
	useEffect(() => {
		if (!data) return;
		const key = data.messages.map((m) => m.id).join(",");
		if (markedKeyRef.current === key) return;
		markedKeyRef.current = key;
		for (const m of data.messages) {
			if (m.is_read === 0) {
				void runMessageAction(mailboxId, m.id, "mark_read");
			}
		}
	}, [data, mailboxId]);

	const backToList = () =>
		navigate({
			to: "/mailboxes/$mailboxId",
			params: { mailboxId },
			search: (prev) => ({ folder: prev.folder }),
		});

	async function handleArchive() {
		await moveThread(mailboxId, threadId, "archive");
		backToList();
	}

	async function handleTrash() {
		await moveThread(mailboxId, threadId, "trash");
		backToList();
	}

	async function handleMarkUnread() {
		await moveThread(mailboxId, threadId, "mark_unread");
		refetch();
	}

	function openCompose(prefill: { to?: string; subject: string }) {
		navigate({
			search: (prev) => ({ ...prev, compose: true, threadId, ...prefill }),
		});
	}

	function handleReply() {
		const messages = data?.messages ?? [];
		const target = findReplyTarget(messages);
		const subject = target?.subject ?? "";
		const subjectWithRe = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
		openCompose({ to: extractEmail(target?.from_addr), subject: subjectWithRe });
	}

	function handleForward() {
		const messages = data?.messages ?? [];
		const target = messages.at(-1);
		const subject = target?.subject ?? "";
		openCompose({ to: undefined, subject: `Fwd: ${subject}` });
	}

	if (loading) return <CenteredSpinner />;
	if (error) return <ErrorState message={error} onRetry={refetch} />;
	if (data && data.messages.length === 0) {
		return <EmptyState title="No messages in this thread" />;
	}

	const messages = data?.messages ?? [];
	const subject = messages[0]?.subject ?? "(no subject)";

	return (
		<div className="flex h-full flex-col">
			<header className="glass-thin sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b border-[var(--app-border)] px-4">
				<IconButton title="Back to inbox" className="lg:hidden" onClick={backToList}>
					<ArrowLeft className="h-5 w-5" />
				</IconButton>
				<h1 className="min-w-0 flex-1 truncate text-base font-medium text-[var(--app-text)]">
					{subject}
				</h1>
				<div className="flex shrink-0 items-center gap-1">
					<IconButton title="Archive" onClick={handleArchive}>
						<Archive className="h-5 w-5" />
					</IconButton>
					<IconButton title="Delete" onClick={handleTrash}>
						<Trash2 className="h-5 w-5" />
					</IconButton>
					<IconButton title="Mark unread" onClick={handleMarkUnread}>
						<Mail className="h-5 w-5" />
					</IconButton>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto app-scroll bg-[var(--app-surface)]">
				<div className="mx-auto max-w-3xl px-4 py-4">
					{messages.map((message, i) => (
						<MessageItem
							key={message.id}
							message={message}
							mailboxId={mailboxId}
							defaultOpen={i === messages.length - 1}
							onReply={handleReply}
							onForward={handleForward}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
