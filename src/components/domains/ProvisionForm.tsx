import type { ReactElement, ReactNode } from "react";
import { useId, useState } from "react";
import {
	asDomainError,
	type DmarcPolicy,
	type DomainError,
	explainDomainError,
	type ProvisionInput,
	type ProvisionResult,
	provisionDomain,
} from "#/components/domains/domains";
import { ProvisionPreview } from "#/components/domains/ProvisionSteps";
import { Button } from "#/components/ui/Button";
import { cn } from "#/lib/cn";

/**
 * The one judgement in provisioning that has consequences for mail already
 * flowing, so it is spelled out rather than defaulted.
 *
 * DMARC is a ramp, not a setting. `reject` on a domain nobody has observed is
 * how legitimate mail disappears silently — the receiver drops it and no bounce
 * comes back. So monitoring first, with a reports address, then tighten once the
 * reports show DKIM and SPF actually align.
 */
const POLICIES: Array<{ value: DmarcPolicy; label: string; blurb: string }> = [
	{
		value: "none",
		label: "Monitor",
		blurb: "Nothing is rejected. Reports tell you whether your mail aligns. Start here.",
	},
	{
		value: "quarantine",
		label: "Quarantine",
		blurb: "Unaligned mail goes to spam. Move here once reports look clean.",
	},
	{
		value: "reject",
		label: "Reject",
		blurb: "Unaligned mail is refused outright. Only after quarantine has been quiet.",
	},
];

function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<div className="block">
			<label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--app-text)]">
				{label}
			</label>
			{hint && <span className="mt-0.5 block text-[12px] text-[var(--app-text-soft)]">{hint}</span>}
			<div className="mt-1.5">{children}</div>
		</div>
	);
}

const INPUT_CLASS =
	"w-full rounded-lg border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-3 py-2 text-sm text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";

export function ProvisionForm({
	onResult,
}: {
	onResult: (result: ProvisionResult) => void;
}): ReactElement {
	const ids = {
		zone: useId(),
		subdomain: useId(),
		rua: useId(),
		mailbox: useId(),
	};
	const [zone, setZone] = useState("");
	const [subdomain, setSubdomain] = useState("send");
	const [policy, setPolicy] = useState<DmarcPolicy>("none");
	const [rua, setRua] = useState("");
	const [inbound, setInbound] = useState(true);
	const [mailboxAddress, setMailboxAddress] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<DomainError | null>(null);

	const trimmedZone = zone.trim().toLowerCase();
	const sendingDomain = trimmedZone ? `${subdomain.trim() || "send"}.${trimmedZone}` : "";
	// Monitoring without a reports address publishes a policy that observes
	// nothing, which is the one combination that looks configured and teaches you
	// nothing. Warn rather than block: it is still a legitimate thing to do.
	const monitoringBlind = policy === "none" && rua.trim() === "";

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
		event.preventDefault();
		if (!trimmedZone) return;
		setError(null);
		setBusy(true);
		const input: ProvisionInput = {
			subdomain: subdomain.trim() || "send",
			dmarc: { policy, ...(rua.trim() ? { rua: rua.trim() } : {}) },
			inbound,
			...(mailboxAddress.trim() ? { mailbox: { address: mailboxAddress.trim() } } : {}),
		};
		try {
			onResult(await provisionDomain(trimmedZone, input));
		} catch (caught) {
			setError(asDomainError(caught));
		} finally {
			setBusy(false);
		}
	}

	const explanation = error ? explainDomainError(error) : null;

	return (
		<form
			onSubmit={(event) => void handleSubmit(event)}
			className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-2)] p-4 sm:p-5"
		>
			<h2 className="text-[15px] font-semibold text-[var(--app-text)]">Provision a domain</h2>
			<p className="mt-1 text-sm text-[var(--app-text-soft)]">
				Runs every step below in order. Safe to run again at any point — each step checks what is
				already true, so re-running is how you finish a domain that stopped half way.
			</p>

			<div className="mt-4 grid gap-4 sm:grid-cols-2">
				<Field label="Domain" htmlFor={ids.zone} hint="A zone already in your Cloudflare account.">
					<input
						id={ids.zone}
						className={INPUT_CLASS}
						placeholder="example.com"
						value={zone}
						onChange={(event) => setZone(event.target.value)}
						autoComplete="off"
						required
					/>
				</Field>

				<Field
					label="Sending subdomain"
					htmlFor={ids.subdomain}
					hint="Mail is sent from here, not from the apex."
				>
					<input
						id={ids.subdomain}
						className={INPUT_CLASS}
						placeholder="send"
						value={subdomain}
						onChange={(event) => setSubdomain(event.target.value)}
						autoComplete="off"
					/>
				</Field>
			</div>

			{sendingDomain && (
				<p className="mt-2 text-[13px] text-[var(--app-text-soft)]">
					Will send as{" "}
					<code className="rounded bg-[var(--app-surface)] px-1.5 py-0.5 text-[var(--app-text)]">
						{sendingDomain}
					</code>
				</p>
			)}

			<fieldset className="mt-5">
				<legend className="text-[13px] font-medium text-[var(--app-text)]">DMARC policy</legend>
				<p className="mt-0.5 text-[12px] text-[var(--app-text-soft)]">
					Cloudflare publishes <code>p=reject</code> by default when sending is enabled. This
					replaces it.
				</p>
				<div className="mt-2 grid gap-2 sm:grid-cols-3">
					{POLICIES.map((option) => (
						<button
							key={option.value}
							type="button"
							onClick={() => setPolicy(option.value)}
							aria-pressed={policy === option.value}
							className={cn(
								"rounded-xl border p-3 text-left transition",
								policy === option.value
									? "border-[var(--app-accent)] bg-[var(--app-surface)]"
									: "border-[var(--app-border)] bg-[var(--app-surface)] hover:bg-[var(--app-hover)]",
							)}
						>
							<span className="block text-[13px] font-medium text-[var(--app-text)]">
								{option.label}
							</span>
							<span className="mt-0.5 block text-[12px] text-[var(--app-text-soft)]">
								{option.blurb}
							</span>
						</button>
					))}
				</div>
			</fieldset>

			<div className="mt-4">
				<Field
					label="Aggregate reports to"
					htmlFor={ids.rua}
					hint="Where receivers send DMARC reports. Without it you are ramping blind."
				>
					<input
						id={ids.rua}
						type="email"
						className={INPUT_CLASS}
						placeholder="dmarc@example.com"
						value={rua}
						onChange={(event) => setRua(event.target.value)}
						autoComplete="off"
					/>
				</Field>
				{monitoringBlind && (
					<p className="mt-1.5 text-[12px] text-[var(--app-warning,#b45309)]">
						Monitoring with no reports address publishes a policy that observes nothing — you will
						have no evidence for when to tighten it.
					</p>
				)}
			</div>

			<div className="mt-5 space-y-3">
				<label className="flex items-start gap-2.5">
					<input
						type="checkbox"
						checked={inbound}
						onChange={(event) => setInbound(event.target.checked)}
						className="mt-0.5"
					/>
					<span className="text-[13px] text-[var(--app-text)]">
						Enable inbound routing
						<span className="mt-0.5 block text-[12px] text-[var(--app-text-soft)]">
							So the domain can receive mail as well as send it.
						</span>
					</span>
				</label>

				<Field
					label="Mailbox (optional)"
					htmlFor={ids.mailbox}
					hint="Must be on the domain above — inbound routing is enabled on that zone only."
				>
					<input
						id={ids.mailbox}
						type="email"
						className={INPUT_CLASS}
						placeholder={trimmedZone ? `hello@${trimmedZone}` : "hello@example.com"}
						value={mailboxAddress}
						onChange={(event) => setMailboxAddress(event.target.value)}
						autoComplete="off"
					/>
				</Field>
			</div>

			<details className="mt-5 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3">
				<summary className="cursor-pointer text-[13px] font-medium text-[var(--app-text)]">
					What this will do
				</summary>
				<ProvisionPreview />
			</details>

			{error && (
				<p className="mt-4 rounded-lg border border-[var(--app-danger)] bg-[var(--app-surface)] px-3 py-2 text-[13px] text-[var(--app-text)]">
					{error.code}
					{error.status ? ` (HTTP ${error.status})` : ""}
					{explanation ? ` — ${explanation}` : ""}
				</p>
			)}

			<div className="mt-5 flex justify-end">
				<Button type="submit" variant="primary" disabled={busy || !trimmedZone}>
					{busy ? "Provisioning…" : "Provision"}
				</Button>
			</div>
		</form>
	);
}
