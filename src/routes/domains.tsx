import { createFileRoute, redirect } from "@tanstack/react-router";

/** Domains moved into Settings. Old links keep working. */
export const Route = createFileRoute("/domains")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/domains", replace: true });
	},
});
