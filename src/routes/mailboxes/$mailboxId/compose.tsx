import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { ComposeModal } from "#/components/mail/ComposeModal";

type ComposeSearch = {
	to?: string;
	subject?: string;
	threadId?: string;
	draftId?: string;
};

export const Route = createFileRoute("/mailboxes/$mailboxId/compose")({
	component: ComposePage,
	validateSearch: (search: Record<string, unknown>): ComposeSearch => ({
		to: typeof search.to === "string" ? search.to : undefined,
		subject: typeof search.subject === "string" ? search.subject : undefined,
		threadId: typeof search.threadId === "string" ? search.threadId : undefined,
		draftId: typeof search.draftId === "string" ? search.draftId : undefined,
	}),
});

// Standalone deep-link fallback: this route doesn't render under the mailbox
// shell's Outlet, so it paints its own full-height surface and hosts the
// compose modal directly.
function ComposePage(): ReactElement {
	const { mailboxId } = Route.useParams();
	const prefill = Route.useSearch();
	const navigate = useNavigate();

	return (
		<div className="app-surface-root h-[100dvh]">
			<ComposeModal
				mailboxId={mailboxId}
				prefill={prefill}
				onClose={() => navigate({ to: "/mailboxes/$mailboxId", params: { mailboxId } })}
				onSent={() => {}}
			/>
		</div>
	);
}
