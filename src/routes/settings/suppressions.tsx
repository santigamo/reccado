import { createFileRoute } from "@tanstack/react-router";
import { SuppressionsSettings } from "#/components/settings/suppressions/SuppressionsSettings";

type SuppressionsSearch = { mailbox?: string };

export const Route = createFileRoute("/settings/suppressions")({
	validateSearch: (search: Record<string, unknown>): SuppressionsSearch =>
		typeof search.mailbox === "string" && search.mailbox ? { mailbox: search.mailbox } : {},
	component: SuppressionsRoute,
});

function SuppressionsRoute() {
	const { mailbox } = Route.useSearch();
	return <SuppressionsSettings mailboxParam={mailbox} />;
}
