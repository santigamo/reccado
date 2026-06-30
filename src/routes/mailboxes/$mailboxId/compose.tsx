import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

export const Route = createFileRoute("/mailboxes/$mailboxId/compose")({
	component: ComposePage,
});

function ComposePage() {
	const { mailboxId } = Route.useParams();
	const [to, setTo] = useState("");
	const [subject, setSubject] = useState("");
	const [bodyText, setBodyText] = useState("");
	const [draftId, setDraftId] = useState<string | null>(null);
	const [status, setStatus] = useState<string | null>(null);
	const [idempotencyKey] = useState(() => crypto.randomUUID());

	async function saveDraft() {
		const payload = {
			to: [to],
			subject,
			bodyText,
		};
		const response = await fetch(`/api/mailboxes/${mailboxId}/drafts`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const data = (await response.json()) as { id: string };
		setDraftId(data.id);
		setStatus("Draft saved");
	}

	async function requestSend() {
		if (!draftId) return;
		await fetch(`/api/mailboxes/${mailboxId}/drafts/${draftId}/request-send`, { method: "POST" });
		setStatus("Send requested — confirm below");
	}

	async function confirmSend() {
		if (!draftId) return;
		const response = await fetch(`/api/mailboxes/${mailboxId}/drafts/${draftId}/confirm-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ idempotencyKey }),
		});
		const data = await response.json();
		setStatus(JSON.stringify(data));
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell max-w-2xl rounded-2xl p-6">
				<h1 className="mb-4 text-2xl font-bold">Compose</h1>
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
				<div className="mt-4 flex flex-wrap gap-2">
					<button
						type="button"
						className="rounded bg-[var(--lagoon-deep)] px-4 py-2 text-white"
						onClick={saveDraft}
					>
						Save draft
					</button>
					<button
						type="button"
						className="rounded border px-4 py-2"
						onClick={requestSend}
						disabled={!draftId}
					>
						Request send
					</button>
					<button
						type="button"
						className="rounded border px-4 py-2"
						onClick={confirmSend}
						disabled={!draftId}
					>
						Confirm send
					</button>
				</div>
				{status ? <p className="mt-4 text-sm">{status}</p> : null}
			</section>
		</main>
	);
}
