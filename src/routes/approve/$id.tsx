import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { type ReactElement, type ReactNode, useEffect, useState } from "react";
import { displayLabel, displayTitle, displayWarning, statusCopy } from "#/components/approval-page";
import {
	CheckCircleIcon,
	CheckIcon,
	ClockIcon,
	LockIcon,
	ProgressArcIcon,
	WarningIcon,
	XCircleIcon,
} from "#/components/auth/icons";
import { OneTimeReveal, useUnloadGuard } from "#/components/auth/OneTimeReveal";
import {
	AuthPage,
	Brand,
	Card,
	Checkbox,
	Eyebrow,
	InlineError,
	PrimaryButton,
	SecondaryButton,
} from "#/components/auth/primitives";
import { EmailHtmlBody } from "#/components/mail/MessageItem";
import { cn } from "#/lib/cn";

type ApprovalField = { label: string; value: string; format?: "text" | "pre" | "list" };

type ApprovalView = {
	id: string;
	kind: string;
	status: string;
	title: string;
	fields: ApprovalField[];
	warnings: Array<{ code: string; message: string }>;
	payloadHash: string | null;
	/** ISO timestamp; null only for an unknown id (already rendered as expired). */
	expiresAt: string | null;
};

const loadApproval = createServerFn({ method: "GET" })
	.validator((id: string) => {
		if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("missing id");
		return id;
	})
	.handler(
		async ({
			data,
		}): Promise<{ unauthenticated: true } | { unauthenticated: false; view: ApprovalView }> => {
			const { getRequest } = await import("@tanstack/react-start/server");
			const { env } = await import("cloudflare:workers");
			const { requireAuth } = await import("../../api/auth");
			const { getIntentView } = await import("../../lib/approvals");
			const request = getRequest();
			try {
				const auth = await requireAuth(request, env, { disableCookieCache: true });
				const view = await getIntentView(env, data, { userId: auth.userId });
				return { unauthenticated: false, view };
			} catch (error) {
				if (error instanceof Response && error.status === 401) return { unauthenticated: true };
				throw error;
			}
		},
	);

export const Route = createFileRoute("/approve/$id")({
	loader: async ({ params }) => {
		const result = await loadApproval({ data: params.id });
		if (result.unauthenticated) {
			throw redirect({ href: `/login?next=${encodeURIComponent(`/approve/${params.id}`)}` });
		}
		return result.view;
	},
	head: () => ({ meta: [{ title: "Approval · Reccado" }] }),
	component: ApprovePage,
});

/** The rendered HTML part of a pending send, tied to the hash this page approves. */
function approvalHtmlSrc(id: string, payloadHash: string | null): string | null {
	if (!payloadHash) return null;
	return `/api/approvals/${encodeURIComponent(id)}/html?hash=${encodeURIComponent(payloadHash)}`;
}

/** Subtitle under the pending title. The email one is shorter on a phone. */
function pendingSubtitle(kind: string): { full: string; short: string } {
	if (kind === "send") {
		return {
			full: "An agent connected over MCP asked to send it. This is exactly what will go out; it cannot change after you approve.",
			short: "An agent asked to send it. This is exactly what will go out.",
		};
	}
	if (kind === "api_key_create" || kind === "api_key_rotate" || kind === "api_key_scopes") {
		const text =
			"An agent connected over MCP asked for this change. Nothing is created until you approve. The secret is then shown to you once, and never to the agent.";
		return { full: text, short: text };
	}
	const text =
		"An agent connected over MCP asked for this change. Nothing changes until you approve, and exactly this is what will be applied.";
	return { full: text, short: text };
}

function revealTitle(kind: string): string {
	if (kind === "api_key_create") return "API key created. Copy it now.";
	if (kind === "api_key_rotate" || kind === "api_key_scopes")
		return "New API key issued. Copy it now.";
	return "Change applied. Copy the secret now.";
}

/** Remaining whole seconds until `expiresAt`, never below zero. */
function remainingSeconds(expiresAt: string | null, now: number): number | null {
	if (!expiresAt) return null;
	const at = Date.parse(expiresAt);
	if (Number.isNaN(at)) return null;
	return Math.max(0, Math.ceil((at - now) / 1000));
}

function formatCountdown(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = String(seconds % 60).padStart(2, "0");
	return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * The owner's approval page. Opened from the URL an MCP tool returns or from
 * the Telegram notice (mostly on a phone), with the owner web session. It shows
 * the frozen payload exactly as the server rendered it, then POSTs approve
 * (bound to `payloadHash`) or deny. The countdown is cosmetic: the server
 * enforces expiry on its own clock.
 */
function ApprovePage(): ReactElement {
	const view = Route.useLoaderData();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// One-time secrets from the approve response. Held in memory only; a reload loses them.
	const [reveal, setReveal] = useState<Array<{ label: string; value: string }> | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const [leaving, setLeaving] = useState(false);
	const [now, setNow] = useState(() => Date.now());

	const pending = view.status === "pending";
	const remaining = remainingSeconds(view.expiresAt, now);
	const expiredByClock = pending && remaining === 0;
	const ticking = pending && !reveal && remaining !== null && remaining > 0;

	useEffect(() => {
		if (!ticking) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [ticking]);

	useUnloadGuard(Boolean(reveal) && !leaving);
	useEffect(() => {
		if (leaving) window.location.reload();
	}, [leaving]);

	async function approve(): Promise<void> {
		if (!view.payloadHash) return;
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/approvals/${encodeURIComponent(view.id)}/approve`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ payloadHash: view.payloadHash }),
			});
			if (!response.ok) {
				setError("Not approved. The request is still pending or is no longer valid.");
				setBusy(false);
				return;
			}
			const result = (await response.json().catch(() => null)) as {
				reveal?: Array<{ label: string; value: string }>;
			} | null;
			if (result?.reveal?.length) {
				setReveal(result.reveal);
				setBusy(false);
				return;
			}
			window.location.reload();
		} catch {
			setError("Not approved. The request is still pending or is no longer valid.");
			setBusy(false);
		}
	}

	async function deny(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/approvals/${encodeURIComponent(view.id)}/deny`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			if (!response.ok) {
				setError("Could not deny it. Try again.");
				setBusy(false);
				return;
			}
			window.location.reload();
		} catch {
			setError("Could not deny it. Try again.");
			setBusy(false);
		}
	}

	if (reveal) {
		return (
			<AuthPage className="gap-4">
				<Brand />
				<Card as="article" className="max-w-[680px]" aria-labelledby="approval-title">
					<StatusRow
						icon={<CheckCircleIcon size={16} />}
						label="Approved · change applied"
						className="h-12 px-7 text-success"
					/>
					<PageHeading
						title={revealTitle(view.kind)}
						subtitle="This is the only time the secret is shown, and only to you. The agent that asked for it never receives it."
					/>
					<div className="flex flex-col gap-3.5 px-5 pb-6 sm:px-7">
						{reveal.map((item) => (
							<OneTimeReveal key={item.label} label={displayLabel(item.label)} value={item.value} />
						))}
						{view.fields.length > 0 && <FieldTable fields={view.fields} dense />}
					</div>
					<footer className="flex flex-col gap-3 border-t border-border-card bg-content px-5 py-3.5 sm:flex-row sm:items-center sm:gap-2.5 sm:pl-7 sm:pr-6">
						<Checkbox
							className="grow items-center"
							checked={acknowledged}
							onChange={setAcknowledged}
						>
							I have stored this key somewhere safe.
						</Checkbox>
						<PrimaryButton
							disabled={!acknowledged || leaving}
							onClick={() => setLeaving(true)}
							className="h-12 sm:h-9 sm:px-[18px]"
						>
							Done, hide it
						</PrimaryButton>
					</footer>
				</Card>
			</AuthPage>
		);
	}

	if (!pending || expiredByClock) {
		const status = expiredByClock ? "expired" : view.status;
		return (
			<AuthPage>
				<Brand />
				<TerminalCard status={status} kind={view.kind} fields={view.fields} />
			</AuthPage>
		);
	}

	const subtitle = pendingSubtitle(view.kind);
	const canAct = Boolean(view.payloadHash);
	const countdown = remaining === null ? null : formatCountdown(remaining);

	return (
		<AuthPage className="justify-start gap-3 px-4 pb-[calc(140px+env(safe-area-inset-bottom))] pt-4 sm:justify-center sm:gap-5 sm:pb-10 sm:pt-10">
			<div className="flex w-full max-w-[680px] items-center gap-2 sm:w-auto">
				<Brand compact className="grow sm:hidden" />
				<Brand className="hidden sm:flex" />
				{countdown && (
					<p className="flex h-7 items-center gap-1.5 rounded-pill border border-approval-border bg-approval-surface px-2.5 text-[13px] font-medium leading-[18px] text-approval sm:hidden">
						<ClockIcon size={14} />
						Expires in <Countdown value={countdown} />
					</p>
				)}
			</div>
			<Card
				as="article"
				tone="approval"
				aria-labelledby="approval-title"
				className="max-w-[680px] overflow-visible border-0 bg-transparent shadow-none sm:overflow-clip sm:border sm:bg-panel sm:shadow-[0_1px_2px_#1B2A410F,0_24px_48px_-12px_#1B2A4124]"
			>
				<div className="hidden h-12 shrink-0 items-center gap-2.5 border-b border-approval-border bg-approval-surface pl-7 pr-6 sm:flex">
					<span aria-hidden="true" className="size-[7px] shrink-0 rounded-[4px] bg-approval" />
					<p className="grow text-[13px] font-medium leading-[18px] text-approval">
						Awaiting your approval
					</p>
					{countdown && (
						<p className="flex items-center gap-2.5 text-[13px] leading-[18px] text-approval">
							<ClockIcon />
							<span>
								Expires in <Countdown value={countdown} />
							</span>
						</p>
					)}
				</div>

				<div className="flex flex-col gap-3 sm:gap-3.5 sm:px-7 sm:pb-6">
					<header className="order-1 flex flex-col gap-1.5 px-1 pb-0.5 pt-1.5 sm:px-0 sm:pb-1 sm:pt-6">
						<h1
							id="approval-title"
							className="text-[22px] font-semibold leading-7 tracking-[-0.02em] text-ink sm:text-[20px] sm:leading-[26px] sm:tracking-[-0.015em]"
						>
							{displayTitle(view.title)}
						</h1>
						<p className="text-[15px] leading-[21px] text-text-secondary sm:text-[14px] sm:leading-5 sm:text-text-muted">
							<span className="sm:hidden">{subtitle.short}</span>
							<span className="hidden sm:inline">{subtitle.full}</span>
						</p>
					</header>

					{view.warnings.length > 0 && (
						<ul
							aria-label="Warnings"
							className="order-2 flex flex-col gap-1.5 rounded-[10px] border border-approval-border bg-approval-surface px-3.5 py-2.5 sm:order-3"
						>
							{view.warnings.map((warning) => (
								<li
									key={`${warning.code}:${warning.message}`}
									className="flex items-start gap-2.5 text-[13px] leading-[19px] text-text"
								>
									<WarningIcon className="mt-0.5" />
									<span>{displayWarning(warning)}</span>
								</li>
							))}
						</ul>
					)}

					<div className="order-3 sm:order-2">
						{view.kind === "send" ? (
							<EmailPreview
								fields={view.fields}
								htmlSrc={approvalHtmlSrc(view.id, view.payloadHash)}
							/>
						) : view.fields.length > 0 ? (
							<FieldTable fields={view.fields} />
						) : (
							<p className="rounded-card border border-border bg-panel px-[18px] py-3 text-[14px] leading-5 text-text-muted">
								This request has no details to show.
							</p>
						)}
					</div>
				</div>

				<footer className="fixed inset-x-0 bottom-0 z-10 flex flex-col gap-2.5 border-t border-border-card bg-panel px-4 pb-[max(30px,env(safe-area-inset-bottom))] pt-3.5 shadow-[0_-8px_24px_-8px_#1B2A411F] sm:static sm:flex-row sm:items-center sm:gap-2 sm:bg-content sm:pb-3.5 sm:pl-5 sm:pr-6 sm:shadow-none">
					{error && <InlineError className="sm:order-last sm:basis-full">{error}</InlineError>}
					{canAct ? (
						<div className="flex items-center gap-2.5 sm:gap-2">
							<PrimaryButton
								disabled={busy}
								aria-busy={busy}
								onClick={() => void approve()}
								className="order-2 h-12 grow text-[16px] sm:order-1 sm:h-9 sm:grow-0 sm:pl-3.5 sm:pr-4 sm:text-[14px]"
							>
								<CheckIcon size={18} color="#FFFFFF" strokeWidth={2.2} />
								{view.kind === "send" ? "Approve & send" : "Approve"}
							</PrimaryButton>
							<SecondaryButton
								disabled={busy}
								onClick={() => void deny()}
								className="order-1 h-12 px-[22px] text-[16px] sm:order-2 sm:h-9 sm:px-4 sm:text-[14px]"
							>
								Deny
							</SecondaryButton>
						</div>
					) : (
						<p className="text-[13px] leading-[18px] text-text-muted">
							This request cannot be approved from here.
						</p>
					)}
					<p className="flex items-center justify-center gap-1.5 text-[13px] leading-[18px] text-text-muted sm:ml-auto sm:gap-2">
						<LockIcon color="#6B6B6B" />
						Only you can approve this · single use
					</p>
				</footer>
			</Card>
		</AuthPage>
	);
}

function Countdown({ value }: { value: string }): ReactElement {
	return (
		<span className="font-mono font-medium tabular-nums" suppressHydrationWarning>
			{value}
		</span>
	);
}

function PageHeading({ title, subtitle }: { title: string; subtitle: string }): ReactElement {
	return (
		<header className="flex flex-col gap-1.5 px-5 pb-4 pt-5 sm:px-7">
			<h1
				id="approval-title"
				className="text-[20px] font-semibold leading-[26px] tracking-[-0.015em] text-ink"
			>
				{title}
			</h1>
			<p className="text-[14px] leading-5 text-text-muted">{subtitle}</p>
		</header>
	);
}

function StatusRow({
	icon,
	label,
	trailing,
	className,
}: {
	icon: ReactNode;
	label: string;
	trailing?: ReactNode;
	className?: string;
}): ReactElement {
	return (
		<div
			className={cn(
				"flex shrink-0 items-center gap-2.5 border-b border-border-card bg-content",
				className,
			)}
		>
			{icon}
			<p className="grow text-[13px] font-medium leading-[18px]">{label}</p>
			{trailing}
		</div>
	);
}

const TONE_CLASS: Record<string, string> = {
	muted: "text-text-secondary",
	progress: "text-brand",
	success: "text-success",
	danger: "text-danger",
	approval: "text-approval",
};

function statusIcon(status: string): ReactNode {
	switch (status) {
		case "approved":
			return (
				<ProgressArcIcon className="animate-spin [animation-duration:1.6s] motion-reduce:animate-none" />
			);
		case "sent":
		case "executed":
			return <CheckCircleIcon />;
		case "failed":
			return <XCircleIcon filled color="var(--color-danger)" />;
		case "denied":
			return <XCircleIcon />;
		case "stale":
			return <WarningIcon color="var(--color-text-muted)" />;
		default:
			return <ClockIcon color="var(--color-text-muted)" />;
	}
}

/** One card per terminal status (and for a pending request whose clock ran out). */
function TerminalCard({
	status,
	kind,
	fields,
}: {
	status: string;
	kind: string;
	fields: ApprovalField[];
}): ReactElement {
	const copy = statusCopy(status, kind);
	return (
		<Card
			as="article"
			aria-labelledby="approval-title"
			className="max-w-[480px] rounded-panel shadow-[0_1px_2px_#1B2A410F,0_12px_24px_-12px_#1B2A4114]"
		>
			<StatusRow
				icon={statusIcon(status)}
				label={copy.label}
				className={cn("h-[42px] px-5", TONE_CLASS[copy.tone])}
				trailing={
					<code className="font-mono text-[12px] font-normal leading-4 text-text-muted">
						{status}
					</code>
				}
			/>
			<div className="flex flex-col gap-1.5 p-5">
				<h1
					id="approval-title"
					className="text-[16px] font-semibold leading-[22px] tracking-[-0.01em] text-ink"
				>
					{copy.title}
				</h1>
				<p className="text-[14px] leading-[21px] text-text-muted">{copy.body}</p>
			</div>
			{fields.length > 0 && (
				<details className="group border-t border-border-card">
					<summary className="flex h-11 cursor-pointer list-none items-center px-5 text-[13px] font-medium text-text-secondary outline-none hover:text-ink focus-visible:bg-row-selected [&::-webkit-details-marker]:hidden">
						<span className="grow">What was requested</span>
						<span aria-hidden="true" className="transition-transform group-open:rotate-180">
							▾
						</span>
					</summary>
					<div className="px-5 pb-5">
						<FieldTable fields={fields} dense />
					</div>
				</details>
			)}
		</Card>
	);
}

const MONO_LABELS = new Set([
	"Permisos",
	"Plantillas permitidas",
	"Clave",
	"Patrón",
	"Zona",
	"Zona Cloudflare",
]);

/** A field value in its server-declared format. Empty or "—" reads muted. */
function FieldValue({
	field,
	size = "md",
}: {
	field: ApprovalField;
	size?: "sm" | "md";
}): ReactElement {
	const text = size === "sm" ? "text-[13px] leading-5" : "text-[14px] leading-5";
	// The server writes "—" or "(vacío)" for an unset value.
	if (field.value === "" || field.value === "—" || field.value === "(vacío)") {
		return (
			<span className={cn("text-text-muted", text)}>{field.value === "" ? "(empty)" : "—"}</span>
		);
	}
	if (field.format === "pre") {
		return (
			<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-content p-2.5 font-mono text-[12px] leading-[18px] text-text">
				{field.value}
			</pre>
		);
	}
	if (field.format === "list") {
		return (
			<ul className={cn("flex list-disc flex-col gap-1 pl-4 text-text", text)}>
				{field.value.split("\n").map((item, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: server-rendered rows, never reordered
					<li key={`${i}:${item}`} className="break-all">
						{item}
					</li>
				))}
			</ul>
		);
	}
	if (field.label === "Entorno") {
		return (
			<span className="inline-flex h-[22px] items-center rounded-[6px] bg-pill px-2 font-mono text-[12px] font-medium leading-4 text-text">
				{field.value}
			</span>
		);
	}
	return (
		<span
			className={cn(
				"whitespace-pre-wrap text-text",
				MONO_LABELS.has(field.label) ? "font-mono text-[13px] leading-5" : text,
				field.label === "Remitente" && "font-medium",
			)}
		>
			{field.value}
		</span>
	);
}

/** The control-plane layout: a bordered list of label/value rows. */
function FieldTable({
	fields,
	dense = false,
}: {
	fields: ApprovalField[];
	dense?: boolean;
}): ReactElement {
	return (
		<dl className="flex flex-col overflow-clip rounded-card border border-border bg-panel">
			{fields.map((field, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: server-rendered rows, never reordered
					key={`${index}:${field.label}`}
					className={cn(
						"flex flex-col gap-1 border-t border-border px-[18px] first:border-t-0 sm:flex-row sm:items-start sm:gap-3",
						dense ? "min-h-[34px] py-1.5" : "min-h-10 py-2.5 sm:py-2",
					)}
				>
					<dt className="shrink-0 text-[13px] leading-5 text-text-muted sm:w-[140px]">
						{displayLabel(field.label)}
					</dt>
					<dd className="min-w-0 grow">
						<FieldValue field={field} />
					</dd>
				</div>
			))}
		</dl>
	);
}

/**
 * The send layout: headers (From, Reply-To, To, Cc, Bcc, Subject, and any
 * other field the server adds) above the message body; HTML source and
 * attachment hashes, when present, below it. Every field the server sent is
 * shown somewhere.
 */
function EmailPreview({
	fields,
	htmlSrc,
}: {
	fields: ApprovalField[];
	/** The rendered HTML part, bound to the payload hash this page approves. */
	htmlSrc: string | null;
}): ReactElement {
	const BODY = new Set(["Mensaje", "HTML", "Adjuntos"]);
	const headers = fields.filter((field) => !BODY.has(field.label));
	const message = fields.find((field) => field.label === "Mensaje");
	const html = fields.find((field) => field.label === "HTML");
	const attachments = fields.find((field) => field.label === "Adjuntos");
	return (
		<div className="flex flex-col overflow-clip rounded-card border border-border bg-panel">
			<dl className="flex flex-col gap-1 border-b border-border bg-content px-[18px] pb-3 pt-3.5">
				{headers.map((field, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: server-rendered rows, never reordered
					<div key={`${index}:${field.label}`} className="flex items-start gap-2.5">
						<dt className="w-14 shrink-0 text-[13px] leading-5 text-text-muted">
							{displayLabel(field.label)}
						</dt>
						<dd
							className={cn(
								"min-w-0 whitespace-pre-wrap text-[13px] leading-5",
								field.value ? "text-text" : "text-text-muted",
								field.label === "Asunto" && "font-medium",
							)}
						>
							{field.value || "(empty)"}
						</dd>
					</div>
				))}
			</dl>
			{html && htmlSrc ? (
				<div className="flex flex-col gap-2 px-[18px] pb-[18px] pt-4">
					<Eyebrow as="h2">
						Formatted version · as it will be sent, link targets in brackets
					</Eyebrow>
					<EmailHtmlBody
						src={htmlSrc}
						title="Formatted version of the message"
						foldQuote={false}
						fallback={
							<p className="text-[13px] leading-5 text-text-muted">
								The formatted version could not be shown. Its source is below.
							</p>
						}
					/>
				</div>
			) : null}
			<div
				className={cn(
					"px-[18px] pb-[18px] pt-4",
					html && htmlSrc && "flex flex-col gap-2 border-t border-border pt-3.5",
				)}
			>
				{html && htmlSrc ? (
					<Eyebrow as="h2">Plain-text version</Eyebrow>
				) : (
					<h2 className="sr-only">Message</h2>
				)}
				{message?.value ? (
					<p className="whitespace-pre-wrap text-[14px] leading-[22px] tracking-[-0.005em] text-text">
						{message.value}
					</p>
				) : (
					<p className="text-[14px] leading-[22px] text-text-muted">(no plain-text body)</p>
				)}
			</div>
			{html && (
				<details className="flex flex-col gap-2 border-t border-border px-[18px] py-3.5">
					<summary className="cursor-pointer select-none">
						<Eyebrow as="span">HTML source</Eyebrow>
					</summary>
					<div className="mt-2">
						<FieldValue field={{ ...html, format: "pre" }} />
					</div>
				</details>
			)}
			{attachments && (
				<div className="flex flex-col gap-2 border-t border-border px-[18px] py-3.5">
					<Eyebrow as="h2">Attachments</Eyebrow>
					{/^\d+$/.test(attachments.value) ? (
						<p className="text-[13px] leading-5 text-text">
							{attachments.value} {attachments.value === "1" ? "attachment" : "attachments"}
						</p>
					) : (
						<FieldValue field={{ ...attachments, format: "list" }} size="sm" />
					)}
				</div>
			)}
		</div>
	);
}
