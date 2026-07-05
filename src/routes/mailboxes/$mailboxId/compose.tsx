import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

type ComposeSearch = {
	to?: string;
	subject?: string;
	threadId?: string;
};

export const Route = createFileRoute("/mailboxes/$mailboxId/compose")({
	component: ComposePage,
	validateSearch: (search: Record<string, unknown>): ComposeSearch => ({
		to: typeof search.to === "string" ? search.to : undefined,
		subject: typeof search.subject === "string" ? search.subject : undefined,
		threadId: typeof search.threadId === "string" ? search.threadId : undefined,
	}),
});

function ComposePage() {
	const { mailboxId } = Route.useParams();
	const prefill = Route.useSearch();
	const isReply = Boolean(prefill.threadId);
	const [to, setTo] = useState(prefill.to ?? "");
	const [subject, setSubject] = useState(prefill.subject ?? "");
	const [bodyText, setBodyText] = useState("");
	const [draftId, setDraftId] = useState<string | null>(null);
	const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
	const [status, setStatus] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	function draftPayload() {
		return {
			to: [to.trim()],
			// subject is required server-side (min 1); fall back so an empty one
			// doesn't get rejected by validation.
			subject: subject.trim() || "(no subject)",
			bodyText,
			...(prefill.threadId ? { threadId: prefill.threadId } : {}),
		};
	}

	// Create the draft once, or update it in place if we already have one, so
	// repeated Save/Send clicks don't spawn duplicate drafts.
	async function ensureDraft(): Promise<string> {
		if (draftId) {
			const res = await fetch(`/api/mailboxes/${mailboxId}/drafts/${draftId}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(draftPayload()),
			});
			if (!res.ok) throw new Error(`Could not update draft (HTTP ${res.status})`);
			return draftId;
		}
		const res = await fetch(`/api/mailboxes/${mailboxId}/drafts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(draftPayload()),
		});
		if (!res.ok) throw new Error(`Could not save draft (HTTP ${res.status})`);
		const { id } = (await res.json()) as { id: string };
		setDraftId(id);
		return id;
	}

	async function saveDraft() {
		if (!to.trim()) {
			setStatus("Add a recipient first.");
			return;
		}
		setBusy(true);
		try {
			await ensureDraft();
			setStatus("Draft saved.");
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Could not save draft.");
		} finally {
			setBusy(false);
		}
	}

	// One click. The backend still runs draft -> request-send -> confirm-send
	// (that state machine is the human-confirmation gate for agent-initiated
	// sends via MCP). But when you compose here, *you* are that human, so the UI
	// walks the whole chain for you instead of making you click it three times.
	async function send() {
		if (!to.trim()) {
			setStatus("Add a recipient first.");
			return;
		}
		setBusy(true);
		setStatus("Sending…");
		try {
			const id = await ensureDraft();
			const requested = await fetch(`/api/mailboxes/${mailboxId}/drafts/${id}/request-send`, {
				method: "POST",
			});
			if (!requested.ok) throw new Error(`Send request failed (HTTP ${requested.status})`);
			const res = await fetch(`/api/mailboxes/${mailboxId}/drafts/${id}/confirm-send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ idempotencyKey }),
			});
			const data = (await res.json()) as { sent?: boolean; duplicate?: boolean; reason?: string };
			if (res.ok && (data.sent || data.duplicate)) {
				setStatus("Sent ✓");
				// Reset for a fresh next message: new draft + new idempotency key.
				setDraftId(null);
				setIdempotencyKey(crypto.randomUUID());
				setTo("");
				setSubject("");
				setBodyText("");
			} else {
				setStatus(`Not sent: ${data.reason ?? `HTTP ${res.status}`}`);
			}
		} catch (err) {
			setStatus(err instanceof Error ? err.message : "Send failed.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell max-w-2xl rounded-2xl p-6">
				<h1 className="mb-4 text-2xl font-bold">{isReply ? "Reply" : "Compose"}</h1>
				<div className="space-y-3">
					<input
						className="w-full rounded border px-3 py-2"
						placeholder="To"
						value={to}
						onChange={(e) => setTo(e.target.value)}
					/>
					<input
						className="w-full rounded border px-3 py-2"
						placeholder="Subject"
						value={subject}
						onChange={(e) => setSubject(e.target.value)}
					/>
					<textarea
						className="min-h-40 w-full rounded border px-3 py-2"
						placeholder="Body"
						value={bodyText}
						onChange={(e) => setBodyText(e.target.value)}
					/>
				</div>
				<div className="mt-4 flex flex-wrap items-center gap-2">
					<button
						type="button"
						className="rounded bg-[var(--lagoon-deep)] px-4 py-2 text-white disabled:opacity-50"
						onClick={send}
						disabled={busy}
					>
						{busy ? "Sending…" : "Send"}
					</button>
					<button
						type="button"
						className="rounded border px-4 py-2 disabled:opacity-50"
						onClick={saveDraft}
						disabled={busy}
					>
						Save draft
					</button>
				</div>
				{status ? <p className="mt-4 text-sm">{status}</p> : null}
			</section>
		</main>
	);
}
