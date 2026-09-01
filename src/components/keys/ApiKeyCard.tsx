import { Ban, Check, Copy, Loader2, RefreshCw } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { Button } from "#/components/ui/Button";
import { IconButton } from "#/components/ui/IconButton";
import { cn } from "#/lib/cn";
import {
	type ApiKeyError,
	asApiKeyError,
	type DisplayStatus,
	displayStatus,
	explainKeyError,
	formatKeyDate,
	maskedKey,
	sendScopeHasTemplateAllowlist,
	sendScopeHasTemplateUse,
	type TransactionalApiKey,
} from "./api-keys";

const STATUS_STYLES: Record<DisplayStatus, { label: string; className: string }> = {
	active: {
		label: "Active",
		className:
			"border-[color-mix(in_oklab,var(--palm)_45%,transparent)] bg-[color-mix(in_oklab,var(--palm)_14%,transparent)] text-[var(--palm)]",
	},
	expired: {
		label: "Expired",
		className:
			"border-[color-mix(in_oklab,var(--app-danger)_40%,transparent)] bg-[color-mix(in_oklab,var(--app-danger)_10%,transparent)] text-[var(--app-danger)]",
	},
	revoked: {
		label: "Revoked",
		className:
			"border-[var(--app-border-strong)] bg-[var(--app-surface-2)] text-[var(--app-text-faint)]",
	},
};

function Meta({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<div className="min-w-0">
			<dt className="text-[11px] uppercase tracking-wide text-[var(--app-text-faint)]">{label}</dt>
			<dd className="mt-0.5 break-words text-[13px] text-[var(--app-text)]">{children}</dd>
		</div>
	);
}

/**
 * One transactional API key. Owns its own destructive-action flow: revoke and
 * rotate both swap the action row for an inline confirmation strip — never a
 * `window.confirm` or any other native browser dialog.
 */
export function ApiKeyCard({
	apiKey,
	onRevoke,
	onRotate,
}: {
	apiKey: TransactionalApiKey;
	onRevoke: () => Promise<void>;
	onRotate: () => Promise<void>;
}): ReactElement {
	const [pending, setPending] = useState<"revoke" | "rotate" | null>(null);
	const [busy, setBusy] = useState<"revoke" | "rotate" | null>(null);
	const [error, setError] = useState<ApiKeyError | null>(null);
	const [copied, setCopied] = useState(false);

	const status = displayStatus(apiKey);
	const statusStyle = STATUS_STYLES[status];
	// The DO only lets an `active` row be rotated or revoked; an expired key is
	// still `active` in storage, so both actions remain available for it.
	const actionable = apiKey.status === "active";

	async function run(action: "revoke" | "rotate") {
		setError(null);
		setBusy(action);
		try {
			await (action === "revoke" ? onRevoke() : onRotate());
			setPending(null);
		} catch (caught) {
			setError(asApiKeyError(caught));
		} finally {
			setBusy(null);
		}
	}

	async function copyKeyId() {
		try {
			await navigator.clipboard.writeText(apiKey.keyId);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard unavailable — the id is selectable in place.
		}
	}

	const explanation = error ? explainKeyError(error) : null;
	// Two ways an active key is refused by the send path no matter what it is asked to
	// send. Creation now rejects both, but keys minted before it did are still out there.
	const missingTemplateUse = status === "active" && !sendScopeHasTemplateUse(apiKey.scopes);
	const missingAllowlist =
		status === "active" &&
		!sendScopeHasTemplateAllowlist(apiKey.scopes, apiKey.templateAllowlist ?? []);

	return (
		<article
			className={cn(
				"rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)] p-4",
				status !== "active" && "opacity-80",
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<code className="font-mono text-sm font-semibold text-[var(--app-text)]">
					{maskedKey(apiKey)}
				</code>
				<span
					className={cn(
						"rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider",
						apiKey.environment === "live"
							? "bg-[var(--app-danger)] text-white shadow-[var(--app-shadow)]"
							: "border border-[var(--app-border-strong)] text-[var(--app-text-soft)]",
					)}
				>
					{apiKey.environment}
				</span>
				<span
					className={cn(
						"rounded-full border px-2 py-0.5 text-[11px] font-medium",
						statusStyle.className,
					)}
				>
					{statusStyle.label}
				</span>
			</div>

			<dl className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
				<Meta label="Sender">{apiKey.sender || "—"}</Meta>
				<Meta label="Key ID">
					<span className="inline-flex items-center gap-1">
						<code className="select-all font-mono text-[12px] text-[var(--app-text-soft)]">
							{apiKey.keyId}
						</code>
						<IconButton
							title={copied ? "Copied" : "Copy key ID"}
							size="sm"
							onClick={() => void copyKeyId()}
						>
							{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
						</IconButton>
					</span>
				</Meta>
				<Meta label="Scopes">
					{apiKey.scopes.length === 0 ? (
						"—"
					) : (
						<span className="flex flex-wrap gap-1">
							{apiKey.scopes.map((scope) => (
								<code
									key={scope}
									className="rounded bg-[var(--app-surface-2)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--app-text-soft)]"
								>
									{scope}
								</code>
							))}
						</span>
					)}
					{missingTemplateUse ? (
						<span className="mt-1 block text-[12px] text-[var(--app-danger)]">
							Missing transactional:templates:use, so every send is refused.
						</span>
					) : null}
				</Meta>
				<Meta label="Quota">
					{apiKey.quotaMax === null ? "Unlimited" : `${apiKey.quotaUsed} / ${apiKey.quotaMax}`}
				</Meta>
				<Meta label="Expires">{formatKeyDate(apiKey.expiresAt)}</Meta>
				<Meta label="Created">{formatKeyDate(apiKey.createdAt)}</Meta>
				{apiKey.templateAllowlist && apiKey.templateAllowlist.length > 0 ? (
					<Meta label="Templates">{apiKey.templateAllowlist.join(", ")}</Meta>
				) : missingAllowlist ? (
					// Hiding the row when the allowlist is empty reads as "no restriction",
					// which is the opposite of what the send path does with it.
					<Meta label="Templates">
						<span className="text-[var(--app-danger)]">
							None allowlisted, so every send is refused. Replace this key with one that names its
							templates.
						</span>
					</Meta>
				) : null}
				{apiKey.recipientPolicy ? (
					<Meta label="Recipient policy">{apiKey.recipientPolicy}</Meta>
				) : null}
				{apiKey.revokedAt ? <Meta label="Revoked">{formatKeyDate(apiKey.revokedAt)}</Meta> : null}
			</dl>

			{error ? (
				<div
					role="alert"
					className="mt-3 rounded-lg border border-[var(--app-danger)] bg-[color-mix(in_oklab,var(--app-danger)_8%,transparent)] px-3 py-2 text-[13px]"
				>
					<p className="font-medium text-[var(--app-danger)]">
						<code className="font-mono">{error.code}</code>
						{error.status ? ` (HTTP ${error.status})` : ""}
					</p>
					{explanation ? <p className="text-[var(--app-text-soft)]">{explanation}</p> : null}
				</div>
			) : null}

			{actionable ? (
				<div className="mt-4 border-t border-[var(--app-border)] pt-3">
					{pending === null ? (
						<div className="flex flex-wrap items-center gap-2">
							<Button size="sm" variant="secondary" onClick={() => setPending("rotate")}>
								<RefreshCw className="h-3.5 w-3.5" />
								Rotate
							</Button>
							<Button size="sm" variant="danger" onClick={() => setPending("revoke")}>
								<Ban className="h-3.5 w-3.5" />
								Revoke
							</Button>
						</div>
					) : (
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
							<p className="text-[13px] text-[var(--app-text)]">
								{pending === "revoke"
									? "Revoke this key? Every request using it starts failing immediately, and this cannot be undone."
									: "Rotate this key? The current secret is revoked immediately and a replacement is shown once."}
							</p>
							<div className="flex shrink-0 items-center gap-2">
								<Button
									size="sm"
									variant="ghost"
									onClick={() => setPending(null)}
									disabled={busy !== null}
								>
									Cancel
								</Button>
								<Button
									size="sm"
									variant={pending === "revoke" ? "danger" : "primary"}
									onClick={() => void run(pending)}
									disabled={busy !== null}
									className={
										pending === "revoke"
											? "border-[var(--app-danger)] bg-[var(--app-danger)] text-white hover:bg-[var(--app-danger)] hover:brightness-110"
											: undefined
									}
								>
									{busy !== null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
									{pending === "revoke" ? "Yes, revoke it" : "Yes, rotate it"}
								</Button>
							</div>
						</div>
					)}
				</div>
			) : null}
		</article>
	);
}
