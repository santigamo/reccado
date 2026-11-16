import { Link } from "@tanstack/react-router";
import { Layers, PanelLeftClose, PanelLeftOpen, Plus } from "lucide-react";
import { IconButton } from "#/components/ui/IconButton";
import { StatusDot } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import type { InboxSearch } from "#/lib/inbox-search";
import type { Mailbox } from "#/lib/mail";
import { type MailboxColor, sortMailboxesForColor } from "#/lib/mailbox-color";
import { formatCount } from "#/lib/use-unified-mail";

type DomainGroup = { domain: string; mailboxes: Mailbox[] };

/** Group mailboxes by domain, domains in order of their first mailbox. */
export function groupByDomain(mailboxes: Mailbox[]): DomainGroup[] {
	const groups: DomainGroup[] = [];
	for (const m of sortMailboxesForColor(mailboxes)) {
		const domain = m.primary_address.split("@")[1] ?? "";
		let group = groups.find((g) => g.domain === domain);
		if (!group) {
			group = { domain, mailboxes: [] };
			groups.push(group);
		}
		group.mailboxes.push(m);
	}
	return groups;
}

/**
 * Unread conversations in a mailbox's Inbox, in the list's unread language:
 * semibold ink next to a semibold name. Nothing at all when everything is read.
 */
function UnreadCount({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<span className="w-12 shrink-0 text-right text-label font-semibold text-ink tabular-nums">
			<span className="sr-only">, </span>
			{formatCount(count)}
			<span className="sr-only"> unread</span>
		</span>
	);
}

const rowBase =
	"flex h-8 shrink-0 items-center gap-2.5 rounded-[10px] px-[11px] text-body tracking-[-0.01em] no-underline";

/** Left column: All mailboxes, mailboxes by domain, add entry, approvals note. */
export function MailboxColumn({
	mailboxes,
	search,
	colorOf,
	unreadOf,
	totalUnread,
	pendingApprovals,
	onNavigate,
	onCollapse,
	className,
}: {
	mailboxes: Mailbox[];
	search: InboxSearch;
	colorOf: (id: string) => MailboxColor;
	unreadOf: (id: string) => number;
	totalUnread: number;
	pendingApprovals: number;
	/** Called after a selection (closes the drawer on narrow screens). */
	onNavigate?: () => void;
	/** Fold the column into a rail (desktop). */
	onCollapse?: () => void;
	className?: string;
}) {
	const scope = search.mailbox;
	const groups = groupByDomain(mailboxes);

	return (
		<nav
			aria-label="Mailboxes"
			className={cn("flex w-[216px] shrink-0 flex-col gap-0.5 pt-1", className)}
		>
			<div className="group/head flex shrink-0 items-center gap-1">
				<Link
					to="/inbox"
					search={{ folder: search.folder }}
					onClick={onNavigate}
					aria-current={!scope ? "page" : undefined}
					className={cn(
						rowBase,
						"h-9 min-w-0 flex-1 px-2.5",
						!scope
							? "border border-border-card bg-panel font-medium text-text shadow-card"
							: "text-text hover:bg-hover",
					)}
				>
					<Layers aria-hidden="true" className="size-4 shrink-0 text-[#1F1F1F]" />
					<span
						className={cn("min-w-0 flex-1 truncate", totalUnread > 0 && "font-semibold text-ink")}
					>
						All mailboxes
					</span>
					<UnreadCount count={totalUnread} />
				</Link>
				{onCollapse ? (
					<IconButton
						title="Hide mailboxes ([)"
						aria-label="Hide mailboxes"
						size="sm"
						onClick={onCollapse}
						// Takes no room until the pointer or focus is here, so the label
						// above keeps its full width; `[` folds the column either way.
						className="hidden focus-visible:flex group-focus-within/head:flex group-hover/head:flex"
					>
						<PanelLeftClose />
					</IconButton>
				) : null}
			</div>

			<div className="app-scroll -mr-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-2">
				{groups.map((group) => (
					<div key={group.domain} className="flex flex-col gap-0.5">
						<div className="flex h-[30px] shrink-0 items-center px-[11px] pt-2.5 text-meta font-medium tracking-[0.02em] text-text-muted">
							<span className="truncate">{group.domain}</span>
						</div>
						{group.mailboxes.map((m) => {
							const active = scope === m.mailbox_id;
							const unread = unreadOf(m.mailbox_id);
							const local = m.primary_address.split("@")[0] ?? m.primary_address;
							return (
								<Link
									key={m.mailbox_id}
									to="/inbox"
									search={{ mailbox: m.mailbox_id, folder: search.folder }}
									onClick={onNavigate}
									aria-current={active ? "page" : undefined}
									title={
										m.display_name ? `${m.display_name} <${m.primary_address}>` : m.primary_address
									}
									className={cn(
										rowBase,
										active
											? "border border-border-card bg-panel font-medium text-text shadow-card"
											: "text-text hover:bg-hover",
										m.status === "disabled" && "opacity-60",
									)}
								>
									<span className="flex w-4 shrink-0 justify-center">
										<StatusDot color={colorOf(m.mailbox_id).css} size={8} />
									</span>
									<span
										className={cn(
											"min-w-0 flex-1 truncate",
											unread > 0 ? "font-semibold text-ink" : !active && "text-text-secondary",
										)}
									>
										{local}@
									</span>
									<UnreadCount count={unread} />
								</Link>
							);
						})}
					</div>
				))}

				<Link
					to="/settings/domains"
					search={{ add: "mailbox" }}
					className={cn(rowBase, "mt-0.5 text-text-muted hover:bg-hover hover:text-text")}
				>
					<span className="flex w-4 shrink-0 justify-center">
						<Plus aria-hidden="true" className="size-3.5" />
					</span>
					<span className="truncate">Add mailbox or domain</span>
				</Link>
			</div>

			{pendingApprovals > 0 ? (
				<div className="flex shrink-0 flex-col gap-1.5 border-t border-border px-3 pt-3.5 pb-5">
					<div className="flex items-center gap-2">
						<StatusDot tone="approval" />
						<span className="text-label font-medium text-text">
							{pendingApprovals === 1
								? "1 request awaits your approval"
								: `${formatCount(pendingApprovals)} requests await your approval`}
						</span>
					</div>
					<p className="m-0 text-label leading-[19px] text-text-muted">
						The agent asked for them. Nothing is sent or changed until you approve each one.
					</p>
					<Link
						to="/inbox"
						search={{ mailbox: search.mailbox, folder: "approvals" }}
						onClick={onNavigate}
						className="text-label font-medium text-text underline decoration-1"
					>
						Review approvals
					</Link>
				</div>
			) : null}
		</nav>
	);
}

/**
 * The mailbox column folded (desktop): a thin rail with the way back, All
 * mailboxes, and one dot per mailbox in its colour (a ring when it has unread
 * mail). Same links as the column, so scope still switches from here.
 */
export function MailboxRail({
	mailboxes,
	search,
	colorOf,
	unreadOf,
	totalUnread,
	onExpand,
	className,
}: {
	mailboxes: Mailbox[];
	search: InboxSearch;
	colorOf: (id: string) => MailboxColor;
	unreadOf: (id: string) => number;
	totalUnread: number;
	onExpand: () => void;
	className?: string;
}) {
	const scope = search.mailbox;
	const cell =
		"flex size-8 shrink-0 items-center justify-center rounded-[10px] no-underline hover:bg-hover";
	return (
		<nav
			aria-label="Mailboxes"
			className={cn("w-9 shrink-0 flex-col items-center gap-1 pt-1", className)}
		>
			<IconButton title="Show mailboxes ([)" aria-label="Show mailboxes" onClick={onExpand}>
				<PanelLeftOpen />
			</IconButton>
			<Link
				to="/inbox"
				search={{ folder: search.folder }}
				aria-current={!scope ? "page" : undefined}
				title={
					totalUnread > 0 ? `All mailboxes · ${formatCount(totalUnread)} unread` : "All mailboxes"
				}
				className={cn(cell, !scope && "border border-border-card bg-panel shadow-card")}
			>
				<Layers aria-hidden="true" className="size-4 text-[#1F1F1F]" />
				<span className="sr-only">All mailboxes</span>
			</Link>
			<div className="app-scroll flex min-h-0 flex-col items-center gap-1 overflow-y-auto">
				{sortMailboxesForColor(mailboxes).map((m) => {
					const active = scope === m.mailbox_id;
					const unread = unreadOf(m.mailbox_id);
					const color = colorOf(m.mailbox_id).css;
					return (
						<Link
							key={m.mailbox_id}
							to="/inbox"
							search={{ mailbox: m.mailbox_id, folder: search.folder }}
							aria-current={active ? "page" : undefined}
							title={`${m.primary_address}${unread > 0 ? ` · ${formatCount(unread)} unread` : ""}`}
							className={cn(cell, active && "border border-border-card bg-panel shadow-card")}
						>
							<span
								aria-hidden="true"
								className="size-2.5 rounded-full"
								style={{
									background: color,
									boxShadow:
										unread > 0 ? `0 0 0 2px var(--color-content), 0 0 0 3.5px ${color}` : undefined,
								}}
							/>
							<span className="sr-only">
								{m.primary_address}
								{unread > 0 ? `, ${formatCount(unread)} unread` : ""}
							</span>
						</Link>
					);
				})}
			</div>
		</nav>
	);
}
