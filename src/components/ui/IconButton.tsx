import type { ButtonHTMLAttributes } from "react";
import { cn } from "#/lib/cn";

/**
 * Circular icon button for toolbars (archive, trash, reply…). Always pass a
 * `title` — it doubles as the tooltip and the accessible label.
 */
export function IconButton({
	className,
	title,
	size = "md",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { title: string; size?: "sm" | "md" }) {
	return (
		<button
			type="button"
			title={title}
			aria-label={title}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-full text-[var(--app-text-soft)] transition hover:bg-[var(--app-hover)] hover:text-[var(--app-text)] active:scale-[0.9] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100",
				size === "sm" ? "h-8 w-8" : "h-9 w-9",
				className,
			)}
			{...props}
		/>
	);
}
