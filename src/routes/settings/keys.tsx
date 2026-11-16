import { createFileRoute } from "@tanstack/react-router";
import { ApiKeysSettings } from "#/components/keys/ApiKeysSettings";

type KeysSearch = { mailbox?: string };

export const Route = createFileRoute("/settings/keys")({
	validateSearch: (search: Record<string, unknown>): KeysSearch =>
		typeof search.mailbox === "string" && search.mailbox ? { mailbox: search.mailbox } : {},
	component: KeysRoute,
});

function KeysRoute() {
	const { mailbox } = Route.useSearch();
	return <ApiKeysSettings mailboxParam={mailbox} />;
}
