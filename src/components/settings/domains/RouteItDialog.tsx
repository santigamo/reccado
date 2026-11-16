import { Check, CircleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import {
	asDomainError,
	explainDomainError,
	type RouteAddressResult,
	routeAddress,
} from "#/components/domains/domains";
import { Button } from "#/components/ui/Button";
import { Dialog, DialogFooterNote } from "#/components/ui/Dialog";
import { InlineNotice, Spinner } from "#/components/ui/Feedback";
import { CodeBlock } from "./bits";

export type RouteState =
	| { kind: "idle" }
	| { kind: "running" }
	| { kind: "done"; result: RouteAddressResult }
	/** The request never got a routing answer (session, network). */
	| { kind: "error"; message: string };

/** Calls the server-side "Route it" for one address and tracks the answer. */
export function useRouteAddress(address: string, onRouted?: (result: RouteAddressResult) => void) {
	const [state, setState] = useState<RouteState>({ kind: "idle" });
	const run = useCallback(() => {
		setState({ kind: "running" });
		routeAddress(address)
			.then((result) => {
				setState({ kind: "done", result });
				if (result.ok) onRouted?.(result);
			})
			.catch((caught: unknown) => {
				const err = asDomainError(caught);
				setState({ kind: "error", message: explainDomainError(err) ?? err.message ?? err.code });
			});
	}, [address, onRouted]);
	return { state, run };
}

/**
 * What Cloudflare said about routing one address, in one line or one notice.
 * Only ever says "routed" when the server answered `ok: true`.
 */
export function RouteOutcome({
	address,
	state,
	onRetry,
}: {
	address: string;
	state: RouteState;
	onRetry: () => void;
}) {
	if (state.kind === "idle") return null;
	if (state.kind === "running")
		return (
			<p className="m-0 flex items-center gap-2 text-label leading-[18px] text-text-muted">
				<Spinner className="size-3.5" />
				Asking Cloudflare to route {address} to Reccado…
			</p>
		);
	const retry = (
		<Button size="sm" variant="ghost" onClick={onRetry}>
			Retry
		</Button>
	);
	if (state.kind === "error")
		return (
			<InlineNotice tone="danger" className="rounded-[10px]" action={retry}>
				Couldn't ask Cloudflare: {state.message}
			</InlineNotice>
		);
	const r = state.result;
	if (r.ok)
		return (
			<p className="m-0 flex items-start gap-2 text-label leading-[18px] text-text">
				<Check className="mt-0.5 size-3.5 shrink-0 text-success" strokeWidth={2.6} aria-hidden />
				<span>
					<span className="font-medium">
						{r.status === "created"
							? "Receiving: routed."
							: r.via === "catch_all"
								? "Receiving: already routed by the catch-all."
								: "Receiving: already routed."}
					</span>{" "}
					<span className="text-text-muted">
						{r.status === "created"
							? `Cloudflare now delivers ${r.address} to Worker ${r.worker}.`
							: r.via === "catch_all"
								? `The domain's catch-all delivers ${r.address} to Worker ${r.worker}; nothing was changed.`
								: `A rule already delivers ${r.address} to Worker ${r.worker}; nothing was changed.`}
					</span>
				</span>
			</p>
		);
	return (
		<div className="flex flex-col gap-3">
			<InlineNotice tone="approval" className="rounded-[10px] py-2.5" action={retry}>
				<span className="flex items-start gap-2">
					<CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
					<span className="flex flex-col gap-1">
						<span className="font-medium">Not routed. {r.message}</span>
						<span>{r.remedy}</span>
					</span>
				</span>
			</InlineNotice>
			{r.cli ? (
				<CodeBlock
					title="From the repository (env is dev, or leave --env out for production)"
					code={r.cli}
				/>
			) : null}
		</div>
	);
}

/**
 * "Route it": asks the server to create the one Cloudflare Email Routing rule
 * that delivers this address to the Worker serving Reccado. The server never
 * changes or deletes an existing rule; when one is in the way, or the Worker's
 * token can't do it, the answer says why and how to fix it (with the
 * `pnpm setup:routing` fallback when the problem is the token).
 */
export function RouteItDialog({
	address,
	reason,
	onClose,
	onRouted,
}: {
	address: string;
	/** What the last Cloudflare read said: not routed, routed elsewhere, or not readable. */
	reason: "not_routed" | "unknown" | "elsewhere";
	onClose: () => void;
	onRouted?: (result: RouteAddressResult) => void;
}) {
	const { state, run } = useRouteAddress(address, onRouted);
	const routed = state.kind === "done" && state.result.ok;
	return (
		<Dialog
			onClose={onClose}
			size="md"
			dismissible={state.kind !== "running"}
			title={`Route ${address}`}
			description={
				reason === "unknown"
					? "Reccado couldn't read Cloudflare Email Routing for this domain, so it doesn't know whether mail to this address reaches it."
					: reason === "elsewhere"
						? "A Cloudflare Email Routing rule sends this address somewhere other than Reccado, so Reccado never sees its mail."
						: "Cloudflare doesn't deliver this address to Reccado yet. You can send from it, but mail sent to it won't arrive."
			}
			footer={
				<>
					<DialogFooterNote>Adds one rule. Existing rules are never changed.</DialogFooterNote>
					{routed ? (
						<Button variant="primary" onClick={onClose}>
							Done
						</Button>
					) : (
						<>
							<Button variant="ghost" onClick={onClose} disabled={state.kind === "running"}>
								Close
							</Button>
							{state.kind === "idle" ? (
								<Button variant="primary" onClick={run}>
									Route it
								</Button>
							) : null}
						</>
					)}
				</>
			}
		>
			<div className="flex flex-col gap-4 text-label leading-[19px] text-text-secondary">
				<p className="m-0">
					Route it adds a Cloudflare Email Routing rule that hands{" "}
					<span className="font-medium text-text">{address}</span> to this Worker. If a rule or the
					domain's catch-all already handles the address, Reccado leaves it alone and tells you.
				</p>
				<RouteOutcome address={address} state={state} onRetry={run} />
			</div>
		</Dialog>
	);
}
