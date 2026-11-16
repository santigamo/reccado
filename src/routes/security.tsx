import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Legacy URL. Sign-in security (password, authenticator) moved to
 * Settings → Account; connected apps moved to Settings → Agent access.
 */
export const Route = createFileRoute("/security")({
	beforeLoad: () => {
		throw redirect({ to: "/settings/account", replace: true });
	},
});
