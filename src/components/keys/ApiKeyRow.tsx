import { Loader2 } from "lucide-react";
import { type ReactElement, useState } from "react";
import { ConfirmStrip, formatDay } from "#/components/settings/parts/SettingsParts";
import { Button } from "#/components/ui/Button";
import { StatusDot } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import {
	type ApiKeyError,
	asApiKeyError,
	displayStatus,
	explainKeyError,
	maskedKey,
	scopeSummary,
	sendScopeHasTemplateAllowlist,
	sendScopeHasTemplateUse,
	type TransactionalApiKey,
} from "./api-keys";

/** Column widths shared by the header row and every key row (Paper "Keys Card"). */
export const KEY_COLUMNS = {
	key: "lg:w-55.5",
	sender: "lg:w-44",
	templates: "lg:min-w-0 lg:flex-1 lg:basis-0",
	quota: "lg:w-29",
	expires: "lg:w-28",
	actions: "lg:w-33",
} as const;

const numberFormat = new Intl.NumberFormat("en-GB");

/** Small rounded "Live" / "Test" badge next to the masked key. */
function EnvBadge({ live, muted }: { live: boolean; muted: boolean }): ReactElement {
	return (
		<span
			className={cn(
				"inline-flex h-4.5 shrink-0 items-center rounded-[9px] text-meta",
				live && !muted
					? "bg-brand px-1.75 font-semibold text-panel"
					: "border border-[#D6DAE0] px-1.5 font-medium",
				muted ? "text-text-muted" : !live && "text-text-secondary",
			)}
		>
			{live ? "Live" : "Test"}
		</span>
	);
}

/**
 * One transactional API key as a table row. Rotate and revoke swap in an
 * inline confirmation strip under the row (never a native dialog); the From
 * display name is edited inline in the same strip.
 */
export function ApiKeyRow({
	apiKey,
	highlighted,
	onRevoke,
	onRotate,
	onRenameSender,
}: {
	apiKey: TransactionalApiKey;
	/** The key whose secret is on screen right now. */
	highlighted?: boolean;
	onRevoke: () => Promise<void>;
	onRotate: () => Promise<void>;
	/** Sets or clears the From display name. A PATCH — the secret is untouched. */
	onRenameSender: (senderName: string | null) => Promise<void>;
}): ReactElement {
	const [pending, setPending] = useState<"revoke" | "rotate" | "name" | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<ApiKeyError | null>(null);
	const [copied, setCopied] = useState(false);
	const [nameDraft, setNameDraft] = useState(apiKey.senderName ?? "");

	const status = displayStatus(apiKey);
	const revoked = status === "revoked";
	// The DO only lets an `active` row be rotated or revoked; an expired key is
	// still `active` in storage, so both actions remain available for it.
	const actionable = apiKey.status === "active";
	// Two ways an active key is refused by the send path no matter what it is asked
	// to send. Creation rejects both, but older keys may still be out there.
	const missingTemplateUse = status === "active" && !sendScopeHasTemplateUse(apiKey.scopes);
	const missingAllowlist =
		status === "active" &&
		!sendScopeHasTemplateAllowlist(apiKey.scopes, apiKey.templateAllowlist ?? []);

	async function run(action: () => Promise<void>) {
		setError(null);
		setBusy(true);
		try {
			await action();
			setPending(null);
		} catch (caught) {
			setError(asApiKeyError(caught));
		} finally {
			setBusy(false);
		}
	}

	async function copyKeyId() {
		try {
			await navigator.clipboard.writeText(apiKey.keyId);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1500);
		} catch {
			// Clipboard unavailable — the id is in the button's title to select.
		}
	}

	const templates = apiKey.templateAllowlist ?? [];
	const capability = [
		scopeSummary(apiKey.scopes),
		apiKey.recipientPolicy ? `recipients ${apiKey.recipientPolicy}` : null,
	]
		.filter(Boolean)
		.join(" · ");

	const quotaRatio =
		apiKey.quotaMax !== null && apiKey.quotaMax > 0
			? Math.min(1, apiKey.quotaUsed / apiKey.quotaMax)
			: null;

	const explanation = error ? explainKeyError(error) : null;

	return (
		<li className="flex flex-col border-t border-border-card">
			<div
				className={cn(
					"flex flex-col gap-3 px-5 py-3.5 lg:min-h-16 lg:flex-row lg:items-center lg:gap-4 lg:py-2.5",
					highlighted && "bg-row-selected",
				)}
			>
				{/* Key */}
				<div className={cn("flex shrink-0 flex-col gap-0.5", KEY_COLUMNS.key)}>
					<div className="flex items-center gap-2">
						<code
							className={cn(
								"font-mono text-label leading-5",
								revoked ? "text-text-muted line-through" : "font-medium text-text",
							)}
						>
							{maskedKey(apiKey)}
						</code>
						<EnvBadge live={apiKey.environment === "live"} muted={revoked} />
					</div>
					<span className="text-meta text-text-muted">
						Created {formatDay(apiKey.createdAt)} ·{" "}
						<button
							type="button"
							onClick={() => void copyKeyId()}
							title={apiKey.keyId}
							className="text-text-muted underline-offset-2 hover:text-text hover:underline"
						>
							{copied ? "Copied" : "Copy ID"}
						</button>
					</span>
				</div>

				{/* Sends as */}
				<div className={cn("flex min-w-0 shrink-0 flex-col gap-0.5", KEY_COLUMNS.sender)}>
					{apiKey.senderName ? (
						<>
							<span
								className={cn(
									"truncate text-label leading-5",
									revoked ? "text-text-muted" : "font-medium text-text",
								)}
							>
								{apiKey.senderName}
							</span>
							<span className="truncate text-meta text-text-muted">{apiKey.sender}</span>
						</>
					) : (
						<span
							className={cn(
								"truncate text-label leading-5",
								revoked ? "text-text-muted" : "text-text",
							)}
						>
							{apiKey.sender || "—"}
						</span>
					)}
					{actionable ? (
						<button
							type="button"
							onClick={() => {
								setNameDraft(apiKey.senderName ?? "");
								setError(null);
								setPending("name");
							}}
							className="self-start text-meta text-text-muted underline decoration-1 underline-offset-2 hover:text-text"
						>
							{apiKey.senderName ? "Change display name" : "Add a display name"}
						</button>
					) : null}
				</div>

				{/* Allowed templates */}
				<div className={cn("flex min-w-0 flex-col gap-0.5", KEY_COLUMNS.templates)}>
					{templates.length > 0 ? (
						<span
							className={cn(
								"font-mono text-label leading-5 break-words",
								revoked ? "text-text-muted" : "text-text",
							)}
						>
							{templates.join(", ")}
						</span>
					) : (
						<span className="text-label leading-5 text-text-muted">No templates</span>
					)}
					{!revoked ? (
						<span className="text-meta text-text-muted" title={apiKey.scopes.join(" ")}>
							{capability}
						</span>
					) : null}
					{missingTemplateUse ? (
						<span className="text-meta text-danger">
							Missing the template scope, so every send is refused.
						</span>
					) : missingAllowlist ? (
						// An empty list reads as "no restriction", which is the opposite of
						// what the send path does with it.
						<span className="text-meta text-danger">
							No templates allowed, so every send is refused. Replace this key.
						</span>
					) : null}
				</div>

				{/* Quota */}
				<div className={cn("flex shrink-0 flex-col gap-1", KEY_COLUMNS.quota)}>
					<span className="lg:hidden text-meta text-text-muted">Quota used</span>
					{apiKey.quotaMax === null ? (
						<span className={cn("text-label", revoked ? "text-text-muted" : "text-text")}>
							Unlimited
						</span>
					) : (
						<>
							<span className={cn("text-label", revoked ? "text-text-muted" : "text-text")}>
								{numberFormat.format(apiKey.quotaUsed)}{" "}
								<span className="text-text-muted">/ {numberFormat.format(apiKey.quotaMax)}</span>
							</span>
							{!revoked && quotaRatio !== null && quotaRatio < 1 ? (
								<span className="flex h-1 w-21 rounded-[2px] bg-pill" aria-hidden="true">
									<span
										className="h-1 rounded-[2px] bg-brand"
										style={{ width: `${Math.max(quotaRatio * 100, 4)}%` }}
									/>
								</span>
							) : null}
						</>
					)}
				</div>

				{/* Expires */}
				<div className={cn("flex shrink-0 flex-col", KEY_COLUMNS.expires)}>
					<span className="lg:hidden text-meta text-text-muted">Expires</span>
					{revoked ? (
						<span className="text-label text-text-muted">
							Revoked {formatDay(apiKey.revokedAt, { year: false })}
						</span>
					) : status === "expired" ? (
						<span className="flex items-center gap-1.75 text-label font-medium text-danger">
							<StatusDot tone="danger" />
							Expired {formatDay(apiKey.expiresAt, { year: false })}
						</span>
					) : (
						<span className="text-label text-text">
							{apiKey.expiresAt ? formatDay(apiKey.expiresAt) : "Never"}
						</span>
					)}
				</div>

				{/* Actions */}
				<div className={cn("flex shrink-0 items-center gap-1 lg:justify-end", KEY_COLUMNS.actions)}>
					{actionable && pending === null ? (
						<>
							<Button
								size="sm"
								variant="secondary"
								className="h-7.5 border-[#D6DAE0]"
								onClick={() => {
									setError(null);
									setPending("rotate");
								}}
							>
								Rotate
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-7.5 px-2 font-normal text-text-muted"
								onClick={() => {
									setError(null);
									setPending("revoke");
								}}
							>
								Revoke
							</Button>
						</>
					) : null}
				</div>
			</div>

			{pending === "rotate" || pending === "revoke" ? (
				<ConfirmStrip
					tone={pending === "revoke" ? "danger" : "neutral"}
					actions={
						<>
							<Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
								Cancel
							</Button>
							<Button
								size="sm"
								variant="primary"
								disabled={busy}
								className={cn(
									"h-7.5",
									pending === "revoke" &&
										"bg-danger shadow-none hover:bg-[color-mix(in_srgb,var(--color-danger)_88%,black)]",
								)}
								onClick={() => void run(pending === "revoke" ? onRevoke : onRotate)}
							>
								{busy ? <Loader2 className="animate-spin" /> : null}
								{pending === "revoke" ? "Yes, revoke it" : "Yes, rotate it"}
							</Button>
						</>
					}
				>
					{pending === "revoke" ? (
						<>
							<span className="font-medium">Revoke this key?</span> Every request using it starts
							failing now. This cannot be undone.
						</>
					) : (
						<>
							<span className="font-medium">Rotate this key?</span> The current secret stops working
							immediately. The new one is shown once.
						</>
					)}
				</ConfirmStrip>
			) : null}

			{pending === "name" ? (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						// Empty means "no name", not an empty name — the address would
						// otherwise render with a stray leading space.
						void run(() => onRenameSender(nameDraft.trim() || null));
					}}
					className="flex flex-col gap-2 border-t border-border-card bg-content py-2.5 pr-4 pl-5 sm:flex-row sm:items-center sm:gap-3"
				>
					<label
						htmlFor={`name-${apiKey.keyId}`}
						className="shrink-0 text-label font-medium text-text"
					>
						Display name
					</label>
					<input
						id={`name-${apiKey.keyId}`}
						value={nameDraft}
						onChange={(event) => setNameDraft(event.target.value)}
						placeholder="e.g. Acme"
						maxLength={64}
						autoComplete="off"
						// biome-ignore lint/a11y/noAutofocus: the strip opens on an explicit click; focus belongs in its only field.
						autoFocus
						className="h-8 w-full min-w-0 rounded-control border border-border bg-panel px-2.5 text-label text-ink outline-none focus:border-brand sm:max-w-64"
					/>
					<span className="min-w-0 flex-1 truncate text-meta text-text-muted">
						{nameDraft.trim()
							? `${nameDraft.trim()} <${apiKey.sender}>`
							: `Sends as ${apiKey.sender}`}
					</span>
					<div className="flex shrink-0 items-center gap-1">
						<Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending(null)}>
							Cancel
						</Button>
						<Button size="sm" variant="primary" type="submit" disabled={busy} className="h-7.5">
							{busy ? "Saving…" : "Save"}
						</Button>
					</div>
				</form>
			) : null}

			{error ? (
				<div
					role="alert"
					className="border-t border-border-card bg-[color-mix(in_srgb,var(--color-danger)_6%,white)] px-5 py-2 text-label"
				>
					<span className="font-medium text-danger">
						<code className="font-mono">{error.code}</code>
						{error.status ? ` (HTTP ${error.status})` : ""}
					</span>
					{explanation ? <span className="text-text-muted"> — {explanation}</span> : null}
				</div>
			) : null}
		</li>
	);
}
