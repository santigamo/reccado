import { Loader2 } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import { SettingsCard } from "#/components/settings/parts/SettingsParts";
import { Button } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { CenteredSpinner, ErrorState } from "#/components/ui/Feedback";
import { TextField } from "#/components/ui/Field";
import { StatusDot, type StatusTone } from "#/components/ui/StatusDot";
import { useAsyncResource } from "#/lib/use-mail";
import {
	type DeliveryTestResult,
	delivered,
	type RebindResult,
	TelegramApiError,
	type TelegramOperatorStatus,
	telegramApi,
} from "./telegram-api";

const MODE: Record<TelegramOperatorStatus["bridge"]["mode"], { label: string; tone: StatusTone }> =
	{
		on: { label: "On", tone: "success" },
		partial: { label: "Setting up", tone: "approval" },
		failing: { label: "Failing", tone: "danger" },
		off: { label: "Off", tone: "muted" },
	};

function errorText(error: unknown): string {
	if (error instanceof TelegramApiError) return error.message;
	return "The request never reached the server.";
}

function Row({
	label,
	children,
	action,
}: {
	label: string;
	children: ReactNode;
	action?: ReactNode;
}): ReactElement {
	return (
		<div className="flex min-h-10.5 items-center gap-3 border-t border-border-card px-5 py-2.5">
			<span className="w-19 shrink-0 text-label text-text-muted">{label}</span>
			<span className="min-w-0 flex-1 text-label break-words text-text">{children}</span>
			{action}
		</div>
	);
}

function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="shrink-0 text-label font-medium text-text underline decoration-1 underline-offset-2 hover:text-ink"
		>
			{children}
		</button>
	);
}

/** Bind the bridge to another chat: check with Telegram first (dry run), then apply. */
function RebindDialog({
	onClose,
	onDone,
}: {
	onClose: () => void;
	onDone: () => void;
}): ReactElement {
	const [chatId, setChatId] = useState("");
	const [checked, setChecked] = useState<RebindResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function run(dryRun: boolean) {
		setBusy(true);
		setError(null);
		try {
			const result = await telegramApi.rebind(chatId.trim(), dryRun);
			if (dryRun) setChecked(result);
			else onDone();
		} catch (caught) {
			setError(errorText(caught));
			setChecked(null);
		} finally {
			setBusy(false);
		}
	}

	const eligible = checked && (checked.membership === null || checked.membership.eligible);

	return (
		<Dialog
			size="sm"
			onClose={onClose}
			dismissible={!busy}
			title="Change Telegram chat"
			description="Where new-mail and approval notices are posted. Add the bot to the chat first."
			footer={
				<>
					<DialogFooterNote>Topic mappings of the old chat are kept.</DialogFooterNote>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					{checked && eligible && checked.outcome === "would_rebind" ? (
						<Button variant="primary" disabled={busy} onClick={() => void run(false)}>
							{busy ? <Loader2 className="animate-spin" /> : null}
							Use this chat
						</Button>
					) : (
						<Button
							variant="primary"
							type="submit"
							form="telegram-rebind"
							disabled={busy || !chatId.trim()}
						>
							{busy ? <Loader2 className="animate-spin" /> : null}
							Check chat
						</Button>
					)}
				</>
			}
		>
			<form
				id="telegram-rebind"
				className="flex flex-col gap-3"
				onSubmit={(event) => {
					event.preventDefault();
					void run(true);
				}}
			>
				<TextField
					label="Chat id or @username"
					value={chatId}
					onChange={(event) => {
						setChatId(event.target.value);
						setChecked(null);
					}}
					placeholder="-1001234567890"
					autoComplete="off"
					data-autofocus
					hint="Or send /start to the bot from the chat itself."
					error={error ?? undefined}
				/>
				{checked ? (
					<div className="flex flex-col gap-1 rounded-[10px] bg-content px-3.5 py-3 text-label">
						<span className="font-medium text-text">
							{checked.current.title ?? checked.current.chatId} ·{" "}
							{checked.current.isForum ? "forum" : checked.current.type}
						</span>
						{checked.outcome === "would_be_unchanged" ? (
							<span className="text-text-muted">This is already the bound chat.</span>
						) : null}
						{checked.membership ? (
							<span className={checked.membership.eligible ? "text-text-muted" : "text-danger"}>
								{checked.membership.reason}
							</span>
						) : null}
						{checked.notes.map((note) => (
							<span key={note} className="text-text-muted">
								{note}
							</span>
						))}
					</div>
				) : null}
			</form>
		</Dialog>
	);
}

/** Per-mailbox forum topics: shows the mapping and creates a missing topic. */
function TopicsDialog({
	status,
	onClose,
	onChanged,
}: {
	status: TelegramOperatorStatus;
	onClose: () => void;
	onChanged: () => void;
}): ReactElement {
	const [busyId, setBusyId] = useState<string | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});

	async function create(mailboxId: string, name: string) {
		setBusyId(mailboxId);
		setErrors((prev) => ({ ...prev, [mailboxId]: "" }));
		try {
			await telegramApi.createTopic(mailboxId, name);
			onChanged();
		} catch (caught) {
			setErrors((prev) => ({ ...prev, [mailboxId]: errorText(caught) }));
		} finally {
			setBusyId(null);
		}
	}

	return (
		<Dialog
			onClose={onClose}
			title="Telegram topics"
			description="Each mailbox posts into its own forum topic. Missing ones fall back to General."
			footer={
				<>
					<DialogFooterNote>
						Renaming or adopting an existing topic: pnpm operator telegram topic.
					</DialogFooterNote>
					<Button variant="secondary" onClick={onClose}>
						Done
					</Button>
				</>
			}
		>
			<ul className="m-0 flex list-none flex-col p-0">
				{status.mailboxes.map((mailbox) => {
					const name = mailbox.displayName?.trim() || mailbox.address;
					return (
						<li
							key={mailbox.mailboxId}
							className="flex flex-col gap-1 border-b border-border-card py-2.5 last:border-b-0"
						>
							<div className="flex items-center gap-3">
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate text-label font-medium text-text">
										{mailbox.address}
									</span>
									<span className="truncate text-meta text-text-muted">
										{mailbox.topic
											? `Topic “${mailbox.topic.effectiveName}” (#${mailbox.topic.topicId})`
											: "Not mapped"}
									</span>
								</span>
								{mailbox.topic ? (
									<StatusDot tone="success" />
								) : (
									<Button
										size="sm"
										variant="secondary"
										disabled={busyId !== null}
										onClick={() => void create(mailbox.mailboxId, name)}
									>
										{busyId === mailbox.mailboxId ? <Loader2 className="animate-spin" /> : null}
										Create topic
									</Button>
								)}
							</div>
							{errors[mailbox.mailboxId] ? (
								<span role="alert" className="text-meta text-danger">
									{errors[mailbox.mailboxId]}
								</span>
							) : null}
						</li>
					);
				})}
			</ul>
		</Dialog>
	);
}

/**
 * "Telegram notices": the bridge status, the bound chat and its topics, and a
 * delivery test (POST /api/telegram/test). Notices carry a link; approval
 * always happens on this site, never in Telegram.
 */
export function TelegramCard(): ReactElement {
	const status = useAsyncResource<TelegramOperatorStatus | null>(
		() => telegramApi.status(),
		null,
		[],
	);
	const [testing, setTesting] = useState(false);
	const [test, setTest] = useState<DeliveryTestResult | null>(null);
	const [testError, setTestError] = useState<string | null>(null);
	const [dialog, setDialog] = useState<"rebind" | "topics" | null>(null);

	async function sendTest() {
		setTesting(true);
		setTestError(null);
		try {
			setTest(await telegramApi.test());
		} catch (caught) {
			setTest(null);
			setTestError(errorText(caught));
		} finally {
			setTesting(false);
		}
	}

	const data = status.data;
	const mode = data ? MODE[data.bridge.mode] : null;
	const bridgeOff = data?.bridge.mode === "off";
	const bound = Boolean(data?.binding.chatId);
	const isForum = data?.chat?.ok ? data.chat.isForum : (data?.binding.isForum ?? false);
	const mapped = data ? data.mailboxes.filter((m) => m.topic).length : 0;

	return (
		<SettingsCard aria-labelledby="telegram-title">
			<div className="flex items-start gap-3 px-5 pt-4.5 pb-4">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2
						id="telegram-title"
						className="m-0 text-sender font-medium tracking-[-0.01em] text-text"
					>
						Telegram notices
					</h2>
					<p className="m-0 text-label text-text-muted">
						New mail and approval requests arrive as a notice with a link. You approve on this site,
						never in Telegram.
					</p>
				</div>
				{mode ? (
					<span className="flex shrink-0 items-center gap-1.75 text-label font-medium text-text">
						<StatusDot tone={mode.tone} size={6} />
						{mode.label}
					</span>
				) : null}
			</div>

			{status.loading && !data ? (
				<div className="border-t border-border-card">
					<CenteredSpinner />
				</div>
			) : status.error || !data ? (
				<div className="border-t border-border-card">
					<ErrorState message="Could not read the Telegram status." onRetry={status.refetch} />
				</div>
			) : bridgeOff ? (
				<Row label="Status">
					Off. Set the <code className="font-mono text-meta">TELEGRAM_BOT_TOKEN</code> secret to
					turn notices on.
				</Row>
			) : (
				<>
					{data.bridge.reason && data.bridge.mode !== "on" ? (
						<Row label="Needs">{data.bridge.reason}</Row>
					) : null}
					<Row label="Bot">
						{data.bot?.ok ? (
							data.bot.username ? (
								`@${data.bot.username}`
							) : (
								data.bot.firstName
							)
						) : (
							<span className="text-danger">{data.bot?.error ?? "Unknown"}</span>
						)}
					</Row>
					<Row
						label="Chat"
						action={<LinkButton onClick={() => setDialog("rebind")}>Change</LinkButton>}
					>
						{!bound ? (
							<span className="text-text-muted">
								Not bound. Send /start to the bot from your chat.
							</span>
						) : data.chat?.ok ? (
							<>
								{data.chat.title ?? data.chat.id}{" "}
								<span className="text-text-muted">
									· {data.chat.isForum ? "forum" : data.chat.type}
								</span>
							</>
						) : (
							<span className="text-danger">{data.chat?.error ?? data.binding.chatId}</span>
						)}
					</Row>
					{bound && isForum ? (
						<Row
							label="Topics"
							action={<LinkButton onClick={() => setDialog("topics")}>Edit</LinkButton>}
						>
							{mapped} of {data.mailboxes.length} mailboxes mapped
						</Row>
					) : null}
				</>
			)}

			{data && !bridgeOff ? (
				<div className="flex flex-col gap-1 border-t border-border-card bg-content py-3 pr-4 pl-5">
					<div className="flex items-center gap-3">
						<span className="min-w-0 flex-1 text-meta text-text-muted">
							{testing
								? "Sending a labelled test to each mailbox…"
								: test
									? `Test delivered to ${delivered(test)} of ${test.results.length} mailboxes`
									: "Posts a labelled test message per mailbox. It is not mail."}
						</span>
						<Button
							size="sm"
							variant="secondary"
							className="h-8"
							disabled={testing || !bound}
							onClick={() => void sendTest()}
						>
							{testing ? <Loader2 className="animate-spin" /> : null}
							Send test
						</Button>
					</div>
					{testError ? (
						<span role="alert" className="text-meta text-danger">
							{testError}
						</span>
					) : null}
					{test
						? test.results
								.filter((r) => r.reason)
								.map((r) => (
									<span key={r.mailboxId} className="text-meta text-text-muted">
										{r.address}: {r.reason}
									</span>
								))
						: null}
				</div>
			) : null}

			{dialog === "rebind" ? (
				<RebindDialog
					onClose={() => setDialog(null)}
					onDone={() => {
						setDialog(null);
						setTest(null);
						status.refetch();
					}}
				/>
			) : null}
			{dialog === "topics" && data ? (
				<TopicsDialog status={data} onClose={() => setDialog(null)} onChanged={status.refetch} />
			) : null}
		</SettingsCard>
	);
}
