import type { ReactNode } from "react";
import { StatusDot } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import type { Mailbox } from "#/lib/mail";
import type { MailboxColor } from "#/lib/mailbox-color";

/**
 * Building blocks shared by the per-mailbox Settings tabs (API keys,
 * Suppressions) and the single-column ones (Agent access, Account). They
 * follow the Paper "Settings — API keys" artboard: a 216px mailbox rail on the
 * left, white 14px-radius cards on the grey content area on the right.
 */

/** White card on the grey settings background. */
export function SettingsCard({
	children,
	className,
	as: Tag = "section",
	...rest
}: {
	children: ReactNode;
	className?: string;
	as?: "section" | "div" | "article";
	"aria-labelledby"?: string;
	"aria-label"?: string;
}) {
	return (
		<Tag
			className={cn(
				"flex min-w-0 shrink-0 flex-col overflow-clip rounded-card border border-border-card bg-panel",
				className,
			)}
			{...rest}
		>
			{children}
		</Tag>
	);
}

/** Scroll container + padding for a settings tab body. */
/** Fills the shell's content row (a flex row) for loading / empty / error states. */
export function SettingsFill({ children }: { children: ReactNode }) {
	return <div className="flex min-w-0 flex-1 flex-col">{children}</div>;
}

export function SettingsBody({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className="app-scroll h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
			<div className={cn("flex min-h-full flex-col gap-4 pb-4 lg:flex-row", className)}>
				{children}
			</div>
		</div>
	);
}

/**
 * Left mailbox column. Below `lg` it becomes a horizontal, scrollable strip so
 * the detail stays reachable on a phone.
 */
export function MailboxRail({
	mailboxes,
	selectedId,
	colorOf,
	sublabel,
	onSelect,
	footnote,
	label,
	lockedReason,
}: {
	mailboxes: readonly Mailbox[];
	selectedId: string | null;
	colorOf: (mailboxId: string) => MailboxColor;
	sublabel: (mailbox: Mailbox) => ReactNode;
	onSelect: (mailboxId: string) => void;
	footnote?: ReactNode;
	label: string;
	/** When set, switching mailbox is disabled and this explains why. */
	lockedReason?: string;
}) {
	return (
		<nav aria-label={label} className="flex shrink-0 flex-col gap-1 pt-1 lg:w-54">
			<ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 lg:flex-col lg:overflow-visible">
				{mailboxes.map((mailbox) => {
					const active = mailbox.mailbox_id === selectedId;
					return (
						<li key={mailbox.mailbox_id} className="shrink-0">
							<button
								type="button"
								onClick={() => onSelect(mailbox.mailbox_id)}
								aria-current={active ? "true" : undefined}
								disabled={Boolean(lockedReason) && !active}
								title={lockedReason && !active ? lockedReason : undefined}
								className={cn(
									"flex w-full gap-2.25 rounded-[10px] border py-2.25 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
									active
										? "border-border-card bg-panel px-2.75 shadow-card"
										: "border-transparent px-3 hover:bg-hover",
								)}
							>
								<span className="flex h-5 w-2 shrink-0 items-center">
									<StatusDot color={colorOf(mailbox.mailbox_id).css} size={8} />
								</span>
								<span className="flex min-w-0 flex-col gap-0.5">
									<span className={cn("truncate text-body text-text", active && "font-medium")}>
										{mailbox.primary_address}
									</span>
									<span className="truncate text-meta text-text-muted">{sublabel(mailbox)}</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{footnote ? (
				<div className="mt-auto hidden border-t border-border px-3 pt-3.5 pb-5 text-label leading-[19px] text-text-muted lg:block">
					{footnote}
				</div>
			) : null}
		</nav>
	);
}

export type StatCell = { label: string; value: ReactNode };

/** "● support@reccado.app" + description, then a strip of 3 stat cells. */
export function MailboxHeaderCard({
	color,
	title,
	description,
	stats,
}: {
	color: MailboxColor;
	title: string;
	description: ReactNode;
	stats: StatCell[];
}) {
	return (
		<SettingsCard>
			<div className="flex flex-col gap-0.5 pt-4 pr-4 pb-3.5 pl-5">
				<div className="flex min-w-0 items-center gap-2.5">
					<StatusDot color={color.css} size={8} className="size-2.25" />
					<h1 className="m-0 truncate text-title font-semibold tracking-[-0.015em] text-ink">
						{title}
					</h1>
				</div>
				<p className="m-0 text-label text-text-muted">{description}</p>
			</div>
			<div className="flex flex-col border-t border-border-card sm:flex-row">
				{stats.map((stat, index) => (
					<div
						key={stat.label}
						className={cn(
							"flex min-w-0 flex-1 basis-0 flex-col gap-0.75 px-5 pt-3 pb-3.5",
							index > 0 && "border-t border-border-card sm:border-t-0 sm:border-l",
						)}
					>
						<span className="text-meta text-text-muted">{stat.label}</span>
						<span className="text-body font-medium text-text">{stat.value}</span>
					</div>
				))}
			</div>
		</SettingsCard>
	);
}

/** A muted continuation inside a stat value: "2 · 1 live, 1 test". */
export function StatMuted({ children }: { children: ReactNode }) {
	return <span className="font-normal text-text-muted">{children}</span>;
}

/**
 * The grey confirmation strip that replaces a row's actions ("Rotate this
 * key? … Cancel / Yes, rotate it"). Never a native confirm().
 */
export function ConfirmStrip({
	children,
	actions,
	tone = "neutral",
}: {
	children: ReactNode;
	actions: ReactNode;
	tone?: "neutral" | "danger";
}) {
	return (
		<div
			role={tone === "danger" ? "alert" : "status"}
			className="flex flex-col gap-2 border-t border-border-card bg-content py-2.5 pr-4 pl-5 sm:min-h-13 sm:flex-row sm:items-center sm:gap-3"
		>
			<div className="min-w-0 flex-1 text-label text-text">{children}</div>
			<div className="flex shrink-0 items-center gap-1">{actions}</div>
		</div>
	);
}

/** "on 3 Sep 2026" style date used across the settings tabs. */
export function formatDay(iso: string | null | undefined, opts: { year?: boolean } = {}): string {
	if (!iso) return "—";
	const at = new Date(iso);
	if (Number.isNaN(at.getTime())) return "—";
	return at.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		...(opts.year === false ? {} : { year: "numeric" }),
	});
}

/** The domain part of an address, lowercased. */
export function domainOf(address: string): string {
	return (address.split("@")[1] ?? "").toLowerCase();
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
