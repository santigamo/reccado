import { Check, Copy, KeyRound } from "lucide-react";
import { type ReactElement, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/Button";
import type { MintedApiKey } from "./api-keys";

/**
 * The one and only reveal of a plaintext API key (Paper artboard 3JX-0).
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
	const live = minted.key.environment === "live";

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

	const title = rotated
		? `Rotated ${live ? "live" : "test"} key. Copy it now.`
		: `New ${live ? "live" : "test"} key. Copy it now.`;

	return (
		<section
			aria-labelledby={`${ackId}-title`}
			className="flex shrink-0 flex-col gap-4 rounded-card border-[1.5px] border-brand bg-panel px-5 pt-4.5 pb-4"
		>
			<div className="flex items-start gap-3">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-brand text-panel">
					<KeyRound className="size-4" aria-hidden="true" />
				</span>
				<div className="flex min-w-0 flex-col gap-0.5">
					<h2
						id={`${ackId}-title`}
						className="m-0 text-sender font-semibold tracking-[-0.01em] text-ink"
					>
						{title}
					</h2>
					<p className="m-0 text-label text-text-secondary">
						This is the only time the secret is shown. Reccado keeps a hash, not the key, so it
						cannot be recovered after you close this.
					</p>
					{rotated ? (
						<p className="m-0 text-label text-text-muted">
							The previous key <code className="font-mono text-meta">{minted.previousKeyId}</code>{" "}
							was revoked in the same step and stops working now.
						</p>
					) : null}
				</div>
			</div>

			<div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
				{/* `select-all` makes one click select the whole key — the fallback
				    when the clipboard API is unavailable. */}
				<code className="flex min-h-11 min-w-0 flex-1 select-all items-center break-all rounded-[10px] bg-brand px-3.5 py-2.5 font-mono text-label leading-5 text-code-text">
					{minted.plaintextKey}
				</code>
				<Button
					variant="secondary"
					onClick={() => void handleCopy()}
					className="h-11 shrink-0 rounded-[10px] px-4 sm:min-w-30"
				>
					{copied ? <Check /> : <Copy />}
					{copied ? "Copied" : "Copy key"}
				</Button>
			</div>

			{copyFailed ? (
				<p role="alert" className="m-0 -mt-2 text-label text-danger">
					Could not reach the clipboard. Click the key to select it, then copy it by hand.
				</p>
			) : null}

			<p className="m-0 -mt-1 text-meta text-text-muted">
				<span className="font-mono">{minted.key.keyId}</span> · {live ? "Live" : "Test"} · sends as{" "}
				{minted.key.sender}
			</p>

			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<label
					htmlFor={ackId}
					className="flex cursor-pointer items-center gap-2.5 text-body text-text"
				>
					<input
						id={ackId}
						type="checkbox"
						checked={acknowledged}
						onChange={(event) => setAcknowledged(event.target.checked)}
						className="size-4 shrink-0 accent-[var(--color-brand)]"
					/>
					I have stored this key somewhere safe
				</label>
				<Button variant="primary" disabled={!acknowledged} onClick={onDismiss}>
					Done, hide it
				</Button>
			</div>
		</section>
	);
}
