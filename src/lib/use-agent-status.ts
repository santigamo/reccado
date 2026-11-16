import { useAsyncResource } from "./use-mail";

type OAuthClient = { authorized: boolean; granted_scopes: string[] };

export type AgentStatus =
	/** At least one authorized MCP client. */
	| { state: "connected"; clients: number; canRead: boolean; canDraft: boolean }
	/** The owner has no authorized MCP client. */
	| { state: "none" }
	/** Not known (loading, not the MCP owner, endpoint failed) — render nothing. */
	| { state: "unknown" };

async function fetchAgentStatus(): Promise<AgentStatus> {
	const res = await fetch("/api/oauth-clients");
	if (!res.ok) return { state: "unknown" };
	const data = (await res.json()) as { clients?: OAuthClient[] };
	const authorized = (data.clients ?? []).filter((c) => c.authorized);
	if (authorized.length === 0) return { state: "none" };
	const scopes = new Set(authorized.flatMap((c) => c.granted_scopes));
	return {
		state: "connected",
		clients: authorized.length,
		canRead: scopes.has("mail:read"),
		canDraft: scopes.has("mail:draft"),
	};
}

/**
 * Whether an agent (an authorized MCP client) is connected, from
 * GET /api/oauth-clients. "Never sends alone" is always true: every MCP send
 * needs the owner's approval on /approve/:id (AGENTS.md invariant).
 */
export function useAgentStatus(): AgentStatus {
	const { data } = useAsyncResource<AgentStatus>(
		() => fetchAgentStatus().catch((): AgentStatus => ({ state: "unknown" })),
		{ state: "unknown" },
		[],
	);
	return data;
}
