import { Loader2 } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import { ConfirmStrip, SettingsCard } from "#/components/settings/parts/SettingsParts";
import { Button } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { cn } from "#/lib/cn";
import {
	appInitials,
	appName,
	type ConnectedApp,
	formatAppDate,
	formatLastUsed,
	OAuthClientsError,
	orderScopes,
	readJson,
	scopeCopy,
} from "./connected-apps";

const COLUMNS = {
	agent: "lg:w-63",
	scopes: "lg:min-w-0 lg:flex-1 lg:basis-0",
	last: "lg:w-28",
	action: "lg:w-20",
} as const;

function ScopeTag({ scope }: { scope: string }): ReactElement {
	const copy = scopeCopy(scope);
	return (
		<span
			title={`${copy.detail} (${scope})`}
			className={cn(
				"inline-flex h-6 items-center rounded-[7px] border px-2 text-meta whitespace-nowrap",
				copy.gated
					? "border-approval-border bg-approval-surface text-approval"
					: "border-transparent bg-pill text-text-secondary",
			)}
		>
			{copy.label}
		</span>
	);
}

function AgentRow({
	app,
	onChanged,
}: {
	app: ConnectedApp;
	onChanged: () => Promise<void>;
}): ReactElement {
	const [confirming, setConfirming] = useState(false);
	const [revoking, setRevoking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const name = appName(app);

	async function revoke(): Promise<void> {
		setRevoking(true);
		setError(null);
		try {
			const response = await fetch(
				`/api/oauth-clients/${encodeURIComponent(app.client_id)}/revoke`,
				{
					method: "POST",
				},
			);
			if (!response.ok) {
				setError(`Could not revoke it (HTTP ${response.status}).`);
				return;
			}
			setConfirming(false);
			await onChanged();
		} catch {
			setError("The request never reached the server.");
		} finally {
			setRevoking(false);
		}
	}

	const host = app.redirect_hosts.join(", ") || "unknown site";
	const scopes = orderScopes(app.granted_scopes);

	return (
		<li className="flex flex-col border-t border-border-card">
			<div className="flex flex-col gap-3 px-5 py-3.5 lg:min-h-16 lg:flex-row lg:items-center lg:gap-4">
				<div className={cn("flex min-w-0 shrink-0 items-center gap-3", COLUMNS.agent)}>
					<span
						aria-hidden="true"
						className={cn(
							"flex size-8 shrink-0 items-center justify-center rounded-[8px] text-label font-semibold",
							app.authorized
								? "bg-brand text-panel"
								: "border border-dashed border-disabled bg-panel text-text-muted",
						)}
					>
						{appInitials(app)}
					</span>
					<span className="flex min-w-0 flex-col gap-0.5">
						<span className="truncate text-body font-medium text-text">{name}</span>
						<span className="truncate text-meta text-text-muted">
							{host} · since {formatAppDate(app.created_at)}
						</span>
					</span>
				</div>

				<div className={cn("flex min-w-0 flex-wrap gap-1.5", COLUMNS.scopes)}>
					{app.authorized ? (
						scopes.length > 0 ? (
							scopes.map((scope) => <ScopeTag key={scope} scope={scope} />)
						) : (
							<span className="text-label text-text-muted">Authorised with no permissions.</span>
						)
					) : (
						<span className="text-label text-text-muted">
							Registered but never authorised. It cannot do anything.
						</span>
					)}
				</div>

				<div className={cn("shrink-0 text-label text-text", COLUMNS.last)}>
					<span className="text-meta text-text-muted lg:hidden">Last used </span>
					{formatLastUsed(app.last_token_at)}
				</div>

				<div className={cn("flex shrink-0 lg:justify-end", COLUMNS.action)}>
					{confirming ? null : app.authorized ? (
						<Button
							size="sm"
							variant="secondary"
							className="h-7.5"
							onClick={() => setConfirming(true)}
						>
							Revoke
						</Button>
					) : (
						<Button
							size="sm"
							variant="ghost"
							className="h-7.5 px-2 font-normal text-text-muted"
							onClick={() => setConfirming(true)}
						>
							Revoke
						</Button>
					)}
				</div>
			</div>

			{confirming ? (
				<ConfirmStrip
					tone="danger"
					actions={
						<>
							<Button
								size="sm"
								variant="ghost"
								disabled={revoking}
								onClick={() => setConfirming(false)}
							>
								Cancel
							</Button>
							<Button
								size="sm"
								variant="primary"
								disabled={revoking}
								className="h-7.5 bg-danger shadow-none hover:bg-[color-mix(in_srgb,var(--color-danger)_88%,black)]"
								onClick={() => void revoke()}
							>
								{revoking ? <Loader2 className="animate-spin" /> : null}
								{revoking ? "Revoking…" : "Yes, revoke"}
							</Button>
						</>
					}
				>
					<span className="font-medium">Revoke {name}?</span> Its permission is removed now. Access
					it already holds can last up to one hour.
					{error ? <span className="block text-danger">{error}</span> : null}
				</ConfirmStrip>
			) : null}
		</li>
	);
}

type LoadState =
	| { kind: "loading" }
	| { kind: "ready"; apps: ConnectedApp[] }
	| { kind: "unavailable"; message: string }
	| { kind: "error"; message: string };

/**
 * "Connected agents": the owner's MCP OAuth clients with their granted
 * permissions in plain language, and revoke. GET /api/oauth-clients is gated
 * on the MCP owner (requireMcpOwner); when this identity is not one — e.g. the
 * localhost dev identity with no owner registered — it says so instead of
 * failing.
 */
export function ConnectedApps(): ReactElement {
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const load = useCallback(async (): Promise<void> => {
		try {
			const body = await fetch("/api/oauth-clients").then((r) =>
				readJson<{ clients: ConnectedApp[] }>(r),
			);
			setState({ kind: "ready", apps: body.clients });
		} catch (error) {
			if (error instanceof OAuthClientsError && (error.status === 503 || error.status === 403)) {
				setState({
					kind: "unavailable",
					message:
						error.code === "mcp_not_configured"
							? "No owner is registered on this deployment, so no agent can connect yet. Register an owner (owner registry or OWNER_BOOTSTRAP_EMAILS) and sign in as them."
							: "Only the deployment owner can see and manage connected agents.",
				});
				return;
			}
			setState({ kind: "error", message: "Could not load connected agents." });
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<SettingsCard aria-labelledby="connected-agents-title">
			<div className="flex h-11 shrink-0 items-center gap-4 px-5">
				<h2
					id="connected-agents-title"
					className={cn("m-0 text-sender font-medium tracking-[-0.01em] text-text", COLUMNS.agent)}
				>
					Connected agents
				</h2>
				<span className={cn("hidden text-meta text-text-muted lg:block", COLUMNS.scopes)}>
					What you allowed
				</span>
				<span className={cn("hidden shrink-0 text-meta text-text-muted lg:block", COLUMNS.last)}>
					Last used
				</span>
				<span className={cn("hidden shrink-0 lg:block", COLUMNS.action)} />
			</div>
			<div className="border-t border-border-card empty:hidden">
				{state.kind === "loading" ? <CenteredSpinner label="Loading agents…" /> : null}
				{state.kind === "error" ? (
					<ErrorState message={state.message} onRetry={() => void load()} />
				) : null}
				{state.kind === "unavailable" ? (
					<EmptyState title="Agent access is not available here" hint={state.message} />
				) : null}
				{state.kind === "ready" && state.apps.length === 0 ? (
					<EmptyState
						title="No agents connected"
						hint="Connect one with the MCP address on this page. It shows up here once you allow it."
					/>
				) : null}
			</div>
			{state.kind === "ready" && state.apps.length > 0 ? (
				<ul className="m-0 list-none p-0">
					{state.apps.map((app) => (
						<AgentRow key={app.client_id} app={app} onChanged={load} />
					))}
				</ul>
			) : null}
		</SettingsCard>
	);
}
