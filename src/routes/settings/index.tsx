import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/settings` opens on the first tab. */
export const Route = createFileRoute("/settings/")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/domains", replace: true });
	},
});
