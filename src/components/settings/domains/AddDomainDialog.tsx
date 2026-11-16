import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Globe } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
	type AddressRouting,
	asDomainError,
	type DmarcPolicy,
	type Domain,
	explainDomainError,
	explainReadFailure,
	fetchDomainOverview,
	fetchMailboxes,
	fetchZones,
	type Mailbox,
	type ProvisionInput,
	type ProvisionResult,
	provisionDomain,
	STEP_LABELS,
	type StepName,
	type ZoneListing,
} from "#/components/domains/domains";
import { Button, buttonClassName } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { InlineNotice, Spinner } from "#/components/ui/Feedback";
import { TextField } from "#/components/ui/Field";
import { cn } from "#/lib/cn";
import { mailboxColor } from "#/lib/mailbox-color";
import { CodeBlock } from "./bits";
import { RouteItDialog } from "./RouteItDialog";
import { StepList, summarizeSteps } from "./StepList";

/**
 * DMARC is a ramp, not a setting. `reject` on a domain nobody has observed is
 * how legitimate mail disappears silently, so nothing is preselected: it is the
 * one judgement in provisioning with consequences for mail already flowing.
 */
const POLICIES: Array<{ value: DmarcPolicy; label: string; blurb: string }> = [
	{
		value: "none",
		label: "Start with Monitor",
		blurb: "Recommended for a new domain. Only collects reports; mail in flight is untouched.",
	},
	{
		value: "quarantine",
		label: "Quarantine",
		blurb: "Mail that fails the check goes to the recipient's spam.",
	},
	{
		value: "reject",
		label: "Reject",
		blurb: "Failing mail is refused. Best once reports look clean.",
	},
];

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

export type AddDomainMode =
	| { kind: "new" }
	| { kind: "rerun"; domain: string; initialPolicy?: DmarcPolicy | null };

type Phase =
	| { kind: "pick" }
	| { kind: "running"; zone: string; input: ProvisionInput }
	| {
			kind: "result";
			zone: string;
			input: ProvisionInput;
			result: ProvisionResult;
			seconds: number;
	  };

function PolicyCard({
	option,
	selected,
	onSelect,
}: {
	option: (typeof POLICIES)[number];
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<label
			className={cn(
				"flex flex-1 cursor-pointer flex-col gap-1.5 rounded-[10px] border p-3 transition",
				selected
					? "border-brand shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_12%,transparent)]"
					: "border-border hover:bg-row-selected",
			)}
		>
			<span className="flex items-center gap-2">
				<input
					type="radio"
					name="dmarc-policy"
					value={option.value}
					checked={selected}
					onChange={onSelect}
					className="peer sr-only"
				/>
				<span
					aria-hidden
					className={cn(
						"flex size-4 shrink-0 items-center justify-center rounded-full border-[1.5px] peer-focus-visible:ring-2 peer-focus-visible:ring-brand/40",
						selected ? "border-brand" : "border-[#B9C0CA]",
					)}
				>
					{selected ? <span className="size-2 rounded-full bg-brand" /> : null}
				</span>
				<span className="text-body leading-[18px] font-medium text-ink">{option.label}</span>
			</span>
			<span className="text-meta leading-[17px] text-text-muted">{option.blurb}</span>
		</label>
	);
}

function ZonePicker({
	listing,
	loading,
	zone,
	setZone,
	onRefresh,
}: {
	listing: ZoneListing | "error" | null;
	loading: boolean;
	zone: string;
	setZone: (zone: string) => void;
	onRefresh: () => void;
}) {
	const typedId = useId();
	const refresh = (
		<button
			type="button"
			onClick={onRefresh}
			className="inline-flex items-center gap-1 font-medium text-text underline decoration-1 underline-offset-2"
		>
			refresh the list
		</button>
	);

	if (loading || listing === null) {
		return (
			<div className="flex flex-col gap-2">
				<span className="text-label leading-4 font-medium text-text">Zone</span>
				<div className="flex h-11 items-center gap-2.5 rounded-[10px] border border-border px-3.5 text-body text-text-muted">
					<Spinner className="size-4" /> Reading your Cloudflare zones…
				</div>
			</div>
		);
	}

	if (listing !== "error" && listing.ok && listing.zones.length > 0) {
		return (
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-baseline gap-x-2">
					<label htmlFor={typedId} className="text-label leading-4 font-medium text-text">
						Zone
					</label>
					<span className="text-meta text-text-muted">
						{listing.total} active zone{listing.total === 1 ? "" : "s"} in your Cloudflare account
						{listing.registered ? ` · ${listing.registered} already added` : ""}
					</span>
				</div>
				<div className="relative flex h-11 items-center gap-2.5 rounded-[10px] border border-border pr-3 pl-3.5 focus-within:border-brand focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_12%,transparent)]">
					<Globe aria-hidden className="size-4 shrink-0 text-icon" />
					<select
						id={typedId}
						value={zone}
						onChange={(e) => setZone(e.target.value)}
						className="h-full min-w-0 flex-1 appearance-none bg-transparent pr-28 text-[15px] font-medium text-ink outline-none"
					>
						{listing.zones.map((z) => (
							<option key={z.id} value={z.name}>
								{z.name}
							</option>
						))}
					</select>
					<span className="pointer-events-none absolute right-9 flex h-6 items-center gap-1.5 rounded-[12px] bg-success/12 px-2">
						<span className="size-1.5 rounded-full bg-success" />
						<span className="text-meta font-medium text-success">Active zone</span>
					</span>
					<ChevronDown
						aria-hidden
						className="pointer-events-none absolute right-3 size-3.5 text-icon"
					/>
				</div>
				<p className="m-0 text-label text-text-muted">
					Not listed? Add the domain to your Cloudflare account first, then {refresh}.
					{listing.truncated ? " Only the first 200 zones are listed." : ""}
				</p>
			</div>
		);
	}

	// Fallback: no token, no permission, no unregistered zone, or the read failed.
	const why =
		listing === "error"
			? "Couldn't list your Cloudflare zones, so type the domain instead."
			: listing.ok
				? listing.total > 0
					? `All ${listing.total} active zones in your Cloudflare account are already added. Type another domain, or add it to Cloudflare first.`
					: "No active zones found in your Cloudflare account. Type the domain instead."
				: `${explainReadFailure(listing)} Type the domain instead.`;
	return (
		<div className="flex flex-col gap-2">
			<TextField
				id={typedId}
				label="Domain"
				value={zone}
				onChange={(e) => setZone(e.target.value.trim().toLowerCase())}
				placeholder="example.com"
				autoComplete="off"
				spellCheck={false}
				hint={
					<>
						{why} It must be an active zone in your Cloudflare account. You can also {refresh}.
					</>
				}
			/>
		</div>
	);
}

function ReadyView({
	phase,
	onAddMailbox,
}: {
	phase: Extract<Phase, { kind: "result" }>;
	onAddMailbox: (domain: string) => void;
}) {
	const { zone, input, result, seconds } = phase;
	const [showDetails, setShowDetails] = useState(false);
	const [routeIt, setRouteIt] = useState<AddressRouting | null>(null);
	const [mailboxes, setMailboxes] = useState<Mailbox[] | null>(null);
	const [routing, setRouting] = useState<AddressRouting | null>(null);
	const mailboxStep = result.steps.find((s) => s.name === "mailbox");
	const mailboxReady =
		mailboxStep?.outcome.state === "done" || mailboxStep?.outcome.state === "already";
	const address = input.mailbox?.address.toLowerCase();

	useEffect(() => {
		if (!mailboxReady || !address) return;
		let alive = true;
		fetchMailboxes()
			.then((list) => alive && setMailboxes(list))
			.catch(() => alive && setMailboxes([]));
		fetchDomainOverview(zone)
			.then((o) => {
				if (!alive) return;
				setRouting(
					o.routing.addresses.find((a) => a.address === address) ?? {
						address,
						state: "unknown",
					},
				);
			})
			.catch(() => alive && setRouting({ address, state: "unknown" }));
		return () => {
			alive = false;
		};
	}, [mailboxReady, address, zone]);

	const mailbox = mailboxes?.find((m) => m.primary_address.toLowerCase() === address);
	const color = mailbox && mailboxes ? mailboxColor(mailboxes, mailbox.mailbox_id) : null;
	const origin =
		typeof window === "undefined" ? "https://<your-reccado-host>" : window.location.origin;
	const mailboxId = mailbox?.mailbox_id ?? "<mailbox-id>";
	const snippet = [
		`curl -X POST ${origin}/v1/mailboxes/${mailboxId}/transactional/messages \\`,
		`  -H "Authorization: Bearer $RECCADO_KEY" \\`,
		`  -H "Idempotency-Key: welcome:user_123:v1" \\`,
		`  -H "Content-Type: application/json" \\`,
		`  -d '{"template":"<template-id>","to":"you@example.com","variables":{}}'`,
	].join("\n");

	let receivingLine: React.ReactNode = "Checking whether Cloudflare routes it to Reccado…";
	if (routing?.state === "routed")
		receivingLine = `Routed to Reccado${routing.workers.length ? ` (Worker ${routing.workers.join(", ")})` : ""}`;
	else if (routing)
		receivingLine = (
			<>
				{routing.state === "unknown"
					? "Receiving not checked (no Cloudflare access)"
					: "Send-only until Cloudflare routes it"}{" "}
				·{" "}
				<button
					type="button"
					onClick={() => setRouteIt(routing)}
					className="font-medium text-brand underline decoration-1 underline-offset-2"
				>
					Route it
				</button>
			</>
		);

	return (
		<div className="flex flex-col gap-[18px]">
			{mailboxReady && address ? (
				<div
					className="flex items-center gap-2.5 rounded-r-[10px] border-l-[3px] bg-content py-[11px] pr-3.5 pl-3"
					style={{ borderLeftColor: color?.css ?? "var(--color-border)" }}
				>
					<div className="flex min-w-0 flex-1 flex-col gap-px">
						<span className="truncate text-body leading-[18px] font-medium text-ink">
							{address}
						</span>
						<span className="text-label text-text-muted">{receivingLine}</span>
					</div>
					<button
						type="button"
						onClick={() => onAddMailbox(zone)}
						className="shrink-0 text-label font-medium text-text underline decoration-1 underline-offset-2"
					>
						Add another mailbox
					</button>
				</div>
			) : (
				<div className="flex items-center gap-2.5 rounded-[10px] bg-content px-3.5 py-3 text-label text-text-muted">
					<span className="flex-1">No mailbox was created on {zone}.</span>
					<button
						type="button"
						onClick={() => onAddMailbox(zone)}
						className="shrink-0 font-medium text-text underline decoration-1 underline-offset-2"
					>
						Add a mailbox
					</button>
				</div>
			)}

			<div className="flex flex-col gap-2.5">
				<div className="flex flex-col gap-px">
					<span className="text-sender font-semibold tracking-[-0.01em] text-ink">
						Send your first email
					</span>
					<span className="text-label text-text-muted">
						Your code calls the transactional API with a live key bound to this mailbox and a
						template on that key's allowlist.
					</span>
				</div>
				<div className="flex items-center gap-2.5 rounded-[10px] border border-border py-1.5 pr-1.5 pl-3.5">
					<span className="min-w-0 flex-1 text-label text-text-secondary">
						Keys are created and shown once in <span className="font-medium">API keys</span>.
					</span>
					<Link to="/settings/keys" className={buttonClassName("primary", "sm")}>
						Create a key
					</Link>
				</div>
				<CodeBlock title="curl" code={snippet} />
			</div>

			<div className="flex flex-col rounded-[10px] border border-border">
				<button
					type="button"
					onClick={() => setShowDetails((v) => !v)}
					aria-expanded={showDetails}
					className="flex h-11 items-center gap-2.5 pr-3.5 pl-3 text-left"
				>
					<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-panel">
						<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
							<path
								d="M5 12.5l4.5 4.5L19 7.5"
								fill="none"
								stroke="currentColor"
								strokeWidth="3"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</span>
					<span className="min-w-0 flex-1 text-body text-text">
						<span className="font-medium">
							Set up in {seconds} second{seconds === 1 ? "" : "s"}
						</span>{" "}
						<span className="text-text-muted">· all {result.steps.length} steps in place</span>
					</span>
					<span className="flex items-center gap-1 text-label font-medium text-text">
						Details{" "}
						{showDetails ? (
							<ChevronUp className="size-3.5" />
						) : (
							<ChevronDown className="size-3.5" />
						)}
					</span>
				</button>
				{showDetails ? (
					<div className="border-t border-border px-3.5">
						<StepList result={result} mailbox={address} />
					</div>
				) : null}
			</div>
			{routeIt ? (
				<RouteItDialog
					address={routeIt.address}
					reason={routeIt.state === "routed" ? "unknown" : routeIt.state}
					onRouted={(r) => {
						if (r.ok)
							setRouting({ address: r.address, state: "routed", via: r.via, workers: [r.worker] });
					}}
					onClose={() => setRouteIt(null)}
				/>
			) : null}
		</div>
	);
}

/**
 * Paper "Add domain" 1 → 2 → 3. One POST to /api/domains/:zone/provision; the
 * response's per-step states decide what comes next: "Ready" only when every
 * step is in place, otherwise the step list with remedies inline and Retry
 * (every step is idempotent, so retrying is always safe).
 */
export function AddDomainDialog({
	mode,
	domains,
	onClose,
	onProvisioned,
	onAddMailbox,
	onOpenDomain,
}: {
	mode: AddDomainMode;
	domains: Domain[];
	onClose: () => void;
	/** Called after every provision run (the domain list may have changed). */
	onProvisioned: (zone: string) => void;
	onAddMailbox: (domain: string) => void;
	onOpenDomain: (domain: string) => void;
}) {
	const rerun = mode.kind === "rerun";
	const [phase, setPhase] = useState<Phase>({ kind: "pick" });
	const [listing, setListing] = useState<ZoneListing | "error" | null>(null);
	const [listingLoading, setListingLoading] = useState(!rerun);
	const [zone, setZone] = useState(rerun ? mode.domain : "");
	const [policy, setPolicy] = useState<DmarcPolicy | null>(
		rerun ? (mode.initialPolicy ?? null) : null,
	);
	const [customize, setCustomize] = useState(false);
	const [subdomain, setSubdomain] = useState("send");
	const [inbound, setInbound] = useState(true);
	const [withMailbox, setWithMailbox] = useState(!rerun);
	const [mailboxLocal, setMailboxLocal] = useState("hello");
	const [rua, setRua] = useState("");
	const [error, setError] = useState<string | null>(null);
	const startedAt = useRef(0);

	const loadZones = useCallback(() => {
		if (rerun) return;
		setListingLoading(true);
		fetchZones()
			.then((l) => {
				setListing(l);
				if (l.ok && l.zones.length > 0)
					setZone((current) =>
						l.zones.some((z) => z.name === current) ? current : (l.zones[0]?.name ?? ""),
					);
			})
			.catch(() => setListing("error"))
			.finally(() => setListingLoading(false));
	}, [rerun]);

	useEffect(() => {
		loadZones();
	}, [loadZones]);

	const zoneName = zone.trim().toLowerCase();
	const zoneValid = DOMAIN_RE.test(zoneName);
	const alreadyRegistered = !rerun && domains.some((d) => d.domain === zoneName);
	const subValid = LABEL_RE.test(subdomain.trim());
	const mailboxAddress =
		withMailbox && mailboxLocal.trim() ? `${mailboxLocal.trim().toLowerCase()}@${zoneName}` : "";
	const ruaValid = rua.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rua.trim());
	const ready = zoneValid && policy !== null && subValid && ruaValid;
	const sendingDomain = `${subdomain.trim() || "send"}.${zoneName || "your-domain"}`;

	const run = useCallback(
		async (targetZone: string, input: ProvisionInput) => {
			setError(null);
			setPhase({ kind: "running", zone: targetZone, input });
			startedAt.current = Date.now();
			try {
				const result = await provisionDomain(targetZone, input);
				const seconds = Math.max(1, Math.round((Date.now() - startedAt.current) / 1000));
				setPhase({ kind: "result", zone: targetZone, input, result, seconds });
				onProvisioned(targetZone);
			} catch (caught) {
				const err = asDomainError(caught);
				setError(
					`${explainDomainError(err) ?? err.message ?? err.code}${err.status ? ` (HTTP ${err.status})` : ""}`,
				);
				setPhase({ kind: "pick" });
			}
		},
		[onProvisioned],
	);

	function submit() {
		if (!ready || policy === null) return;
		const input: ProvisionInput = {
			subdomain: subdomain.trim().toLowerCase() || "send",
			dmarc: { policy, ...(rua.trim() ? { rua: rua.trim() } : {}) },
			inbound,
			...(mailboxAddress ? { mailbox: { address: mailboxAddress } } : {}),
		};
		void run(zoneName, input);
	}

	const plannedSteps = useMemo(() => {
		const names: StepName[] = ["register_domain", "email_sending", "dmarc"];
		if (phase.kind === "running" && phase.input.inbound) names.push("email_routing");
		names.push("feedback_subscription");
		if (phase.kind === "running" && phase.input.mailbox) names.push("mailbox");
		return names;
	}, [phase]);

	// --- Phase 2: running -------------------------------------------------------
	if (phase.kind === "running") {
		return (
			<Dialog
				onClose={onClose}
				dismissible={false}
				size="md"
				className="sm:max-w-[620px]"
				title={`Setting up ${phase.zone}…`}
				description="Usually a few seconds. Nothing to do yet."
				footer={
					<>
						<DialogFooterNote>Every step checks what is already true first.</DialogFooterNote>
						<Button variant="primary" disabled>
							Working…
						</Button>
					</>
				}
			>
				<ul className="m-0 flex list-none flex-col p-0">
					{plannedSteps.map((name, i) => (
						<li
							key={name}
							className={cn(
								"flex items-center gap-3 py-3 text-body text-text-muted",
								i < plannedSteps.length - 1 && "border-b border-border-card",
							)}
						>
							<Spinner className="size-4" />
							{STEP_LABELS[name].title}
						</li>
					))}
				</ul>
			</Dialog>
		);
	}

	// --- Phase 3: result --------------------------------------------------------
	if (phase.kind === "result") {
		const { result } = phase;
		if (result.complete) {
			return (
				<Dialog
					onClose={onClose}
					size="md"
					className="sm:max-w-[620px]"
					title={`${phase.zone} is ready`}
					description={`Sending from ${result.sendingDomain}${phase.input.inbound ? " · Email Routing is on for the zone" : ""}.`}
					footer={
						<>
							<DialogFooterNote>
								Over MCP, adding or disabling a domain always needs your approval.
							</DialogFooterNote>
							<Button
								variant="ghost"
								onClick={() => {
									onOpenDomain(phase.zone);
								}}
							>
								Domain settings
							</Button>
							<Button variant="primary" onClick={onClose}>
								Done
							</Button>
						</>
					}
				>
					<ReadyView phase={phase} onAddMailbox={onAddMailbox} />
				</Dialog>
			);
		}
		const stuck = result.steps.filter(
			(s) => s.outcome.state === "blocked" || s.outcome.state === "failed",
		).length;
		return (
			<Dialog
				onClose={onClose}
				size="md"
				className="sm:max-w-[620px]"
				title={`Setting up ${phase.zone}`}
				description={
					stuck > 0
						? `${stuck === 1 ? "One step needs" : `${stuck} steps need`} you. Everything that could be done is in place, and retrying is always safe.`
						: "Some steps were skipped. Retrying is always safe."
				}
				footer={
					<>
						<DialogFooterNote>{summarizeSteps(result)}</DialogFooterNote>
						<Button variant="ghost" onClick={onClose}>
							Close
						</Button>
						<Button variant="primary" onClick={() => void run(phase.zone, phase.input)}>
							Retry
						</Button>
					</>
				}
			>
				<StepList result={result} mailbox={phase.input.mailbox?.address} />
			</Dialog>
		);
	}

	// --- Phase 1: pick & confirm -----------------------------------------------
	return (
		<Dialog
			onClose={onClose}
			size="md"
			className="sm:max-w-[620px]"
			title={rerun ? `Re-run setup for ${mode.domain}` : "Add domain"}
			description={
				rerun
					? "Runs every step again. Steps already in place are left as they are."
					: "Pick a zone from your Cloudflare account and Reccado does the rest."
			}
			footer={
				<>
					<DialogFooterNote>
						{policy === null
							? "Choose a DMARC policy to continue"
							: alreadyRegistered
								? `${zoneName} is already added; this re-runs its setup.`
								: "Safe to run again at any point."}
					</DialogFooterNote>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" disabled={!ready} onClick={submit}>
						{rerun ? "Re-run setup" : "Set up domain"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-5 pt-3">
				{rerun ? null : (
					<ZonePicker
						listing={listing}
						loading={listingLoading}
						zone={zone}
						setZone={setZone}
						onRefresh={loadZones}
					/>
				)}

				<fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
					<legend className="mb-2 flex flex-wrap items-baseline gap-x-2 p-0">
						<span className="text-label leading-4 font-medium text-text">DMARC policy</span>
						<span className="text-meta text-text-muted">The one choice we can't make for you.</span>
					</legend>
					<div className="flex flex-col gap-2 sm:flex-row">
						{POLICIES.map((option) => (
							<PolicyCard
								key={option.value}
								option={option}
								selected={policy === option.value}
								onSelect={() => setPolicy(option.value)}
							/>
						))}
					</div>
				</fieldset>

				<div className="flex flex-col rounded-[10px] bg-content">
					<button
						type="button"
						onClick={() => setCustomize((v) => !v)}
						aria-expanded={customize}
						className="flex items-center gap-3 px-3.5 py-3 text-left"
					>
						<span className="flex min-w-0 flex-1 flex-col gap-0.5">
							<span className="text-label font-medium text-text">
								We'll set up the rest for you
							</span>
							<span className="text-label leading-[19px] text-text-muted">
								Send from <span className="text-text">{sendingDomain}</span>
								{inbound ? " · receive mail" : " · no inbound"}
								{mailboxAddress ? (
									<>
										{" "}
										· first mailbox <span className="text-text">{mailboxAddress}</span>
									</>
								) : null}
							</span>
						</span>
						<span className="flex shrink-0 items-center gap-1 text-label font-medium text-text">
							Customize
							{customize ? (
								<ChevronUp className="size-3.5" />
							) : (
								<ChevronDown className="size-3.5" />
							)}
						</span>
					</button>
					{customize ? (
						<div className="flex flex-col gap-4 border-t border-border px-3.5 pt-3.5 pb-4">
							<TextField
								label="Sending subdomain"
								value={subdomain}
								onChange={(e) => setSubdomain(e.target.value.trim())}
								error={subValid ? undefined : "A single DNS label, e.g. send"}
								hint="Mail is sent from here, not from the apex."
								autoComplete="off"
							/>
							<label className="flex items-start gap-2.5 text-label text-text">
								<input
									type="checkbox"
									checked={inbound}
									onChange={(e) => setInbound(e.target.checked)}
									className="mt-0.5 accent-[var(--color-brand)]"
								/>
								<span>
									Receive mail
									<span className="block text-text-muted">
										Turns on Cloudflare Email Routing for the zone.
									</span>
								</span>
							</label>
							<div className="flex flex-col gap-2">
								<label className="flex items-start gap-2.5 text-label text-text">
									<input
										type="checkbox"
										checked={withMailbox}
										onChange={(e) => setWithMailbox(e.target.checked)}
										className="mt-0.5 accent-[var(--color-brand)]"
									/>
									<span>Create a first mailbox</span>
								</label>
								{withMailbox ? (
									<div className="flex h-11 items-stretch overflow-hidden rounded-[10px] border border-border bg-panel focus-within:border-brand">
										<input
											aria-label="First mailbox name"
											value={mailboxLocal}
											onChange={(e) => setMailboxLocal(e.target.value.replace(/\s/g, ""))}
											className="min-w-0 flex-1 bg-transparent px-3.5 text-[15px] text-ink outline-none"
										/>
										<span className="flex items-center border-l border-border bg-content px-3.5 text-[15px] text-text-muted">
											@{zoneName || "your-domain"}
										</span>
									</div>
								) : null}
							</div>
							<TextField
								label="DMARC reports to (optional)"
								type="email"
								value={rua}
								onChange={(e) => setRua(e.target.value)}
								placeholder={`dmarc@${zoneName || "example.com"}`}
								error={ruaValid ? undefined : "That isn't an email address."}
								hint={
									policy === "none" && rua.trim() === ""
										? "Monitoring without a reports address observes nothing — you'll have no evidence for when to tighten it."
										: "Where receivers send aggregate DMARC reports."
								}
								autoComplete="off"
							/>
						</div>
					) : null}
				</div>

				{error ? (
					<InlineNotice tone="danger" className="rounded-[10px]">
						{error}
					</InlineNotice>
				) : null}
			</div>
		</Dialog>
	);
}
