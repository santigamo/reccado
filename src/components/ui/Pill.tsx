import type { ReactNode } from "react";
import { cn } from "#/lib/cn";
import { type MailboxColor, shade, tint } from "#/lib/mailbox-color";
import { StatusDot } from "./StatusDot";

export type PillTone = "neutral" | "approval" | "success" | "danger" | "outline";

const TONES: Record<PillTone, string> = {
	neutral: "bg-pill text-text-secondary",
	outline: "border border-border bg-panel text-text",
	approval: "border border-approval-border bg-approval-surface text-approval",
	success:
		"bg-[color-mix(in_srgb,var(--color-success)_12%,transparent)] text-[color-mix(in_srgb,var(--color-success)_75%,black)]",
	danger:
		"bg-[color-mix(in_srgb,var(--color-danger)_10%,transparent)] text-[color-mix(in_srgb,var(--color-danger)_85%,black)]",
};

/**
 * Small rounded label ("Draft awaiting approval", "Sent", "Verified"…).
 * Pass `mailbox` to get the mailbox chip from the reading-pane header: a
 * 16% tint of the mailbox colour with a dot and darker text.
 */
export function Pill({
	children,
	tone = "neutral",
	mailbox,
	dot,
	size = "sm",
	className,
	title,
}: {
	children: ReactNode;
	tone?: PillTone;
	mailbox?: MailboxColor;
	/** Show a leading dot (mailbox colour when `mailbox` is set, else currentColor). */
	dot?: boolean;
	size?: "sm" | "md";
	className?: string;
	title?: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				"inline-flex max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill font-medium",
				size === "sm" ? "h-5 px-2 text-meta" : "h-6 pr-2.5 pl-[9px] text-meta",
				mailbox ? null : TONES[tone],
				className,
			)}
			style={mailbox ? { backgroundColor: tint(mailbox, 16), color: shade(mailbox) } : undefined}
		>
			{dot ? <StatusDot color={mailbox ? mailbox.css : "currentColor"} /> : null}
			<span className="truncate">{children}</span>
		</span>
	);
}

/**
 * Mailbox chip as drawn in the thread list: coloured dot + muted address, no
 * background.
 */
export function MailboxTag({
	color,
	children,
	className,
}: {
	color: MailboxColor;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 items-center gap-1.5 text-meta text-text-muted",
				className,
			)}
		>
			<StatusDot color={color.css} />
			<span className="truncate">{children}</span>
		</span>
	);
}

/** Numeric badge next to a tab label. `approval` is the amber one (Approvals tab). */
export function CountBadge({
	count,
	tone = "plain",
	className,
}: {
	count: number | string;
	tone?: "plain" | "approval";
	className?: string;
}) {
	if (tone === "approval") {
		return (
			<span
				className={cn(
					"inline-flex h-5 min-w-5 items-center justify-center rounded-[10px] border border-approval-border bg-approval-surface px-1.5 text-meta font-semibold text-approval",
					className,
				)}
			>
				{count}
			</span>
		);
	}
	return <span className={cn("text-label text-text-muted tabular-nums", className)}>{count}</span>;
}
