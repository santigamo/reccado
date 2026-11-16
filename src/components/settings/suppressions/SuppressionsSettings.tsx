import { useNavigate } from "@tanstack/react-router";
import { Loader2, ShieldOff } from "lucide-react";
import { type ReactElement, useCallback, useState } from "react";
import {
	ConfirmStrip,
	domainOf,
	formatDay,
	MailboxHeaderCard,
	MailboxRail,
	plural,
	SettingsBody,
	SettingsCard,
	SettingsFill,
	StatMuted,
} from "#/components/settings/parts/SettingsParts";
import {
	useDeliveryFeedback,
	useSelectedMailbox,
} from "#/components/settings/parts/use-settings-data";
import { SettingsShell } from "#/components/settings/SettingsShell";
import { Button } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { StatusDot } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import { useMailboxColors } from "#/lib/mailbox-color";

/** A row of GET /api/mailboxes/:id/suppressions (src/do/mailbox-suppressions.ts). */
export type Suppression = {
	email: string;
	reason: "hard_bounce" | "complaint" | "manual" | "provider_rejected" | string;
	created_at: string;
	expires_at: string | null;
};

class SuppressionError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
	) {
		super(code);
	}
}

async function readOrThrow<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null;
	if (!res.ok) {
		throw new SuppressionError(
			res.status,
			typeof body?.error === "string" ? body.error : `http_${res.status}`,
		);
	}
	return body as T;
}

async function fetchSuppressions(mailboxId: string): Promise<Suppression[]> {
	const body = await readOrThrow<{ suppressions?: Suppression[] }>(
		await fetch(`/api/mailboxes/${encodeURIComponent(mailboxId)}/suppressions`),
	);
	return body.suppressions ?? [];
}

/**
 * The owner removes directly from the web session (no approval: that gate is
 * for agents over MCP, see control-plane kind `suppression_remove`). The DO
 * only drops a provider-originated entry (bounce, complaint, rejection) when
 * `allowProviderRemoval` is true; a manual entry needs no override.
 */
async function removeSuppression(mailboxId: string, row: Suppression): Promise<boolean> {
	const body = await readOrThrow<{ removed?: boolean }>(
		await fetch(`/api/mailboxes/${encodeURIComponent(mailboxId)}/suppressions/remove`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: row.email, allowProviderRemoval: row.reason !== "manual" }),
		}),
	);
	return body.removed === true;
}

const REASONS: Record<string, { label: string; detail: string | null; dot: string }> = {
	hard_bounce: {
		label: "Hard bounce",
		detail: "delivery failed permanently",
		dot: "var(--color-danger)",
	},
	complaint: { label: "Complaint", detail: "marked your mail as spam", dot: "var(--color-danger)" },
	provider_rejected: {
		label: "Rejected by provider",
		detail: "Cloudflare refused the send",
		dot: "var(--color-ink)",
	},
	manual: { label: "Added by hand", detail: null, dot: "var(--color-icon)" },
};

function reasonOf(reason: string) {
	return REASONS[reason] ?? { label: reason, detail: null, dot: "var(--color-icon)" };
}

function railLabel(rows: Suppression[] | null): string {
	if (!rows) return "…";
	return rows.length === 0 ? "None" : `${rows.length} suppressed`;
}

function whySummary(rows: Suppression[]) {
	const bounced = rows.filter((r) => r.reason === "hard_bounce").length;
	const complained = rows.filter((r) => r.reason === "complaint").length;
	const other = rows.length - bounced - complained;
	const parts = [
		bounced ? `${bounced} bounced` : null,
		complained ? `${complained} complained` : null,
		other ? `${other} other` : null,
	].filter((p): p is string => Boolean(p));
	return parts;
}

const COLUMNS = {
	email: "lg:w-79",
	reason: "lg:min-w-0 lg:flex-1 lg:basis-0",
	since: "lg:w-31",
	until: "lg:w-33",
	action: "lg:w-20",
} as const;

function SuppressionRow({
	row,
	domain,
	onRemove,
}: {
	row: Suppression;
	domain: string;
	onRemove: () => Promise<boolean>;
}): ReactElement {
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const reason = reasonOf(row.reason);

	async function remove() {
		setBusy(true);
		setError(null);
		try {
			const removed = await onRemove();
			if (!removed) {
				setError(
					"Nothing was removed: it may have expired or been removed already. Refresh the list.",
				);
				return;
			}
			setConfirming(false);
		} catch (caught) {
			setError(
				caught instanceof SuppressionError
					? `Could not remove it (${caught.code}, HTTP ${caught.status}).`
					: "The request never reached the server.",
			);
		} finally {
			setBusy(false);
		}
	}

	const warning =
		row.reason === "complaint" ? (
			<>
				<span className="font-medium">Send to {row.email} again?</span> Removing it lets your API
				keys mail this person. They reported your mail as spam, and a second complaint harms
				delivery for everyone on {domain}.
			</>
		) : row.reason === "hard_bounce" ? (
			<>
				<span className="font-medium">Send to {row.email} again?</span> The address failed
				permanently. Only remove it if you know it works now: repeated bounces hurt {domain}&apos;s
				reputation.
			</>
		) : row.reason === "provider_rejected" ? (
			<>
				<span className="font-medium">Send to {row.email} again?</span> Cloudflare refused this
				recipient. If its own list still holds the address, it will refuse again.
			</>
		) : (
			<>
				<span className="font-medium">Remove {row.email}?</span> Your API keys can mail this address
				again.
			</>
		);

	return (
		<li className="flex flex-col border-t border-border-card">
			<div className="flex flex-col gap-2 px-5 py-3 lg:min-h-13 lg:flex-row lg:items-center lg:gap-4 lg:py-2">
				<span
					className={cn("min-w-0 shrink-0 truncate text-body font-medium text-text", COLUMNS.email)}
				>
					{row.email}
				</span>
				<span
					className={cn("flex min-w-0 items-center gap-2 text-label text-text", COLUMNS.reason)}
				>
					<StatusDot color={reason.dot} size={6} />
					<span className="min-w-0">
						{reason.label}
						{reason.detail ? <span className="text-text-muted"> · {reason.detail}</span> : null}
					</span>
				</span>
				<span className={cn("shrink-0 text-label text-text", COLUMNS.since)}>
					<span className="text-meta text-text-muted lg:hidden">Since </span>
					{formatDay(row.created_at)}
				</span>
				<span
					className={cn(
						"shrink-0 text-label",
						row.expires_at ? "text-text" : "text-text-muted",
						COLUMNS.until,
					)}
				>
					{row.expires_at ? (
						<>
							<span className="text-meta text-text-muted lg:hidden">Until </span>
							{formatDay(row.expires_at)}
						</>
					) : (
						"Until you remove it"
					)}
				</span>
				<span className={cn("flex shrink-0 lg:justify-end", COLUMNS.action)}>
					{confirming ? null : (
						<Button
							size="sm"
							variant="secondary"
							className="h-7.5"
							onClick={() => setConfirming(true)}
						>
							Remove
						</Button>
					)}
				</span>
			</div>
			{confirming ? (
				<ConfirmStrip
					tone={row.reason === "manual" ? "neutral" : "danger"}
					actions={
						<>
							<Button
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() => setConfirming(false)}
							>
								Keep suppressed
							</Button>
							<Button
								size="sm"
								variant="primary"
								disabled={busy}
								className={cn(
									"h-7.5",
									row.reason !== "manual" &&
										"bg-danger shadow-none hover:bg-[color-mix(in_srgb,var(--color-danger)_88%,black)]",
								)}
								onClick={() => void remove()}
							>
								{busy ? <Loader2 className="animate-spin" /> : null}
								{row.reason === "manual" ? "Remove" : "Remove anyway"}
							</Button>
						</>
					}
				>
					{warning}
					{error ? <span className="mt-0.5 block text-danger">{error}</span> : null}
				</ConfirmStrip>
			) : error ? (
				<p role="alert" className="m-0 px-5 pb-2 text-label text-danger">
					{error}
				</p>
			) : null}
		</li>
	);
}

/**
 * Settings → Suppressions (Paper "Settings — Suppressions"): per mailbox, the
 * recipients its transactional API keys will not send to, and removal.
 */
export function SuppressionsSettings({ mailboxParam }: { mailboxParam?: string }): ReactElement {
	const navigate = useNavigate();
	const loader = useCallback((id: string) => fetchSuppressions(id), []);
	const mailboxes = useSelectedMailbox(mailboxParam, loader);
	const colorOf = useMailboxColors(mailboxes.data);
	const lists = mailboxes.per;
	const feedbackFor = useDeliveryFeedback();

	const selected = mailboxes.selected;
	const current = selected ? lists.get(selected.mailbox_id) : null;
	const rows = current?.data ?? [];
	const feedback = feedbackFor(selected?.primary_address);
	const why = whySummary(rows);

	return (
		<SettingsShell active="suppressions">
			{mailboxes.loading && mailboxes.ordered.length === 0 ? (
				<SettingsFill>
					<CenteredSpinner label="Loading mailboxes…" />
				</SettingsFill>
			) : mailboxes.error ? (
				<SettingsFill>
					<ErrorState
						message={`Could not load mailboxes (${mailboxes.error}).`}
						onRetry={mailboxes.refetch}
					/>
				</SettingsFill>
			) : mailboxes.ordered.length === 0 ? (
				<SettingsFill>
					<EmptyState
						icon={<ShieldOff />}
						title="No mailboxes yet"
						hint="Add one under Domains & mailboxes."
					/>
				</SettingsFill>
			) : (
				<SettingsBody>
					<MailboxRail
						label="Mailboxes"
						mailboxes={mailboxes.ordered}
						selectedId={selected?.mailbox_id ?? null}
						colorOf={colorOf}
						onSelect={(id) =>
							void navigate({
								to: "/settings/suppressions",
								search: { mailbox: id },
								replace: true,
							})
						}
						sublabel={(m) => {
							const state = lists.get(m.mailbox_id);
							return state.error && !state.data ? "Could not load" : railLabel(state.data);
						}}
						footnote="Each mailbox keeps its own list. Entries are added automatically from delivery feedback."
					/>
					<div className="flex min-w-0 flex-1 flex-col gap-3.5">
						{!selected ? (
							<SettingsCard>
								<EmptyState title="Mailbox not found" hint="Pick another mailbox on the left." />
							</SettingsCard>
						) : (
							<>
								<MailboxHeaderCard
									color={colorOf(selected.mailbox_id)}
									title={selected.primary_address}
									description="Addresses that bounced or complained. API keys on this mailbox are refused when they try to send to them, which protects your sender reputation."
									stats={[
										{
											label: "Suppressed",
											value: current?.data ? plural(rows.length, "address", "addresses") : "…",
										},
										{
											label: "Why",
											value: !current?.data ? (
												"…"
											) : why.length === 0 ? (
												<StatMuted>Nothing suppressed</StatMuted>
											) : (
												<>
													{why[0]}
													{why.length > 1 ? (
														<StatMuted> · {why.slice(1).join(" · ")}</StatMuted>
													) : null}
												</>
											),
										},
										{
											label: "Delivery feedback",
											value: feedback ? (
												<span
													className="inline-flex items-center gap-1.75"
													title={feedback.detail ?? undefined}
												>
													<StatusDot tone={feedback.tone} />
													{feedback.label}
												</span>
											) : (
												"…"
											),
										},
									]}
								/>
								<SettingsCard aria-label="Suppressed addresses">
									<div className="flex h-11 shrink-0 items-center gap-4 px-5">
										<h2
											className={cn(
												"m-0 text-sender font-medium tracking-[-0.01em] text-text",
												COLUMNS.email,
											)}
										>
											Will not send to
										</h2>
										<span
											className={cn("hidden text-meta text-text-muted lg:block", COLUMNS.reason)}
										>
											Reason
										</span>
										<span
											className={cn(
												"hidden shrink-0 text-meta text-text-muted lg:block",
												COLUMNS.since,
											)}
										>
											Since
										</span>
										<span
											className={cn(
												"hidden shrink-0 text-meta text-text-muted lg:block",
												COLUMNS.until,
											)}
										>
											Until
										</span>
										<span className={cn("hidden shrink-0 lg:block", COLUMNS.action)} />
									</div>
									{current?.loading && !current.data ? (
										<div className="border-t border-border-card">
											<CenteredSpinner />
										</div>
									) : current?.error ? (
										<div className="border-t border-border-card">
											<ErrorState
												message={
													current.error instanceof SuppressionError
														? `Could not load suppressions (${current.error.code}).`
														: "Could not load suppressions."
												}
												onRetry={() => lists.refresh(selected.mailbox_id)}
											/>
										</div>
									) : rows.length === 0 ? (
										<div className="border-t border-border-card">
											<EmptyState
												icon={<ShieldOff />}
												title="Nobody is suppressed"
												hint="When a send hard-bounces or the recipient marks it as spam, the address lands here and keys stop mailing it."
											/>
										</div>
									) : (
										<ul className="m-0 list-none p-0">
											{rows.map((row) => (
												<SuppressionRow
													key={row.email}
													row={row}
													domain={domainOf(selected.primary_address)}
													onRemove={async () => {
														const removed = await removeSuppression(selected.mailbox_id, row);
														if (removed) lists.refresh(selected.mailbox_id);
														return removed;
													}}
												/>
											))}
										</ul>
									)}
								</SettingsCard>
								<p className="m-0 px-1 text-label text-text-muted">
									Removing an address lifts Reccado&apos;s own block for this mailbox. Cloudflare
									keeps its own account-level list; if it still holds the address, Cloudflare
									refuses the send anyway. Agents can only ask to remove one: that needs your
									approval.
								</p>
							</>
						)}
					</div>
				</SettingsBody>
			)}
		</SettingsShell>
	);
}
