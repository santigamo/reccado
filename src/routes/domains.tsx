import { createFileRoute } from "@tanstack/react-router";
import { Globe, RefreshCw } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useState } from "react";
import {
	asDomainError,
	type Domain,
	type DomainError,
	explainDomainError,
	fetchDomains,
	type ProvisionResult,
	summarizeResult,
} from "#/components/domains/domains";
import { ProvisionForm } from "#/components/domains/ProvisionForm";
import { ProvisionSteps } from "#/components/domains/ProvisionSteps";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";

export const Route = createFileRoute("/domains")({
	component: DomainsPage,
});

function useDomains() {
	const [data, setData] = useState<Domain[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<DomainError | null>(null);
	const [nonce, setNonce] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is a deliberate re-run trigger — bumping it is what `refetch()` does.
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		fetchDomains()
			.then((domains) => {
				if (alive) setData(domains);
			})
			.catch((caught: unknown) => {
				if (alive) setError(asDomainError(caught));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [nonce]);

	return { data, loading, error, refetch: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * Domain provisioning, the UI counterpart to POST /api/domains/:domain/provision.
 *
 * The page deliberately shows the per-step result rather than a success toast.
 * A partially provisioned domain is the normal outcome when a token is missing a
 * permission, and it is also the outcome that used to go unnoticed — a domain
 * verified for sending whose bounces went nowhere. Making every step visible,
 * including the ones that were already fine, is the whole point.
 */
function DomainsPage(): ReactElement {
	const { data, loading, error, refetch } = useDomains();
	const [result, setResult] = useState<ProvisionResult | null>(null);

	function handleResult(next: ProvisionResult): void {
		setResult(next);
		// A successful registration adds a row, so the list below is now stale.
		refetch();
	}

	return (
		<div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
			<header className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold text-[var(--app-text)]">Domains</h1>
					<p className="mt-1 text-sm text-[var(--app-text-soft)]">
						Set a domain up for sending and receiving, in one pass and with no records to paste.
					</p>
				</div>
				<IconButton title="Refresh" onClick={refetch}>
					<RefreshCw className="h-4 w-4" aria-hidden />
				</IconButton>
			</header>

			<section className="mt-6">
				<ProvisionForm onResult={handleResult} />
			</section>

			{result && (
				<section className="mt-6 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface-2)] p-4 sm:p-5">
					<h2 className="text-[15px] font-semibold text-[var(--app-text)]">
						{result.sendingDomain}
					</h2>
					<p className="mt-1 text-sm text-[var(--app-text-soft)]">{summarizeResult(result)}</p>
					<ProvisionSteps result={result} />
				</section>
			)}

			<section className="mt-8">
				<h2 className="text-[15px] font-semibold text-[var(--app-text)]">Registered domains</h2>
				{loading ? (
					<CenteredSpinner label="Loading domains" />
				) : error ? (
					<ErrorState
						message={`${error.code}${explainDomainError(error) ? ` — ${explainDomainError(error)}` : ""}`}
						onRetry={refetch}
					/>
				) : data.length === 0 ? (
					<EmptyState
						icon={<Globe className="h-5 w-5" aria-hidden />}
						title="No domains yet"
						hint="Provision one above to get started."
					/>
				) : (
					<ul className="mt-3 space-y-2">
						{data.map((domain) => (
							<li
								key={domain.id}
								className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] px-3 py-2.5"
							>
								<span className="truncate text-sm text-[var(--app-text)]">{domain.domain}</span>
								<span className="shrink-0 text-[12px] text-[var(--app-text-soft)]">
									{domain.status}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
