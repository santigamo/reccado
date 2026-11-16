import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy URL: API keys now live under Settings, one mailbox at a time. */
export const Route = createFileRoute("/mailboxes/$mailboxId/keys")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/settings/keys",
			search: { mailbox: params.mailboxId },
			replace: true,
		});
	},
});
