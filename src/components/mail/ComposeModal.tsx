import { ChevronDown, ChevronUp, Send, Trash2, X } from "lucide-react";
import { type ReactElement, useEffect, useState } from "react";
import { Button } from "#/components/ui/Button";
import { IconButton } from "#/components/ui/IconButton";
import { cn } from "#/lib/cn";
import {
	cancelDraft,
	createDraft,
	type DraftPayload,
	fetchDraft,
	parseAddressList,
	sendDraft,
	updateDraft,
} from "#/lib/mail";

type Prefill = {
	to?: string;
	subject?: string;
	threadId?: string;
	draftId?: string;
};

type Status = {
	text: string;
	error?: boolean;
};

/**
 * Gmail-style floating compose window. Anchored bottom-right on desktop,
 * a near-full-width sheet on small screens. Owns the draft/send state
 * machine: it creates a draft on first save/send and reuses it on
 * subsequent clicks so repeated Save/Send never spawns duplicates.
 */
export function ComposeModal({
	mailboxId,
	prefill,
	onClose,
	onSent,
}: {
	mailboxId: string;
	prefill: Prefill;
	onClose: () => void;
	onSent?: () => void;
}): ReactElement {
	const [minimized, setMinimized] = useState(false);
	const [to, setTo] = useState(prefill.to ?? "");
	const [subject, setSubject] = useState(prefill.subject ?? "");
	const [bodyText, setBodyText] = useState("");
	const [threadId, setThreadId] = useState<string | undefined>(prefill.threadId);
	const [draftId, setDraftId] = useState<string | null>(prefill.draftId ?? null);
	const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<Status | null>(null);
	const isReply = Boolean(threadId);

	useEffect(() => {
		if (!prefill.draftId) return;
		let alive = true;
		setBusy(true);
		setStatus({ text: "Loading draft…" });
		fetchDraft(mailboxId, prefill.draftId)
			.then((draft) => {
				if (!alive) return;
				setDraftId(draft.id);
				setThreadId(draft.thread_id ?? undefined);
				setTo(parseAddressList(draft.to_json).join(", "));
				setSubject(draft.subject ?? "");
				setBodyText(draft.body_text ?? "");
				setStatus(null);
			})
			.catch((err: unknown) => {
				if (!alive) return;
				setStatus({
					text: err instanceof Error ? err.message : "Could not load draft.",
					error: true,
				});
			})
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, [mailboxId, prefill.draftId]);

	function buildPayload(): DraftPayload {
		return {
			to: to
				.split(/[,;]/)
				.map((s) => s.trim())
				.filter(Boolean),
			// subject is required server-side (min length 1); fall back so an
			// empty one doesn't get rejected by validation.
			subject: subject.trim() || "(no subject)",
			bodyText,
			...(threadId ? { threadId } : {}),
		};
	}

	// Create the draft once, or update it in place if we already have one, so
	// repeated Save/Send clicks don't spawn duplicate drafts.
	async function ensureDraft(payload: DraftPayload): Promise<string> {
		if (draftId) {
			await updateDraft(mailboxId, draftId, payload);
			return draftId;
		}
		const id = await createDraft(mailboxId, payload);
		setDraftId(id);
		return id;
	}

	async function handleSaveDraft() {
		const payload = buildPayload();
		if (payload.to.length === 0) {
			setStatus({ text: "Add a recipient.", error: true });
			return;
		}
		setBusy(true);
		try {
			await ensureDraft(payload);
			setStatus({ text: "Draft saved." });
		} catch (err) {
			setStatus({
				text: err instanceof Error ? err.message : "Could not save draft.",
				error: true,
			});
		} finally {
			setBusy(false);
		}
	}

	// One click. The backend still runs draft -> request-send -> confirm-send
	// (the human-confirmation gate for agent-initiated sends via MCP), but
	// since a person is composing here, the UI walks the whole chain for them.
	async function handleSend() {
		const payload = buildPayload();
		if (payload.to.length === 0) {
			setStatus({ text: "Add a recipient.", error: true });
			return;
		}
		setBusy(true);
		setStatus({ text: "Sending…" });
		try {
			const id = await ensureDraft(payload);
			const result = await sendDraft(mailboxId, id, idempotencyKey);
			if (result.sent) {
				setStatus({ text: "Sent ✓" });
				setIdempotencyKey(crypto.randomUUID());
				onSent?.();
				// Brief pause so "Sent ✓" is actually visible before the window closes.
				window.setTimeout(onClose, 500);
			} else {
				setStatus({ text: `Not sent: ${result.reason ?? "unknown error"}`, error: true });
			}
		} catch (err) {
			setStatus({ text: err instanceof Error ? err.message : "Send failed.", error: true });
		} finally {
			setBusy(false);
		}
	}

	async function handleDiscard() {
		setBusy(true);
		try {
			if (draftId) await cancelDraft(mailboxId, draftId);
		} catch {
			// best effort — still close the window below
		} finally {
			setBusy(false);
			onClose();
		}
	}

	return (
		<div
			className={cn(
				"glass-strong fixed bottom-0 right-6 z-50 flex max-h-[72vh] w-[min(92vw,512px)] flex-col overflow-hidden rounded-t-2xl border border-[var(--glass-border)]",
				"max-sm:inset-x-2 max-sm:right-2",
			)}
		>
			{/* Title bar */}
			<div className="flex h-11 shrink-0 items-center justify-between border-b border-[var(--glass-border)] px-4">
				<span className="truncate text-sm font-medium text-[var(--app-text)]">
					{isReply ? "Reply" : "New message"}
				</span>
				<div className="flex items-center gap-1">
					<IconButton
						size="sm"
						title={minimized ? "Expand" : "Minimize"}
						onClick={() => setMinimized((m) => !m)}
					>
						{minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
					</IconButton>
					<IconButton size="sm" title="Close" onClick={onClose}>
						<X className="h-4 w-4" />
					</IconButton>
				</div>
			</div>

			{minimized ? null : (
				<>
					{/* Form body */}
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto app-scroll">
						<div className="flex items-center border-b border-[var(--app-border)] px-4 py-2">
							<input
								value={to}
								onChange={(e) => setTo(e.target.value)}
								placeholder="To"
								aria-label="To"
								className="w-full bg-transparent text-sm text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-faint)]"
							/>
						</div>
						<div className="flex items-center border-b border-[var(--app-border)] px-4 py-2">
							<input
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								placeholder="Subject"
								aria-label="Subject"
								className="w-full bg-transparent text-sm text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-faint)]"
							/>
						</div>
						<textarea
							value={bodyText}
							onChange={(e) => setBodyText(e.target.value)}
							placeholder="Write your message…"
							aria-label="Message body"
							className="min-h-40 w-full flex-1 resize-none bg-transparent px-4 py-3 text-sm text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-faint)]"
						/>
					</div>

					{/* Footer */}
					<div className="flex shrink-0 items-center gap-2 px-4 py-3">
						<Button variant="primary" onClick={handleSend} disabled={busy}>
							<Send className="h-4 w-4" />
							{busy ? "Sending…" : "Send"}
						</Button>
						<Button variant="secondary" onClick={handleSaveDraft} disabled={busy}>
							Save draft
						</Button>
						<div className="ml-auto">
							<IconButton title="Discard draft" onClick={handleDiscard} disabled={busy}>
								<Trash2 className="h-4 w-4" />
							</IconButton>
						</div>
					</div>

					{status ? (
						<p
							className={cn(
								"px-4 pb-3 text-xs",
								status.error ? "text-[var(--app-danger)]" : "text-[var(--app-text-soft)]",
							)}
						>
							{status.text}
						</p>
					) : null}
				</>
			)}
		</div>
	);
}
