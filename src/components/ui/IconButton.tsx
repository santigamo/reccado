import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "#/lib/cn";

export type IconButtonSize = "sm" | "md" | "lg";

const SIZES: Record<IconButtonSize, string> = {
	sm: "h-7 w-7 [&_svg]:size-4",
	md: "h-8 w-8 [&_svg]:size-[17px] pointer-coarse:h-10 pointer-coarse:w-10",
	lg: "h-[38px] w-[38px] [&_svg]:size-[19px] pointer-coarse:h-11 pointer-coarse:w-11",
};

/** Class string for an icon-only control rendered as something other than a button (e.g. `<a>`). */
export function iconButtonClassName(size: IconButtonSize = "md", className?: string): string {
	return cn(
		"inline-flex shrink-0 items-center justify-center rounded-control text-icon transition hover:bg-hover hover:text-text active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 [&_svg]:shrink-0",
		SIZES[size],
		className,
	);
}

/**
 * Square icon-only button for toolbars (archive, trash, more…). `title` is
 * required: it doubles as the tooltip and the accessible label.
 */
export const IconButton = forwardRef<
	HTMLButtonElement,
	ButtonHTMLAttributes<HTMLButtonElement> & { title: string; size?: IconButtonSize }
>(function IconButton({ className, title, size = "md", type = "button", ...props }, ref) {
	return (
		<button
			ref={ref}
			type={type}
			title={title}
			aria-label={props["aria-label"] ?? title}
			className={iconButtonClassName(size, className)}
			{...props}
		/>
	);
});
