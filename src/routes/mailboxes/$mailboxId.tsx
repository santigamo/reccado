import { createFileRoute } from "@tanstack/react-router";
import { type InboxSearch, parseInboxSearch } from "#/lib/inbox-search";

/**
 * Legacy per-mailbox URLs (/mailboxes/:id, /:threadId, /compose, /keys). Every
 * child redirects to the unified inbox or to Settings; this parent only parses
 * the search params they carry over.
 */
export const Route = createFileRoute("/mailboxes/$mailboxId")({
	validateSearch: (search: Record<string, unknown>): InboxSearch => parseInboxSearch(search),
});
