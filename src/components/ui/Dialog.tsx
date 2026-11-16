import { X } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/cn";
import { IconButton } from "./IconButton";

const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type DialogSize = "sm" | "md" | "lg";

const WIDTHS: Record<DialogSize, string> = {
	sm: "max-w-[440px]",
	md: "max-w-[560px]",
	lg: "max-w-[680px]",
};

/**
 * Accessible modal dialog — a centred card over the dimmed app (Paper
 * artboard "Add mailbox"). Portal to <body>, focus trap, Esc and scrim click
 * close it (unless `dismissible={false}`), focus returns to the opener, body
 * scroll is locked while open.
 *
 * Render it only while open (`{open ? <Dialog …/> : null}`) or pass `open`.
 *
 * Layout: header (title, optional description, close ×) / body (children,
 * padded) / optional footer bar (grey, use `<DialogFooterNote>` for the left
 * hint and put buttons after it).
 */
export function Dialog({
	open = true,
	onClose,
	title,
	description,
	children,
	footer,
	size = "md",
	dismissible = true,
	initialFocusRef,
	className,
	bodyClassName,
	headerAside,
	headerClassName,
	footerClassName,
}: {
	open?: boolean;
	onClose: () => void;
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	footer?: ReactNode;
	size?: DialogSize;
	/** Esc / scrim click close the dialog. Turn off while there is unsaved input. */
	dismissible?: boolean;
	initialFocusRef?: RefObject<HTMLElement | null>;
	className?: string;
	bodyClassName?: string;
	/** Right side of the header, before the close button (e.g. "Draft saved"). */
	headerAside?: ReactNode;
	headerClassName?: string;
	footerClassName?: string;
}) {
	const [mounted, setMounted] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const descId = useId();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	const dismissibleRef = useRef(dismissible);
	dismissibleRef.current = dismissible;

	useEffect(() => setMounted(true), []);

	useEffect(() => {
		if (!open || !mounted) return;
		const previouslyFocused = document.activeElement as HTMLElement | null;
		const panel = panelRef.current;
		const first =
			initialFocusRef?.current ?? panel?.querySelector<HTMLElement>("[data-autofocus]") ?? null;
		(first ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel)?.focus();

		const { overflow } = document.body.style;
		document.body.style.overflow = "hidden";

		function onKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				if (dismissibleRef.current) {
					event.stopPropagation();
					onCloseRef.current();
				}
				return;
			}
			if (event.key !== "Tab" || !panel) return;
			const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
				(el) => el.offsetParent !== null || el === document.activeElement,
			);
			if (items.length === 0) {
				event.preventDefault();
				return;
			}
			const firstItem = items[0]!;
			const lastItem = items[items.length - 1]!;
			if (event.shiftKey && document.activeElement === firstItem) {
				event.preventDefault();
				lastItem.focus();
			} else if (!event.shiftKey && document.activeElement === lastItem) {
				event.preventDefault();
				firstItem.focus();
			} else if (!panel.contains(document.activeElement)) {
				event.preventDefault();
				firstItem.focus();
			}
		}
		document.addEventListener("keydown", onKeyDown, true);
		return () => {
			document.removeEventListener("keydown", onKeyDown, true);
			document.body.style.overflow = overflow;
			previouslyFocused?.focus?.();
		};
	}, [open, mounted, initialFocusRef]);

	if (!open || !mounted) return null;

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
			<button
				type="button"
				tabIndex={-1}
				aria-label="Close dialog"
				className="absolute inset-0 cursor-default bg-[var(--scrim)]"
				onClick={() => {
					if (dismissibleRef.current) onCloseRef.current();
				}}
			/>
			<div
				ref={panelRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={description ? descId : undefined}
				tabIndex={-1}
				className={cn(
					"relative flex max-h-[min(92dvh,100%)] w-full flex-col overflow-hidden border border-border-card bg-panel shadow-dialog outline-none",
					"rounded-t-shell sm:rounded-shell",
					WIDTHS[size],
					className,
				)}
			>
				<div className={cn("flex shrink-0 items-start gap-4 pt-6 pr-6 pb-5 pl-7", headerClassName)}>
					<div className="flex min-w-0 flex-1 flex-col gap-1.5">
						<h2 id={titleId} className="m-0 text-title font-semibold tracking-[-0.015em] text-ink">
							{title}
						</h2>
						{description ? (
							<p id={descId} className="m-0 text-body text-text-muted">
								{description}
							</p>
						) : null}
					</div>
					{headerAside}
					<IconButton title="Close" onClick={onClose}>
						<X />
					</IconButton>
				</div>
				<div
					className={cn(
						"app-scroll min-h-0 flex-1 overflow-y-auto px-7 pt-1.5 pb-6",
						bodyClassName,
					)}
				>
					{children}
				</div>
				{footer ? (
					<div
						className={cn(
							"flex shrink-0 flex-wrap items-center gap-2.5 border-t border-border-card bg-content py-4 pr-5 pl-7 max-sm:justify-end max-sm:pl-5",
							footerClassName,
						)}
					>
						{footer}
					</div>
				) : null}
			</div>
		</div>,
		document.body,
	);
}

/** Left-aligned hint in a dialog footer ("The agent can read and draft here."). */
export function DialogFooterNote({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
	return (
		<div className="flex min-w-0 flex-1 items-center gap-2.5 text-label text-text-muted max-sm:order-last max-sm:basis-full [&_svg]:size-[15px] [&_svg]:shrink-0">
			{icon}
			<span>{children}</span>
		</div>
	);
}
