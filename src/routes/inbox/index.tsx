import { createFileRoute, useSearch } from "@tanstack/react-router";
import { ApprovalRequestPane } from "#/components/inbox/ApprovalPane";
import { SelectConversation } from "#/components/inbox/ReadingPane";

/**
 * /inbox with no conversation open: the reading pane's empty state, or an
 * approval request with no thread (`?folder=approvals&approval=<id>`).
 */
export const Route = createFileRoute("/inbox/")({
	component: InboxIndexPane,
});

function InboxIndexPane() {
	const search = useSearch({ from: "/inbox" });
	if (search.folder === "approvals" && search.approval) {
		return <ApprovalRequestPane key={search.approval} approvalId={search.approval} />;
	}
	return <SelectConversation />;
}
