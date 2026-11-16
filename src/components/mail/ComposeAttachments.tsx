import { AlertCircle, Paperclip, X } from "lucide-react";
import { type ReactElement, useCallback, useRef, useState } from "react";
import {
	formatBytes,
	MAX_ATTACHMENT_BYTES,
	MAX_ATTACHMENT_COUNT,
	MAX_TOTAL_ATTACHMENT_BYTES,
} from "#/lib/attachment-limits";
import { cn } from "#/lib/cn";
import {
	type Attachment,
	AttachmentUploadError,
	attachMessageFiles,
	attachmentErrorText,
	type DraftAttachment,
	deleteDraftAttachment,
	draftAttachmentUrl,
	uploadDraftAttachment,
} from "#/lib/mail";

/**
 * One file in the compose dialog. `queued` waits for the draft to exist (a new
 * message has none until it has a recipient); `uploading` is on its way; `done`
 * is on the draft (`id` is the server's); `error` stays visible until removed.
 * A forward offer is a queued item with a source message instead of a File.
 */
export type ComposeFile = {
	key: string;
	status: "queued" | "uploading" | "done" | "error";
	filename: string;
	size: number;
	progress: number;
	error?: string;
	id?: string;
	file?: File;
	source?: { messageId: string; attachmentId: string; inline: boolean };
	removing?: boolean;
};

function fromDraft(a: DraftAttachment): ComposeFile {
	return { key: a.id, status: "done", filename: a.filename, size: a.size, progress: 1, id: a.id };
}

/** Bytes that count against the limits: everything not refused. */
function counted(items: readonly ComposeFile[]) {
	const live = items.filter((i) => i.status !== "error");
	return { count: live.length, total: live.reduce((sum, i) => sum + i.size, 0) };
}

/**
 * The compose dialog's files: limits checked before a byte moves, uploads with
 * progress, forward offers attached by reference, removal. The list lives in a
 * ref as well as state so the async paths (flush, uploads finishing after a
 * re-render) never act on a stale copy.
 */
export function useComposeFiles(mailboxId: string) {
	const [items, setItemsState] = useState<ComposeFile[]>([]);
	const ref = useRef<ComposeFile[]>([]);
	const controllers = useRef(new Map<string, AbortController>());
	const inflight = useRef(new Set<Promise<void>>());

	const setItems = useCallback((fn: (prev: ComposeFile[]) => ComposeFile[]) => {
		ref.current = fn(ref.current);
		setItemsState(ref.current);
	}, []);
	const patch = useCallback(
		(key: string, change: Partial<ComposeFile>) =>
			setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...change } : i))),
		[setItems],
	);

	/** Queues what fits; answers a sentence about what did not (or null). */
	const addFiles = useCallback(
		(files: readonly File[]): string | null => {
			const { count, total } = counted(ref.current);
			let n = count;
			let bytes = total;
			const refused: string[] = [];
			const accepted: ComposeFile[] = [];
			for (const file of files) {
				if (file.size === 0) refused.push(`“${file.name}” is empty.`);
				else if (file.size > MAX_ATTACHMENT_BYTES)
					refused.push(`“${file.name}” is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}.`);
				else if (n + 1 > MAX_ATTACHMENT_COUNT)
					refused.push(`Up to ${MAX_ATTACHMENT_COUNT} files per message.`);
				else if (bytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES)
					refused.push(
						`“${file.name}” would take the message over ${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} of attachments.`,
					);
				else {
					n += 1;
					bytes += file.size;
					accepted.push({
						key: crypto.randomUUID(),
						status: "queued",
						filename: file.name || "attachment",
						size: file.size,
						progress: 0,
						file,
					});
				}
			}
			if (accepted.length) setItems((prev) => [...prev, ...accepted]);
			return refused.length ? [...new Set(refused)].join(" ") : null;
		},
		[setItems],
	);

	/** Forward: the original's files, offered (and attached once there is a draft). */
	const offerForward = useCallback(
		(messageId: string, attachments: readonly Attachment[]) => {
			const offered = attachments
				.filter((a) => !ref.current.some((i) => i.source?.attachmentId === a.id))
				.map<ComposeFile>((a) => ({
					key: `fwd-${a.id}`,
					status: "queued",
					filename: a.filename || "attachment",
					size: a.size,
					progress: 0,
					source: { messageId, attachmentId: a.id, inline: a.disposition === "inline" },
				}));
			if (offered.length) setItems((prev) => [...prev, ...offered]);
		},
		[setItems],
	);

	const load = useCallback(
		(attachments: readonly DraftAttachment[]) => setItems(() => attachments.map(fromDraft)),
		[setItems],
	);

	const track = useCallback((p: Promise<void>) => {
		inflight.current.add(p);
		void p.finally(() => inflight.current.delete(p));
	}, []);

	/**
	 * Starts every queued file on `draftId` and waits for all transfers (including
	 * ones already running). True when nothing is left queued, uploading or failed.
	 */
	const flush = useCallback(
		async (draftId: string): Promise<boolean> => {
			const queued = ref.current.filter((i) => i.status === "queued");
			for (const item of queued) patch(item.key, { status: "uploading", progress: 0 });

			for (const item of queued.filter((i) => i.file)) {
				const controller = new AbortController();
				controllers.current.set(item.key, controller);
				track(
					uploadDraftAttachment(mailboxId, draftId, item.file!, {
						signal: controller.signal,
						onProgress: (fraction) => patch(item.key, { progress: fraction }),
					})
						.then((saved) =>
							patch(item.key, {
								status: "done",
								id: saved.id,
								filename: saved.filename,
								progress: 1,
								file: undefined,
							}),
						)
						.catch((err: unknown) =>
							patch(item.key, {
								status: "error",
								error:
									err instanceof AttachmentUploadError
										? err.message
										: attachmentErrorText(undefined),
							}),
						)
						.finally(() => controllers.current.delete(item.key)),
				);
			}

			const forwards = new Map<string, ComposeFile[]>();
			for (const item of queued.filter((i) => i.source)) {
				const list = forwards.get(item.source!.messageId) ?? [];
				list.push(item);
				forwards.set(item.source!.messageId, list);
			}
			for (const [messageId, group] of forwards) {
				track(
					attachMessageFiles(
						mailboxId,
						draftId,
						messageId,
						group.map((i) => i.source!.attachmentId),
					)
						.then(({ added, skipped }) => {
							for (const item of group) {
								const ok = added.find((a) => a.source_attachment_id === item.source!.attachmentId);
								const no = skipped.find((s) => s.id === item.source!.attachmentId);
								if (ok) patch(item.key, { status: "done", id: ok.id, progress: 1 });
								else if (no)
									patch(item.key, { status: "error", error: attachmentErrorText(no.reason) });
								// Neither: it was already on the draft (a second flush); drop the duplicate.
								else setItems((prev) => prev.filter((i) => i.key !== item.key));
							}
						})
						.catch(() => {
							for (const item of group)
								patch(item.key, { status: "error", error: "Could not attach" });
						}),
				);
			}

			while (inflight.current.size > 0) await Promise.allSettled([...inflight.current]);
			return ref.current.every((i) => i.status === "done");
		},
		[mailboxId, patch, setItems, track],
	);

	/** Removes a file: aborts its upload, or deletes it from the draft. */
	const remove = useCallback(
		async (key: string, draftId: string | null): Promise<boolean> => {
			const item = ref.current.find((i) => i.key === key);
			if (!item) return true;
			controllers.current.get(key)?.abort();
			if (item.status === "done" && item.id && draftId) {
				patch(key, { removing: true });
				try {
					await deleteDraftAttachment(mailboxId, draftId, item.id);
				} catch {
					patch(key, { removing: false });
					return false;
				}
			}
			setItems((prev) => prev.filter((i) => i.key !== key));
			return true;
		},
		[mailboxId, patch, setItems],
	);

	const abortAll = useCallback(() => {
		for (const controller of controllers.current.values()) controller.abort();
	}, []);

	return {
		items,
		addFiles,
		offerForward,
		load,
		flush,
		remove,
		abortAll,
		hasQueued: items.some((i) => i.status === "queued"),
		uploading: items.some((i) => i.status === "uploading"),
		failed: items.some((i) => i.status === "error"),
	};
}

/** The strip of file chips under the message, with the running total. */
export function ComposeAttachmentList({
	items,
	mailboxId,
	draftId,
	disabled,
	onRemove,
}: {
	items: readonly ComposeFile[];
	mailboxId: string;
	draftId: string | null;
	disabled?: boolean;
	onRemove: (key: string) => void;
}): ReactElement | null {
	if (items.length === 0) return null;
	const { count, total } = counted(items);
	const inline = items.some((i) => i.source?.inline);
	return (
		<div className="flex max-h-40 shrink-0 flex-col gap-1.5 overflow-y-auto border-t border-border-card px-7 py-2.5 max-sm:px-5">
			<ul aria-label="Attachments" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
				{items.map((item) => (
					<FileChip
						key={item.key}
						item={item}
						href={
							item.status === "done" && item.id && draftId
								? draftAttachmentUrl(mailboxId, draftId, item.id)
								: undefined
						}
						disabled={disabled || item.removing}
						onRemove={() => onRemove(item.key)}
					/>
				))}
			</ul>
			<p className="m-0 text-label text-text-muted">
				{count === 1 ? "1 file" : `${count} files`} · {formatBytes(total)} of{" "}
				{formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}
				{inline ? " · Images shown inside the original are attached as files." : null}
			</p>
		</div>
	);
}

function FileChip({
	item,
	href,
	disabled,
	onRemove,
}: {
	item: ComposeFile;
	href?: string;
	disabled?: boolean;
	onRemove: () => void;
}) {
	const failed = item.status === "error";
	const detail = failed
		? item.error
		: item.status === "uploading"
			? `${Math.round(item.progress * 100)}%`
			: formatBytes(item.size);
	const name = (
		<span className="min-w-0 truncate text-text" title={item.filename}>
			{item.filename}
		</span>
	);
	return (
		<li
			className={cn(
				"relative inline-flex h-8 max-w-full items-center gap-2 overflow-hidden rounded-card border bg-panel pr-1 pl-2.5 text-label",
				failed ? "border-danger/40" : "border-border-card",
				item.removing && "opacity-50",
			)}
		>
			{failed ? (
				<AlertCircle aria-hidden="true" className="size-3.5 shrink-0 text-danger" />
			) : (
				<Paperclip aria-hidden="true" className="size-3.5 shrink-0 text-icon" />
			)}
			{href ? (
				<a href={href} download className="flex min-w-0 max-w-56 rounded-[4px] hover:underline">
					{name}
				</a>
			) : (
				<span className="flex min-w-0 max-w-56">{name}</span>
			)}
			<span
				className={cn("shrink-0 tabular-nums", failed ? "text-danger" : "text-text-muted")}
				aria-live={item.status === "uploading" ? "off" : "polite"}
			>
				{detail}
			</span>
			<button
				type="button"
				aria-label={`Remove ${item.filename}`}
				title="Remove"
				disabled={disabled}
				onClick={onRemove}
				className="inline-flex size-6 shrink-0 items-center justify-center rounded-full text-text-muted hover:bg-hover hover:text-text disabled:opacity-40"
			>
				<X className="size-3" strokeWidth={2.4} />
			</button>
			{item.status === "uploading" ? (
				<span
					aria-hidden="true"
					className="absolute bottom-0 left-0 h-0.5 bg-brand transition-[width]"
					style={{ width: `${Math.max(4, Math.round(item.progress * 100))}%` }}
				/>
			) : null}
		</li>
	);
}
