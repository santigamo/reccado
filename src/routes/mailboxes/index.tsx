import { createFileRoute, redirect } from "@tanstack/react-router";

/** Legacy mailbox picker → the unified inbox (all mailboxes). */
export const Route = createFileRoute("/mailboxes/")({
	beforeLoad: () => {
		throw redirect({ to: "/inbox", replace: true });
	},
});
