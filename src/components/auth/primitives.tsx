import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactElement, ReactNode } from "react";
import { forwardRef, useId } from "react";
import { cn } from "#/lib/cn";
import { AlertCircleIcon, CheckIcon, LockIcon, LogoGlyph, WarningIcon } from "./icons";

/**
 * Shared pieces of the standalone pages (login, consent, approve). These pages
 * render without the app shell, so they carry their own brand mark, card and
 * controls here instead of borrowing from src/components/ui. Values come from
 * the Paper file "Reccado — UI" (page p-2-0); colours, radii and fonts are the
 * tokens from styles.css.
 */

/** Full-height backdrop that centres its column. */
export function AuthPage({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}): ReactElement {
	return (
		<main
			className={cn(
				"flex min-h-dvh flex-col items-center justify-center gap-6 bg-backdrop px-4 py-10 font-sans text-text antialiased [overflow-wrap:anywhere]",
				className,
			)}
		>
			{children}
		</main>
	);
}

/** The logo tile and the Lato wordmark. */
export function Brand({
	className,
	compact = false,
}: {
	className?: string;
	compact?: boolean;
}): ReactElement {
	return (
		<div className={cn("flex items-center gap-2.5", className)}>
			<span className="flex size-7 shrink-0 items-center justify-center rounded-[7px] bg-brand">
				<LogoGlyph />
			</span>
			<span
				className={cn(
					"font-brand font-bold tracking-[-0.01em] text-brand",
					compact ? "text-[18px] leading-6" : "text-[20px] leading-[26px]",
				)}
			>
				Reccado
			</span>
		</div>
	);
}

const CARD_SHADOW = "shadow-[0_1px_2px_#1B2A410F,0_24px_48px_-12px_#1B2A4124]";

/** The white card every standalone page sits in. */
export function Card({
	children,
	className,
	tone = "neutral",
	as: Tag = "section",
	...rest
}: {
	children: ReactNode;
	className?: string;
	tone?: "neutral" | "approval";
	as?: "section" | "article" | "div";
} & React.HTMLAttributes<HTMLElement>): ReactElement {
	return (
		<Tag
			{...rest}
			className={cn(
				"flex w-full flex-col overflow-clip rounded-shell border bg-panel",
				CARD_SHADOW,
				tone === "approval" ? "border-approval-border" : "border-border-card",
				className,
			)}
		>
			{children}
		</Tag>
	);
}

/** Amber context strip at the top of a card ("Sign in to review an approval request"). */
export function ApprovalStrip({
	children,
	trailing,
	className,
}: {
	children: ReactNode;
	trailing?: ReactNode;
	className?: string;
}): ReactElement {
	return (
		<div
			className={cn(
				"flex items-center gap-2.5 border-b border-approval-border bg-approval-surface px-7 py-3",
				className,
			)}
		>
			<span aria-hidden="true" className="size-[7px] shrink-0 rounded-[4px] bg-approval" />
			<p className="grow text-[13px] font-medium leading-[18px] text-approval">{children}</p>
			{trailing}
		</div>
	);
}

/** Card heading block: 20px semibold title with an optional muted line under it. */
export function CardHeader({
	title,
	subtitle,
	className,
	titleId,
}: {
	title: ReactNode;
	subtitle?: ReactNode;
	className?: string;
	titleId?: string;
}): ReactElement {
	return (
		<header className={cn("flex flex-col gap-1.5 px-7 pt-7", className)}>
			<h1
				id={titleId}
				className="text-[20px] font-semibold leading-[26px] tracking-[-0.015em] text-ink"
			>
				{title}
			</h1>
			{subtitle ? <p className="text-[14px] leading-5 text-text-muted">{subtitle}</p> : null}
		</header>
	);
}

/** "Reccado is self-hosted. Only its owner can sign in." */
export function SelfHostedNote(): ReactElement {
	return (
		<p className="flex items-center gap-2 text-[13px] leading-[18px] text-text-secondary">
			<LockIcon />
			Reccado is self-hosted. Only its owner can sign in.
		</p>
	);
}

/** Small uppercase label used for group titles. */
export function Eyebrow({
	children,
	className,
	as: Tag = "p",
}: {
	children: ReactNode;
	className?: string;
	as?: "p" | "h2" | "h3" | "span" | "legend";
}): ReactElement {
	return (
		<Tag
			className={cn(
				"text-[12px] font-medium uppercase leading-4 tracking-[0.04em] text-text-muted",
				className,
			)}
		>
			{children}
		</Tag>
	);
}

/** Inline error: danger icon and one line of copy. Announced politely. */
export function InlineError({
	children,
	id,
	className,
}: {
	children: ReactNode;
	id?: string;
	className?: string;
}): ReactElement {
	return (
		<p
			id={id}
			role="alert"
			className={cn("flex items-start gap-1.5 text-[13px] leading-[18px] text-danger", className)}
		>
			<AlertCircleIcon className="mt-0.5" />
			<span>{children}</span>
		</p>
	);
}

/** Amber warning box (approval language) or red one (identity doubts). */
export function Notice({
	children,
	tone = "approval",
	role,
	className,
}: {
	children: ReactNode;
	tone?: "approval" | "danger";
	role?: "alert" | "note" | "status";
	className?: string;
}): ReactElement {
	return (
		<div
			role={role}
			className={cn(
				"flex items-start gap-2.5 rounded-[10px] border px-3.5 py-2.5 text-[13px] leading-[19px]",
				tone === "danger"
					? "border-[#EBC8C5] bg-[#FBEDEC] py-3 text-danger"
					: "border-approval-border bg-approval-surface text-text",
				className,
			)}
		>
			<WarningIcon
				className="mt-0.5"
				color={tone === "danger" ? "var(--color-danger)" : "var(--color-approval)"}
			/>
			<div className="min-w-0">{children}</div>
		</div>
	);
}

const BUTTON_BASE =
	"inline-flex shrink-0 items-center justify-center gap-2 rounded-pill text-[14px] font-medium leading-5 tracking-[-0.01em] outline-none transition focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--color-brand)_25%,transparent)] disabled:cursor-not-allowed";

/** Navy pill. Disabled turns it into the flat grey of the design. */
export function PrimaryButton({
	className,
	children,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>): ReactElement {
	return (
		<button
			type={type}
			{...props}
			className={cn(
				BUTTON_BASE,
				"h-11 bg-brand px-5 text-white shadow-[inset_0_0_0_1px_#101B2D,0_2px_4px_#1B2A4133] hover:bg-brand-hover disabled:bg-disabled disabled:shadow-none disabled:hover:bg-disabled",
				className,
			)}
		>
			{children}
		</button>
	);
}

/** White pill with a hairline border. */
export function SecondaryButton({
	className,
	children,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement>): ReactElement {
	return (
		<button
			type={type}
			{...props}
			className={cn(
				BUTTON_BASE,
				"h-10 border border-[#DCDCDC] bg-panel px-4 text-text hover:bg-content disabled:text-text-muted disabled:opacity-70",
				className,
			)}
		>
			{children}
		</button>
	);
}

/** Text-only action ("Back", "Send a new code"). Keeps a 36px hit area. */
export function TextButton({
	className,
	children,
	underline = false,
	type = "button",
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { underline?: boolean }): ReactElement {
	return (
		<button
			type={type}
			{...props}
			className={cn(
				"inline-flex h-9 items-center rounded-control px-1 text-[14px] font-medium leading-5 outline-none focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--color-brand)_25%,transparent)] disabled:opacity-50",
				underline
					? "text-text underline decoration-1 underline-offset-[3px] hover:text-ink"
					: "text-text-secondary hover:text-ink",
				className,
			)}
		>
			{children}
		</button>
	);
}

const INPUT_BASE =
	"w-full rounded-[10px] border border-[#DCDCDC] bg-panel text-ink outline-none transition placeholder:text-disabled focus:border-brand focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_12%,transparent)] aria-[invalid=true]:border-danger aria-[invalid=true]:focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_12%,transparent)] disabled:bg-content";

/** Text input with the design's 44px height and focus ring. */
export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
	function TextInput({ className, ...props }, ref): ReactElement {
		return (
			<input
				ref={ref}
				{...props}
				className={cn(INPUT_BASE, "h-11 px-3.5 text-[15px] font-medium leading-[18px]", className)}
			/>
		);
	},
);

/** Six-digit code input: mono, wide tracking, 52px tall. */
export const CodeInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
	function CodeInput({ className, ...props }, ref): ReactElement {
		return (
			<input
				ref={ref}
				inputMode="numeric"
				pattern="[0-9]*"
				autoComplete="one-time-code"
				maxLength={10}
				placeholder="000000"
				{...props}
				className={cn(
					INPUT_BASE,
					"h-[52px] px-4 font-mono text-[22px] font-medium leading-7 tracking-[0.3em]",
					className,
				)}
			/>
		);
	},
);

/** Label + control + optional hint/error, stacked with the design's 8px gap. */
export function Field({
	label,
	hint,
	error,
	children,
	htmlFor,
}: {
	label: ReactNode;
	hint?: ReactNode;
	error?: ReactNode;
	children: ReactNode;
	htmlFor: string;
}): ReactElement {
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-baseline gap-2">
				<label htmlFor={htmlFor} className="text-[13px] font-medium leading-4 text-text">
					{label}
				</label>
				{hint ? <span className="text-[12px] leading-4 text-text-muted">{hint}</span> : null}
			</div>
			{children}
			{error}
		</div>
	);
}

/**
 * A real checkbox drawn as the design's 18px square: hairline when off, navy
 * with a white tick when on. The native input keeps keyboard and form behaviour.
 */
export function Checkbox({
	checked,
	onChange,
	children,
	description,
	trailing,
	disabled,
	className,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	children: ReactNode;
	description?: ReactNode;
	trailing?: ReactNode;
	disabled?: boolean;
	className?: string;
}): ReactElement {
	const id = useId();
	const descriptionId = description ? `${id}-desc` : undefined;
	return (
		<div className={cn("flex items-start gap-3", className)}>
			<span className="relative mt-px flex size-[18px] shrink-0">
				<input
					id={id}
					type="checkbox"
					checked={checked}
					disabled={disabled}
					aria-describedby={descriptionId}
					onChange={(event) => onChange(event.target.checked)}
					className="peer size-[18px] cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-[#B9BFC9] bg-panel outline-none transition checked:border-brand checked:bg-brand focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--color-brand)_25%,transparent)] disabled:cursor-not-allowed"
				/>
				<span className="pointer-events-none absolute inset-0 hidden items-center justify-center peer-checked:flex">
					<CheckIcon size={12} color="#FFFFFF" strokeWidth={3} />
				</span>
			</span>
			<span className="flex min-w-0 grow flex-col gap-0.5">
				<label htmlFor={id} className="cursor-pointer text-[14px] leading-5 text-text">
					{children}
				</label>
				{description ? (
					<span id={descriptionId} className="text-[13px] leading-[18px] text-text-muted">
						{description}
					</span>
				) : null}
			</span>
			{trailing}
		</div>
	);
}
