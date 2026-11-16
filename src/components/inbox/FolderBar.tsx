import { Link } from "@tanstack/react-router";
import {
	Archive,
	FileChartColumn,
	Inbox,
	Mails,
	Menu as MenuIcon,
	MoreHorizontal,
	PenLine,
	Send,
	ShieldCheck,
	SquarePen,
	Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { ToolbarDivider, ToolbarSpacer } from "#/components/shell/AppShell";
import { Button } from "#/components/ui/Button";
import { IconButton } from "#/components/ui/IconButton";
import { Menu } from "#/components/ui/Menu";
import { NavTabContent, navTabClassName } from "#/components/ui/NavTab";
import { CountBadge } from "#/components/ui/Pill";
import { StatusDot } from "#/components/ui/StatusDot";
import { FOLDER_LABELS, type InboxFolderKey, type InboxSearch } from "#/lib/inbox-search";
import type { AgentStatus } from "#/lib/use-agent-status";
import { formatCount } from "#/lib/use-unified-mail";

const PRIMARY: { key: InboxFolderKey; icon: ReactNode }[] = [
	{ key: "inbox", icon: <Inbox /> },
	{ key: "approvals", icon: <ShieldCheck /> },
	{ key: "drafts", icon: <PenLine /> },
	{ key: "sent", icon: <Send /> },
	{ key: "archive", icon: <Archive /> },
];

const OVERFLOW: { key: InboxFolderKey; icon: ReactNode }[] = [
	{ key: "trash", icon: <Trash2 /> },
	{ key: "all", icon: <Mails /> },
	// Automated DMARC aggregate reports: stored, never in another folder or count.
	{ key: "reports", icon: <FileChartColumn /> },
];

/** Tabs that move into "More" on phones (unless they are the current folder). */
const PHONE_OVERFLOW = new Set<InboxFolderKey>(["sent", "archive"]);

/** Second bar of the inbox: Compose · folder tabs · More · agent status. */
export function FolderBar({
	search,
	active,
	counts,
	agent,
	onCompose,
	onSelectFolder,
	onOpenDrawer,
}: {
	search: InboxSearch;
	active: InboxFolderKey;
	counts: { inbox?: string; approvals?: number; drafts?: string };
	agent: AgentStatus;
	onCompose: () => void;
	onSelectFolder: (key: InboxFolderKey) => void;
	onOpenDrawer: () => void;
}) {
	const overflowActive = OVERFLOW.find((f) => f.key === active);
	const linkSearch = (key: InboxFolderKey): InboxSearch => ({
		mailbox: search.mailbox,
		folder: key === "inbox" ? undefined : key,
	});

	function badgeFor(key: InboxFolderKey): ReactNode {
		if (key === "inbox" && counts.inbox) return <CountBadge count={counts.inbox} />;
		if (key === "drafts" && counts.drafts) return <CountBadge count={counts.drafts} />;
		if (key === "approvals" && counts.approvals) {
			return <CountBadge tone="approval" count={formatCount(counts.approvals)} />;
		}
		return undefined;
	}

	return (
		<>
			<IconButton title="Mailboxes" className="lg:hidden" onClick={onOpenDrawer}>
				<MenuIcon />
			</IconButton>
			<Button variant="primary" onClick={onCompose} className="pr-4 pl-3.5 max-sm:px-3">
				<SquarePen />
				<span className="max-sm:sr-only">Compose</span>
			</Button>
			<ToolbarDivider />
			<div className="flex items-center gap-1">
				{PRIMARY.map((f) => (
					<Link
						key={f.key}
						to="/inbox"
						search={linkSearch(f.key)}
						aria-current={active === f.key ? "page" : undefined}
						className={navTabClassName(
							active === f.key,
							PHONE_OVERFLOW.has(f.key) && active !== f.key ? "max-sm:hidden" : undefined,
						)}
						title={f.key === "inbox" && counts.inbox ? `${counts.inbox} unread` : undefined}
					>
						<NavTabContent
							icon={f.icon}
							badge={badgeFor(f.key)}
							compact={active === f.key ? "sm" : "lg"}
						>
							{FOLDER_LABELS[f.key]}
						</NavTabContent>
					</Link>
				))}
				{/* Desktop: Trash and All mail. Phones: Sent and Archive join them. */}
				<span className="contents max-sm:hidden">
					<MoreFolders
						entries={OVERFLOW}
						active={active}
						overflowActive={overflowActive}
						onSelectFolder={onSelectFolder}
					/>
				</span>
				<span className="contents sm:hidden">
					<MoreFolders
						entries={[
							...PRIMARY.filter((f) => PHONE_OVERFLOW.has(f.key) && f.key !== active),
							...OVERFLOW,
						]}
						active={active}
						overflowActive={overflowActive}
						onSelectFolder={onSelectFolder}
					/>
				</span>
			</div>
			<ToolbarSpacer />
			<AgentStatusNote agent={agent} />
		</>
	);
}

function MoreFolders({
	entries,
	active,
	overflowActive,
	onSelectFolder,
}: {
	entries: { key: InboxFolderKey; icon: ReactNode }[];
	active: InboxFolderKey;
	overflowActive: { key: InboxFolderKey; icon: ReactNode } | undefined;
	onSelectFolder: (key: InboxFolderKey) => void;
}) {
	return (
		<Menu
			label="More folders"
			triggerClassName={navTabClassName(Boolean(overflowActive))}
			trigger={
				overflowActive ? (
					<NavTabContent icon={overflowActive.icon}>
						{FOLDER_LABELS[overflowActive.key]}
					</NavTabContent>
				) : (
					<NavTabContent icon={<MoreHorizontal />} compact="lg">
						More
					</NavTabContent>
				)
			}
			items={entries.map((f) => ({
				key: f.key,
				label: FOLDER_LABELS[f.key],
				icon: f.icon,
				active: active === f.key,
				onSelect: () => onSelectFolder(f.key),
			}))}
		/>
	);
}

/**
 * "● Agent on · reads and drafts, never sends alone" — only when an MCP client
 * is actually authorized. "Never sends alone" is the approval invariant, so it
 * is always true; "reads and drafts" only when those scopes were granted.
 */
function AgentStatusNote({ agent }: { agent: AgentStatus }) {
	if (agent.state === "unknown") return null;
	if (agent.state === "none") {
		return (
			<Link
				to="/settings/agent-access"
				className="hidden shrink-0 items-center gap-2 text-label text-text-muted no-underline hover:text-text lg:flex"
			>
				<StatusDot tone="muted" />
				<span>
					<span className="font-medium text-text">No agent connected</span> · connect one in
					settings
				</span>
			</Link>
		);
	}
	const what =
		agent.canRead && agent.canDraft
			? "reads and drafts, never sends alone"
			: agent.canRead
				? "reads, never sends alone"
				: "never sends alone";
	return (
		<div
			className="hidden shrink-0 items-center gap-2 text-label text-text-muted lg:flex"
			title={`${agent.clients} connected ${agent.clients === 1 ? "app" : "apps"}. Every send it asks for needs your approval.`}
		>
			<StatusDot tone="agent" />
			<span>
				<span className="font-medium text-text">Agent on</span> · {what}
			</span>
		</div>
	);
}
