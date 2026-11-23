import { Paperclip, PenLine, Trash2 } from "lucide-react";
import { IconButton } from "#/components/ui/IconButton";
import { Pill } from "#/components/ui/Pill";
import { formatDayTime, formatFullDate } from "#/lib/dates";
import { type Draft, parseAddressList } from "#/lib/mail";
import { stripQuotedText } from "#/lib/quoted-text";

/**
 * A draft of this conversation, inline at the bottom of the thread (Gmail): who
 * it is to, the start of what you wrote, and when you last touched it. Opening it
 * resumes editing in the compose dialog; the reply button does the same, so a
 * conversation never grows a second reply draft.
 */
export function ThreadDraftRow({
	draft,
	onOpen,
	onDiscard,
}: {
	draft: Draft;
	onOpen: () => void;
	onDiscard: () => void;
}) {
	const to = parseAddressList(draft.to_json);
	const preview = stripQuotedText(draft.body_text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	const byAgent = draft.origin === "mcp";
	const files = draft.attachment_count ?? draft.attachments?.length ?? 0;
	return (
		<div className="flex items-start gap-3 border-b border-[#F1F1F1] px-4 py-3.5 sm:px-7">
			<span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-pill text-text-secondary [&_svg]:size-3.5 sm:size-8">
				<PenLine aria-hidden="true" />
			</span>
			<button
				type="button"
				onClick={onOpen}
				className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-control text-left outline-none focus-visible:ring-2 focus-visible:ring-text-muted"
			>
				<span className="flex min-w-0 items-center gap-1.5">
					<span className="shrink-0 text-label font-semibold text-danger">Draft</span>
					<span className="min-w-0 truncate text-label text-text-muted">
						to {to.join(", ") || "(no recipients)"}
					</span>
					{byAgent ? <Pill tone="neutral">Written by the agent</Pill> : null}
					{draft.status === "pending_confirmation" && !byAgent ? (
						// An agent draft only reaches this row once no approval request is
						// live for it (a live one is drawn as the approval card instead):
						// it is then an ordinary draft the owner can open and send.
						<Pill tone="approval">Sending</Pill>
					) : null}
					{files > 0 ? (
						<Paperclip
							aria-label={files === 1 ? "1 attachment" : `${files} attachments`}
							className="size-3.5 shrink-0 text-icon"
						/>
					) : null}
					<span className="min-w-2 flex-1" />
					<time
						dateTime={draft.updated_at}
						title={formatFullDate(draft.updated_at)}
						className="shrink-0 text-label text-text-muted"
					>
						{formatDayTime(draft.updated_at)}
					</time>
				</span>
				<span className="line-clamp-2 text-body text-text-secondary">
					{preview || <span className="italic text-text-muted">(empty)</span>}
				</span>
			</button>
			<IconButton title="Discard draft" size="sm" onClick={onDiscard}>
				<Trash2 />
			</IconButton>
		</div>
	);
}
