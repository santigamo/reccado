import type { ReactElement, ReactNode } from "react";
import { SettingsCard } from "#/components/settings/parts/SettingsParts";
import { StatusDot, type StatusTone } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";

function Column({
	tone,
	title,
	titleClassName,
	children,
	first,
}: {
	tone: StatusTone | "ink";
	title: string;
	titleClassName?: string;
	children: ReactNode;
	first?: boolean;
}): ReactElement {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-1 basis-0 flex-col gap-1.5 px-5 pt-4 pb-4.5",
				!first && "border-t border-border-card md:border-t-0 md:border-l",
			)}
		>
			<span
				className={cn("flex items-center gap-2 text-body font-medium text-text", titleClassName)}
			>
				{tone === "ink" ? (
					<StatusDot color="var(--color-ink)" size={6} />
				) : (
					<StatusDot tone={tone} size={6} />
				)}
				{title}
			</span>
			<p className="m-0 text-label leading-[19px] text-text-secondary">{children}</p>
		</div>
	);
}

/**
 * The rule, stated plainly (AGENTS.md "Outbound sending"): an agent reads and
 * drafts on its own; every send and every critical control-plane change only
 * creates an approval the owner gives on /approve/:id with the web session.
 */
export function AgentPolicyCard(): ReactElement {
	return (
		<SettingsCard aria-labelledby="agent-policy-title">
			<div className="flex flex-col gap-0.5 pt-4 pr-4 pb-3.5 pl-5">
				<h1
					id="agent-policy-title"
					className="m-0 text-title font-semibold tracking-[-0.015em] text-ink"
				>
					Agents read and draft. You approve.
				</h1>
				<p className="m-0 text-label text-text-muted">
					An agent you connect works inside these limits, whatever it is asked to do. Sends and
					critical changes wait for you on this site.
				</p>
			</div>
			<div className="flex flex-col border-t border-border-card md:flex-row">
				<Column first tone="success" title="On its own">
					Read and search mail, write drafts, mark, archive and trash. Routine settings, which you
					can undo.
				</Column>
				<Column tone="approval" title="Only with your approval" titleClassName="text-approval">
					Sending any mail. Creating or rotating API keys. Adding or disabling a domain. Forwarding
					outside your domains. Removing a suppression.
				</Column>
				<Column tone="ink" title="Never">
					Approve its own request. See a key&apos;s secret. Change who owns this inbox.
				</Column>
			</div>
		</SettingsCard>
	);
}
