import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "#/lib/cn";

/**
 * Class string for a second-bar tab ("Inbox", "Approvals", "Domains &
 * mailboxes"…). Active = grey pill; inactive = plain text. Use it on a router
 * `<Link>` (`className={navTabClassName(active)}` + `aria-current`), or use
 * `<NavTab>` for a button.
 */
export function navTabClassName(active: boolean, className?: string): string {
	return cn(
		"relative inline-flex h-[34px] shrink-0 items-center gap-[9px] whitespace-nowrap rounded-[17px] text-body tracking-[-0.01em] no-underline transition [&_svg]:size-4 [&_svg]:shrink-0",
		active
			? "bg-pill pr-3.5 pl-[13px] font-medium text-[#3A3A3A]"
			: "px-2.5 text-text-secondary hover:bg-hover hover:text-text max-sm:px-2",
		className,
	);
}

/** Inner layout for a tab: optional icon, label, optional trailing badge. */
export function NavTabContent({
	icon,
	children,
	badge,
	compact,
}: {
	icon?: ReactNode;
	children: ReactNode;
	badge?: ReactNode;
	/** Icon-only below this breakpoint (the label stays for screen readers). */
	compact?: "sm" | "lg";
}) {
	return (
		<>
			{icon}
			<span
				className={
					compact === "lg" ? "max-lg:sr-only" : compact === "sm" ? "max-sm:sr-only" : undefined
				}
			>
				{children}
			</span>
			{badge}
		</>
	);
}

export function NavTab({
	active = false,
	icon,
	badge,
	children,
	className,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	active?: boolean;
	icon?: ReactNode;
	badge?: ReactNode;
}) {
	return (
		<button
			type={type}
			aria-current={active ? "page" : undefined}
			className={navTabClassName(active, className)}
			{...props}
		>
			<NavTabContent icon={icon} badge={badge}>
				{children}
			</NavTabContent>
		</button>
	);
}
