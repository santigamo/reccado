import { ArrowLeft, ExternalLink, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
import { Pill } from "#/components/ui/Pill";
import { approvalTitle, STATUS_COPY } from "#/lib/approval-copy";
import { formatListDate } from "#/lib/dates";
import { tint } from "#/lib/mailbox-color";
import { type PendingApproval, useApprovalOutcomes } from "#/lib/use-approvals";
import {
	ApprovalActionBar,
	ControlApprovalCard,
	OutcomeNotice,
	SendApprovalCard,
} from "./ApprovalSlot";
import { useInbox } from "./inbox-context";
import { ReadingPaneFrame, SelectConversation } from "./ReadingPane";

/**
 * `/inbox?folder=approvals&approval=<id>`: an approval with no thread to open
 * (a new message, or a control-plane change) shown on its own in the reading
 * pane, with the same card and action bar as a thread reply.
 */
export function ApprovalRequestPane({ approvalId }: { approvalId: string }) {
	const { approvals, decidedApprovals, approvalsLoading, colorOf, mailboxById, closeThread } =
		useInbox();
	const outcomes = useApprovalOutcomes();
	const live = approvals.find((a) => a.id === approvalId);
	// Keep the last pending snapshot on screen after a decision so the result reads in context.
	const [seen, setSeen] = useState<PendingApproval | undefined>(live);
	useEffect(() => {
		if (live) setSeen(live);
	}, [live]);
	const outcome = outcomes.find((o) => o.id === approvalId);
	const decided = decidedApprovals.find((a) => a.id === approvalId);
	// Once it is no longer pending, the kept snapshot carries the decided status, not "awaiting".
	const approval =
		live ??
		(seen
			? {
					...seen,
					status:
						outcome && outcome.status !== "pending"
							? outcome.status
							: (decided?.status ?? "expired"),
				}
			: undefined);

	if (!approval) {
		if (approvalsLoading) return <SelectConversation />;
		const status = decided?.status ?? "expired";
		const copy = STATUS_COPY[status];
		return (
			<ReadingPaneFrame>
				<div className="flex h-12 shrink-0 items-center border-b border-[#EFEFEF] pl-2 min-[720px]:hidden">
					<IconButton title="Back to list" onClick={closeThread}>
						<ArrowLeft />
					</IconButton>
				</div>
				<EmptyState icon={<ShieldCheck />} title={copy.title} hint={copy.detail} />
			</ReadingPaneFrame>
		);
	}

	const send = approval.send;
	const color = approval.mailboxId ? colorOf(approval.mailboxId) : null;
	const mailbox = approval.mailboxId ? mailboxById(approval.mailboxId) : undefined;
	const title = send ? send.subject || "(no subject)" : approvalTitle(approval);

	return (
		<ReadingPaneFrame>
			<div className="flex h-12 shrink-0 items-center gap-1 border-b border-[#EFEFEF] pr-[18px] pl-2 sm:pl-4">
				<IconButton title="Back to list" className="min-[720px]:hidden" onClick={closeThread}>
					<ArrowLeft />
				</IconButton>
				<div className="flex-1" />
				<a
					href={approval.approveUrl}
					className="inline-flex items-center gap-1.5 rounded-control px-2 py-1 text-label text-text-muted no-underline hover:bg-hover hover:text-text"
				>
					Open request page
					<ExternalLink aria-hidden="true" className="size-3.5" />
				</a>
			</div>
			<div className="app-scroll min-h-0 flex-1 overflow-y-auto">
				<header
					className="flex flex-col gap-2 border-b px-4 pt-5 pb-[18px] sm:px-7"
					style={
						color
							? { backgroundColor: tint(color, 7), borderBottomColor: tint(color, 16) }
							: {
									backgroundColor: "var(--color-content)",
									borderBottomColor: "var(--color-border-card)",
								}
					}
				>
					<h2 className="m-0 text-title font-semibold tracking-[-0.015em] text-[#1F1F1F]">
						{title}
					</h2>
					<div className="flex flex-wrap items-center gap-2">
						{color ? (
							<Pill mailbox={color} dot size="md">
								{mailbox?.primary_address ?? approval.mailboxId}
							</Pill>
						) : null}
						<span className="text-label text-text-muted">
							{send ? "New message" : "Change request"} · requested{" "}
							{formatListDate(approval.createdAt)}
						</span>
					</div>
				</header>
				<div className="px-5 py-5">
					{send ? (
						<SendApprovalCard approval={approval} />
					) : (
						<ControlApprovalCard approval={approval} />
					)}
				</div>
			</div>
			{live ? (
				<ApprovalActionBar key={live.id} approval={live} />
			) : outcome ? (
				<OutcomeNotice outcome={outcome} />
			) : (
				<div className="shrink-0 border-t border-[#ECECEC] px-5 py-4 text-label text-text-muted">
					{STATUS_COPY[decided?.status ?? "expired"].title}
				</div>
			)}
		</ReadingPaneFrame>
	);
}
