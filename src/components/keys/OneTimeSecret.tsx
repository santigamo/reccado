import { AlertTriangle, Check, Copy, KeyRound } from "lucide-react";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/Button";
import { cn } from "#/lib/cn";
import type { MintedApiKey } from "./api-keys";

/**
 * The one and only reveal of a plaintext API key.
 *
 * Hard rules this component upholds (see docs/plans/transactional-api.md):
 *  - the secret lives in React state owned by the route and dies with it — it is
 *    never written to localStorage, sessionStorage, the URL, or a cookie;
 *  - it is never logged;
 *  - the panel only disappears on an explicit user action, gated behind an
 *    acknowledgement checkbox so it cannot be dismissed by a stray click;
 *  - while it is on screen, a beforeunload guard makes an accidental reload or
 *    tab close cost a confirmation.
 */
export function OneTimeSecret({
	minted,
	onDismiss,
}: {
	minted: MintedApiKey;
	onDismiss: () => void;
}): ReactElement {
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);
	const [acknowledged, setAcknowledged] = useState(false);
	const ackId = useId();
	const rotated = Boolean(minted.previousKeyId);

	// Losing the page loses the secret for good — make that cost a confirmation.
	useEffect(() => {
		const guard = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, []);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);

	async function handleCopy() {
		setCopyFailed(false);
		try {
			await navigator.clipboard.writeText(minted.plaintextKey);
			setCopied(true);
		} catch {
			// Clipboard denied (insecure context, permission): tell the user to
			// select it by hand rather than swallowing the failure silently.
			setCopyFailed(true);
		}
	}

	return (
		<section
			aria-labelledby={`${ackId}-title`}
			className="rounded-2xl border-2 border-[var(--app-accent)] bg-[color-mix(in_oklab,var(--app-accent)_8%,var(--app-surface))] p-4 shadow-[var(--app-shadow)] sm:p-5"
		>
			<div className="flex items-start gap-3">
				<span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--app-accent)] text-[var(--app-on-accent)]">
					<KeyRound className="h-5 w-5" />
				</span>
				<div className="min-w-0 flex-1">
					<h2 id={`${ackId}-title`} className="text-[15px] font-semibold text-[var(--app-text)]">
						{rotated ? "Rotated key — copy it now" : "New key — copy it now"}
					</h2>
					<p className="mt-1 flex items-start gap-1.5 text-sm font-medium text-[var(--app-danger)]">
						<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
						<span>
							This secret is shown once and is never stored in plaintext. Close this panel or leave
							the page and it is gone for good — there is no way to recover it.
						</span>
					</p>
					{rotated ? (
						<p className="mt-1.5 text-sm text-[var(--app-text-soft)]">
							The previous key{" "}
							<code className="rounded bg-[var(--app-surface-2)] px-1 py-0.5 font-mono text-[12px]">
								{minted.previousKeyId}
							</code>{" "}
							was revoked in the same operation and stops working immediately.
						</p>
					) : null}
				</div>
			</div>

			<div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-stretch">
				{/* `select-all` makes one click select the whole key, which is the
				    fallback when the clipboard API is unavailable. */}
				<code className="min-w-0 flex-1 select-all break-all rounded-xl border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-3 py-2.5 font-mono text-[13px] leading-relaxed text-[var(--app-text)]">
					{minted.plaintextKey}
				</code>
				<Button
					variant="primary"
					onClick={() => void handleCopy()}
					className="h-auto shrink-0 self-stretch rounded-xl px-4 sm:min-w-[7.5rem]"
				>
					{copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
					{copied ? "Copied" : "Copy key"}
				</Button>
			</div>

			{copyFailed ? (
				<p className="mt-2 text-xs text-[var(--app-danger)]">
					Could not reach the clipboard. Click the key above to select it, then copy manually.
				</p>
			) : null}

			<dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--app-text-soft)]">
				<div className="flex gap-1.5">
					<dt className="text-[var(--app-text-faint)]">Key ID</dt>
					<dd className="font-mono">{minted.key.keyId}</dd>
				</div>
				<div className="flex gap-1.5">
					<dt className="text-[var(--app-text-faint)]">Environment</dt>
					<dd className="font-medium uppercase">{minted.key.environment}</dd>
				</div>
				<div className="flex gap-1.5">
					<dt className="text-[var(--app-text-faint)]">Sender</dt>
					<dd className="break-all">{minted.key.sender}</dd>
				</div>
			</dl>

			<div className="mt-4 flex flex-col gap-3 border-t border-[var(--app-border)] pt-3 sm:flex-row sm:items-center sm:justify-between">
				<label
					htmlFor={ackId}
					className="flex cursor-pointer items-center gap-2 text-sm text-[var(--app-text-soft)]"
				>
					<input
						id={ackId}
						type="checkbox"
						checked={acknowledged}
						onChange={(event) => setAcknowledged(event.target.checked)}
						className="h-4 w-4 shrink-0 accent-[var(--app-accent)]"
					/>
					I have stored this key somewhere safe.
				</label>
				<Button
					variant="secondary"
					disabled={!acknowledged}
					onClick={onDismiss}
					className={cn(acknowledged && "border-[var(--app-accent)] text-[var(--app-accent)]")}
				>
					Done — hide it
				</Button>
			</div>
		</section>
	);
}
