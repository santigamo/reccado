import { ChevronDown, ChevronRight, Loader2, ShieldAlert } from "lucide-react";
import { type ReactElement, type ReactNode, useId, useState } from "react";
import { Button } from "#/components/ui/Button";
import { cn } from "#/lib/cn";
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
} from "./api-keys";

const INPUT_CLASS =
	"h-10 w-full rounded-lg border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-3 text-sm text-[var(--app-text)] outline-none transition placeholder:text-[var(--app-text-faint)] focus:border-[var(--app-accent)]";

/** Mirrors `z.string().email()` loosely; the server schema stays the authority. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const DEFAULT_SCOPES: KeyScope[] = ["transactional:send", "transactional:status"];

type FieldErrors = Partial<Record<"sender" | "scopes" | "quotaMax" | "expiresAt", string>>;

function Field({
	label,
	htmlFor,
	hint,
	error,
	children,
}: {
	label: string;
	htmlFor?: string;
	hint?: string;
	error?: string;
	children: ReactNode;
}): ReactElement {
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={htmlFor} className="text-[13px] font-medium text-[var(--app-text)]">
				{label}
			</label>
			{children}
			{error ? (
				<p className="text-xs text-[var(--app-danger)]">{error}</p>
			) : hint ? (
				<p className="text-xs text-[var(--app-text-faint)]">{hint}</p>
			) : null}
		</div>
	);
}

/**
 * Creation form for a transactional API key. Validates client-side exactly what
 * `createTransactionalApiKeySchema` validates server-side, then surfaces the
 * server's own error codes verbatim when it disagrees.
 *
 * The plaintext key that comes back is handed straight to `onCreated` and is
 * never held here.
 */
export function CreateApiKeyForm({
	mailboxId,
	defaultSender,
	onCreated,
	onCancel,
}: {
	mailboxId: string;
	defaultSender?: string;
	onCreated: (minted: MintedApiKey) => void;
	onCancel: () => void;
}): ReactElement {
	const formId = useId();
	const [environment, setEnvironment] = useState<KeyEnvironment>("test");
	const [sender, setSender] = useState(defaultSender ?? "");
	const [scopes, setScopes] = useState<KeyScope[]>(DEFAULT_SCOPES);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [templateAllowlist, setTemplateAllowlist] = useState("");
	const [recipientPolicy, setRecipientPolicy] = useState("");
	const [quotaMax, setQuotaMax] = useState("");
	const [expiresAt, setExpiresAt] = useState("");
	const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
	const [serverError, setServerError] = useState<ApiKeyError | null>(null);
	const [busy, setBusy] = useState(false);

	function toggleScope(scope: KeyScope) {
		setScopes((prev) =>
			prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope],
		);
	}

	/** Client-side mirror of the zod schema. Returns null when invalid. */
	function buildInput(): CreateApiKeyInput | null {
		const errors: FieldErrors = {};
		const trimmedSender = sender.trim();
		if (!trimmedSender) errors.sender = "A sender address is required.";
		else if (!EMAIL_RE.test(trimmedSender)) errors.sender = "Enter a valid email address.";
		if (scopes.length === 0) errors.scopes = "Pick at least one scope.";

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
		if (Object.keys(errors).length > 0) return null;

		const templates = templateAllowlist
			.split(/[\n,]/)
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		const policy = recipientPolicy.trim();

		return {
			environment,
			sender: trimmedSender,
			// Keep the canonical scope order regardless of click order.
			scopes: KEY_SCOPES.filter((s) => scopes.includes(s)),
			...(templates.length > 0 ? { templateAllowlist: templates } : {}),
			...(policy ? { recipientPolicy: policy } : {}),
			...(quota !== undefined ? { quotaMax: quota } : {}),
			...(expiry !== undefined ? { expiresAt: expiry } : {}),
		};
	}

	async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setServerError(null);
		const input = buildInput();
		if (!input) return;
		setBusy(true);
		try {
			const minted = await createApiKey(mailboxId, input);
			onCreated(minted);
		} catch (error) {
			const apiError = asApiKeyError(error);
			setServerError(apiError);
			// Map the server's zod field errors back onto the form.
			const mapped: FieldErrors = {};
			for (const [field, messages] of Object.entries(apiError.fieldErrors)) {
				if (!Array.isArray(messages) || messages.length === 0) continue;
				if (field === "sender" || field === "scopes" || field === "quotaMax") {
					mapped[field] = messages.join(" ");
				} else if (field === "expiresAt") {
					mapped.expiresAt = messages.join(" ");
				}
			}
			if (Object.keys(mapped).length > 0) setFieldErrors((prev) => ({ ...prev, ...mapped }));
		} finally {
			setBusy(false);
		}
	}

	const explanation = serverError ? explainKeyError(serverError) : null;

	return (
		<form
			onSubmit={(event) => void handleSubmit(event)}
			className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-2)] p-4 sm:p-5"
		>
			<h2 className="text-[15px] font-semibold text-[var(--app-text)]">New API key</h2>
			<p className="mt-1 text-sm text-[var(--app-text-soft)]">
				The key is bound to this mailbox and to one sender address. Its secret is shown once, right
				after it is created.
			</p>

			<div className="mt-4 grid gap-4 sm:grid-cols-2">
				<Field label="Environment">
					<div className="inline-flex rounded-lg border border-[var(--app-border-strong)] bg-[var(--app-surface)] p-0.5">
						{(["test", "live"] as const).map((env) => {
							const active = environment === env;
							return (
								<button
									key={env}
									type="button"
									onClick={() => setEnvironment(env)}
									aria-pressed={active}
									className={cn(
										"h-8 flex-1 rounded-md px-4 text-[13px] font-semibold uppercase tracking-wide transition",
										!active && "text-[var(--app-text-soft)] hover:bg-[var(--app-hover)]",
										active &&
											env === "test" &&
											"bg-[var(--app-surface-2)] text-[var(--app-text)] shadow-[var(--app-shadow)]",
										active &&
											env === "live" &&
											"bg-[var(--app-danger)] text-white shadow-[var(--app-shadow)]",
									)}
								>
									{env}
								</button>
							);
						})}
					</div>
				</Field>

				<Field
					label="Sender"
					htmlFor={`${formId}-sender`}
					hint="Every send made with this key must use exactly this From address."
					error={fieldErrors.sender}
				>
					<input
						id={`${formId}-sender`}
						type="email"
						value={sender}
						onChange={(event) => setSender(event.target.value)}
						placeholder="notifications@example.com"
						autoComplete="off"
						className={INPUT_CLASS}
					/>
				</Field>
			</div>

			{environment === "live" ? (
				<p className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--app-danger)] bg-[color-mix(in_oklab,var(--app-danger)_8%,transparent)] px-3 py-2 text-sm text-[var(--app-text)]">
					<ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-danger)]" />
					<span>
						A <strong>live</strong> key sends real mail to real recipients, with no human
						confirmation step. Treat it like a production credential.
					</span>
				</p>
			) : null}

			<fieldset className="mt-4">
				<legend className="text-[13px] font-medium text-[var(--app-text)]">Scopes</legend>
				<div className="mt-2 flex flex-col gap-2">
					{KEY_SCOPES.map((scope) => {
						const id = `${formId}-scope-${scope}`;
						return (
							<label
								key={scope}
								htmlFor={id}
								className="flex cursor-pointer items-start gap-2.5 text-sm text-[var(--app-text)]"
							>
								<input
									id={id}
									type="checkbox"
									checked={scopes.includes(scope)}
									onChange={() => toggleScope(scope)}
									className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--app-accent)]"
								/>
								<span className="min-w-0">
									<code className="font-mono text-[13px]">{scope}</code>
									<span className="block text-xs text-[var(--app-text-faint)]">
										{SCOPE_LABELS[scope].hint}
									</span>
								</span>
							</label>
						);
					})}
				</div>
				{fieldErrors.scopes ? (
					<p className="mt-1.5 text-xs text-[var(--app-danger)]">{fieldErrors.scopes}</p>
				) : null}
			</fieldset>

			<button
				type="button"
				onClick={() => setAdvancedOpen((open) => !open)}
				aria-expanded={advancedOpen}
				className="mt-4 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--app-text-soft)] hover:text-[var(--app-text)]"
			>
				{advancedOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
				Restrictions (optional)
			</button>

			{advancedOpen ? (
				<div className="mt-3 grid gap-4 sm:grid-cols-2">
					<Field
						label="Template allowlist"
						htmlFor={`${formId}-templates`}
						hint="One template id per line. Empty means every template is allowed."
					>
						<textarea
							id={`${formId}-templates`}
							value={templateAllowlist}
							onChange={(event) => setTemplateAllowlist(event.target.value)}
							rows={3}
							placeholder={"welcome-email\npassword-reset"}
							className={cn(INPUT_CLASS, "h-auto resize-y py-2 font-mono text-[13px]")}
						/>
					</Field>

					<Field
						label="Recipient policy"
						htmlFor={`${formId}-policy`}
						hint="Free-form policy string enforced by the mailbox, e.g. a domain restriction."
					>
						<input
							id={`${formId}-policy`}
							type="text"
							value={recipientPolicy}
							onChange={(event) => setRecipientPolicy(event.target.value)}
							placeholder="@example.com"
							autoComplete="off"
							className={INPUT_CLASS}
						/>
					</Field>

					<Field
						label="Quota"
						htmlFor={`${formId}-quota`}
						hint="Maximum number of sends. Empty means unlimited."
						error={fieldErrors.quotaMax}
					>
						<input
							id={`${formId}-quota`}
							type="number"
							min={1}
							step={1}
							value={quotaMax}
							onChange={(event) => setQuotaMax(event.target.value)}
							placeholder="1000"
							className={INPUT_CLASS}
						/>
					</Field>

					<Field
						label="Expires at"
						htmlFor={`${formId}-expires`}
						hint="Local time, sent as UTC. Empty means the key never expires."
						error={fieldErrors.expiresAt}
					>
						<input
							id={`${formId}-expires`}
							type="datetime-local"
							value={expiresAt}
							onChange={(event) => setExpiresAt(event.target.value)}
							className={INPUT_CLASS}
						/>
					</Field>
				</div>
			) : null}

			{serverError ? (
				<div
					role="alert"
					className="mt-4 rounded-lg border border-[var(--app-danger)] bg-[color-mix(in_oklab,var(--app-danger)_8%,transparent)] px-3 py-2 text-sm"
				>
					<p className="font-medium text-[var(--app-danger)]">
						Could not create the key — <code className="font-mono">{serverError.code}</code>
						{serverError.status ? ` (HTTP ${serverError.status})` : ""}
					</p>
					{explanation ? <p className="mt-0.5 text-[var(--app-text-soft)]">{explanation}</p> : null}
					{serverError.formErrors.map((message) => (
						<p key={message} className="mt-0.5 text-[var(--app-text-soft)]">
							{message}
						</p>
					))}
				</div>
			) : null}

			<div className="mt-5 flex items-center gap-2">
				<Button type="submit" variant="primary" disabled={busy}>
					{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
					{busy ? "Creating…" : "Create key"}
				</Button>
				<Button variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</div>
		</form>
	);
}
