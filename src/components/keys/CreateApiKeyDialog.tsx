import { Check, Loader2, SlidersHorizontal, UserRound, X } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
	useId,
	useRef,
	useState,
} from "react";
import { Button } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { TextField } from "#/components/ui/Field";
import { StatusDot } from "#/components/ui/StatusDot";
import { cn } from "#/lib/cn";
import { formatDay } from "#/lib/dates";
import type { MailboxColor } from "#/lib/mailbox-color";
import {
	type ApiKeyError,
	asApiKeyError,
	type CreateApiKeyInput,
	createApiKey,
	explainKeyError,
	KEY_SCOPES,
	type KeyEnvironment,
	type KeyScope,
	type MintedApiKey,
	SCOPE_LABELS,
	scopeSummary,
	sendScopeHasTemplateAllowlist,
	sendScopeHasTemplateUse,
} from "./api-keys";

/** Mirrors `z.string().email()` loosely; the server schema stays the authority. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `transactional:templates:use` is in here because rendering a template is the
 * only send path: a key offered "send" without it is refused at every send.
 */
const DEFAULT_SCOPES: KeyScope[] = [
	"transactional:send",
	"transactional:status",
	"transactional:templates:use",
];

type FieldName =
	| "sender"
	| "senderName"
	| "scopes"
	| "templateAllowlist"
	| "recipientPolicy"
	| "quotaMax"
	| "expiresAt";
type FieldErrors = Partial<Record<FieldName, string>>;
type Section = "sender" | "scopes" | "limits";

const SECTION_OF: Record<FieldName, Section | null> = {
	sender: "sender",
	senderName: "sender",
	scopes: "scopes",
	templateAllowlist: null,
	recipientPolicy: "limits",
	quotaMax: "limits",
	expiresAt: "limits",
};

function splitTemplates(text: string): string[] {
	return text
		.split(/[\n,]+/)
		.map((t) => t.trim())
		.filter((t) => t.length > 0);
}

/** One line of the grey summary block: icon · text · "Change". */
function SummaryRow({
	icon,
	children,
	action,
	open,
	onToggle,
	first,
	panel,
}: {
	icon: ReactNode;
	children: ReactNode;
	action: string;
	open: boolean;
	onToggle: () => void;
	first?: boolean;
	panel: ReactNode;
}): ReactElement {
	const panelId = useId();
	return (
		<div className={cn(!first && "border-t border-border")}>
			<div className="flex min-h-10.5 items-center gap-2.5 px-3.5 py-2">
				<span className="flex w-4 shrink-0 items-center justify-center text-icon [&_svg]:size-3.5">
					{icon}
				</span>
				<div className="min-w-0 flex-1 text-label text-text">{children}</div>
				<button
					type="button"
					onClick={onToggle}
					aria-expanded={open}
					aria-controls={panelId}
					className="shrink-0 text-label font-medium text-text underline decoration-1 underline-offset-2 hover:text-ink"
				>
					{open ? "Done" : action}
				</button>
			</div>
			{open ? (
				<div id={panelId} className="flex flex-col gap-4 px-3.5 pt-1 pb-4 pl-10">
					{panel}
				</div>
			) : null}
		</div>
	);
}

/**
 * "Create API key" (Paper artboard 3EM-0). The fewest decisions up front —
 * mode and the templates the key may send — and everything else (sender,
 * scopes, limits) summarised in one line each, behind "Change"/"Add limits".
 *
 * Validates client-side exactly what `createTransactionalApiKeySchema`
 * validates server-side, then surfaces the server's own error codes verbatim
 * when it disagrees. The plaintext key that comes back is handed straight to
 * `onCreated` and is never held here.
 */
export function CreateApiKeyDialog({
	mailboxId,
	mailboxAddress,
	color,
	onCreated,
	onClose,
}: {
	mailboxId: string;
	mailboxAddress: string;
	color: MailboxColor;
	onCreated: (minted: MintedApiKey) => void;
	onClose: () => void;
}): ReactElement {
	const formId = useId();
	const templateInputRef = useRef<HTMLInputElement>(null);
	const [environment, setEnvironment] = useState<KeyEnvironment>("test");
	const [templates, setTemplates] = useState<string[]>([]);
	const [templateDraft, setTemplateDraft] = useState("");
	const [sender, setSender] = useState(mailboxAddress);
	const [senderName, setSenderName] = useState("");
	const [scopes, setScopes] = useState<KeyScope[]>(DEFAULT_SCOPES);
	const [recipientPolicy, setRecipientPolicy] = useState("");
	const [quotaMax, setQuotaMax] = useState("");
	const [expiresAt, setExpiresAt] = useState("");
	const [open, setOpen] = useState<Record<Section, boolean>>({
		sender: false,
		scopes: false,
		limits: false,
	});
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [serverError, setServerError] = useState<ApiKeyError | null>(null);
	const [busy, setBusy] = useState(false);

	const toggle = (section: Section) => setOpen((prev) => ({ ...prev, [section]: !prev[section] }));

	function openSectionsFor(errors: FieldErrors) {
		setOpen((prev) => {
			const next = { ...prev };
			for (const field of Object.keys(errors) as FieldName[]) {
				const section = SECTION_OF[field];
				if (section) next[section] = true;
			}
			return next;
		});
	}

	function commitDraft(text = templateDraft): string[] {
		const added = splitTemplates(text);
		if (added.length === 0) return templates;
		const next = [...templates, ...added.filter((id) => !templates.includes(id))];
		setTemplates(next);
		setTemplateDraft("");
		return next;
	}

	function onTemplateKey(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Enter" || event.key === ",") {
			if (templateDraft.trim()) {
				event.preventDefault();
				commitDraft();
			} else if (event.key === ",") {
				event.preventDefault();
			}
		} else if (event.key === "Backspace" && templateDraft === "" && templates.length > 0) {
			setTemplates(templates.slice(0, -1));
		}
	}

	function toggleScope(scope: KeyScope) {
		setScopes((prev) =>
			prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
		);
	}

	/** Client-side mirror of the zod schema. Returns null when invalid. */
	function buildInput(templateList: string[]): CreateApiKeyInput | null {
		const errors: FieldErrors = {};
		const trimmedSender = sender.trim();
		if (!trimmedSender) errors.sender = "A sender address is required.";
		else if (!EMAIL_RE.test(trimmedSender)) errors.sender = "Enter a valid email address.";
		// Mirrors isValidSenderName on the server: printable ASCII minus the three
		// address-form delimiters — this goes straight into the From header.
		const trimmedName = senderName.trim();
		if (trimmedName && !(/^[\x20-\x7e]{1,64}$/.test(trimmedName) && !/[<>"]/.test(trimmedName))) {
			errors.senderName =
				"Use printable ASCII only, without angle brackets or double quotes. It goes straight into the From header.";
		}
		if (scopes.length === 0) errors.scopes = "Pick at least one permission.";
		// The server refuses both of these outright; say so before the round trip.
		if (!sendScopeHasTemplateUse(scopes)) {
			errors.scopes = "A key that sends also needs “Use templates”: every send renders a template.";
		}
		if (!sendScopeHasTemplateAllowlist(scopes, templateList)) {
			errors.templateAllowlist = "Add at least one template id this key may send.";
		}

		let quota: number | undefined;
		const trimmedQuota = quotaMax.trim();
		if (trimmedQuota) {
			const parsed = Number(trimmedQuota);
			if (!Number.isInteger(parsed) || parsed <= 0) {
				errors.quotaMax = "Quota must be a whole number greater than zero.";
			} else {
				quota = parsed;
			}
		}

		let expiry: string | undefined;
		const trimmedExpiry = expiresAt.trim();
		if (trimmedExpiry) {
			const at = new Date(trimmedExpiry);
			if (Number.isNaN(at.getTime())) errors.expiresAt = "Enter a valid date and time.";
			else expiry = at.toISOString();
		}

		setFieldErrors(errors);
		if (Object.keys(errors).length > 0) {
			openSectionsFor(errors);
			return null;
		}

		const policy = recipientPolicy.trim();
		return {
			environment,
			sender: trimmedSender,
			...(trimmedName ? { senderName: trimmedName } : {}),
			// Keep the canonical scope order regardless of click order.
			scopes: KEY_SCOPES.filter((s) => scopes.includes(s)),
			...(templateList.length > 0 ? { templateAllowlist: templateList } : {}),
			...(policy ? { recipientPolicy: policy } : {}),
			...(quota !== undefined ? { quotaMax: quota } : {}),
			...(expiry !== undefined ? { expiresAt: expiry } : {}),
		};
	}

	async function handleSubmit(event?: React.FormEvent) {
		event?.preventDefault();
		setServerError(null);
		// A template id typed but not yet confirmed with Enter still counts.
		const input = buildInput(commitDraft());
		if (!input) return;
		setBusy(true);
		try {
			onCreated(await createApiKey(mailboxId, input));
		} catch (error) {
			const apiError = asApiKeyError(error);
			setServerError(apiError);
			// Map the server's zod field errors back onto the form.
			const mapped: FieldErrors = {};
			for (const [field, messages] of Object.entries(apiError.fieldErrors)) {
				if (!Array.isArray(messages) || messages.length === 0) continue;
				if (field in SECTION_OF) mapped[field as FieldName] = messages.join(" ");
			}
			if (Object.keys(mapped).length > 0) {
				setFieldErrors((prev) => ({ ...prev, ...mapped }));
				openSectionsFor(mapped);
			}
		} finally {
			setBusy(false);
		}
	}

	const canSend = scopes.includes("transactional:send");
	const trimmedName = senderName.trim();
	const limits = [
		recipientPolicy.trim() ? `Recipients ${recipientPolicy.trim()}` : "Any recipient",
		quotaMax.trim() ? `quota ${quotaMax.trim()}` : "no quota",
		expiresAt.trim() ? `expires ${formatDay(expiresAt) || expiresAt}` : "never expires",
	].join(", ");
	const explanation = serverError ? explainKeyError(serverError) : null;

	return (
		<Dialog
			onClose={onClose}
			dismissible={!busy}
			title="Create API key"
			description={
				<span className="inline-flex items-center gap-1.75">
					<StatusDot color={color.css} size={8} />
					<span>
						For <span className="font-medium text-text">{mailboxAddress}</span>. The secret is shown
						once, right after.
					</span>
				</span>
			}
			footer={
				<>
					<DialogFooterNote>You can rotate or revoke it at any time.</DialogFooterNote>
					<Button variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" form={formId} disabled={busy}>
						{busy ? <Loader2 className="animate-spin" /> : null}
						{busy ? "Creating…" : "Create key"}
					</Button>
				</>
			}
		>
			<form
				id={formId}
				onSubmit={(event) => void handleSubmit(event)}
				className="flex flex-col gap-5.5"
				noValidate
			>
				<fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
					<legend className="mb-2 p-0 text-label font-medium text-text">Mode</legend>
					<div
						role="radiogroup"
						aria-label="Mode"
						className="flex h-10 gap-0.5 rounded-[10px] bg-pill p-0.75"
					>
						{(["test", "live"] as const).map((env) => {
							const active = environment === env;
							return (
								// biome-ignore lint/a11y/useSemanticElements: a segmented control; radio semantics without the native input chrome.
								<button
									key={env}
									type="button"
									role="radio"
									aria-checked={active}
									onClick={() => setEnvironment(env)}
									className={cn(
										"flex flex-1 basis-0 items-center justify-center gap-1.75 rounded-control text-body transition",
										active
											? "bg-panel font-medium text-ink shadow-[0_1px_2px_rgba(27,42,65,0.12)]"
											: "text-text-secondary hover:text-text",
									)}
								>
									{active ? <StatusDot tone={env === "live" ? "brand" : "muted"} /> : null}
									{env === "live" ? "Live" : "Test"}
								</button>
							);
						})}
					</div>
					<p className="m-0 text-label text-text-muted">
						{environment === "live" ? (
							<>
								<span className="font-medium text-text">
									Live keys deliver real mail to real people
								</span>
								, without asking you first. Treat it like a production credential.
							</>
						) : (
							"Test keys are for wiring up your app: their sends are refused. Live keys deliver real mail without asking you first."
						)}
					</p>
				</fieldset>

				<div className="flex flex-col gap-2">
					<label htmlFor={`${formId}-templates`} className="text-label font-medium text-text">
						Templates it can send{canSend ? "" : " (optional)"}
					</label>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: clicking the chip box focuses its input; the input itself is the control. */}
					{/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users land on the input directly. */}
					<div
						onClick={() => templateInputRef.current?.focus()}
						className={cn(
							"flex min-h-11 cursor-text flex-wrap items-center gap-1.5 rounded-[10px] border bg-panel px-2.5 py-2 transition",
							"focus-within:border-brand focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_12%,transparent)]",
							fieldErrors.templateAllowlist ? "border-danger" : "border-border",
						)}
					>
						{templates.map((id) => (
							<span
								key={id}
								className="inline-flex h-6.5 items-center gap-1.5 rounded-[6px] bg-pill px-2"
							>
								<span className="font-mono text-label text-text">{id}</span>
								<button
									type="button"
									aria-label={`Remove ${id}`}
									onClick={(event) => {
										event.stopPropagation();
										setTemplates(templates.filter((t) => t !== id));
									}}
									className="inline-flex text-text-muted hover:text-text"
								>
									<X className="size-2.5" strokeWidth={2.6} />
								</button>
							</span>
						))}
						<input
							ref={templateInputRef}
							id={`${formId}-templates`}
							value={templateDraft}
							onChange={(event) => setTemplateDraft(event.target.value)}
							onKeyDown={onTemplateKey}
							onBlur={() => commitDraft()}
							onPaste={(event) => {
								const text = event.clipboardData.getData("text");
								if (/[\n,]/.test(text.trim())) {
									event.preventDefault();
									commitDraft(`${templateDraft}${text}`);
								}
							}}
							placeholder={templates.length === 0 ? "welcome-email" : ""}
							autoComplete="off"
							spellCheck={false}
							aria-invalid={fieldErrors.templateAllowlist ? true : undefined}
							aria-describedby={`${formId}-templates-hint`}
							data-autofocus
							className="h-6.5 min-w-24 flex-1 border-0 bg-transparent pl-0.5 font-mono text-label text-ink outline-none placeholder:text-text-faint"
						/>
					</div>
					<p
						id={`${formId}-templates-hint`}
						className={cn(
							"m-0 text-label",
							fieldErrors.templateAllowlist ? "text-danger" : "text-text-muted",
						)}
					>
						{fieldErrors.templateAllowlist ??
							(canSend
								? "Type a template id and press Enter. The key can send only what is listed here."
								: "Only a key that sends needs templates.")}
					</p>
				</div>

				<div className="flex flex-col rounded-[10px] bg-content">
					<SummaryRow
						first
						icon={<UserRound />}
						action="Change"
						open={open.sender}
						onToggle={() => toggle("sender")}
						panel={
							<>
								<TextField
									label="Sender address"
									type="email"
									value={sender}
									onChange={(event) => setSender(event.target.value)}
									autoComplete="off"
									hint="Every send made with this key must use exactly this From address."
									error={fieldErrors.sender}
									className="h-10 text-body"
								/>
								<TextField
									label="Display name"
									value={senderName}
									onChange={(event) => setSenderName(event.target.value)}
									placeholder="Acme"
									maxLength={64}
									autoComplete="off"
									hint="What recipients see instead of the bare address. Leave empty to send the address alone."
									error={fieldErrors.senderName}
									className="h-10 text-body"
								/>
							</>
						}
					>
						Sends as{" "}
						{trimmedName ? (
							<span className="font-medium">
								{trimmedName} &lt;{sender.trim()}&gt;
							</span>
						) : (
							<>
								<span className="font-medium">{sender.trim() || "—"}</span>, no display name
							</>
						)}
						{fieldErrors.sender || fieldErrors.senderName ? (
							<span className="block text-meta text-danger">Check the sender.</span>
						) : null}
					</SummaryRow>

					<SummaryRow
						icon={<Check className="text-success" strokeWidth={2.6} />}
						action="Change"
						open={open.scopes}
						onToggle={() => toggle("scopes")}
						panel={
							<fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
								<legend className="sr-only">Permissions</legend>
								{KEY_SCOPES.map((scope) => {
									const id = `${formId}-scope-${scope}`;
									return (
										<label
											key={scope}
											htmlFor={id}
											className="flex cursor-pointer items-start gap-2.5"
										>
											<input
												id={id}
												type="checkbox"
												checked={scopes.includes(scope)}
												onChange={() => toggleScope(scope)}
												className="mt-0.5 size-4 shrink-0 accent-[var(--color-brand)]"
											/>
											<span className="flex min-w-0 flex-col">
												<span className="text-label font-medium text-text">
													{SCOPE_LABELS[scope].label}
												</span>
												<span className="text-meta text-text-muted">
													{SCOPE_LABELS[scope].hint}{" "}
													<code className="font-mono text-[11px] text-text-faint">{scope}</code>
												</span>
											</span>
										</label>
									);
								})}
								{fieldErrors.scopes ? (
									<p className="m-0 text-label text-danger">{fieldErrors.scopes}</p>
								) : null}
							</fieldset>
						}
					>
						{scopes.length === 0
							? "No permissions"
							: scopeSummary(scopes) === "Can send and read delivery status"
								? "Can send and read the delivery status of its own sends"
								: scopeSummary(scopes)}
						{fieldErrors.scopes && !open.scopes ? (
							<span className="block text-meta text-danger">{fieldErrors.scopes}</span>
						) : null}
					</SummaryRow>

					<SummaryRow
						icon={<SlidersHorizontal />}
						action={recipientPolicy || quotaMax || expiresAt ? "Change" : "Add limits"}
						open={open.limits}
						onToggle={() => toggle("limits")}
						panel={
							<>
								<TextField
									label="Recipients"
									value={recipientPolicy}
									onChange={(event) => setRecipientPolicy(event.target.value)}
									placeholder="@example.com"
									autoComplete="off"
									hint="Comma-separated rules: @domain.com, an exact address, or a * pattern (qa+*@example.com). Prefix ! to deny."
									error={fieldErrors.recipientPolicy}
									className="h-10 text-body"
								/>
								<div className="grid gap-4 sm:grid-cols-2">
									<TextField
										label="Quota"
										type="number"
										min={1}
										step={1}
										value={quotaMax}
										onChange={(event) => setQuotaMax(event.target.value)}
										placeholder="1000"
										hint="Maximum sends. Empty means unlimited."
										error={fieldErrors.quotaMax}
										className="h-10 text-body"
									/>
									<TextField
										label="Expires"
										type="datetime-local"
										value={expiresAt}
										onChange={(event) => setExpiresAt(event.target.value)}
										hint="Local time. Empty means never."
										error={fieldErrors.expiresAt}
										className="h-10 text-body"
									/>
								</div>
							</>
						}
					>
						{limits}
					</SummaryRow>
				</div>

				{serverError ? (
					<div
						role="alert"
						className="rounded-[10px] border border-[color-mix(in_srgb,var(--color-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-danger)_6%,white)] px-3.5 py-2.5 text-label"
					>
						<p className="m-0 font-medium text-danger">
							Could not create the key — <code className="font-mono">{serverError.code}</code>
							{serverError.status ? ` (HTTP ${serverError.status})` : ""}
						</p>
						{explanation ? <p className="m-0 mt-0.5 text-text-muted">{explanation}</p> : null}
						{serverError.formErrors.map((message) => (
							<p key={message} className="m-0 mt-0.5 text-text-muted">
								{message}
							</p>
						))}
					</div>
				) : null}
			</form>
		</Dialog>
	);
}
