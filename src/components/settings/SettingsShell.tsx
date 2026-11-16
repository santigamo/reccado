import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppShell, ToolbarDivider } from "#/components/shell/AppShell";
import { NavTabContent, navTabClassName } from "#/components/ui/NavTab";

export type SettingsTab = "domains" | "keys" | "agent-access" | "suppressions" | "account";

export const SETTINGS_TABS = [
	{ key: "domains", label: "Domains & mailboxes", to: "/settings/domains" },
	{ key: "keys", label: "API keys", to: "/settings/keys" },
	{ key: "agent-access", label: "Agent access", to: "/settings/agent-access" },
	{ key: "suppressions", label: "Suppressions", to: "/settings/suppressions" },
	{ key: "account", label: "Account", to: "/settings/account" },
] as const satisfies ReadonlyArray<{ key: SettingsTab; label: string; to: string }>;

function BackChevron() {
	return (
		<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
			<path
				d="M14.5 6l-6 6 6 6"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

/**
 * Shared frame for every Settings tab (Paper "Settings — Domains & mailboxes"):
 * header "Settings • <tab>", toolbar "‹ Inbox | tabs … {action}".
 *
 * Tabs are typed router `<Link>`s.
 */
export function SettingsShell({
	active,
	action,
	children,
	contentClassName,
}: {
	active: SettingsTab;
	/** Right-aligned toolbar slot (e.g. the "Add domain" button). */
	action?: ReactNode;
	children: ReactNode;
	/** Forwarded to `AppShell` (the grey content region). */
	contentClassName?: string;
}) {
	const current = SETTINGS_TABS.find((t) => t.key === active) ?? SETTINGS_TABS[0]!;
	return (
		<AppShell
			title="Settings"
			subtitle={current.label}
			contentClassName={contentClassName}
			toolbar={
				<>
					{/* Tabs scroll sideways on narrow screens; the action stays in reach. */}
					<div className="no-scrollbar flex min-w-0 flex-1 items-center gap-2 overflow-x-auto sm:gap-3">
						<Link
							to="/inbox"
							className="inline-flex h-[34px] shrink-0 items-center gap-[7px] rounded-[17px] pr-3 pl-2 text-body text-text-secondary no-underline transition hover:bg-hover hover:text-text"
						>
							<BackChevron />
							<span>Inbox</span>
						</Link>
						<ToolbarDivider />
						{SETTINGS_TABS.map((tab) => (
							<Link
								key={tab.key}
								to={tab.to}
								aria-current={tab.key === active ? "page" : undefined}
								className={navTabClassName(tab.key === active)}
							>
								<NavTabContent>{tab.label}</NavTabContent>
							</Link>
						))}
					</div>
					{action ? <div className="flex shrink-0 items-center">{action}</div> : null}
				</>
			}
		>
			{children}
		</AppShell>
	);
}
