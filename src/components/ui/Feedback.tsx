import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/cn";
import { Button } from "./Button";

export function Spinner({ className, label }: { className?: string; label?: string }) {
	return (
		<Loader2
			role={label ? "status" : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
			className={cn("h-5 w-5 animate-spin text-icon", className)}
		/>
	);
}

export function CenteredSpinner({ label }: { label?: string }) {
	return (
		<div
			role="status"
			className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-text-muted"
		>
			<Spinner />
			<p className="text-label">{label ?? "Loading…"}</p>
		</div>
	);
}

export function EmptyState({
	icon,
	title,
	hint,
	action,
	className,
}: {
	icon?: ReactNode;
	title: string;
	hint?: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex h-full min-h-60 flex-col items-center justify-center gap-2 px-6 text-center",
				className,
			)}
		>
			{icon ? (
				<div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-pill text-icon [&_svg]:size-5">
					{icon}
				</div>
			) : null}
			<p className="text-sender font-medium tracking-[-0.01em] text-text">{title}</p>
			{hint ? <p className="max-w-sm text-label text-text-muted">{hint}</p> : null}
			{action ? <div className="mt-2">{action}</div> : null}
		</div>
	);
}

export function ErrorState({
	message,
	onRetry,
	className,
}: {
	message: string;
	onRetry?: () => void;
	className?: string;
}) {
	return (
		<div
			role="alert"
			className={cn(
				"flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 text-center",
				className,
			)}
		>
			<p className="text-label text-danger">{message}</p>
			{onRetry ? (
				<Button size="sm" variant="secondary" onClick={onRetry}>
					Try again
				</Button>
			) : null}
		</div>
	);
}

/** Inline, non-blocking notice (e.g. "1 mailbox failed to load"). */
export function InlineNotice({
	tone = "neutral",
	children,
	action,
	className,
}: {
	tone?: "neutral" | "danger" | "approval";
	children: ReactNode;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div
			role={tone === "danger" ? "alert" : "status"}
			className={cn(
				"flex items-center gap-3 px-4 py-2 text-label",
				tone === "danger" && "bg-[color-mix(in_srgb,var(--color-danger)_8%,white)] text-danger",
				tone === "approval" && "bg-approval-surface text-approval",
				tone === "neutral" && "bg-content text-text-muted",
				className,
			)}
		>
			<div className="min-w-0 flex-1">{children}</div>
			{action}
		</div>
	);
}
