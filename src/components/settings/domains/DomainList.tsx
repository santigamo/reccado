import type { Domain, FeedbackHealth, Mailbox } from "#/components/domains/domains";
import { cn } from "#/lib/cn";
import { StatusLine } from "./bits";

/**
 * One-line health per domain, from data that costs nothing to read: D1 rows and
 * the feedback liveness `/api/health` already publishes. Cloudflare-side state
 * (send-only addresses, DMARC) needs a per-domain read and lives in the detail.
 */
function healthLine(domain: Domain, mailboxes: Mailbox[], health: FeedbackHealth | null) {
	if (domain.status === "disabled") return <StatusLine tone="muted">Disabled</StatusLine>;
	if (domain.status === "pending")
		return <StatusLine tone="brand-strong">Setup pending</StatusLine>;
	const dark = (health?.darkDomains ?? []).some(
		(d) => d === domain.domain || d.endsWith(`.${domain.domain}`),
	);
	if (dark) return <StatusLine tone="danger-strong">No feedback events</StatusLine>;
	const count = mailboxes.filter(
		(m) => m.status === "active" && m.primary_address.toLowerCase().endsWith(`@${domain.domain}`),
	).length;
	return (
		<StatusLine tone="success">
			{count === 0 ? "No mailboxes" : `${count} mailbox${count === 1 ? "" : "es"}`}
		</StatusLine>
	);
}

export function DomainList({
	domains,
	mailboxes,
	health,
	selected,
	onSelect,
}: {
	domains: Domain[];
	mailboxes: Mailbox[];
	health: FeedbackHealth | null;
	selected: string | null;
	onSelect: (domain: string) => void;
}) {
	return (
		<nav aria-label="Domains" className="flex shrink-0 flex-col gap-1 pt-1 md:min-h-full md:w-54">
			<ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 md:flex-col md:overflow-visible">
				{domains.map((d) => {
					const active = d.domain === selected;
					return (
						<li key={d.id} className="shrink-0">
							<button
								type="button"
								onClick={() => onSelect(d.domain)}
								aria-current={active ? "true" : undefined}
								className={cn(
									"flex w-full min-w-44 flex-col gap-0.5 rounded-[10px] border px-3 py-[9px] text-left text-meta transition",
									active
										? "border-border-card bg-panel shadow-card"
										: "border-transparent hover:bg-hover",
								)}
							>
								<span
									className={cn(
										"truncate text-body text-text",
										active && "font-medium",
										d.status === "disabled" && "text-text-muted",
									)}
								>
									{d.domain}
								</span>
								<span className="text-text-muted">{healthLine(d, mailboxes, health)}</span>
							</button>
						</li>
					);
				})}
			</ul>
			<div className="hidden flex-1 md:block" />
			<p className="m-0 hidden border-t border-border px-3 pt-3.5 pb-5 text-label leading-[19px] text-text-muted md:block">
				Domains are disabled, never deleted. You can turn one back on at any time.
			</p>
		</nav>
	);
}
