import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyToInboxSearch } from "#/lib/inbox-search";

/** Legacy standalone compose deep link → the compose dialog over the inbox. */
export const Route = createFileRoute("/mailboxes/$mailboxId/compose")({
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/inbox",
			search: legacyToInboxSearch(params.mailboxId, { ...search, compose: true }),
			replace: true,
		});
	},
});
