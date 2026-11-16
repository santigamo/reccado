import { Check, ChevronDown, CircleAlert, Lock, UserRound } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
	type Alias,
	asDomainError,
	type CreateMailboxResult,
	createMailbox,
	type Domain,
	type DomainOverview,
	explainDomainError,
	fetchDomainOverview,
	type Mailbox,
} from "#/components/domains/domains";
import { Button } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { InlineNotice, Spinner } from "#/components/ui/Feedback";
import { cn } from "#/lib/cn";
import { nextMailboxColor } from "#/lib/mailbox-color";
import { RouteOutcome, useRouteAddress } from "./RouteItDialog";

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/i;

function Row({
	icon,
	children,
	action,
	first,
}: {
	icon: React.ReactNode;
	children: React.ReactNode;
	action?: React.ReactNode;
	first?: boolean;
}) {
	return (
		<div
			className={cn(
				"flex min-h-[42px] items-center gap-2.5 px-3.5 py-2",
				!first && "border-t border-border",
			)}
		>
			<span className="flex w-4 shrink-0 items-center justify-center [&_svg]:size-3.5">{icon}</span>
			<div className="min-w-0 flex-1 text-label leading-[18px] text-text">{children}</div>
			{action}
		</div>
	);
}

function linkClass() {
	return "shrink-0 text-label font-medium text-text underline decoration-1 underline-offset-2 hover:text-ink";
}

/**
 * After "Create mailbox": the mailbox exists; now ask Cloudflare to deliver its
 * address here and say exactly what happened. Runs once on mount; Retry runs it
 * again. Closing at any point keeps the mailbox.
 */
function CreatedView({
	result,
	address,
	onDone,
}: {
	result: CreateMailboxResult;
	address: string;
	onDone: () => void;
}) {
	const { state, run } = useRouteAddress(address);
	const started = useRef(false);
	useEffect(() => {
		if (started.current) return;
		started.current = true;
		run();
	}, [run]);
	return (
		<Dialog
			onClose={onDone}
			title={result.created ? "Mailbox created" : "Mailbox already exists"}
			size="md"
			dismissible={state.kind !== "running"}
			footer={
				<>
					<span className="flex-1" />
					<Button variant="primary" onClick={onDone} disabled={state.kind === "running"}>
						Done
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-3 text-body text-text-secondary">
				<p className="m-0">
					<span className="font-medium text-ink">{address}</span>{" "}
					{result.created ? "is ready to send from." : "was already in Reccado."}
				</p>
				{result.aliasReason ? (
					<InlineNotice tone="approval" className="rounded-[10px]">
						Reccado couldn't point the address at it, so mail to it won't be filed here yet:{" "}
						{result.aliasReason}
					</InlineNotice>
				) : null}
				<RouteOutcome address={address} state={state} onRetry={run} />
			</div>
		</Dialog>
	);
}

/**
 * Paper "Add mailbox": one field (name @ domain). Colour is assigned on the
 * client, the display name is optional. What it says about receiving comes
 * from a Cloudflare read of the domain's catch-all — never assumed.
 */
export function AddMailboxDialog({
	domains,
	mailboxes,
	aliases,
	defaultDomain,
	onClose,
	onCreated,
}: {
	domains: Domain[];
	mailboxes: Mailbox[];
	aliases: Alias[];
	defaultDomain?: string;
	onClose: () => void;
	onCreated: (result: CreateMailboxResult) => void;
}) {
	const active = useMemo(() => domains.filter((d) => d.status === "active"), [domains]);
	const [local, setLocal] = useState("");
	const [domain, setDomain] = useState(
		() =>
			active.find((d) => d.domain === defaultDomain)?.domain ??
			active.find((d) => d.domain !== "example.com")?.domain ??
			active[0]?.domain ??
			"",
	);
	const [displayName, setDisplayName] = useState("");
	const [editingName, setEditingName] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<CreateMailboxResult | null>(null);
	const [overview, setOverview] = useState<DomainOverview | null | "error">(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const nameId = useId();
	const hintId = useId();

	useEffect(() => {
		if (!domain) return;
		let alive = true;
		setOverview(null);
		fetchDomainOverview(domain)
			.then((o) => alive && setOverview(o))
			.catch(() => alive && setOverview("error"));
		return () => {
			alive = false;
		};
	}, [domain]);

	const trimmed = local.trim().toLowerCase();
	const address = trimmed && domain ? `${trimmed}@${domain}` : "";
	const existingMailbox = mailboxes.find((m) => m.primary_address.toLowerCase() === address);
	const existingAlias = aliases.find((a) => a.alias_address.toLowerCase() === address);
	const invalid = trimmed !== "" && !LOCAL_PART.test(trimmed);
	const color = nextMailboxColor(mailboxes);

	let hint: { tone: "ok" | "warn" | "muted"; text: string } | null = null;
	if (!domain) hint = { tone: "warn", text: "Add an active domain first." };
	else if (!trimmed)
		hint = { tone: "muted", text: `On ${domain}, a domain registered in Reccado.` };
	else if (invalid) hint = { tone: "warn", text: "That isn't a valid address name." };
	else if (existingMailbox)
		hint = {
			tone: "warn",
			text:
				existingMailbox.status === "disabled"
					? "That mailbox exists but is disabled. Turn it back on from the mailbox list."
					: "That mailbox already exists.",
		};
	else if (existingAlias) {
		const owner = mailboxes.find((m) => m.mailbox_id === existingAlias.mailbox_id);
		hint = {
			tone: "warn",
			text: `Already an alias of ${owner?.primary_address ?? existingAlias.mailbox_id}. Creating the mailbox leaves that alias untouched.`,
		};
	} else hint = { tone: "ok", text: `Available. ${domain} is registered and active in Reccado.` };

	const canSubmit = Boolean(address) && !invalid && !existingMailbox && !busy;

	// What we can truthfully say about mail to a *new* address on this domain:
	// only the catch-all can route it, since no literal rule names it yet.
	let receiving: { icon: React.ReactNode; text: React.ReactNode };
	if (overview === null) {
		receiving = {
			icon: <Spinner className="size-3.5" />,
			text: "Checking how this domain receives mail…",
		};
	} else if (overview === "error") {
		receiving = {
			icon: <CircleAlert className="text-icon" aria-hidden />,
			text: "Couldn't check whether Cloudflare routes this address to Reccado.",
		};
	} else {
		const ca = overview.routing.catchAll;
		if (ca.state === "routed")
			receiving = {
				icon: <Check className="text-success" strokeWidth={2.6} aria-hidden />,
				text: (
					<>
						Mail to this address reaches Reccado through the domain's catch-all
						{ca.workers.length ? ` (Worker ${ca.workers.join(", ")})` : ""}.
					</>
				),
			};
		else if (ca.state === "unknown")
			receiving = {
				icon: <CircleAlert className="text-icon" aria-hidden />,
				text: "Receiving can't be checked from here. Creating the mailbox will try to route it; you can send from it either way.",
			};
		else
			receiving = {
				icon: <CircleAlert className="text-brand" aria-hidden />,
				text: "Not routed by the catch-all. Creating the mailbox asks Cloudflare to route it here.",
			};
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!canSubmit) return;
		setBusy(true);
		setError(null);
		try {
			const result = await createMailbox({
				primaryAddress: address,
				...(displayName.trim() ? { displayName: displayName.trim() } : {}),
			});
			// The mailbox exists now, whatever Cloudflare says next. Routing is a
			// separate step whose failure never undoes the mailbox.
			setCreated(result);
			setBusy(false);
		} catch (caught) {
			const err = asDomainError(caught);
			setError(explainDomainError(err) ?? err.message ?? err.code);
			setBusy(false);
		}
	}

	if (created) {
		return (
			<CreatedView
				result={created}
				address={created.mailbox?.primary_address ?? address}
				onDone={() => onCreated(created)}
			/>
		);
	}

	return (
		<Dialog
			onClose={onClose}
			title="Add mailbox"
			description="Type a name and pick the domain. That's it."
			size="md"
			dismissible={!busy && !local}
			initialFocusRef={inputRef}
			footer={
				<>
					<DialogFooterNote icon={<Lock aria-hidden />}>
						The agent can read and draft here. Sending needs your approval.
					</DialogFooterNote>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" form="add-mailbox-form" disabled={!canSubmit}>
						{busy ? "Creating…" : "Create mailbox"}
					</Button>
				</>
			}
		>
			<form
				id="add-mailbox-form"
				onSubmit={(e) => void submit(e)}
				className="flex flex-col gap-[22px]"
			>
				<div className="flex flex-col gap-2">
					<label htmlFor={`${hintId}-local`} className="text-label leading-4 font-medium text-text">
						Address
					</label>
					<div
						className={cn(
							"flex h-11 items-stretch overflow-hidden rounded-[10px] border bg-panel transition focus-within:border-brand focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_12%,transparent)]",
							invalid ? "border-danger" : "border-border",
						)}
					>
						<input
							ref={inputRef}
							id={`${hintId}-local`}
							value={local}
							onChange={(e) => setLocal(e.target.value.replace(/\s/g, ""))}
							placeholder="invoices"
							autoComplete="off"
							data-1p-ignore
							spellCheck={false}
							aria-describedby={hintId}
							aria-invalid={invalid || undefined}
							className="min-w-0 flex-1 bg-transparent px-3.5 text-[15px] font-medium text-ink outline-none placeholder:font-normal placeholder:text-text-faint"
						/>
						<div className="relative flex shrink-0 items-center gap-2 border-l border-border bg-content pr-3 pl-3.5">
							<span className="text-[15px] text-text-muted">@</span>
							<select
								aria-label="Domain"
								value={domain}
								onChange={(e) => setDomain(e.target.value)}
								className="max-w-[46vw] appearance-none bg-transparent pr-5 text-[15px] font-medium text-text outline-none sm:max-w-[220px]"
							>
								{active.map((d) => (
									<option key={d.id} value={d.domain}>
										{d.domain}
									</option>
								))}
							</select>
							<ChevronDown
								aria-hidden
								className="pointer-events-none absolute right-3 size-3.5 text-icon"
							/>
						</div>
					</div>
					{hint ? (
						<p
							id={hintId}
							className={cn(
								"m-0 flex items-center gap-1.5 text-label leading-4",
								hint.tone === "warn" ? "text-approval" : "text-text-muted",
							)}
						>
							{hint.tone === "ok" ? (
								<Check className="size-3.5 shrink-0 text-success" strokeWidth={2.6} aria-hidden />
							) : null}
							{hint.text}
						</p>
					) : null}
				</div>

				<div className="flex flex-col rounded-[10px] bg-content">
					<Row first icon={receiving.icon}>
						{receiving.text}
					</Row>
					<Row
						icon={<span className="size-3 rounded-full" style={{ backgroundColor: color.css }} />}
					>
						Colour picked for you
					</Row>
					<Row
						icon={<UserRound className="text-icon" aria-hidden />}
						action={
							editingName ? null : (
								<button type="button" className={linkClass()} onClick={() => setEditingName(true)}>
									{displayName ? "Change" : "Add name"}
								</button>
							)
						}
					>
						{editingName ? (
							<input
								id={nameId}
								autoFocus
								aria-label="Sender name"
								value={displayName}
								maxLength={120}
								onChange={(e) => setDisplayName(e.target.value)}
								onBlur={() => setEditingName(false)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										setEditingName(false);
									}
								}}
								placeholder="Sender name, e.g. Santi · Billing"
								className="w-full rounded-[6px] border border-border bg-panel px-2 py-1 text-label text-ink outline-none focus:border-brand"
							/>
						) : displayName ? (
							<>
								Sends as <span className="font-medium">{displayName}</span>
							</>
						) : (
							<span className="text-text-muted">Sends with no display name</span>
						)}
					</Row>
				</div>

				{error ? (
					<InlineNotice tone="danger" className="rounded-[10px]">
						{error}
					</InlineNotice>
				) : null}
			</form>
		</Dialog>
	);
}
