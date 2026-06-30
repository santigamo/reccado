import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

export const Route = createFileRoute("/mailboxes/$mailboxId/")({
	component: MailboxInboxPage,
});

type Thread = {
	id: string;
	subject_norm: string | null;
	last_message_at: string;
	unread_count: number;
	latest_subject?: string | null;
};

type Message = {
	id: string;
	subject: string | null;
	from_addr: string;
	snippet: string | null;
	body_text: string | null;
	received_at: string;
	is_read: number;
};

function MailboxInboxPage() {
	const { mailboxId } = Route.useParams();
	const [threads, setThreads] = useState<Thread[]>([]);
	const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
	const [messages, setMessages] = useState<Message[]>([]);
	const [search, setSearch] = useState("");
	const [searchResults, setSearchResults] = useState<Array<{ message_id: string }>>([]);
	const [status, setStatus] = useState<string | null>(null);

	const wsUrl = useMemo(() => {
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		return `${protocol}//${window.location.host}/api/mailboxes/${mailboxId}/ws`;
	}, [mailboxId]);

	useEffect(() => {
		fetch(`/api/mailboxes/${mailboxId}/threads?limit=50`)
			.then(async (response) => response.json())
			.then((data) => setThreads((data as { threads: Thread[] }).threads ?? []))
			.catch(() => setStatus("Failed to load threads"));
	}, [mailboxId]);

	useEffect(() => {
		if (!selectedThreadId) return;
		fetch(`/api/mailboxes/${mailboxId}/threads/${selectedThreadId}`)
			.then(async (response) => response.json())
			.then((data) => setMessages((data as { messages: Message[] }).messages ?? []))
			.catch(() => setStatus("Failed to load thread"));
	}, [mailboxId, selectedThreadId]);

	useEffect(() => {
		const ws = new WebSocket(wsUrl);
		ws.onmessage = (event) => {
			try {
				const payload = JSON.parse(String(event.data)) as { type?: string };
				if (payload.type === "message.created") {
					setStatus("New message received");
					fetch(`/api/mailboxes/${mailboxId}/threads?limit=50`)
						.then(async (response) => response.json())
						.then((data) => setThreads((data as { threads: Thread[] }).threads ?? []));
				}
			} catch {
				// ignore
			}
		};
		ws.onopen = () =>
			ws.send(
				JSON.stringify({
					v: 1,
					type: "ping",
					id: "1",
					mailboxId,
					ts: new Date().toISOString(),
					payload: {},
				}),
			);
		return () => ws.close();
	}, [mailboxId, wsUrl]);

	async function runSearch() {
		if (!search.trim()) return;
		const response = await fetch(
			`/api/mailboxes/${mailboxId}/search?q=${encodeURIComponent(search)}&limit=20`,
		);
		const data = (await response.json()) as { results: Array<{ message_id: string }> };
		setSearchResults(data.results ?? []);
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rounded-2xl p-4">
				<h1 className="mb-2 text-2xl font-bold text-[var(--sea-ink)]">Inbox</h1>
				<p className="mb-4 text-sm text-[var(--sea-ink-soft)]">{mailboxId}</p>
				{status ? <p className="mb-3 text-sm text-[var(--lagoon-deep)]">{status}</p> : null}
				<div className="mb-4 flex gap-2">
					<input
						className="flex-1 rounded-lg border px-3 py-2"
						placeholder="Search mailbox"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
					<button
						type="button"
						className="rounded-lg bg-[var(--lagoon-deep)] px-4 py-2 text-white"
						onClick={runSearch}
					>
						Search
					</button>
				</div>
				{searchResults.length > 0 ? (
					<div className="mb-4 rounded-lg border p-3 text-sm">
						Search hits: {searchResults.map((row) => row.message_id).join(", ")}
					</div>
				) : null}
				<div className="grid gap-4 md:grid-cols-2">
					<div className="rounded-xl border bg-white/60 p-3">
						<h2 className="mb-2 font-semibold">Threads</h2>
						<ul className="space-y-2">
							{threads.map((thread) => (
								<li key={thread.id}>
									<button
										type="button"
										className="w-full rounded-lg border px-3 py-2 text-left hover:bg-white"
										onClick={() => setSelectedThreadId(thread.id)}
									>
										<div className="font-medium">
											{thread.latest_subject ?? thread.subject_norm ?? "(no subject)"}
										</div>
										<div className="text-xs text-[var(--sea-ink-soft)]">
											{thread.unread_count} unread ·{" "}
											{new Date(thread.last_message_at).toLocaleString()}
										</div>
									</button>
								</li>
							))}
						</ul>
					</div>
					<div className="rounded-xl border bg-white/60 p-3">
						<h2 className="mb-2 font-semibold">Messages</h2>
						{messages.map((message) => (
							<article key={message.id} className="mb-4 border-b pb-4">
								<h3 className="font-semibold">{message.subject ?? "(no subject)"}</h3>
								<p className="text-sm text-[var(--sea-ink-soft)]">
									{message.from_addr} · {new Date(message.received_at).toLocaleString()}
								</p>
								<p className="mt-2 whitespace-pre-wrap text-sm">
									{message.body_text ?? message.snippet}
								</p>
								<div className="mt-2 flex gap-2">
									<button
										type="button"
										className="rounded border px-2 py-1 text-xs"
										onClick={async () => {
											await fetch(`/api/mailboxes/${mailboxId}/messages/${message.id}/actions`, {
												method: "POST",
												headers: { "content-type": "application/json" },
												body: JSON.stringify({ action: "archive" }),
											});
											setStatus("Archived message");
										}}
									>
										Archive
									</button>
									<a
										className="rounded border px-2 py-1 text-xs no-underline"
										href={`/api/mailboxes/${mailboxId}/messages/${message.id}/raw`}
										target="_blank"
										rel="noreferrer"
									>
										Raw
									</a>
								</div>
							</article>
						))}
						{selectedThreadId && messages.length === 0 ? (
							<p className="text-sm text-[var(--sea-ink-soft)]">No messages in thread.</p>
						) : null}
					</div>
				</div>
			</section>
		</main>
	);
}
