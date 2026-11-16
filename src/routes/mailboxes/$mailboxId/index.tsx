import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyToInboxSearch } from "#/lib/inbox-search";

/** Legacy /mailboxes/:id[?folder=&q=&compose=…] → /inbox scoped to that mailbox. */
export const Route = createFileRoute("/mailboxes/$mailboxId/")({
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/inbox",
			search: legacyToInboxSearch(params.mailboxId, search),
			replace: true,
		});
	},
});
