import { ChevronDown, Lock, Send, Trash2, X } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactElement,
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Button } from "#/components/ui/Button";
import { Dialog } from "#/components/ui/Dialog";
import { IconButton } from "#/components/ui/IconButton";
import { Menu } from "#/components/ui/Menu";
import {
	cancelDraft,
	createDraft,
	type DraftPayload,
	fetchDraft,
	fetchMessage,
	type Mailbox,
	messageHtmlUrl,
	parseAddressList,
	sendDraft,
	updateDraft,
} from "#/lib/mail";
import { tint, useMailboxColors } from "#/lib/mailbox-color";
import { htmlToPlainText, plainTextToEditorHtml } from "#/lib/rich-text";
import { forwardQuoteHtml, replyQuoteHtml, sanitizeComposeHtml } from "./compose-html";
import { RichTextEditor, type RichTextEditorHandle } from "./RichTextEditor";

export type ComposePrefill = {
	to?: string;
	subject?: string;
	threadId?: string;
	draftId?: string;
	/** Message to quote below the cursor (reply) or include with its headers (forward). */
	quote?: string;
	mode?: "reply" | "forward";
};

/** Autosave this long after the last edit. */
const AUTOSAVE_MS = 1500;

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

type Status = {
	text: string;
	error?: boolean;
};

/** Server reasons that need a human explanation instead of a code. */
function explainReason(reason: string | undefined): string {
	if (reason === "approval_required") {
		return "This draft was written by an agent. It can only be sent through your approval link.";
	}
	return reason ?? "unknown error";
}

/** "a@x.com, b@y.com; c@z.com" -> ["a@x.com", "b@y.com", "c@z.com"]. */
function splitAddresses(value: string): string[] {
	return value
		.split(/[,;\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/** Committed chips plus whatever is still typed in the field. */
function allAddresses(chips: string[], typed: string): string[] {
	return [...chips, ...splitAddresses(typed)];
}

/** The two bodies a draft carries, from the editor's HTML. Empty editor: both empty. */
function bodiesOf(editorHtml: string): { bodyHtml: string; bodyText: string } {
	const bodyHtml = editorHtml ? sanitizeComposeHtml(editorHtml) : "";
	const bodyText = bodyHtml ? htmlToPlainText(bodyHtml) : "";
	if (!bodyText.trim()) return { bodyHtml: "", bodyText: "" };
	return { bodyHtml, bodyText };
}

/** Everything that decides "unsaved changes", in one comparable string. */
function snapshotOf(
	toList: string[],
	ccList: string[],
	bccList: string[],
	subj: string,
	body: string,
): string {
	return JSON.stringify([toList, ccList, bccList, subj, body]);
}

/**
 * Compose dialog (new message, reply, forward, or an existing draft) — Paper
 * artboard "Compose": header with the draft state, a From row tinted with the
 * mailbox colour, To (address chips, Cc/Bcc toggles), Subject, a borderless
 * body and a footer with Send / Save draft / discard.
 *
 * Owns the draft/send state machine: it creates a draft on first save/send and
 * updates it afterwards, so repeated Save/Send never spawns duplicates, and it
 * reuses one idempotency key per send attempt so a double click sends at most
 * once.
 *
 * `mailboxes` feeds the From selector; replies and existing drafts are pinned
 * to the mailbox they belong to (`defaultMailboxId`).
 */
export function ComposeModal({
	mailboxes,
	defaultMailboxId,
	prefill,
	onClose,
	onSent,
}: {
	mailboxes: Mailbox[];
	defaultMailboxId: string | undefined;
	prefill: ComposePrefill;
	onClose: () => void;
	onSent?: () => void;
}): ReactElement {
	const pinned = Boolean(prefill.threadId || prefill.draftId);
	const [mailboxId, setMailboxId] = useState<string>(
		defaultMailboxId ?? mailboxes.find((m) => m.status === "active")?.mailbox_id ?? "",
	);
	const [to, setTo] = useState<string[]>(() => splitAddresses(prefill.to ?? ""));
	const [toDraft, setToDraft] = useState("");
	const [cc, setCc] = useState<string[]>([]);
	const [ccDraft, setCcDraft] = useState("");
	const [bcc, setBcc] = useState<string[]>([]);
	const [bccDraft, setBccDraft] = useState("");
	const [showCc, setShowCc] = useState(false);
	const [showBcc, setShowBcc] = useState(false);
	const [subject, setSubject] = useState(prefill.subject ?? "");
	// The editor's HTML as last reported; sanitised into the payload on save.
	const [bodyHtml, setBodyHtml] = useState("");
	const [threadId, setThreadId] = useState<string | undefined>(prefill.threadId);
	const [parentMessageId, setParentMessageId] = useState<string | undefined>(
		prefill.mode === "reply" ? prefill.quote : undefined,
	);
	const [draftId, setDraftIdState] = useState<string | null>(prefill.draftId ?? null);
	// Saves are serialised: an autosave and a click can never both create a draft.
	const draftIdRef = useRef<string | null>(prefill.draftId ?? null);
	const saveChain = useRef<Promise<unknown>>(Promise.resolve());
	const setDraftId = useCallback((id: string | null) => {
		draftIdRef.current = id;
		setDraftIdState(id);
	}, []);
	const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<Status | null>(null);
	const [agentDraft, setAgentDraft] = useState(false);
	const [saved, setSaved] = useState(false);
	const toRef = useRef<HTMLInputElement>(null);
	const editorRef = useRef<RichTextEditorHandle>(null);
	const colorOf = useMailboxColors(mailboxes);
	const isReply = Boolean(threadId) && !/^fwd?:/i.test(subject);
	const [quoteReady, setQuoteReady] = useState(!prefill.quote || Boolean(prefill.draftId));

	// What is already persisted (or prefilled): differs from the fields => unsaved input.
	const [savedSnapshot, setSavedSnapshot] = useState<string>(() =>
		snapshotOf(splitAddresses(prefill.to ?? ""), [], [], prefill.subject ?? "", ""),
	);

	// Pick a default once the mailbox list arrives (deep link before load).
	useEffect(() => {
		if (!mailboxId && mailboxes.length > 0) {
			setMailboxId(defaultMailboxId ?? mailboxes[0]!.mailbox_id);
		}
	}, [mailboxId, mailboxes, defaultMailboxId]);

	useEffect(() => {
		if (!prefill.draftId || !mailboxId) return;
		let alive = true;
		setBusy(true);
		setStatus({ text: "Loading draft…" });
		fetchDraft(mailboxId, prefill.draftId)
			.then((draft) => {
				if (!alive) return;
				setDraftId(draft.id);
				setThreadId(draft.thread_id ?? undefined);
				const loadedTo = parseAddressList(draft.to_json);
				const loadedCc = parseAddressList(draft.cc_json);
				const loadedBcc = parseAddressList(draft.bcc_json);
				setTo(loadedTo);
				setCc(loadedCc);
				setBcc(loadedBcc);
				setShowCc(loadedCc.length > 0);
				setShowBcc(loadedBcc.length > 0);
				setSubject(draft.subject ?? "");
				setParentMessageId(draft.parent_message_id ?? undefined);
				const html =
					editorRef.current?.setHtml(
						draft.body_html || plainTextToEditorHtml(draft.body_text ?? ""),
					) ?? "";
				setBodyHtml(html);
				setSavedSnapshot(snapshotOf(loadedTo, loadedCc, loadedBcc, draft.subject ?? "", html));
				setSaved(true);
				setAgentDraft(draft.origin === "mcp");
				setStatus(null);
			})
			.catch((err: unknown) => {
				if (!alive) return;
				setStatus({
					text: err instanceof Error ? err.message : "Could not load the draft.",
					error: true,
				});
			})
			.finally(() => {
				if (alive) setBusy(false);
			});
		return () => {
			alive = false;
		};
	}, [prefill.draftId, mailboxId, setDraftId]);

	// Reply / forward: the original goes below the cursor, as Gmail does it. Fetched
	// here (not passed in the URL) and reduced to the compose allowlist first.
	useEffect(() => {
		if (!prefill.quote || prefill.draftId || !mailboxId) return;
		let alive = true;
		const quoteId = prefill.quote;
		(async () => {
			try {
				const message = await fetchMessage(mailboxId, quoteId);
				let html: string | null = null;
				if (message.body_html_r2_key) {
					const res = await fetch(messageHtmlUrl(mailboxId, quoteId));
					if (res.ok) html = await res.text();
				}
				if (!alive) return;
				const quoted =
					prefill.mode === "forward"
						? forwardQuoteHtml(message, html)
						: replyQuoteHtml(message, html);
				const editor = editorRef.current;
				if (!editor) return;
				// Whatever was typed while the original loaded stays on top.
				const typed = editor.getHtml();
				const normalised = editor.setHtml(
					typed.replace(/<[^>]*>/g, "").trim() ? typed + quoted : quoted,
				);
				setBodyHtml(normalised);
				setSavedSnapshot((prev) => {
					const [t, c, b, subj] = JSON.parse(prev) as [string[], string[], string[], string];
					return typed.replace(/<[^>]*>/g, "").trim()
						? prev
						: snapshotOf(t, c, b, subj, normalised);
				});
				if (!typed.replace(/<[^>]*>/g, "").trim() && prefill.to) editor.focusStart();
			} catch {
				// The original could not be loaded: compose without the quote.
			} finally {
				if (alive) {
					setQuoteReady(true);
					if (
						prefill.to &&
						!editorRef.current
							?.getHtml()
							.replace(/<[^>]*>/g, "")
							.trim()
					) {
						editorRef.current?.focusStart();
					}
				}
			}
		})();
		return () => {
			alive = false;
		};
	}, [prefill.quote, prefill.draftId, prefill.mode, prefill.to, mailboxId]);

	const toList = allAddresses(to, toDraft);
	const ccList = allAddresses(cc, ccDraft);
	const bccList = allAddresses(bcc, bccDraft);
	const dirty = snapshotOf(toList, ccList, bccList, subject, bodyHtml) !== savedSnapshot;

	function buildPayload(): DraftPayload {
		return {
			to: toList,
			cc: ccList,
			bcc: bccList,
			// subject is required server-side (min length 1); fall back so an
			// empty one doesn't get rejected by validation.
			subject: subject.trim() || "(no subject)",
			...bodiesOf(bodyHtml),
			...(threadId ? { threadId } : {}),
			...(parentMessageId ? { parentMessageId } : {}),
		};
	}

	function markSaved() {
		setTo(toList);
		setToDraft("");
		setCc(ccList);
		setCcDraft("");
		setBcc(bccList);
		setBccDraft("");
		setSavedSnapshot(snapshotOf(toList, ccList, bccList, subject, bodyHtml));
		setSaved(true);
	}

	// Create the draft once, or update it in place if we already have one. Queued
	// behind any save in flight, and reading the id from a ref, so an autosave
	// racing a click updates the same draft instead of creating a second one.
	function ensureDraft(payload: DraftPayload): Promise<string> {
		const next = saveChain.current
			.catch(() => undefined)
			.then(async () => {
				const existing = draftIdRef.current;
				if (existing) {
					await updateDraft(mailboxId, existing, payload);
					return existing;
				}
				const id = await createDraft(mailboxId, payload);
				setDraftId(id);
				return id;
			});
		saveChain.current = next;
		return next;
	}

	// Autosave, Gmail style: shortly after you stop typing, once there is someone
	// to send to. Never for an agent's draft — editing one voids its approval, and
	// that has to be a decision, not a side effect of looking at it.
	const autosaveRef = useRef<() => void>(() => {});
	autosaveRef.current = () => {
		if (!dirty || busy || agentDraft || !mailboxId || !quoteReady) return;
		const payload = buildPayload();
		const recipients = [...payload.to, ...(payload.cc ?? []), ...(payload.bcc ?? [])];
		if (payload.to.length === 0 || !recipients.every((a) => EMAIL.test(a))) return;
		const snapshot = snapshotOf(toList, ccList, bccList, subject, bodyHtml);
		setAutosaving(true);
		ensureDraft(payload)
			.then(() => {
				setSavedSnapshot(snapshot);
				setSaved(true);
			})
			.catch(() => {
				// Silent: the explicit Save / Send still report errors.
			})
			.finally(() => setAutosaving(false));
	};
	const [autosaving, setAutosaving] = useState(false);
	useEffect(() => {
		if (!dirty) return;
		const timer = window.setTimeout(() => autosaveRef.current(), AUTOSAVE_MS);
		return () => window.clearTimeout(timer);
	});

	function validate(payload: DraftPayload): boolean {
		if (!mailboxId) {
			setStatus({ text: "Pick a mailbox to send from.", error: true });
			return false;
		}
		if (payload.to.length === 0) {
			setStatus({ text: "Add at least one recipient.", error: true });
			toRef.current?.focus();
			return false;
		}
		return true;
	}

	async function handleSaveDraft() {
		const payload = buildPayload();
		if (!validate(payload)) return;
		setBusy(true);
		setStatus({ text: "Saving…" });
		try {
			await ensureDraft(payload);
			markSaved();
			setStatus(null);
		} catch (err) {
			setStatus({
				text: err instanceof Error ? err.message : "Could not save the draft.",
				error: true,
			});
		} finally {
			setBusy(false);
		}
	}

	// One click. The backend still runs draft -> request-send -> confirm-send;
	// a person is composing here, so the UI walks the chain for them.
	async function handleSend() {
		const payload = buildPayload();
		if (!validate(payload)) return;
		setBusy(true);
		setStatus({ text: "Sending…" });
		try {
			const id = await ensureDraft(payload);
			markSaved();
			const result = await sendDraft(mailboxId, id, idempotencyKey);
			if (result.sent) {
				setStatus({ text: "Sent." });
				setIdempotencyKey(crypto.randomUUID());
				onSent?.();
				// Brief pause so "Sent." is visible before the dialog closes.
				window.setTimeout(onClose, 500);
			} else {
				setStatus({ text: `Not sent: ${explainReason(result.reason)}`, error: true });
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
			// best effort — still close below
		} finally {
			setBusy(false);
			onSent?.();
			onClose();
		}
	}

	const title = prefill.draftId
		? "Draft"
		: isReply
			? "Reply"
			: threadId
				? "Forward"
				: "New message";
	const fromMailbox = mailboxes.find((m) => m.mailbox_id === mailboxId);
	const color = colorOf(mailboxId);
	const locked = pinned || mailboxes.length <= 1;

	// Header state, top right: "Draft saved" / "Unsaved changes" / "Saving…".
	let headerState: string | null = null;
	if ((busy && status?.text === "Saving…") || autosaving) headerState = "Saving…";
	else if (dirty && (saved || draftId)) headerState = "Unsaved changes";
	else if (saved || draftId) headerState = "Draft saved";

	// Footer note: errors and progress first, then the agent-draft rule, then the default.
	const note: ReactNode =
		status && status.text !== "Saving…" ? (
			<span role="status" className={status.error ? "text-danger" : undefined}>
				{status.text}
			</span>
		) : agentDraft ? (
			explainReason("approval_required")
		) : (
			"You are sending this yourself, so it goes out right away"
		);

	const chip = (
		<span
			className="inline-flex h-8 max-w-full items-center gap-2 rounded-panel border bg-panel pr-2.5 pl-3"
			style={{ borderColor: tint(color, 45) }}
		>
			<span
				aria-hidden="true"
				className="size-2 shrink-0 rounded-[4px]"
				style={{ background: color.css }}
			/>
			<span className="truncate text-body font-medium text-ink">
				{fromMailbox?.primary_address ?? "—"}
			</span>
			{locked ? null : <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-icon" />}
		</span>
	);

	return (
		<Dialog
			onClose={onClose}
			title={title}
			size="lg"
			dismissible={!dirty && !busy}
			initialFocusRef={prefill.to ? undefined : toRef}
			headerClassName="items-center pt-[18px] pr-5 pb-3.5 pl-7 max-sm:pl-5"
			headerAside={
				headerState ? (
					<span aria-live="polite" className="shrink-0 pr-1.5 text-label text-text-muted">
						{headerState}
					</span>
				) : null
			}
			bodyClassName="flex flex-col p-0"
			footerClassName="gap-2.5 px-5"
			footer={
				<>
					<Button
						variant="primary"
						onClick={handleSend}
						disabled={busy || !mailboxId}
						className="pr-[18px] pl-3.5"
					>
						<Send />
						{busy && status?.text === "Sending…" ? "Sending…" : "Send"}
					</Button>
					<Button variant="secondary" onClick={handleSaveDraft} disabled={busy} className="px-3.5">
						Save draft
					</Button>
					<div className="flex min-w-0 flex-1 items-center justify-end gap-2 pr-1.5 text-label text-text-muted max-sm:order-last max-sm:basis-full max-sm:justify-start [&_svg]:size-[15px] [&_svg]:shrink-0">
						<Lock aria-hidden="true" />
						<span className="min-w-0">{note}</span>
					</div>
					<IconButton
						title={draftId ? "Discard draft" : "Discard"}
						onClick={handleDiscard}
						disabled={busy}
						className="size-9 max-sm:ml-auto"
					>
						<Trash2 />
					</IconButton>
				</>
			}
		>
			<div
				className="flex h-12 shrink-0 items-center gap-3 border-t border-l-[3px] border-t-border-card pr-5 pl-[25px] max-sm:pl-[17px]"
				style={{ backgroundColor: tint(color, 10), borderLeftColor: color.css }}
			>
				<span className="w-14 shrink-0 text-label text-text-muted max-sm:w-12">From</span>
				{locked ? (
					<span className="flex min-w-0">{chip}</span>
				) : (
					<Menu
						label={`From: ${fromMailbox?.primary_address ?? "pick a mailbox"}`}
						triggerClassName="flex min-w-0 rounded-panel"
						trigger={chip}
						items={mailboxes.map((m) => ({
							key: m.mailbox_id,
							label: m.primary_address,
							icon: (
								<span
									aria-hidden="true"
									className="size-2 rounded-[4px]"
									style={{ background: colorOf(m.mailbox_id).css }}
								/>
							),
							active: m.mailbox_id === mailboxId,
							disabled: m.status !== "active" || busy,
							onSelect: () => setMailboxId(m.mailbox_id),
						}))}
					/>
				)}
				{fromMailbox?.display_name ? (
					<span className="min-w-0 flex-1 truncate text-label text-text-muted max-sm:hidden">
						Sends as {fromMailbox.display_name}
					</span>
				) : null}
			</div>

			<AddressRow
				label="To"
				inputRef={toRef}
				chips={to}
				onChips={setTo}
				draft={toDraft}
				onDraft={setToDraft}
				disabled={busy}
				trailing={
					!showCc || !showBcc ? (
						<span className="flex shrink-0 gap-2 text-label text-text-muted">
							{showCc ? null : (
								<button
									type="button"
									className="rounded-[4px] hover:text-text"
									onClick={() => setShowCc(true)}
								>
									Cc
								</button>
							)}
							{showBcc ? null : (
								<button
									type="button"
									className="rounded-[4px] hover:text-text"
									onClick={() => setShowBcc(true)}
								>
									Bcc
								</button>
							)}
						</span>
					) : null
				}
			/>
			{showCc ? (
				<AddressRow
					label="Cc"
					chips={cc}
					onChips={setCc}
					draft={ccDraft}
					onDraft={setCcDraft}
					disabled={busy}
					autoFocus={cc.length === 0}
				/>
			) : null}
			{showBcc ? (
				<AddressRow
					label="Bcc"
					chips={bcc}
					onChips={setBcc}
					draft={bccDraft}
					onDraft={setBccDraft}
					disabled={busy}
					autoFocus={bcc.length === 0}
				/>
			) : null}

			<label className="flex h-12 shrink-0 items-center gap-3 border-y border-border-card pr-5 pl-7 max-sm:pl-5">
				<span className="w-14 shrink-0 text-label text-text-muted max-sm:w-12">Subject</span>
				<input
					value={subject}
					onChange={(e) => setSubject(e.target.value)}
					placeholder="Subject"
					disabled={busy}
					className="h-full min-w-0 flex-1 bg-transparent text-body font-medium text-ink outline-none placeholder:font-normal placeholder:text-text-faint"
				/>
			</label>

			<RichTextEditor
				ref={editorRef}
				aria-label="Message"
				onChange={setBodyHtml}
				placeholder="Write your message…"
				disabled={busy}
			/>
		</Dialog>
	);
}

/**
 * One recipients row: committed addresses as removable chips, then a field.
 * Enter, comma, semicolon, space or leaving the field turn the typed text into
 * chips; Backspace in an empty field takes the last chip back for editing.
 */
function AddressRow({
	label,
	chips,
	onChips,
	draft,
	onDraft,
	disabled,
	trailing,
	inputRef,
	autoFocus,
}: {
	label: string;
	chips: string[];
	onChips: (chips: string[]) => void;
	draft: string;
	onDraft: (value: string) => void;
	disabled?: boolean;
	trailing?: ReactNode;
	inputRef?: RefObject<HTMLInputElement | null>;
	autoFocus?: boolean;
}) {
	const ownRef = useRef<HTMLInputElement>(null);
	const ref = inputRef ?? ownRef;

	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus, ref]);

	function commit(value: string) {
		const next = splitAddresses(value);
		if (next.length > 0) onChips([...chips, ...next.filter((a) => !chips.includes(a))]);
		onDraft("");
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if ((event.key === "Enter" || event.key === "," || event.key === ";") && draft.trim()) {
			event.preventDefault();
			commit(draft);
		} else if (event.key === "Backspace" && !draft && chips.length > 0) {
			event.preventDefault();
			onDraft(chips[chips.length - 1]!);
			onChips(chips.slice(0, -1));
		}
	}

	return (
		<div className="flex min-h-12 shrink-0 items-center gap-3 border-t border-border-card py-2 pr-5 pl-7 max-sm:pl-5">
			<label
				htmlFor={`compose-${label}`}
				className="w-14 shrink-0 text-label text-text-muted max-sm:w-12"
			>
				{label}
			</label>
			<div
				className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
				onPointerDown={(e) => {
					if (e.target === e.currentTarget) {
						e.preventDefault();
						ref.current?.focus();
					}
				}}
			>
				{chips.map((address) => (
					<span
						key={address}
						className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-card bg-pill pr-1.5 pl-[11px] text-label text-text"
					>
						<span className="truncate">{address}</span>
						<button
							type="button"
							aria-label={`Remove ${address}`}
							disabled={disabled}
							onClick={() => onChips(chips.filter((a) => a !== address))}
							className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-hover hover:text-text"
						>
							<X className="size-2.5" strokeWidth={2.6} />
						</button>
					</span>
				))}
				<input
					ref={ref}
					id={`compose-${label}`}
					type="text"
					inputMode="email"
					value={draft}
					onChange={(e) => {
						const value = e.target.value;
						// A pasted list or a typed separator commits what is before it.
						if (/[,;\s]/.test(value) && splitAddresses(value).length > 0 && /[,;\s]$/.test(value)) {
							commit(value);
						} else {
							onDraft(value);
						}
					}}
					onKeyDown={onKeyDown}
					onBlur={() => {
						if (draft.trim()) commit(draft);
					}}
					placeholder={chips.length === 0 ? "name@example.com" : undefined}
					autoComplete="off"
					disabled={disabled}
					className="h-7 min-w-[8rem] flex-1 bg-transparent pl-0.5 text-body text-ink outline-none placeholder:text-text-faint"
				/>
			</div>
			{trailing}
		</div>
	);
}
