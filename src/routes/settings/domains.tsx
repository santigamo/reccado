import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Globe, Plus } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
	type Alias,
	type DmarcPolicy,
	type Domain,
	type FeedbackHealth,
	fetchAliases,
	fetchDomains,
	fetchFeedbackHealth,
	fetchMailboxes,
	fetchRoutingRules,
	type Mailbox,
	type RoutingRule,
} from "#/components/domains/domains";
import { AddDomainDialog, type AddDomainMode } from "#/components/settings/domains/AddDomainDialog";
import { AddMailboxDialog } from "#/components/settings/domains/AddMailboxDialog";
import { DomainDetail } from "#/components/settings/domains/DomainDetail";
import { DomainList } from "#/components/settings/domains/DomainList";
import { SettingsShell } from "#/components/settings/SettingsShell";
import { Button } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { useMailboxColors } from "#/lib/mailbox-color";
import { useAsyncResource } from "#/lib/use-mail";

type DomainsSearch = { domain?: string; add?: "mailbox" | "domain" };

export const Route = createFileRoute("/settings/domains")({
	validateSearch: (search: Record<string, unknown>): DomainsSearch => ({
		...(typeof search.domain === "string" && search.domain ? { domain: search.domain } : {}),
		...(search.add === "mailbox" || search.add === "domain" ? { add: search.add } : {}),
	}),
	head: () => ({ meta: [{ title: "Domains & mailboxes · Settings · Reccado" }] }),
	component: DomainsSettings,
});

type Data = {
	domains: Domain[];
	mailboxes: Mailbox[];
	aliases: Alias[];
	rules: RoutingRule[];
	health: FeedbackHealth | null;
};

const EMPTY: Data = { domains: [], mailboxes: [], aliases: [], rules: [], health: null };

async function loadAll(): Promise<Data> {
	const [domains, mailboxes, aliases, rules, health] = await Promise.all([
		fetchDomains(),
		fetchMailboxes(),
		fetchAliases(),
		fetchRoutingRules(),
		// Health is advisory: the screen works without it.
		fetchFeedbackHealth().catch(() => null),
	]);
	return { domains, mailboxes, aliases, rules, health };
}

function DomainsSettings() {
	const search = Route.useSearch();
	const navigate = useNavigate({ from: "/settings/domains" });
	const { data, loading, error, refetch } = useAsyncResource<Data>(loadAll, EMPTY, []);
	const [refreshKey, setRefreshKey] = useState(0);
	const [rerun, setRerun] = useState<AddDomainMode | null>(null);
	const [mailboxDomain, setMailboxDomain] = useState<string | undefined>(undefined);
	const colorOf = useMailboxColors(data.mailboxes);

	const changed = useCallback(() => {
		refetch();
		setRefreshKey((k) => k + 1);
	}, [refetch]);

	const sorted = useMemo(
		() =>
			[...data.domains].sort((a, b) => {
				const rank = (d: Domain) => (d.status === "disabled" ? 1 : 0);
				return rank(a) - rank(b) || a.domain.localeCompare(b.domain);
			}),
		[data.domains],
	);
	const selected =
		sorted.find((d) => d.domain === search.domain) ??
		sorted.find((d) => d.status === "active") ??
		sorted[0] ??
		null;

	const setSearch = useCallback(
		(patch: Partial<DomainsSearch>) =>
			navigate({
				search: (prev: DomainsSearch) => {
					const next: DomainsSearch = { ...prev, ...patch };
					if (!next.add) delete next.add;
					if (!next.domain) delete next.domain;
					return next;
				},
				replace: true,
			}),
		[navigate],
	);

	const openAddMailbox = (domain?: string) => {
		setMailboxDomain(domain);
		setRerun(null);
		setSearch({ add: "mailbox" });
	};

	return (
		<SettingsShell
			active="domains"
			contentClassName="flex-col md:flex-row overflow-y-auto md:overflow-hidden"
			action={
				<Button variant="primary" onClick={() => setSearch({ add: "domain" })}>
					<Plus aria-hidden className="size-3.5" />
					Add domain
				</Button>
			}
		>
			{loading && data.domains.length === 0 ? (
				<div className="flex-1">
					<CenteredSpinner label="Loading domains" />
				</div>
			) : error && data.domains.length === 0 ? (
				<div className="flex-1">
					<ErrorState message={error} onRetry={refetch} />
				</div>
			) : sorted.length === 0 ? (
				<div className="flex-1">
					<EmptyState
						icon={<Globe aria-hidden />}
						title="No domains yet"
						hint="Add a domain from your Cloudflare account to send and receive mail on it."
						action={
							<Button variant="primary" onClick={() => setSearch({ add: "domain" })}>
								Add domain
							</Button>
						}
					/>
				</div>
			) : (
				<>
					<DomainList
						domains={sorted}
						mailboxes={data.mailboxes}
						health={data.health}
						selected={selected?.domain ?? null}
						onSelect={(domain) => setSearch({ domain })}
					/>
					<div className="app-scroll min-h-0 min-w-0 flex-1 md:overflow-y-auto">
						{selected ? (
							<DomainDetail
								key={selected.id}
								domain={selected}
								domains={data.domains}
								mailboxes={data.mailboxes}
								aliases={data.aliases}
								rules={data.rules}
								colorOf={colorOf}
								refreshKey={refreshKey}
								onChanged={changed}
								onAddMailbox={() => openAddMailbox(selected.domain)}
								onRerun={(policy: DmarcPolicy | null) =>
									setRerun({ kind: "rerun", domain: selected.domain, initialPolicy: policy })
								}
							/>
						) : null}
					</div>
				</>
			)}

			{search.add === "mailbox" && !loading ? (
				<AddMailboxDialog
					domains={data.domains}
					mailboxes={data.mailboxes}
					aliases={data.aliases}
					defaultDomain={mailboxDomain ?? search.domain ?? selected?.domain}
					onClose={() => setSearch({ add: undefined })}
					onCreated={(result) => {
						changed();
						const domain = result.mailbox?.primary_address.split("@")[1];
						setSearch({ add: undefined, ...(domain ? { domain } : {}) });
					}}
				/>
			) : null}

			{search.add === "domain" || rerun ? (
				<AddDomainDialog
					mode={rerun ?? { kind: "new" }}
					domains={data.domains}
					onClose={() => {
						setRerun(null);
						setSearch({ add: undefined });
					}}
					onProvisioned={changed}
					onAddMailbox={(domain) => openAddMailbox(domain)}
					onOpenDomain={(domain) => {
						setRerun(null);
						setSearch({ add: undefined, domain });
					}}
				/>
			) : null}
		</SettingsShell>
	);
}
