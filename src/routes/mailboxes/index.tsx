import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/mailboxes/")({
	component: MailboxesPage,
});

type Mailbox = {
	mailbox_id: string;
	primary_address: string;
	display_name: string | null;
};

function MailboxesPage() {
	const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch("/api/mailboxes")
			.then(async (response) => {
				if (!response.ok) throw new Error(`${response.status}`);
				const data = (await response.json()) as { mailboxes: Mailbox[] };
				setMailboxes(data.mailboxes);
			})
			.catch((err: Error) => setError(err.message));
	}, []);

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rounded-2xl p-6">
				<p className="island-kicker mb-2">Inbox MCP</p>
				<h1 className="mb-4 text-3xl font-bold text-[var(--sea-ink)]">Mailboxes</h1>
				{error ? <p className="text-red-700">Failed to load mailboxes: {error}</p> : null}
				<ul className="space-y-3">
					{mailboxes.map((mailbox) => (
						<li key={mailbox.mailbox_id}>
							<Link
								to="/mailboxes/$mailboxId"
								params={{ mailboxId: mailbox.mailbox_id }}
								className="block rounded-xl border border-[rgba(23,58,64,0.15)] bg-white/60 px-4 py-3 no-underline hover:bg-white"
							>
								<div className="font-semibold text-[var(--sea-ink)]">
									{mailbox.display_name ?? mailbox.primary_address}
								</div>
								<div className="text-sm text-[var(--sea-ink-soft)]">{mailbox.primary_address}</div>
							</Link>
						</li>
					))}
				</ul>
				{mailboxes.length === 0 && !error ? (
					<p className="text-sm text-[var(--sea-ink-soft)]">No mailboxes yet.</p>
				) : null}
			</section>
		</main>
	);
}
