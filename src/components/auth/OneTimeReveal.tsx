import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon, WarningIcon } from "./icons";
import { Eyebrow } from "./primitives";

/**
 * The one and only reveal of a secret minted by an approved change (a new or
 * rotated API key). Same rules as src/components/keys/OneTimeSecret.tsx:
 *  - the secret lives in React state owned by the route and dies with it — it is
 *    never written to storage, the URL, or a cookie, and never logged;
 *  - while it is on screen, a beforeunload guard makes an accidental reload or
 *    tab close cost a confirmation (the route's "Done, hide it" is gated behind
 *    an acknowledgement checkbox for the same reason).
 */
export function OneTimeReveal({ label, value }: { label: string; value: string }): ReactElement {
	const [copied, setCopied] = useState(false);
	const [copyFailed, setCopyFailed] = useState(false);

	useEffect(() => {
		if (!copied) return;
		const timer = window.setTimeout(() => setCopied(false), 2000);
		return () => window.clearTimeout(timer);
	}, [copied]);

	async function handleCopy(): Promise<void> {
		setCopyFailed(false);
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
		} catch {
			// Clipboard denied (insecure context, permission): say so rather than
			// swallowing it; the value is select-all for a manual copy.
			setCopyFailed(true);
		}
	}

	return (
		<section className="flex flex-col gap-3 rounded-card border border-approval-border bg-approval-surface p-4">
			<Eyebrow as="h2" className="text-approval">
				{label} · shown only once
			</Eyebrow>
			<div className="flex flex-col gap-2 sm:flex-row">
				<code className="min-w-0 grow select-all break-all rounded-[10px] bg-brand px-3.5 py-3 font-mono text-[13px] leading-5 text-code-text">
					{value}
				</code>
				<button
					type="button"
					onClick={() => void handleCopy()}
					className="inline-flex h-12 shrink-0 items-center justify-center gap-2 rounded-[10px] border border-approval-border bg-panel px-4 text-[14px] font-medium leading-5 text-text outline-none transition hover:bg-content focus-visible:ring-[3px] focus-visible:ring-[color-mix(in_srgb,var(--color-brand)_25%,transparent)] sm:h-auto sm:min-w-[7.5rem]"
				>
					{copied ? <CheckIcon size={15} color="var(--color-success)" /> : <CopyIcon />}
					<span aria-live="polite">{copied ? "Copied" : "Copy key"}</span>
				</button>
			</div>
			{copyFailed ? (
				<p role="alert" className="text-[13px] leading-[18px] text-danger">
					Could not reach the clipboard. Tap the key to select it, then copy it by hand.
				</p>
			) : null}
			<p className="flex items-start gap-2 text-[13px] leading-[19px] text-text">
				<WarningIcon className="mt-0.5" />
				It is never stored in plaintext. Leave or reload this page and it is gone for good; there is
				no way to recover it.
			</p>
		</section>
	);
}

/** While a secret is on screen, leaving the page costs a confirmation. */
export function useUnloadGuard(active: boolean): void {
	useEffect(() => {
		if (!active) return;
		const guard = (event: BeforeUnloadEvent) => {
			event.preventDefault();
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [active]);
}
