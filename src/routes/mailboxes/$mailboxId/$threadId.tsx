import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyToInboxSearch } from "#/lib/inbox-search";

/**
 * Legacy /mailboxes/:id/:threadId (in older Telegram notifications) →
 * /inbox/:id/:threadId scoped to that mailbox.
 */
export const Route = createFileRoute("/mailboxes/$mailboxId/$threadId")({
	beforeLoad: ({ params, search }) => {
		throw redirect({
			to: "/inbox/$mailboxId/$threadId",
			params: { mailboxId: params.mailboxId, threadId: params.threadId },
			search: legacyToInboxSearch(params.mailboxId, search),
			replace: true,
		});
	},
});
