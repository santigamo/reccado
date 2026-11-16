import { useState } from "react";
import {
	asDomainError,
	type Domain,
	explainDomainError,
	externalDestinations,
	type Mailbox,
	type RoutingRule,
	type RuleAction,
	type RuleInput,
	ruleForwardTo,
} from "#/components/domains/domains";
import { Button } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { InlineNotice } from "#/components/ui/Feedback";
import { Select, TextField } from "#/components/ui/Field";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Add / edit one routing rule. Patterns are matched by the ingest path exactly
 * as `resolveRoutingForRecipient` does: `*`, a local part (`partners`), a full
 * address, or `*@domain`. Aliases are checked before any rule.
 */
export function RuleDialog({
	domain,
	domains,
	mailboxes,
	rule,
	nextPriority,
	onClose,
	onSave,
}: {
	domain: Domain;
	domains: Domain[];
	mailboxes: Mailbox[];
	rule: RoutingRule | null;
	nextPriority: number;
	onClose: () => void;
	onSave: (input: RuleInput) => Promise<void>;
}) {
	const domainMailboxes = mailboxes.filter(
		(m) => m.status === "active" && m.primary_address.toLowerCase().endsWith(`@${domain.domain}`),
	);
	const storeTargets =
		domainMailboxes.length > 0 ? domainMailboxes : mailboxes.filter((m) => m.status === "active");
	const [pattern, setPattern] = useState(rule?.pattern ?? "");
	const [priority, setPriority] = useState(String(rule?.priority ?? nextPriority));
	const [action, setAction] = useState<RuleAction>(rule?.action ?? "store");
	const [mailboxId, setMailboxId] = useState(rule?.mailbox_id ?? storeTargets[0]?.mailbox_id ?? "");
	const [forwardTo, setForwardTo] = useState(rule ? ruleForwardTo(rule).join(", ") : "");
	const [rejectReason, setRejectReason] = useState(rule?.reject_reason ?? "");
	const [enabled, setEnabled] = useState(rule ? rule.enabled === 1 : true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const destinations = forwardTo
		.split(/[\s,;]+/)
		.map((s) => s.trim())
		.filter(Boolean);
	const badDestinations = destinations.filter((d) => !EMAIL.test(d));
	const external = externalDestinations(destinations, domains);
	const priorityNumber = Number.parseInt(priority, 10);
	const valid =
		pattern.trim() !== "" &&
		Number.isInteger(priorityNumber) &&
		priorityNumber >= 0 &&
		(action !== "store" || mailboxId !== "") &&
		(action !== "forward" || (destinations.length > 0 && badDestinations.length === 0));

	async function save() {
		if (!valid) return;
		setBusy(true);
		setError(null);
		try {
			await onSave({
				pattern: pattern.trim().toLowerCase(),
				priority: priorityNumber,
				action,
				mailboxId: action === "store" ? mailboxId : null,
				forwardTo: action === "forward" ? destinations : [],
				rejectReason: action === "reject" ? rejectReason.trim() || null : null,
				enabled,
			});
			onClose();
		} catch (caught) {
			const err = asDomainError(caught);
			setError(explainDomainError(err) ?? err.message ?? err.code);
			setBusy(false);
		}
	}

	return (
		<Dialog
			onClose={onClose}
			size="md"
			dismissible={!busy}
			title={rule ? "Edit routing rule" : `Add routing rule on ${domain.domain}`}
			description="Aliases match first. Then rules are checked from the lowest priority number up, and the first match wins."
			footer={
				<>
					<DialogFooterNote>
						{external.length > 0 ? "Forwards outside your domains are flagged in the list." : null}
					</DialogFooterNote>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="primary" onClick={() => void save()} disabled={!valid || busy}>
						{busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
					</Button>
				</>
			}
		>
			<div className="flex flex-col gap-4">
				<div className="grid gap-4 sm:grid-cols-[1fr_120px]">
					<TextField
						label="Pattern"
						value={pattern}
						onChange={(e) => setPattern(e.target.value)}
						placeholder="partners"
						hint={
							<>
								<span className="font-mono">partners</span>, a full address, or{" "}
								<span className="font-mono">*</span> for everything else on {domain.domain}.
							</>
						}
						autoComplete="off"
						spellCheck={false}
						className="font-mono text-body"
					/>
					<TextField
						label="Priority"
						type="number"
						min={0}
						value={priority}
						onChange={(e) => setPriority(e.target.value)}
						error={
							Number.isInteger(priorityNumber) && priorityNumber >= 0 ? undefined : "0 or more"
						}
					/>
				</div>
				<Select
					label="Action"
					value={action}
					onChange={(e) => setAction(e.target.value as RuleAction)}
				>
					<option value="store">Store in a mailbox</option>
					<option value="forward">Forward to</option>
					<option value="reject">Reject</option>
				</Select>
				{action === "store" ? (
					<Select label="Mailbox" value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
						{storeTargets.map((m) => (
							<option key={m.mailbox_id} value={m.mailbox_id}>
								{m.primary_address}
							</option>
						))}
					</Select>
				) : null}
				{action === "forward" ? (
					<TextField
						label="Forward to"
						value={forwardTo}
						onChange={(e) => setForwardTo(e.target.value)}
						placeholder="ana@example.com, ops@example.com"
						error={
							badDestinations.length ? `Not an address: ${badDestinations.join(", ")}` : undefined
						}
						hint={
							external.length
								? `Outside your domains: ${external.join(", ")}. Mail leaves your control.`
								: "One or more addresses, separated by commas."
						}
						autoComplete="off"
					/>
				) : null}
				{action === "reject" ? (
					<TextField
						label="Reason (optional)"
						value={rejectReason}
						onChange={(e) => setRejectReason(e.target.value)}
						placeholder="This address doesn't accept mail"
					/>
				) : null}
				<label className="flex items-center gap-2.5 text-label text-text">
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => setEnabled(e.target.checked)}
						className="accent-[var(--color-brand)]"
					/>
					Enabled
				</label>
				{error ? (
					<InlineNotice tone="danger" className="rounded-[10px]">
						{error}
					</InlineNotice>
				) : null}
			</div>
		</Dialog>
	);
}
