import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { InlineNotice } from "#/components/ui/Feedback";
import { StatusDot, type StatusTone } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** "12 Mar 2026" from a D1 timestamp; empty when unparseable. */
export function formatDay(value: string | null | undefined): string {
	if (!value) return "";
	const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
	return Number.isNaN(date.getTime()) ? "" : DATE.format(date);
}

/** "2 h ago", "3 d ago", "just now". */
export function formatAgo(value: string | null | undefined, now = Date.now()): string {
	if (!value) return "";
	const t = new Date(value).getTime();
	if (Number.isNaN(t)) return "";
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86_400)} d ago`;
}

/** Dot + label, the status line used across the screen ("● Routed", "● Live · 2 h ago"). */
export function StatusLine({
	tone,
	children,
	className,
	strong,
}: {
	tone: StatusTone | "danger-strong" | "brand-strong";
	children: ReactNode;
	className?: string;
	strong?: boolean;
}) {
	const base: StatusTone =
		tone === "danger-strong" ? "danger" : tone === "brand-strong" ? "brand" : tone;
	return (
		<span className={cn("inline-flex min-w-0 items-center gap-[7px]", className)}>
			<StatusDot tone={base} />
			<span
				className={cn(
					"min-w-0 truncate",
					tone === "danger-strong" && "font-medium text-danger",
					tone === "brand-strong" && "font-medium text-brand",
					strong && "font-medium",
				)}
			>
				{children}
			</span>
		</span>
	);
}

/** Copies `text`; label flips to "Copied" for a moment. */
export function CopyButton({
	text,
	label = "Copy",
	className,
	variant = "plain",
}: {
	text: string;
	label?: string;
	className?: string;
	variant?: "plain" | "on-dark";
}) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			onClick={() => {
				void navigator.clipboard
					?.writeText(text)
					.then(() => {
						setCopied(true);
						window.setTimeout(() => setCopied(false), 1500);
					})
					.catch(() => undefined);
			}}
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 rounded-control px-1.5 py-1 text-meta font-medium transition [&_svg]:size-3.5",
				variant === "on-dark"
					? "text-code-text hover:bg-white/10"
					: "text-text-secondary hover:bg-hover hover:text-text",
				className,
			)}
		>
			{copied ? <Check aria-hidden /> : <Copy aria-hidden />}
			{copied ? "Copied" : label}
		</button>
	);
}

/** Navy code block with a header bar and a copy action (Paper "Add domain — 3 Ready"). */
export function CodeBlock({ title, code }: { title: string; code: string }) {
	return (
		<div className="flex flex-col overflow-hidden rounded-[12px] bg-brand">
			<div className="flex h-9 shrink-0 items-center gap-3.5 border-b border-white/12 px-3.5">
				<span className="text-meta font-semibold text-panel">{title}</span>
				<span className="flex-1" />
				<CopyButton text={code} variant="on-dark" />
			</div>
			<pre className="app-scroll m-0 overflow-x-auto px-3.5 pt-3 pb-3.5 font-mono text-meta leading-[19px] text-code-text">
				{code}
			</pre>
		</div>
	);
}

/** Small yes/no confirmation dialog. */
export function ConfirmDialog({
	title,
	description,
	confirmLabel,
	tone = "primary",
	note,
	onConfirm,
	onClose,
}: {
	title: string;
	description: ReactNode;
	confirmLabel: string;
	tone?: "primary" | "danger";
	note?: ReactNode;
	onConfirm: () => Promise<void>;
	onClose: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	return (
		<Dialog
			onClose={onClose}
			title={title}
			size="sm"
			dismissible={!busy}
			footer={
				<>
					<DialogFooterNote>{note}</DialogFooterNote>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button
						variant={tone}
						disabled={busy}
						onClick={() => {
							setBusy(true);
							setError(null);
							onConfirm()
								.then(onClose)
								.catch((caught: unknown) => {
									setError(caught instanceof Error ? caught.message : "Something went wrong");
									setBusy(false);
								});
						}}
					>
						{busy ? "Working…" : confirmLabel}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3 text-body text-text-secondary">
				<div>{description}</div>
				{error ? (
					<InlineNotice tone="danger" className="rounded-[10px]">
						{error}
					</InlineNotice>
				) : null}
			</div>
		</Dialog>
	);
}
