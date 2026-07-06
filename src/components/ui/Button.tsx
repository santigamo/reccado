import type { ButtonHTMLAttributes } from "react";
import { cn } from "#/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANTS: Record<Variant, string> = {
	primary:
		"bg-[var(--app-accent)] text-[var(--app-on-accent)] hover:bg-[var(--app-accent-hover)] border border-transparent",
	secondary:
		"bg-[var(--app-surface)] text-[var(--app-text)] border border-[var(--app-border-strong)] hover:bg-[var(--app-hover)]",
	ghost:
		"bg-transparent text-[var(--app-text-soft)] border border-transparent hover:bg-[var(--app-hover)]",
	danger:
		"bg-transparent text-[var(--app-danger)] border border-transparent hover:bg-[color-mix(in_oklab,var(--app-danger)_12%,transparent)]",
};

const SIZES: Record<Size, string> = {
	sm: "h-8 px-3 text-[13px] gap-1.5 rounded-md",
	md: "h-10 px-5 text-sm gap-2 rounded-full",
};

export function Button({
	variant = "secondary",
	size = "md",
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
	return (
		<button
			type={type}
			className={cn(
				"inline-flex select-none items-center justify-center font-medium transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
				VARIANTS[variant],
				SIZES[size],
				className,
			)}
			{...props}
		/>
	);
}
