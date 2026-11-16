import { createFileRoute, redirect } from "@tanstack/react-router";

/** Reccado is an inbox: the root goes straight to it. */
export const Route = createFileRoute("/")({
	beforeLoad: () => {
		throw redirect({ to: "/inbox", replace: true });
	},
});
