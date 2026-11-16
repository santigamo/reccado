import { Check, Copy } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { SettingsCard } from "#/components/settings/parts/SettingsParts";

/**
 * "Connect an agent": the deployment's MCP endpoint (this origin + /mcp) and
 * the three steps. One URL and a browser sign-in — OAuth 2.1 with CIMD/DCR
 * registration, so there is no token to copy.
 */
export function ConnectAgentCard(): ReactElement {
	// The origin is only known in the browser; SSR renders the path alone.
	const [origin, setOrigin] = useState<string | null>(null);
	const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
	useEffect(() => setOrigin(window.location.origin), []);
	const url = `${origin ?? ""}/mcp`;

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
			setCopied("copied");
			window.setTimeout(() => setCopied("idle"), 1500);
		} catch {
			setCopied("failed");
		}
	}

	return (
		<SettingsCard aria-labelledby="connect-agent-title" className="gap-3.5 px-5 pt-4.5 pb-5">
			<div className="flex flex-col gap-0.5">
				<h2
					id="connect-agent-title"
					className="m-0 text-sender font-medium tracking-[-0.01em] text-text"
				>
					Connect an agent
				</h2>
				<p className="m-0 text-label text-text-muted">
					One address and a browser sign-in. No tokens to copy.
				</p>
			</div>
			<div className="flex min-h-11 items-center gap-2 rounded-[10px] bg-brand py-1.5 pr-1.5 pl-3.5">
				<code
					className="min-w-0 flex-1 select-all truncate font-mono text-label text-code-text"
					title={url}
				>
					{url}
				</code>
				<button
					type="button"
					onClick={() => void copy()}
					disabled={!origin}
					className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-white/10 px-2.5 text-label font-medium text-code-text transition hover:bg-white/15 disabled:opacity-50 [&_svg]:size-3.5"
				>
					{copied === "copied" ? <Check /> : <Copy />}
					{copied === "copied" ? "Copied" : "Copy"}
				</button>
			</div>
			{copied === "failed" ? (
				<p role="alert" className="m-0 -mt-1.5 text-label text-danger">
					Could not reach the clipboard. Select the address and copy it by hand.
				</p>
			) : null}
			<ol className="m-0 flex list-none flex-col gap-2 p-0 text-label leading-[19px] text-text-secondary">
				{[
					"Paste the address into your agent as a new MCP server or connector.",
					"It opens this site. Sign in as you do here.",
					"Tick what it may do. It then appears in the list.",
				].map((step, index) => (
					<li key={step} className="flex gap-3">
						<span className="w-3 shrink-0 text-text-muted tabular-nums">{index + 1}</span>
						<span>{step}</span>
					</li>
				))}
			</ol>
		</SettingsCard>
	);
}
