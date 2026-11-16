import { createFileRoute } from "@tanstack/react-router";
import { ConnectedApps } from "#/components/apps/ConnectedApps";
import { AgentPolicyCard } from "#/components/settings/agent-access/AgentPolicyCard";
import { ConnectAgentCard } from "#/components/settings/agent-access/ConnectAgentCard";
import { TelegramCard } from "#/components/settings/agent-access/TelegramCard";
import { SettingsShell } from "#/components/settings/SettingsShell";

export const Route = createFileRoute("/settings/agent-access")({ component: AgentAccessPage });

/**
 * Settings → Agent access (Paper "Settings — Agent access"): the rule, the
 * connected MCP clients with their permissions and revoke, how to connect one,
 * and the Telegram notice channel.
 */
function AgentAccessPage() {
	return (
		<SettingsShell active="agent-access">
			<div className="app-scroll h-full min-h-0 min-w-0 flex-1 overflow-y-auto">
				<div className="flex flex-col gap-4 pb-4 xl:flex-row xl:items-start">
					<div className="flex min-w-0 flex-1 flex-col gap-3.5">
						<AgentPolicyCard />
						<ConnectedApps />
					</div>
					<div className="flex shrink-0 flex-col gap-3.5 xl:w-93">
						<ConnectAgentCard />
						<TelegramCard />
					</div>
				</div>
			</div>
		</SettingsShell>
	);
}
