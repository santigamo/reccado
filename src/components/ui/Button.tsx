import type { ButtonHTMLAttributes } from "react";
import { cn } from "#/lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
	// Navy pill — Compose, "Approve & send", "Create mailbox".
	primary:
		"bg-brand text-white shadow-primary hover:bg-brand-hover disabled:bg-disabled disabled:shadow-none",
	// White outline pill — "Edit".
	secondary: "border border-[#DCDCDC] bg-panel text-text hover:bg-row-selected",
	// Text-only — "Cancel", "Discard".
	ghost: "text-text-secondary hover:bg-hover hover:text-text",
	danger:
		"border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-panel text-danger hover:bg-[color-mix(in_srgb,var(--color-danger)_8%,white)]",
};

const SIZES: Record<ButtonSize, string> = {
	sm: "h-8 gap-1.5 px-3 text-label",
	// 44px tall on touch screens (primary actions need a full touch target).
	md: "h-9 gap-2 px-4 text-body pointer-coarse:h-11",
};

/** Class string for anything that should look like a Button (e.g. a router `<Link>`). */
export function buttonClassName(
	variant: ButtonVariant = "secondary",
	size: ButtonSize = "md",
	className?: string,
): string {
	return cn(
		"relative inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-pill font-medium tracking-[-0.01em] no-underline transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0",
		VARIANTS[variant],
		SIZES[size],
		className,
	);
}

/**
 * Pill button. `primary` navy, `secondary` white outline, `ghost` text-only,
 * `danger` outlined red. Icons go in `children` (lucide icons are sized 16px).
 */
export function Button({
	variant = "secondary",
	size = "md",
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
	return <button type={type} className={buttonClassName(variant, size, className)} {...props} />;
}
