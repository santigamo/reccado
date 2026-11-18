import { AlertTriangle, Check, ExternalLink, Lock, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { EmailHtmlBody } from "#/components/mail/MessageItem";
import { BrandMark } from "#/components/shell/AppShell";
import { Button, buttonClassName } from "#/components/ui/Button";
import { StatusDot } from "#/components/ui/StatusDot";
import { useToast } from "#/components/ui/Toast";
import {
	approvalTitle,
	errorText,
	fieldLabel,
	fieldValue,
	formatCountdown,
	requester,
	STATUS_COPY,
	warningText,
} from "#/lib/approval-copy";
import { cn } from "#/lib/cn";
import {
	type ApprovalField,
	type ApprovalOutcome,
	type ApprovalWarning,
	approveApproval,
	denyApproval,
	dismissOutcome,
	type PendingApproval,
	TakeOverError,
	takeOverAsOwnDraft,
	useApprovalOutcomes,
	useNow,
} from "#/lib/use-approvals";
import { useInbox } from "./inbox-context";

// --------------------------------------------------------------------------
// Card: what the owner is approving, exactly as frozen.
// --------------------------------------------------------------------------

/** "Expires in 6:15", ticking. */
function Countdown({ expiresAt }: { expiresAt: string }) {
	const now = useNow(1000);
	return (
		<span className="tabular-nums">
			Expires in <span className="font-semibold">{formatCountdown(expiresAt, now)}</span>
		</span>
	);
}

function CardHeader({ approval, children }: { approval: PendingApproval; children: ReactNode }) {
	const pending = approval.status === "pending";
	return (
		<div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-approval-border bg-approval-surface px-3.5 py-2">
			<BrandMark className="h-[22px] w-[22px] rounded-[6px] [&_svg]:size-3" />
			<span className="text-body font-medium tracking-[-0.01em] text-text">{children}</span>
			<span className="flex-1" />
			<span
				className={cn(
					"inline-flex items-center gap-2 text-label font-medium",
					pending ? "text-approval" : "text-text-muted",
				)}
			>
				<StatusDot tone={pending ? "approval" : "muted"} />
				{STATUS_COPY[approval.status].label}
				{pending ? (
					<>
						<span aria-hidden="true">·</span>
						<Countdown expiresAt={approval.expiresAt} />
					</>
				) : null}
			</span>
		</div>
	);
}

function Warnings({ warnings }: { warnings: ApprovalWarning[] }) {
	if (warnings.length === 0) return null;
	return (
		<ul className="m-0 flex list-none flex-col gap-1.5 border-b border-[#F1F1F1] bg-approval-surface/60 px-[18px] py-3">
			{warnings.map((warning) => (
				<li
					key={`${warning.code}:${warning.address ?? ""}:${warning.message}`}
					className="flex items-start gap-2 text-label text-text"
				>
					<AlertTriangle aria-hidden="true" className="mt-px size-[15px] shrink-0 text-approval" />
					<span>{warningText(warning)}</span>
				</li>
			))}
		</ul>
	);
}

function MetaRow({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-baseline gap-2.5">
			<span className="w-14 shrink-0 text-label text-text-muted">{label}</span>
			<span className="min-w-0 break-words text-label text-text">{children}</span>
		</div>
	);
}

/** The amber "Reply drafted by the agent" card for one send request. */
export function SendApprovalCard({ approval }: { approval: PendingApproval }) {
	const send = approval.send;
	const fields = new Map(approval.fields.map((f) => [f.label, f.value]));
	const html = fields.get("HTML");
	const replyTo = fields.get("Reply-To");
	const from = fields.get("De") ?? send?.from ?? "";
	return (
		<article
			aria-label={`${approval.threadId ? "Reply" : "Message"} awaiting your approval`}
			className="flex flex-col overflow-hidden rounded-card border border-approval-border bg-panel shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
		>
			<CardHeader approval={approval}>
				{approval.threadId ? "Reply" : "Message"} drafted by{" "}
				{requester(approval).replace(/^The /, "the ")}
			</CardHeader>
			{send ? (
				<>
					<div className="flex flex-col gap-1 border-b border-[#F1F1F1] px-[18px] pt-3.5 pb-3">
						<MetaRow label="From">{from}</MetaRow>
						{replyTo ? <MetaRow label="Reply-To">{replyTo}</MetaRow> : null}
						<MetaRow label="To">{send.to.join(", ") || "(no recipients)"}</MetaRow>
						{send.cc.length ? <MetaRow label="Cc">{send.cc.join(", ")}</MetaRow> : null}
						{send.bcc.length ? <MetaRow label="Bcc">{send.bcc.join(", ")}</MetaRow> : null}
						<MetaRow label="Subject">{send.subject || "(no subject)"}</MetaRow>
						{send.attachments > 0 ? (
							<MetaRow label="Files">
								{send.attachments === 1 ? "1 attachment" : `${send.attachments} attachments`}
							</MetaRow>
						) : null}
					</div>
					<Warnings warnings={approval.warnings} />
					<div className="px-[18px] pt-3.5 pb-4">
						{html && approval.payloadHash ? (
							<>
								<p className="m-0 mb-2 text-meta font-medium text-text-muted">
									Formatted version · as it will be sent, link targets in brackets
								</p>
								<EmailHtmlBody
									src={`/api/approvals/${encodeURIComponent(approval.id)}/html?hash=${encodeURIComponent(approval.payloadHash)}`}
									title="Formatted version of the message"
									foldQuote={false}
									fallback={
										<p className="m-0 text-label text-text-muted">
											The formatted version could not be shown. Its source is below.
										</p>
									}
								/>
								<p className="m-0 mt-3.5 mb-2 text-meta font-medium text-text-muted">
									Plain-text version
								</p>
							</>
						) : null}
						<p className="m-0 whitespace-pre-wrap break-words text-body leading-[22px] tracking-[-0.005em] text-text">
							{send.text || <span className="text-text-muted">(no text body)</span>}
						</p>
						{html ? (
							<details className="mt-3 text-label text-text-muted">
								<summary className="cursor-pointer select-none">HTML source</summary>
								<pre className="mt-2 max-h-80 overflow-auto rounded-control bg-content p-2 font-mono text-meta whitespace-pre-wrap break-words text-text">
									{html}
								</pre>
							</details>
						) : null}
					</div>
				</>
			) : (
				<p className="m-0 px-[18px] py-4 text-label text-text-muted">
					The frozen message could not be read. Open the request page to review it.
				</p>
			)}
		</article>
	);
}

function FieldValue({ field }: { field: ApprovalField }) {
	const value = fieldValue(field);
	if (field.format === "pre") {
		return (
			<pre className="m-0 max-h-80 overflow-auto font-mono text-meta whitespace-pre-wrap break-words text-text">
				{value}
			</pre>
		);
	}
	if (field.format === "list") {
		return (
			<ul className="m-0 list-disc pl-4">
				{value.split("\n").map((item, i) => (
					<li // biome-ignore lint/suspicious/noArrayIndexKey: frozen list, repeated items must all show
						key={`${i}:${item}`}
						className="break-all"
					>
						{item}
					</li>
				))}
			</ul>
		);
	}
	return <span className="whitespace-pre-wrap break-words">{value}</span>;
}

/** A control-plane request (create an API key, add a domain, …): frozen fields + warnings. */
export function ControlApprovalCard({ approval }: { approval: PendingApproval }) {
	return (
		<article
			aria-label={`${approvalTitle(approval)} awaiting your approval`}
			className="flex flex-col overflow-hidden rounded-card border border-approval-border bg-panel shadow-[0_2px_8px_rgba(0,0,0,0.04)]"
		>
			<CardHeader approval={approval}>
				Requested by {requester(approval).replace(/^The /, "the ")}
			</CardHeader>
			{approval.fields.length > 0 ? (
				<dl className="m-0 divide-y divide-[#F1F1F1]">
					{approval.fields.map((field) => (
						<div
							key={`${field.label}:${field.value}`}
							className="flex gap-4 px-[18px] py-2.5 max-sm:flex-col max-sm:gap-0.5"
						>
							<dt className="w-40 shrink-0 text-label text-text-muted">
								{fieldLabel(field.label)}
							</dt>
							<dd className="m-0 min-w-0 flex-1 text-label text-text">
								<FieldValue field={field} />
							</dd>
						</div>
					))}
				</dl>
			) : (
				<p className="m-0 px-[18px] py-4 text-label text-text-muted">
					{approval.status === "stale"
						? STATUS_COPY.stale.detail
						: "Nothing to show for this request. Open the request page to review it."}
				</p>
			)}
			{approval.warnings.length > 0 ? (
				<div className="border-t border-[#F1F1F1]">
					<Warnings warnings={approval.warnings} />
				</div>
			) : null}
			{approval.revealsSecret ? (
				<p className="m-0 border-t border-[#F1F1F1] px-[18px] py-3 text-label text-text-muted">
					Approving creates a secret that is shown to you once, on the request page, and never to
					the agent.
				</p>
			) : null}
		</article>
	);
}

/**
 * Cards for the pending approvals of the open thread, rendered under its
 * messages (Paper "Inbox — Desktop").
 */
export function ApprovalCardSlot({
	approvals,
}: {
	mailboxId: string;
	threadId: string;
	approvals: PendingApproval[];
}) {
	if (approvals.length === 0) return null;
	return (
		<div className="flex flex-col gap-4">
			{approvals.map((approval) => (
				<SendApprovalCard key={approval.id} approval={approval} />
			))}
		</div>
	);
}

// --------------------------------------------------------------------------
// Sticky action bar.
// --------------------------------------------------------------------------

function OutcomeNotice({ outcome }: { outcome: ApprovalOutcome }) {
	const copy = STATUS_COPY[outcome.status];
	const failed = outcome.error && outcome.status !== "sent" && outcome.status !== "executed";
	const good = outcome.status === "sent" || outcome.status === "executed";
	return (
		<div
			role="status"
			className="flex min-h-16 shrink-0 items-center gap-3 border-t border-[#ECECEC] bg-panel py-3 pr-4 pl-5 shadow-sticky"
		>
			<span
				className={cn(
					"inline-flex size-6 shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5",
					good
						? "bg-[color-mix(in_srgb,var(--color-success)_14%,white)] text-success"
						: "bg-pill text-icon",
				)}
			>
				{good ? <Check /> : failed ? <AlertTriangle /> : <X />}
			</span>
			<div className="min-w-0 flex-1">
				<p className="m-0 text-body font-medium text-text">
					{outcome.alreadyDecided ? `Already decided: ${copy.label.toLowerCase()}` : copy.title}
				</p>
				<p className="m-0 text-label text-text-muted">
					{failed && outcome.status !== "expired" && outcome.status !== "stale"
						? errorText(outcome.error)
						: copy.detail}
				</p>
			</div>
			<Button variant="ghost" size="sm" onClick={() => dismissOutcome(outcome.id)}>
				Dismiss
			</Button>
		</div>
	);
}

/**
 * Approve & send / Edit / Discard, plus "Only you can send this". Decides only
 * through `POST /api/approvals/:id/approve|deny` with the owner's session and
 * the frozen hash. Secret-revealing kinds go to `/approve/:id` instead.
 */
export function ApprovalActionBar({ approval }: { approval: PendingApproval }) {
	const { refresh, openCompose } = useInbox();
	const toast = useToast();
	const [busy, setBusy] = useState<null | "approve" | "deny" | "edit">(null);
	const [confirm, setConfirm] = useState<null | "deny" | "edit">(null);
	const [error, setError] = useState<string | null>(null);
	const isSend = approval.kind === "send";
	const stale = approval.status === "stale";
	const canApproveHere = !stale && !approval.revealsSecret && Boolean(approval.payloadHash);

	async function run(action: "approve" | "deny" | "edit") {
		setBusy(action);
		setError(null);
		try {
			if (action === "approve") {
				const outcome = await approveApproval(approval);
				if (outcome.error && outcome.status === "pending") setError(errorText(outcome.error));
			} else if (action === "deny") {
				await denyApproval(approval);
			} else {
				const copy = await takeOverAsOwnDraft(approval);
				openCompose({ from: copy.mailboxId, draftId: copy.draftId });
				if (copy.attachmentsLeftOut > 0) {
					toast.show({
						message: `The agent's ${copy.attachmentsLeftOut === 1 ? "attachment was" : `${copy.attachmentsLeftOut} attachments were`} not copied. Attach ${copy.attachmentsLeftOut === 1 ? "it" : "them"} again if you need ${copy.attachmentsLeftOut === 1 ? "it" : "them"}.`,
					});
				}
			}
		} catch (err) {
			if (action === "edit") {
				// Said in a toast too: once the request is discarded this bar leaves
				// with it, and the inline message would go unseen.
				const message =
					err instanceof TakeOverError
						? err.ownerMessage
						: "Could not open a copy to edit. Nothing was changed. Try again.";
				setError(message);
				toast.show({ tone: "danger", message });
			} else {
				setError("Nothing was done: the request could not be reached. Try again.");
			}
		} finally {
			setBusy(null);
			setConfirm(null);
			refresh();
		}
	}

	const lockNote = isSend ? "Only you can send this" : "Only you can approve this";

	return (
		<div className="flex shrink-0 flex-col border-t border-[#ECECEC] bg-panel shadow-sticky">
			{error ? (
				<p role="alert" className="m-0 px-5 pt-2.5 text-label text-danger">
					{error}
				</p>
			) : null}
			{confirm ? (
				<div className="flex min-h-16 flex-wrap items-center gap-2 py-3 pr-6 pl-5">
					<p className="m-0 min-w-0 flex-1 text-label text-text">
						{confirm === "deny"
							? isSend
								? "Discard this request? Nothing is sent and the agent sees it as denied."
								: "Deny this request? Nothing changes and the agent sees it as denied."
							: "Edit discards the agent's request and opens a copy as your own draft. You send it yourself from there."}
					</p>
					<Button
						variant={confirm === "deny" ? "danger" : "primary"}
						disabled={busy !== null}
						onClick={() => void run(confirm)}
					>
						{confirm === "deny" ? (isSend ? "Discard" : "Deny") : "Edit as my draft"}
					</Button>
					<Button variant="ghost" disabled={busy !== null} onClick={() => setConfirm(null)}>
						Keep it
					</Button>
				</div>
			) : (
				<div className="flex min-h-16 flex-wrap items-center gap-2 py-3 pr-6 pl-5">
					{canApproveHere ? (
						<Button variant="primary" disabled={busy !== null} onClick={() => void run("approve")}>
							<Check aria-hidden="true" />
							{busy === "approve"
								? isSend
									? "Sending…"
									: "Applying…"
								: isSend
									? "Approve & send"
									: "Approve"}
						</Button>
					) : approval.revealsSecret && !stale ? (
						<a href={approval.approveUrl} className={buttonClassName("primary")}>
							Review &amp; approve
							<ExternalLink aria-hidden="true" />
						</a>
					) : null}
					{isSend && !stale && approval.send ? (
						<Button variant="secondary" disabled={busy !== null} onClick={() => setConfirm("edit")}>
							Edit
						</Button>
					) : null}
					<Button variant="ghost" disabled={busy !== null} onClick={() => setConfirm("deny")}>
						{isSend ? "Discard" : "Deny"}
					</Button>
					<span className="min-w-2 flex-1" />
					<span className="inline-flex items-center gap-1.5 text-label text-text-muted">
						<Lock aria-hidden="true" className="size-[15px]" />
						{stale ? STATUS_COPY.stale.label : lockNote}
					</span>
				</div>
			)}
		</div>
	);
}

/**
 * Bottom of the reading pane for an open thread: the action bar for its oldest
 * pending approval, or the result of the last decision taken here.
 */
export function ApprovalActionBarSlot({
	mailboxId,
	threadId,
	approvals,
}: {
	mailboxId: string;
	threadId: string;
	approvals: PendingApproval[];
}) {
	const outcomes = useApprovalOutcomes();
	const first = approvals[0];
	if (first) return <ApprovalActionBar key={first.id} approval={first} />;
	const last = outcomes.find((o) => o.mailboxId === mailboxId && o.threadId === threadId);
	return last ? <OutcomeNotice outcome={last} /> : null;
}

export { OutcomeNotice };
