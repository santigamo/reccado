import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Plus } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import { ApiKeyRow, KEY_COLUMNS } from "./ApiKeyRow";
import {
	asApiKeyError,
	describeApiKeyError,
	displayStatus,
	fetchApiKeys,
	type MintedApiKey,
	revokeApiKey,
	rotateApiKey,
	type TransactionalApiKey,
	updateApiKeySenderName,
} from "./api-keys";
import { CreateApiKeyDialog } from "./CreateApiKeyDialog";
import { OneTimeSecret } from "./OneTimeSecret";

function activeCounts(keys: readonly TransactionalApiKey[]) {
	const active = keys.filter((k) => displayStatus(k) === "active");
	const live = active.filter((k) => k.environment === "live").length;
	return { active: active.length, live, test: active.length - live };
}

function railLabel(keys: readonly TransactionalApiKey[] | null): string {
	if (!keys) return "…";
	if (keys.length === 0) return "No keys";
	const { active, live } = activeCounts(keys);
	if (active === 0) return `${plural(keys.length, "key")} · none active`;
	return `${plural(active, "key")} · ${live === 0 ? "test only" : `${live} live`}`;
}

/**
 * Settings → API keys (Paper "Settings — API keys"). Transactional key
 * management, the admin counterpart to the transactional send API
 * (docs/plans/transactional-api.md). Same-origin fetches, so the session
 * cookie and the Origin header the CSRF guard wants ride along.
 *
 * The plaintext secret returned by create/rotate is held in this component's
 * state and nowhere else — no storage, no URL, no logging — so navigating away
 * destroys it, which is exactly the intended contract.
 */
export function ApiKeysSettings({ mailboxParam }: { mailboxParam?: string }): ReactElement {
	const navigate = useNavigate();
	const loader = useCallback((id: string) => fetchApiKeys(id), []);
	const mailboxes = useSelectedMailbox(mailboxParam, loader);
	const colorOf = useMailboxColors(mailboxes.data);
	const keys = mailboxes.per;
	const feedbackFor = useDeliveryFeedback();
	const [minted, setMinted] = useState<MintedApiKey | null>(null);
	const [creating, setCreating] = useState(false);
	const topRef = useRef<HTMLDivElement | null>(null);

	const selected = mailboxes.selected;
	const selectedId = selected?.mailbox_id ?? null;
	const current = selectedId ? keys.get(selectedId) : null;

	// Active keys first, revoked ones sink to the bottom; each group keeps the
	// server's newest-first ordering.
	const ordered = useMemo(() => {
		const rank = (key: TransactionalApiKey) => (key.status === "revoked" ? 1 : 0);
		return [...(current?.data ?? [])].sort((a, b) => rank(a) - rank(b));
	}, [current?.data]);

	// The one-time secret must never be missed because it rendered off-screen.
	useEffect(() => {
		if (minted) topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [minted]);

	function select(mailboxId: string) {
		// A secret on screen belongs to the mailbox it was minted for; leaving
		// it visible under another mailbox would misattribute it. It stays until
		// acknowledged, so switching is refused while it is shown.
		if (minted) return;
		void navigate({ to: "/settings/keys", search: { mailbox: mailboxId }, replace: true });
	}

	async function handleRevoke(keyId: string) {
		if (!selectedId) return;
		await revokeApiKey(selectedId, keyId);
		keys.refresh(selectedId);
	}

	async function handleRotate(keyId: string) {
		if (!selectedId) return;
		const result = await rotateApiKey(selectedId, keyId);
		setMinted(result);
		keys.refresh(selectedId);
	}

	const counts = activeCounts(current?.data ?? []);
	const feedback = feedbackFor(selected?.primary_address);

	const action = (
		<Button
			variant="primary"
			onClick={() => setCreating(true)}
			disabled={!selected}
			className="h-9 pr-4 pl-3.5"
		>
			<Plus className="size-3.5" />
			New API key
		</Button>
	);

	return (
		<SettingsShell active="keys" action={action}>
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
						icon={<KeyRound />}
						title="No mailboxes yet"
						hint="An API key belongs to a mailbox. Add one under Domains & mailboxes first."
					/>
				</SettingsFill>
			) : (
				<SettingsBody>
					<MailboxRail
						label="Mailboxes"
						mailboxes={mailboxes.ordered}
						selectedId={selectedId}
						colorOf={colorOf}
						onSelect={select}
						lockedReason={minted ? "Store the new key and hide it first." : undefined}
						sublabel={(m) => {
							const state = keys.get(m.mailbox_id);
							return state.error && !state.data ? "Could not load" : railLabel(state.data);
						}}
						footnote="A key belongs to one mailbox and sends from one address. Its secret is shown once."
					/>
					<div ref={topRef} className="flex min-w-0 flex-1 flex-col gap-3.5 scroll-mt-4">
						{mailboxes.unknownRequested || !selected ? (
							<SettingsCard>
								<EmptyState
									title="Mailbox not found"
									hint="It may have been removed. Pick another mailbox on the left."
								/>
							</SettingsCard>
						) : (
							<>
								{minted ? (
									<OneTimeSecret minted={minted} onDismiss={() => setMinted(null)} />
								) : null}

								<MailboxHeaderCard
									color={colorOf(selected.mailbox_id)}
									title={selected.primary_address}
									description="API keys let your app send templated mail from this mailbox. These sends skip your approval, so a live key is a production credential."
									stats={[
										{
											label: "Active keys",
											value: current?.data ? (
												<>
													{counts.active}{" "}
													{counts.active > 0 ? (
														<StatMuted>
															· {counts.live} live, {counts.test} test
														</StatMuted>
													) : null}
												</>
											) : (
												"…"
											),
										},
										{ label: "Default sender", value: selected.primary_address },
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

								<SettingsCard aria-label="Keys">
									<div className="flex h-11 shrink-0 items-center gap-4 px-5">
										<h2
											className={cn(
												"m-0 text-sender font-medium tracking-[-0.01em] text-text",
												KEY_COLUMNS.key,
											)}
										>
											Keys
										</h2>
										<span
											className={cn(
												"hidden shrink-0 text-meta text-text-muted lg:block",
												KEY_COLUMNS.sender,
											)}
										>
											Sends as
										</span>
										<span
											className={cn(
												"hidden text-meta text-text-muted lg:block",
												KEY_COLUMNS.templates,
											)}
										>
											Allowed templates
										</span>
										<span
											className={cn(
												"hidden shrink-0 text-meta text-text-muted lg:block",
												KEY_COLUMNS.quota,
											)}
										>
											Quota used
										</span>
										<span
											className={cn(
												"hidden shrink-0 text-meta text-text-muted lg:block",
												KEY_COLUMNS.expires,
											)}
										>
											Expires
										</span>
										<span className={cn("hidden shrink-0 lg:block", KEY_COLUMNS.actions)} />
									</div>
									{current?.loading && !current.data ? (
										<div className="border-t border-border-card">
											<CenteredSpinner label="Loading keys…" />
										</div>
									) : current?.error ? (
										<div className="border-t border-border-card">
											<ErrorState
												message={describeApiKeyError(asApiKeyError(current.error))}
												onRetry={() => keys.refresh(selected.mailbox_id)}
											/>
										</div>
									) : ordered.length === 0 ? (
										<div className="border-t border-border-card">
											<EmptyState
												icon={<KeyRound />}
												title="No API keys yet"
												hint="Create one to let an application send transactional mail as this mailbox. You can rotate or revoke it at any time."
												action={
													<Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
														<Plus />
														New API key
													</Button>
												}
											/>
										</div>
									) : (
										<ul className="m-0 list-none p-0">
											{ordered.map((key) => (
												<ApiKeyRow
													key={key.keyId}
													apiKey={key}
													highlighted={minted?.key.keyId === key.keyId}
													onRevoke={() => handleRevoke(key.keyId)}
													onRotate={() => handleRotate(key.keyId)}
													onRenameSender={async (senderName) => {
														await updateApiKeySenderName(
															selected.mailbox_id,
															key.keyId,
															senderName,
														);
														keys.refresh(selected.mailbox_id);
													}}
												/>
											))}
										</ul>
									)}
								</SettingsCard>
							</>
						)}
					</div>
				</SettingsBody>
			)}

			{creating && selected ? (
				<CreateApiKeyDialog
					mailboxId={selected.mailbox_id}
					mailboxAddress={selected.primary_address}
					color={colorOf(selected.mailbox_id)}
					onClose={() => setCreating(false)}
					onCreated={(result) => {
						setCreating(false);
						setMinted(result);
						keys.refresh(selected.mailbox_id);
					}}
				/>
			) : null}
		</SettingsShell>
	);
}
