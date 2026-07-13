import { Forward, Paperclip, Reply } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { Avatar } from "#/components/ui/Avatar";
import { Button } from "#/components/ui/Button";
import { cn } from "#/lib/cn";
import {
	type Attachment,
	attachmentUrl,
	displayName,
	extractEmail,
	formatBytes,
	formatFullDate,
	type Message,
	messageHtmlUrl,
	parseAddressList,
	rawMessageUrl,
} from "#/lib/mail";

/**
 * Renders an email's stored HTML body inside a sandboxed, auto-resizing iframe.
 *
 * Security: the HTML is attacker-controlled. The `sandbox` attribute omits
 * `allow-scripts`, so nothing in the email executes; `allow-same-origin` is safe
 * *because* scripts can't run, and it lets us measure the content height from the
 * parent. The endpoint also ships a strict CSP (see mailbox-routes.ts) as a second
 * layer. `allow-popups*` lets injected `<base target="_blank">` links open a tab.
 */
function EmailHtmlBody({ src }: { src: string }): ReactElement {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(120);

	useEffect(() => {
		const iframe = ref.current;
		if (!iframe) return;
		let observer: ResizeObserver | undefined;

		const measure = () => {
			try {
				const doc = iframe.contentDocument;
				if (!doc) return;
				const next = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
				if (next > 0) setHeight(next);
			} catch {
				// Cross-origin (shouldn't happen for our same-origin endpoint) — keep default.
			}
		};

		const onLoad = () => {
			measure();
			try {
				const body = iframe.contentDocument?.body;
				if (body && typeof ResizeObserver !== "undefined") {
					observer = new ResizeObserver(measure);
					observer.observe(body);
				}
			} catch {
				// ignore — measurement is best-effort
			}
		};

		iframe.addEventListener("load", onLoad);
		return () => {
			iframe.removeEventListener("load", onLoad);
			observer?.disconnect();
		};
	}, []);

	return (
		<iframe
			ref={ref}
			src={src}
			title="Email content"
			sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
			referrerPolicy="no-referrer"
			loading="lazy"
			className="block w-full rounded-lg bg-white"
			style={{ height, border: 0 }}
		/>
	);
}

/**
 * One message inside an open thread — a collapsed one-line summary row, or an
 * expanded card with full headers, body, attachments, and reply actions.
 * Gmail-style: every message in a thread renders this way, all but the last
 * collapsed by default.
 */
export function MessageItem({
	message,
	mailboxId,
	defaultOpen,
	onReply,
	onForward,
}: {
	message: Message & { attachments?: Attachment[] };
	mailboxId: string;
	defaultOpen: boolean;
	onReply: () => void;
	onForward: () => void;
}): ReactElement {
	const [open, setOpen] = useState(defaultOpen);
	const isOutbound = message.direction === "outbound";
	const cardBorder = isOutbound ? "border-[var(--app-accent)]/30" : "border-[var(--app-border)]";

	if (!open) {
		const preview =
			message.snippet ??
			(message.body_text ? message.body_text.replace(/\s+/g, " ").trim().slice(0, 140) : "");
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className={cn(
					"mb-3 flex w-full items-center gap-3 rounded-2xl border bg-[var(--app-surface)] px-4 py-3 text-left transition-colors hover:bg-[var(--app-hover)]",
					cardBorder,
				)}
			>
				<Avatar from={message.from_addr} size="sm" />
				<span className="min-w-0 flex-1 truncate text-sm">
					<span className="font-medium text-[var(--app-text)]">
						{displayName(message.from_addr)}
					</span>
					{isOutbound ? (
						<span className="ml-2 rounded-full bg-[var(--app-surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-text-soft)]">
							Sent
						</span>
					) : null}
					<span className="ml-2 text-[var(--app-text-faint)]">{preview}</span>
				</span>
				<span className="shrink-0 text-xs text-[var(--app-text-faint)]">
					{formatFullDate(message.received_at)}
				</span>
			</button>
		);
	}

	const toList = parseAddressList(message.to_json);

	return (
		<div className={cn("mb-3 rounded-2xl border bg-[var(--app-surface)]", cardBorder)}>
			<button
				type="button"
				onClick={() => setOpen(false)}
				className="flex w-full items-start gap-3 px-4 pt-4 text-left"
			>
				<Avatar from={message.from_addr} size="md" />
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="font-medium text-[var(--app-text)]">
							{displayName(message.from_addr)}
						</span>
						<span className="truncate text-sm text-[var(--app-text-faint)]">
							&lt;{extractEmail(message.from_addr)}&gt;
						</span>
						{isOutbound ? (
							<span className="rounded-full bg-[var(--app-surface-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--app-text-soft)]">
								Sent
							</span>
						) : null}
					</div>
					{toList.length > 0 ? (
						<p className="truncate text-xs text-[var(--app-text-faint)]">to {toList.join(", ")}</p>
					) : null}
				</div>
				<span className="shrink-0 text-xs text-[var(--app-text-faint)]">
					{formatFullDate(message.received_at)}
				</span>
			</button>

			<div className="px-4 py-4">
				{message.body_html_r2_key ? (
					<EmailHtmlBody src={messageHtmlUrl(mailboxId, message.id)} />
				) : message.body_text ? (
					<p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-[var(--app-text)]">
						{message.body_text}
					</p>
				) : (
					<p className="text-[var(--app-text-faint)] italic">(no text content)</p>
				)}
			</div>

			{message.attachments?.length ? (
				<div className="flex flex-wrap gap-2 px-4 pb-4">
					{message.attachments.map((att) => (
						<a
							key={att.id}
							href={attachmentUrl(mailboxId, message.id, att.id)}
							className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] px-3 py-1.5 text-xs text-[var(--app-text-soft)] transition-colors hover:bg-[var(--app-hover)]"
						>
							<Paperclip className="h-3.5 w-3.5 shrink-0" />
							<span className="max-w-40 truncate">{att.filename ?? "attachment"}</span>
							<span className="text-[var(--app-text-faint)]">{formatBytes(att.size)}</span>
						</a>
					))}
				</div>
			) : null}

			<div className="flex items-center gap-2 border-t border-[var(--app-border)] px-4 py-3">
				<Button size="sm" variant="secondary" onClick={onReply}>
					<Reply className="h-4 w-4" />
					Reply
				</Button>
				<Button size="sm" variant="secondary" onClick={onForward}>
					<Forward className="h-4 w-4" />
					Forward
				</Button>
				<a
					href={rawMessageUrl(mailboxId, message.id)}
					target="_blank"
					rel="noreferrer"
					className="ml-auto text-xs text-[var(--app-text-faint)] hover:text-[var(--app-text-soft)] hover:underline"
				>
					View raw
				</a>
			</div>
		</div>
	);
}
