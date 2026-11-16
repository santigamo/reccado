import { MoreHorizontal, Pencil, Plus, Power, Trash2, X } from "lucide-react";
import { type ReactNode, useMemo, useRef, useState } from "react";
import {
	type AddressRouting,
	type Alias,
	asDomainError,
	createAlias,
	createRoutingRule,
	DMARC_LABELS,
	type DmarcPolicy,
	type Domain,
	type DomainCloudflareStatus,
	type DomainOverview,
	deleteAlias,
	deleteRoutingRule,
	explainDomainError,
	explainReadFailure,
	externalDestinations,
	fetchDomainOverview,
	fetchDomainStatus,
	type Mailbox,
	patchMailbox,
	type RoutingRule,
	ruleForwardTo,
	setDomainStatus,
	updateRoutingRule,
} from "#/components/domains/domains";
import { Button } from "#/components/ui/Button";
import { Dialog } from "#/components/ui/Dialog";
import { InlineNotice } from "#/components/ui/Feedback";
import { TextField } from "#/components/ui/Field";
import { IconButton, iconButtonClassName } from "#/components/ui/IconButton";
import { Menu } from "#/components/ui/Menu";
import { Pill } from "#/components/ui/Pill";
import { StatusDot } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import type { MailboxColor } from "#/lib/mailbox-color";
import { useAsyncResource } from "#/lib/use-mail";
import { ConfirmDialog, formatAgo, formatDay, StatusLine } from "./bits";
import { RouteItDialog } from "./RouteItDialog";
import { RuleDialog } from "./RuleDialog";

function errorText(caught: unknown): string {
	const err = asDomainError(caught);
	return explainDomainError(err) ?? err.message ?? err.code;
}

const card =
	"flex shrink-0 flex-col overflow-hidden rounded-card border border-border-card bg-panel";

// ---------------------------------------------------------------------------
// Header card
// ---------------------------------------------------------------------------

function Stat({ label, children, first }: { label: string; children: ReactNode; first?: boolean }) {
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-[3px] px-5 pt-3 pb-3.5",
				!first && "border-t border-border-card sm:border-t-0 sm:border-l",
			)}
		>
			<span className="text-meta text-text-muted">{label}</span>
			<span className="text-body font-medium text-text">{children}</span>
		</div>
	);
}

function unknownLine(title: string) {
	return (
		<span title={title}>
			<StatusLine tone="muted">Unknown</StatusLine>
		</span>
	);
}

function HeaderCard({
	domain,
	overview,
	overviewLoading,
	status,
	onRerun,
	onToggle,
}: {
	domain: Domain;
	overview: DomainOverview | null;
	overviewLoading: boolean;
	status: DomainCloudflareStatus | null;
	onRerun: (policy: DmarcPolicy | null) => void;
	onToggle: () => void;
}) {
	const disabled = domain.status === "disabled";
	const added = formatDay(domain.created_at);
	let zoneLine = "Registered in Reccado";
	if (status) {
		const cf = status.cloudflare;
		if (!cf.configured)
			zoneLine = "Registered in Reccado · Cloudflare zone not checked (no API token)";
		else if (cf.ok && cf.status === "active") zoneLine = "Active zone in your Cloudflare account";
		else if (cf.ok) zoneLine = `Cloudflare zone status: ${cf.status ?? "unknown"}`;
		else zoneLine = `Couldn't check the Cloudflare zone${cf.reason ? ` (${cf.reason})` : ""}`;
	}

	const checking = <StatusLine tone="muted">Checking…</StatusLine>;
	let sending: ReactNode = checking;
	let inbound: ReactNode = checking;
	let dmarc: ReactNode = checking;
	let feedback: ReactNode = checking;
	let currentPolicy: DmarcPolicy | null = null;
	if (overview) {
		const s = overview.sending;
		sending = !s.ok ? (
			unknownLine(explainReadFailure(s))
		) : s.subdomains.length ? (
			<StatusLine tone="success">{s.subdomains.join(", ")}</StatusLine>
		) : (
			<StatusLine tone="muted">Not enabled</StatusLine>
		);
		const i = overview.inbound;
		inbound = !i.ok ? (
			unknownLine(explainReadFailure(i))
		) : i.enabled ? (
			<StatusLine tone="success">On</StatusLine>
		) : (
			<StatusLine tone="muted">Off</StatusLine>
		);
		const d = overview.dmarc;
		if (!d.ok) dmarc = unknownLine(explainReadFailure(d));
		else if (d.records.length === 0)
			dmarc = <StatusLine tone="muted">No sending domain</StatusLine>;
		else {
			const policies = [...new Set(d.records.map((r) => r.policy))];
			const first = policies[0];
			if (policies.length === 1 && first && first in DMARC_LABELS) {
				currentPolicy = first as DmarcPolicy;
				dmarc = <StatusLine tone="success">{DMARC_LABELS[first as DmarcPolicy]}</StatusLine>;
			} else if (policies.length === 1 && first === null)
				dmarc = <StatusLine tone="approval">Not published</StatusLine>;
			else
				dmarc = (
					<StatusLine tone="approval">
						{d.records
							.map((r) => `${r.sendingDomain}: ${r.policy ?? "none published"}`)
							.join(" · ")}
					</StatusLine>
				);
		}
		const fb = overview.feedback;
		const dark = fb.filter((f) => f.state === "never_observed" || f.state === "went_dark");
		const live = fb.filter((f) => f.state === "live");
		if (dark.length)
			feedback = (
				<span
					title={dark
						.map((f) => f.reason)
						.filter(Boolean)
						.join("\n")}
				>
					<StatusLine tone="danger-strong">No feedback events</StatusLine>
				</span>
			);
		else if (live.length) {
			const last = live
				.map((f) => f.lastEventAt)
				.filter((v): v is string => Boolean(v))
				.sort()
				.at(-1);
			feedback = (
				<StatusLine tone="success">
					Live{" "}
					{last ? <span className="font-normal text-text-muted">· {formatAgo(last)}</span> : null}
				</StatusLine>
			);
		} else if (fb.length) feedback = <StatusLine tone="muted">Too early to tell</StatusLine>;
		else feedback = <StatusLine tone="muted">No sends yet</StatusLine>;
	} else if (!overviewLoading) {
		sending = inbound = dmarc = feedback = unknownLine("Couldn't load the domain overview.");
	}

	const cloudflareNote =
		overview && !overview.sending.ok && overview.sending.reason === "token_missing"
			? "Sending, Inbound and DMARC are read from Cloudflare. No API token is set on this Worker, so they can't be checked here."
			: overview && !overview.sending.ok
				? `Sending, Inbound and DMARC are read from Cloudflare: ${explainReadFailure(overview.sending)}`
				: null;

	return (
		<section className={card} aria-label={`${domain.domain} overview`}>
			<div className="flex flex-wrap items-center gap-2.5 pt-4 pr-4 pb-3.5 pl-5">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="m-0 flex items-center gap-2.5 truncate text-title font-semibold tracking-[-0.015em] text-[#1F1F1F]">
						{domain.domain}
						{disabled ? <Pill>Disabled</Pill> : null}
						{domain.status === "pending" ? <Pill tone="approval">Setup pending</Pill> : null}
					</h2>
					<span className="text-label text-text-muted">
						{zoneLine}
						{added ? ` · added ${added}` : ""}
					</span>
				</div>
				{disabled ? (
					<Button size="sm" variant="secondary" onClick={onToggle}>
						<Power aria-hidden /> Turn back on
					</Button>
				) : (
					<>
						<Button size="sm" variant="secondary" onClick={() => onRerun(currentPolicy)}>
							Re-run setup
						</Button>
						<Button size="sm" variant="ghost" onClick={onToggle}>
							Disable
						</Button>
					</>
				)}
			</div>
			<div className="grid border-t border-border-card sm:grid-cols-4">
				<Stat first label="Sending">
					{sending}
				</Stat>
				<Stat label="Inbound">{inbound}</Stat>
				<Stat label="DMARC">{dmarc}</Stat>
				<Stat label="Delivery feedback">{feedback}</Stat>
			</div>
			{cloudflareNote ? (
				<p className="m-0 border-t border-border-card px-5 py-2.5 text-meta text-text-muted">
					{cloudflareNote}
				</p>
			) : null}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Mailboxes card
// ---------------------------------------------------------------------------

function Receiving({
	mailbox,
	routing,
	loading,
	onExplain,
}: {
	mailbox: Mailbox;
	routing: AddressRouting | undefined;
	loading: boolean;
	onExplain: (routing: AddressRouting) => void;
}) {
	if (mailbox.status === "disabled") return <StatusLine tone="muted">Disabled</StatusLine>;
	if (loading && !routing) return <StatusLine tone="muted">Checking…</StatusLine>;
	const r = routing ?? { address: mailbox.primary_address, state: "unknown" as const };
	const link = (label: string) => (
		<button
			type="button"
			onClick={() => onExplain(r)}
			className="underline decoration-1 underline-offset-2"
		>
			{label}
		</button>
	);
	switch (r.state) {
		case "routed":
			return (
				<span
					title={`Cloudflare Email Routing delivers it to Worker ${r.workers.join(", ")} (${r.via === "catch_all" ? "catch-all" : "address rule"}).`}
				>
					<StatusLine tone="success">Routed</StatusLine>
				</span>
			);
		case "not_routed":
			return <StatusLine tone="brand-strong">Send-only · {link("Route it")}</StatusLine>;
		case "elsewhere":
			return (
				<StatusLine tone="approval">
					{r.action === "forward" ? "Forwarded by Cloudflare" : "Not to Reccado"} · {link("Why?")}
				</StatusLine>
			);
		default:
			return <StatusLine tone="muted">Unknown · {link("Why?")}</StatusLine>;
	}
}

function AliasAdder({
	domain,
	onAdd,
}: {
	domain: string;
	onAdd: (address: string) => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	if (!open)
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="rounded-control px-1 py-0.5 text-meta text-text-muted hover:bg-hover hover:text-text"
			>
				+ Alias
			</button>
		);
	const submit = async () => {
		const v = value.trim().toLowerCase();
		if (!v) {
			setOpen(false);
			return;
		}
		setBusy(true);
		try {
			await onAdd(v.includes("@") ? v : `${v}@${domain}`);
			setValue("");
			setOpen(false);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void submit();
			}}
			className="flex h-6 items-center overflow-hidden rounded-[12px] border border-brand bg-panel pr-1 pl-2 text-meta"
		>
			<input
				// biome-ignore lint/a11y/noAutofocus: revealed on the user's own click
				autoFocus
				aria-label={`New alias on ${domain}`}
				value={value}
				disabled={busy}
				onChange={(e) => setValue(e.target.value.replace(/\s/g, ""))}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						e.stopPropagation();
						setOpen(false);
					}
				}}
				onBlur={() => {
					if (!value.trim()) setOpen(false);
				}}
				placeholder="name"
				className="w-20 bg-transparent text-ink outline-none"
			/>
			<span className="text-text-muted">@{domain}</span>
		</form>
	);
}

function RenameDialog({
	mailbox,
	onClose,
	onSave,
}: {
	mailbox: Mailbox;
	onClose: () => void;
	onSave: (name: string | null) => Promise<void>;
}) {
	const [name, setName] = useState(mailbox.display_name ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = () => {
		setBusy(true);
		setError(null);
		onSave(name.trim() || null)
			.then(onClose)
			.catch((caught: unknown) => {
				setError(errorText(caught));
				setBusy(false);
			});
	};
	return (
		<Dialog
			onClose={onClose}
			size="sm"
			title="Sender name"
			description={`The display name ${mailbox.primary_address} sends as.`}
			dismissible={!busy}
			footer={
				<>
					<span className="flex-1" />
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="primary" onClick={save} disabled={busy}>
						{busy ? "Saving…" : "Save"}
					</Button>
				</>
			}
		>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					save();
				}}
				className="flex flex-col gap-3"
			>
				<TextField
					label="Name"
					value={name}
					maxLength={120}
					onChange={(e) => setName(e.target.value)}
					placeholder="No display name"
					hint="Leave it empty to send with the bare address."
					data-autofocus
				/>
				{error ? (
					<InlineNotice tone="danger" className="rounded-[10px]">
						{error}
					</InlineNotice>
				) : null}
			</form>
		</Dialog>
	);
}

function MailboxesCard({
	domain,
	mailboxes,
	aliases,
	colorOf,
	overview,
	overviewLoading,
	onAddMailbox,
	onChanged,
	onError,
}: {
	domain: Domain;
	mailboxes: Mailbox[];
	aliases: Alias[];
	colorOf: (id: string) => MailboxColor;
	overview: DomainOverview | null;
	overviewLoading: boolean;
	onAddMailbox: () => void;
	onChanged: () => void;
	onError: (message: string | null) => void;
}) {
	const [explain, setExplain] = useState<AddressRouting | null>(null);
	const routedRef = useRef(false);
	const [renaming, setRenaming] = useState<Mailbox | null>(null);
	const [disabling, setDisabling] = useState<Mailbox | null>(null);
	const rows = mailboxes.filter((m) =>
		m.primary_address.toLowerCase().endsWith(`@${domain.domain}`),
	);
	const routingByAddress = useMemo(
		() => new Map((overview?.routing.addresses ?? []).map((r) => [r.address, r])),
		[overview],
	);

	const act = (fn: () => Promise<unknown>) => {
		onError(null);
		fn()
			.then(onChanged)
			.catch((caught: unknown) => onError(errorText(caught)));
	};

	return (
		<section className={card} aria-label="Mailboxes">
			<div className="hidden h-11 shrink-0 items-center gap-3 px-5 md:flex">
				<h3 className="m-0 w-58 shrink-0 text-sender font-medium tracking-[-0.01em] text-text">
					Mailboxes
				</h3>
				<span className="flex-1 text-meta text-text-muted">Aliases</span>
				<span className="w-[170px] shrink-0 text-meta text-text-muted">Receiving</span>
				<span className="w-8 shrink-0" />
			</div>
			<h3 className="m-0 px-5 pt-3 pb-2 text-sender font-medium text-text md:hidden">Mailboxes</h3>
			{rows.length === 0 ? (
				<p className="m-0 border-t border-border-card px-5 py-4 text-label text-text-muted">
					No mailboxes on {domain.domain} yet.
				</p>
			) : null}
			{rows.map((m) => {
				const color = colorOf(m.mailbox_id);
				const own = aliases.filter(
					(a) =>
						a.mailbox_id === m.mailbox_id &&
						a.alias_address.toLowerCase() !== m.primary_address.toLowerCase(),
				);
				const disabled = m.status === "disabled";
				return (
					<div
						key={m.mailbox_id}
						className={cn(
							"flex flex-col gap-2 border-t border-l-[3px] border-t-border-card py-2.5 pr-3 pl-[17px] md:min-h-14 md:flex-row md:items-center md:gap-3 md:py-2",
						)}
						style={{ borderLeftColor: disabled ? "var(--color-border)" : color.css }}
					>
						<div
							className={cn("flex min-w-0 flex-col md:w-58 md:shrink-0", disabled && "opacity-60")}
						>
							<span className="truncate text-body font-medium text-text">{m.primary_address}</span>
							<span className="truncate text-meta text-text-muted">
								{m.display_name ?? "No display name"}
							</span>
						</div>
						<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
							{own.map((a) => {
								const [localPart, aliasDomain] = a.alias_address.split("@");
								const label = aliasDomain === domain.domain ? `${localPart}@` : a.alias_address;
								return (
									<span
										key={a.alias_address}
										title={a.alias_address}
										className={cn(
											"group inline-flex h-6 items-center gap-1 rounded-[12px] bg-pill pr-1 pl-[9px] text-meta text-text-secondary",
											a.status === "disabled" && "line-through opacity-60",
										)}
									>
										{label}
										<button
											type="button"
											aria-label={`Remove alias ${a.alias_address}`}
											title="Remove alias"
											onClick={() => act(() => deleteAlias(a.alias_address))}
											className="flex size-4 items-center justify-center rounded-full text-icon opacity-60 hover:bg-hover hover:text-text hover:opacity-100 [&_svg]:size-3"
										>
											<X aria-hidden />
										</button>
									</span>
								);
							})}
							{disabled ? null : (
								<AliasAdder
									domain={domain.domain}
									onAdd={async (address) => {
										onError(null);
										try {
											await createAlias(address, m.mailbox_id);
											onChanged();
										} catch (caught) {
											onError(errorText(caught));
										}
									}}
								/>
							)}
						</div>
						<div className="flex items-center gap-2 md:contents">
							<span className="text-label md:w-[170px] md:shrink-0">
								<Receiving
									mailbox={m}
									routing={routingByAddress.get(m.primary_address.toLowerCase())}
									loading={overviewLoading}
									onExplain={setExplain}
								/>
							</span>
							<span className="flex-1 md:hidden" />
							<Menu
								label={`Actions for ${m.primary_address}`}
								align="end"
								triggerClassName={iconButtonClassName("md")}
								trigger={<MoreHorizontal aria-hidden className="size-[17px]" />}
								items={[
									{
										key: "rename",
										label: "Change sender name",
										icon: <Pencil />,
										onSelect: () => setRenaming(m),
									},
									disabled
										? {
												key: "enable",
												label: "Turn back on",
												icon: <Power />,
												onSelect: () => act(() => patchMailbox(m.mailbox_id, { status: "active" })),
											}
										: {
												key: "disable",
												label: "Disable mailbox",
												icon: <Power />,
												danger: true,
												onSelect: () => setDisabling(m),
											},
								]}
							/>
						</div>
					</div>
				);
			})}
			{domain.status === "active" ? (
				<button
					type="button"
					onClick={onAddMailbox}
					className="flex h-11 shrink-0 items-center gap-2 border-t border-border-card px-5 text-left text-label text-text-muted hover:bg-row-selected hover:text-text"
				>
					<Plus aria-hidden className="size-3.5" />
					Add mailbox on {domain.domain}
				</button>
			) : null}

			{explain ? (
				<RouteItDialog
					address={explain.address}
					reason={explain.state === "routed" ? "unknown" : explain.state}
					onRouted={() => {
						routedRef.current = true;
					}}
					onClose={() => {
						setExplain(null);
						// Re-read Cloudflare so the table shows what is true now, not what we just did.
						if (routedRef.current) {
							routedRef.current = false;
							onChanged();
						}
					}}
				/>
			) : null}
			{renaming ? (
				<RenameDialog
					mailbox={renaming}
					onClose={() => setRenaming(null)}
					onSave={async (name) => {
						await patchMailbox(renaming.mailbox_id, { displayName: name });
						onChanged();
					}}
				/>
			) : null}
			{disabling ? (
				<ConfirmDialog
					title={`Disable ${disabling.primary_address}?`}
					description="Mail to it is refused, and Reccado and the agent stop showing it. Its messages are kept, and you can turn it back on at any time."
					confirmLabel="Disable mailbox"
					tone="danger"
					onClose={() => setDisabling(null)}
					onConfirm={async () => {
						await patchMailbox(disabling.mailbox_id, { status: "disabled" });
						onChanged();
					}}
				/>
			) : null}
		</section>
	);
}

// ---------------------------------------------------------------------------
// Routing rules card
// ---------------------------------------------------------------------------

function RulesCard({
	domain,
	domains,
	mailboxes,
	rules,
	colorOf,
	onChanged,
	onError,
}: {
	domain: Domain;
	domains: Domain[];
	mailboxes: Mailbox[];
	rules: RoutingRule[];
	colorOf: (id: string) => MailboxColor;
	onChanged: () => void;
	onError: (message: string | null) => void;
}) {
	const [editing, setEditing] = useState<RoutingRule | "new" | null>(null);
	const [deleting, setDeleting] = useState<RoutingRule | null>(null);
	const own = rules
		.filter((r) => r.domain_id === domain.id)
		.sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
	const nextPriority = own.length ? Math.max(...own.map((r) => r.priority)) + 10 : 10;
	const mailboxById = new Map(mailboxes.map((m) => [m.mailbox_id, m]));

	return (
		<section className={card} aria-label="Routing rules">
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 px-5 pt-[13px] pb-[11px]">
				<h3 className="m-0 text-sender font-medium tracking-[-0.01em] text-text">Routing rules</h3>
				<span className="min-w-0 flex-1 text-meta text-text-muted">
					For addresses without a mailbox or alias. Checked top to bottom; the first match wins.
				</span>
				<button
					type="button"
					onClick={() => setEditing("new")}
					className="rounded-control px-1 text-label text-text-muted hover:bg-hover hover:text-text"
				>
					+ Add rule
				</button>
			</div>
			{own.length === 0 ? (
				<p className="m-0 border-t border-border-card px-5 py-3.5 text-label text-text-muted">
					No rules. Mail to an address on {domain.domain} without a mailbox or alias is refused.
				</p>
			) : null}
			{own.map((rule, index) => {
				const forward = ruleForwardTo(rule);
				const external = rule.action === "forward" ? externalDestinations(forward, domains) : [];
				const target = rule.mailbox_id ? mailboxById.get(rule.mailbox_id) : undefined;
				return (
					<div
						key={rule.id}
						className={cn(
							"flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-card py-2 pr-3 pl-5",
							!rule.enabled && "opacity-60",
						)}
					>
						<span className="w-4 shrink-0 text-meta text-text-muted">{index + 1}</span>
						<span className="w-44 shrink-0 truncate font-mono text-label text-text sm:w-51">
							{rule.pattern === "*" ? (
								<>
									* <span className="font-sans text-text-muted">everything else</span>
								</>
							) : rule.pattern.includes("@") ? (
								rule.pattern
							) : (
								`${rule.pattern}@`
							)}
						</span>
						<span className="w-19 shrink-0 text-label text-text-muted">
							{rule.action === "store"
								? "Store in"
								: rule.action === "forward"
									? "Forward to"
									: "Reject"}
						</span>
						<span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-label text-text">
							{rule.action === "store" ? (
								<>
									{target ? <StatusDot color={colorOf(target.mailbox_id).css} /> : null}
									<span className="truncate">
										{target?.primary_address ?? rule.mailbox_id ?? "—"}
									</span>
								</>
							) : rule.action === "forward" ? (
								<>
									<span className="truncate">{forward.join(", ")}</span>
									{external.length ? (
										<span
											title={`Leaves your domains: ${external.join(", ")}`}
											className="inline-flex h-[22px] items-center rounded-[11px] border border-border px-2 text-meta text-text-muted"
										>
											Outside your domains
										</span>
									) : null}
								</>
							) : (
								<span className="truncate">
									{rule.reject_reason ? `“${rule.reject_reason}”` : "Refused"}
								</span>
							)}
							{!rule.enabled ? <Pill>Off</Pill> : null}
						</span>
						<span className="text-meta text-text-faint" title="Priority">
							{rule.priority}
						</span>
						<IconButton title="Edit rule" size="sm" onClick={() => setEditing(rule)}>
							<Pencil />
						</IconButton>
						<IconButton title="Delete rule" size="sm" onClick={() => setDeleting(rule)}>
							<Trash2 />
						</IconButton>
					</div>
				);
			})}
			{editing ? (
				<RuleDialog
					domain={domain}
					domains={domains}
					mailboxes={mailboxes}
					rule={editing === "new" ? null : editing}
					nextPriority={nextPriority}
					onClose={() => setEditing(null)}
					onSave={async (input) => {
						onError(null);
						if (editing === "new") await createRoutingRule(domain.id, input);
						else await updateRoutingRule(editing.id, input);
						onChanged();
					}}
				/>
			) : null}
			{deleting ? (
				<ConfirmDialog
					title="Delete this rule?"
					description={
						<>
							Mail matching <span className="font-mono text-ink">{deleting.pattern}</span> falls
							through to the next rule, or is refused. This can't be undone from here.
						</>
					}
					confirmLabel="Delete rule"
					tone="danger"
					onClose={() => setDeleting(null)}
					onConfirm={async () => {
						await deleteRoutingRule(deleting.id);
						onChanged();
					}}
				/>
			) : null}
		</section>
	);
}

// ---------------------------------------------------------------------------
// The right column
// ---------------------------------------------------------------------------

export function DomainDetail({
	domain,
	domains,
	mailboxes,
	aliases,
	rules,
	colorOf,
	refreshKey,
	onChanged,
	onAddMailbox,
	onRerun,
}: {
	domain: Domain;
	domains: Domain[];
	mailboxes: Mailbox[];
	aliases: Alias[];
	rules: RoutingRule[];
	colorOf: (id: string) => MailboxColor;
	/** Bumped by the parent after any change, to re-read Cloudflare. */
	refreshKey: number;
	onChanged: () => void;
	onAddMailbox: () => void;
	onRerun: (policy: DmarcPolicy | null) => void;
}) {
	const [actionError, setActionError] = useState<string | null>(null);
	const [toggling, setToggling] = useState(false);
	const overview = useAsyncResource<DomainOverview | null>(
		() => fetchDomainOverview(domain.domain),
		null,
		[domain.domain, refreshKey],
	);
	const status = useAsyncResource<DomainCloudflareStatus | null>(
		() => fetchDomainStatus(domain.domain),
		null,
		[domain.domain],
	);
	const disabled = domain.status === "disabled";

	return (
		<div className="flex min-w-0 flex-col gap-3 pb-4">
			{actionError ? (
				<InlineNotice
					tone="danger"
					className="rounded-[10px]"
					action={
						<Button size="sm" variant="ghost" onClick={() => setActionError(null)}>
							Dismiss
						</Button>
					}
				>
					{actionError}
				</InlineNotice>
			) : null}
			<HeaderCard
				domain={domain}
				overview={overview.data}
				overviewLoading={overview.loading}
				status={status.data}
				onRerun={onRerun}
				onToggle={() => setToggling(true)}
			/>
			<MailboxesCard
				domain={domain}
				mailboxes={mailboxes}
				aliases={aliases}
				colorOf={colorOf}
				overview={overview.data}
				overviewLoading={overview.loading}
				onAddMailbox={onAddMailbox}
				onChanged={onChanged}
				onError={setActionError}
			/>
			<RulesCard
				domain={domain}
				domains={domains}
				mailboxes={mailboxes}
				rules={rules}
				colorOf={colorOf}
				onChanged={onChanged}
				onError={setActionError}
			/>
			{toggling ? (
				<ConfirmDialog
					title={disabled ? `Turn ${domain.domain} back on?` : `Disable ${domain.domain}?`}
					description={
						disabled
							? "Mail to its mailboxes and aliases is accepted again."
							: "Mail to every address on it is refused until you turn it back on. Mailboxes, messages and settings are kept; nothing is deleted, and nothing changes in Cloudflare."
					}
					confirmLabel={disabled ? "Turn back on" : "Disable domain"}
					tone={disabled ? "primary" : "danger"}
					onClose={() => setToggling(false)}
					onConfirm={async () => {
						await setDomainStatus(domain.domain, disabled ? "active" : "disabled");
						onChanged();
					}}
				/>
			) : null}
		</div>
	);
}
