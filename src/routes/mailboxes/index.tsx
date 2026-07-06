import { createFileRoute, Link } from "@tanstack/react-router";
import { Inbox } from "lucide-react";
import type { ReactElement } from "react";
import ThemeToggle from "#/components/ThemeToggle";
import { Avatar } from "#/components/ui/Avatar";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { useMailboxes } from "#/lib/use-mail";

export const Route = createFileRoute("/mailboxes/")({
	component: MailboxesPage,
});

function MailboxesPage(): ReactElement {
	const { data: mailboxes, loading, error, refetch } = useMailboxes();

	return (
		<div className="app-surface-root flex min-h-[100dvh] w-full items-center justify-center p-6">
			<div className="glass-strong w-full max-w-md rounded-2xl border border-[var(--glass-border)] p-6">
				<div className="mb-6 flex items-center gap-2">
					<span className="h-2 w-2 shrink-0 rounded-full bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
					<span className="text-lg font-medium tracking-tight text-[var(--app-text)]">Reccado</span>
					<div className="ml-auto">
						<ThemeToggle variant="plain" />
					</div>
				</div>

				{loading ? (
					<CenteredSpinner label="Loading mailboxes…" />
				) : error ? (
					<ErrorState message={`Failed to load mailboxes: ${error}`} onRetry={refetch} />
				) : mailboxes.length === 0 ? (
					<EmptyState icon={<Inbox className="h-10 w-10" />} title="No mailboxes yet" />
				) : (
					<ul className="flex flex-col gap-2">
						{mailboxes.map((mailbox) => (
							<li key={mailbox.mailbox_id}>
								<Link
									to="/mailboxes/$mailboxId"
									params={{ mailboxId: mailbox.mailbox_id }}
									className="flex items-center gap-3 rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)] px-4 py-3 no-underline transition hover:bg-[var(--app-hover)] active:scale-[0.99]"
								>
									<Avatar from={mailbox.primary_address} size="md" />
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium text-[var(--app-text)]">
											{mailbox.display_name ?? mailbox.primary_address}
										</div>
										<div className="truncate text-sm text-[var(--app-text-soft)]">
											{mailbox.primary_address}
										</div>
									</div>
								</Link>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}
