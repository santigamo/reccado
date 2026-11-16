import { createFileRoute, redirect } from "@tanstack/react-router";

/** The marketing About page is gone; keep the URL alive. */
export const Route = createFileRoute("/about")({
	beforeLoad: () => {
		throw redirect({ to: "/inbox", replace: true });
	},
});
