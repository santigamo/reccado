import { createFileRoute } from "@tanstack/react-router";
import { ThreadView } from "#/components/inbox/ReadingPane";

/** An open conversation in the reading pane; the owning mailbox is in the path. */
export const Route = createFileRoute("/inbox/$mailboxId/$threadId")({
	component: ThreadRoute,
});

function ThreadRoute() {
	const { mailboxId, threadId } = Route.useParams();
	return <ThreadView key={`${mailboxId}:${threadId}`} mailboxId={mailboxId} threadId={threadId} />;
}
