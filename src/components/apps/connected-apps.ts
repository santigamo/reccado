/**
 * Contract for "Connected agents" on Settings → Agent access: the shape
 * GET /api/oauth-clients returns, plus the pure helpers the component renders from.
 */

import { formatDay } from "#/lib/dates";
import { MCP_SCOPES } from "#/lib/mcp-scopes";

export type ConnectedApp = {
	client_id: string;
	name: string | null;
	redirect_hosts: string[];
	granted_scopes: string[];
	authorized: boolean;
	created_at: string | null;
	last_token_at: string | null;
};

export function appName(app: Pick<ConnectedApp, "name" | "client_id">): string {
	return app.name?.trim() || `App ${app.client_id.slice(0, 8)}`;
}

/** "Claude Code" -> "CC", "Claude" -> "C", "App 9f3c2e1a" -> "A". */
export function appInitials(app: Pick<ConnectedApp, "name" | "client_id">): string {
	if (!app.name?.trim()) return "A";
	const words = app.name.trim().split(/\s+/).filter(Boolean);
	return words
		.slice(0, 2)
		.map((w) => w[0] ?? "")
		.join("")
		.toUpperCase();
}

export function formatAppDate(iso: string | null): string {
	if (!iso) return "—";
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? "—" : formatDay(date);
}

/** "Today", "Yesterday", or a date; "Never" when no token was ever issued. */
export function formatLastUsed(iso: string | null, now: Date = new Date()): string {
	if (!iso) return "Never";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "Never";
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diffDays = Math.round((day(now) - day(date)) / 86_400_000);
	if (diffDays <= 0) return "Today";
	if (diffDays === 1) return "Yesterday";
	return formatAppDate(iso);
}

export type ScopeCopy = {
	label: string;
	detail: string;
	/** Something under this scope waits for the owner's approval on this site. */
	gated: boolean;
};

/**
 * Plain-language label for every MCP scope (src/lib/mcp-scopes.ts). `gated`
 * marks the scopes whose writes (or some of them) only ever create an approval
 * request: the agent asks, the owner approves on /approve/:id.
 */
export const SCOPE_COPY: Record<(typeof MCP_SCOPES)[number], ScopeCopy> = {
	"mail:read": {
		label: "Read mail",
		detail: "Read and search messages in every mailbox.",
		gated: false,
	},
	"mail:read:sensitive": {
		label: "Read sensitive mail",
		detail:
			"Also read verification codes and password-reset links from other services. Reccado's own sign-in mail is never exposed.",
		gated: false,
	},
	"mail:draft": {
		label: "Draft and organise",
		detail: "Write and edit drafts; mark read, archive and trash.",
		gated: false,
	},
	"mail:send": {
		label: "Ask to send",
		detail: "Propose messages. Each one is sent only after you approve it on this site.",
		gated: true,
	},
	"config:read": {
		label: "View settings",
		detail: "See health, events and configuration. Never secrets.",
		gated: false,
	},
	"mailboxes:write": {
		label: "Manage mailboxes",
		detail: "Create, rename and disable mailboxes. Undoable.",
		gated: false,
	},
	"templates:write": {
		label: "Manage templates",
		detail: "Create, edit and archive transactional templates. Undoable.",
		gated: false,
	},
	"routing:write": {
		label: "Manage routing",
		detail: "Aliases and routing rules. Forwarding outside your domains needs your approval.",
		gated: true,
	},
	"domains:write": {
		label: "Manage domains",
		detail: "Adding, provisioning or disabling a domain needs your approval.",
		gated: true,
	},
	"keys:write": {
		label: "Manage API keys",
		detail: "Creating or rotating a key needs your approval, and only you ever see the secret.",
		gated: true,
	},
	"suppressions:write": {
		label: "Remove suppressions",
		detail: "Each removal needs your approval.",
		gated: true,
	},
};

/** Copy for a granted scope string, including ones this build no longer issues (e.g. legacy `admin`). */
export function scopeCopy(scope: string): ScopeCopy {
	if (scope in SCOPE_COPY) return SCOPE_COPY[scope as keyof typeof SCOPE_COPY];
	if (scope === "offline_access") {
		return {
			label: "Stay connected",
			detail: "Renews its access without a new login, until you revoke it here.",
			gated: false,
		};
	}
	if (scope === "admin") {
		return {
			label: "Legacy admin",
			detail:
				"A scope from an older version. It grants no tool today; reconnect to choose current permissions.",
			gated: false,
		};
	}
	return {
		label: scope,
		detail: "Not a scope this deployment knows; it grants nothing.",
		gated: false,
	};
}

/** Granted scopes in the canonical MCP_SCOPES order, unknown ones last. */
export function orderScopes(scopes: readonly string[]): string[] {
	const rank = (s: string) => {
		const i = (MCP_SCOPES as readonly string[]).indexOf(s);
		return i === -1 ? MCP_SCOPES.length : i;
	};
	return [...new Set(scopes)].sort((a, b) => rank(a) - rank(b));
}

export class OAuthClientsError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | null,
	) {
		super(code ?? `HTTP ${status}`);
	}
}

export async function readJson<T>(response: Response): Promise<T> {
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
		throw new OAuthClientsError(
			response.status,
			typeof body?.error === "string" ? body.error : null,
		);
	}
	return (await response.json()) as T;
}
