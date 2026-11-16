import {
	ChevronDown,
	Download,
	File,
	FileImage,
	FileSpreadsheet,
	FileText,
	Forward,
	ImageOff,
	Mail,
	MoreHorizontal,
	Reply,
	ReplyAll,
} from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { UnreadDot } from "#/components/mail/ThreadListItem";
import { Avatar } from "#/components/ui/Avatar";
import { Menu } from "#/components/ui/Menu";
import { Pill } from "#/components/ui/Pill";
import { isPreviewableImage } from "#/lib/attachment-preview";
import { cn } from "#/lib/cn";
import { formatDayTime, formatFullDate } from "#/lib/dates";
import {
	type Attachment,
	attachmentUrl,
	displayName,
	extractEmail,
	formatBytes,
	type Message,
	messageHtmlUrl,
	parseAddressList,
	parseAddressNames,
	rawMessageUrl,
	recipientLabel,
} from "#/lib/mail";
import { splitQuotedText } from "#/lib/quoted-text";
import { linkifySegments } from "#/lib/rich-text";

/**
 * Renders an email's stored HTML body inside a sandboxed, auto-resizing iframe.
 *
 * Security: the HTML is attacker-controlled. The `sandbox` attribute omits
 * `allow-scripts` and `allow-forms`, so nothing in the email executes or submits;
 * `allow-same-origin` is safe *because* scripts can't run, and it lets us measure
 * the content height from the parent. The endpoint adds a strict CSP (no
 * script-src, form-action 'none') and is framable by this app only
 * (frame-ancestors 'self' + X-Frame-Options SAMEORIGIN; see mailbox-routes.ts).
 * Links carry target=_blank + rel=noopener noreferrer, and `allow-popups*` lets
 * them open in a new tab.
 *
 * If the frame cannot be read after loading (blocked, or an error page), the
 * message falls back to its text part rather than showing an empty box.
 */
/** Where a reply's quoted history starts in a rendered email, if anywhere. */
const QUOTE_SELECTORS = [
	".gmail_quote",
	"blockquote[type='cite']",
	".moz-cite-prefix",
	"#divRplyFwdMsg",
	"#appendonsend",
	".yahoo_quoted",
];

/**
 * The quoted history of a reply: the first known quote container, else a
 * trailing blockquote (with its "On …, X wrote:" line). Only when something
 * else is left to read above it.
 */
function findQuote(doc: Document): HTMLElement[] {
	const body = doc.body;
	if (!body) return [];
	let start: Element | null = null;
	for (const selector of QUOTE_SELECTORS) {
		const found = body.querySelector(selector);
		if (
			found &&
			(!start || found.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)
		)
			start = found;
	}
	if (!start) {
		const last = [...body.children].reverse().find((el) => el.textContent?.trim());
		if (last?.tagName === "BLOCKQUOTE") {
			const before = last.previousElementSibling;
			start = before && /wrote:\s*$/i.test(before.textContent ?? "") ? before : last;
		}
	}
	if (!start) return [];
	// The quote and everything after it at the same level.
	const parts: HTMLElement[] = [];
	for (let el: Element | null = start; el; el = el.nextElementSibling)
		parts.push(el as HTMLElement);
	const quoted = parts.reduce((n, el) => n + (el.textContent?.trim().length ?? 0), 0);
	const total = body.textContent?.trim().length ?? 0;
	return total - quoted > 0 ? parts : [];
}

/** Remote content the CSP held back: images, CSS backgrounds. */
function hasRemoteContent(doc: Document): boolean {
	for (const img of doc.querySelectorAll("img")) {
		const src = img.getAttribute("src") ?? img.getAttribute("srcset") ?? "";
		if (/^\s*(https?:)?\/\//i.test(src)) return true;
	}
	return /url\(\s*['"]?\s*(https?:)?\/\//i.test(doc.documentElement?.innerHTML ?? "");
}

function EmailHtmlBody({
	src,
	fallback,
	onRemoteContent,
}: {
	src: string;
	fallback: ReactElement | null;
	/** Told after loading whether the message has remote content (blocked or shown). */
	onRemoteContent?: (has: boolean) => void;
}): ReactElement {
	const ref = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(120);
	const [failed, setFailed] = useState(false);
	const [quote, setQuote] = useState<HTMLElement[]>([]);
	const [showQuote, setShowQuote] = useState(false);
	const remoteRef = useRef(onRemoteContent);
	remoteRef.current = onRemoteContent;

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
			try {
				// A blocked or failed frame is an opaque error document: unreadable, or
				// not the HTML we served. Show the text part instead.
				const doc = iframe.contentDocument;
				if (!doc || doc.URL === "about:blank" || !doc.contentType?.includes("html")) {
					setFailed(true);
					return;
				}
			} catch {
				setFailed(true);
				return;
			}
			try {
				const doc = iframe.contentDocument;
				if (doc) {
					remoteRef.current?.(hasRemoteContent(doc));
					// Gmail's "···": a reply's quoted history starts folded.
					const parts = findQuote(doc);
					for (const el of parts) el.style.display = "none";
					setQuote(parts);
					setShowQuote(false);
				}
			} catch {
				// best effort
			}
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

	if (failed && fallback) return fallback;
	return (
		<>
			<iframe
				ref={ref}
				src={src}
				title="Email content"
				sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
				referrerPolicy="no-referrer"
				className="block w-full rounded-control bg-white"
				style={{ height, border: 0 }}
			/>
			{quote.length > 0 ? (
				<QuoteToggle
					open={showQuote}
					onToggle={() => {
						const next = !showQuote;
						for (const el of quote) el.style.display = next ? "" : "none";
						setShowQuote(next);
						const doc = ref.current?.contentDocument;
						if (doc) {
							setHeight(
								Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0) ||
									height,
							);
						}
					}}
				/>
			) : null}
		</>
	);
}

/** The "···" under a reply that shows or hides the quoted history. */
function QuoteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<button
			type="button"
			aria-expanded={open}
			aria-label={open ? "Hide quoted text" : "Show quoted text"}
			title={open ? "Hide quoted text" : "Show quoted text"}
			onClick={onToggle}
			className="mt-2 inline-flex h-4 items-center rounded-[4px] bg-pill px-1.5 text-[11px] leading-none font-semibold tracking-widest text-text-muted hover:bg-hover hover:text-text"
		>
			···
		</button>
	);
}

/**
 * A plain-text body as Gmail shows one: line breaks kept, long lines wrapped,
 * URLs and addresses linked (built as React nodes, never as HTML), and a
 * trailing quoted reply folded behind "…".
 */
function PlainTextBody({ text }: { text: string }): ReactElement {
	const [showQuote, setShowQuote] = useState(false);
	const { body, quoted } = splitQuotedText(text);
	return (
		<div className="text-body leading-[22px] tracking-[-0.005em] text-text-secondary">
			<p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
				<Linkified text={body} />
			</p>
			{quoted ? (
				<>
					<QuoteToggle open={showQuote} onToggle={() => setShowQuote((v) => !v)} />
					{showQuote ? (
						<p className="m-0 mt-2 whitespace-pre-wrap text-text-muted [overflow-wrap:anywhere]">
							<Linkified text={quoted} />
						</p>
					) : null}
				</>
			) : null}
		</div>
	);
}

function Linkified({ text }: { text: string }) {
	const segments = linkifySegments(text);
	let offset = 0;
	return (
		<>
			{segments.map((segment) => {
				const key = offset;
				offset += segment.text.length;
				return segment.href ? (
					<a
						key={key}
						href={segment.href}
						target="_blank"
						rel="noopener noreferrer"
						className="text-text underline decoration-1 hover:text-ink"
					>
						{segment.text}
					</a>
				) : (
					<span key={key}>{segment.text}</span>
				);
			})}
		</>
	);
}

/** Short type label for an attachment card: "PDF", "CSV", "PNG"… */
function fileKind(att: Attachment): string {
	const ext = att.filename?.match(/\.([a-z0-9]{1,6})$/i)?.[1];
	if (ext) return ext.toUpperCase();
	const sub = att.content_type?.split("/")[1]?.split(/[;+]/)[0];
	return sub ? sub.toUpperCase() : "File";
}

function FileIcon({ att }: { att: Attachment }) {
	const type = att.content_type ?? "";
	const kind = fileKind(att);
	if (type.startsWith("image/")) return <FileImage />;
	if (kind === "CSV" || kind === "XLSX" || kind === "XLS" || type.includes("spreadsheet")) {
		return <FileSpreadsheet />;
	}
	if (type.startsWith("text/") || kind === "PDF" || kind === "DOC" || kind === "DOCX") {
		return <FileText />;
	}
	return <File />;
}

const TRUSTED_KEY = "reccado.showImagesFrom";

/** Senders whose images you chose to always show (this browser only). */
function trustedSenders(): string[] {
	try {
		const parsed = JSON.parse(window.localStorage.getItem(TRUSTED_KEY) ?? "[]") as unknown;
		return Array.isArray(parsed) ? parsed.map(String) : [];
	} catch {
		return [];
	}
}

function trustSender(address: string): void {
	try {
		const list = trustedSenders();
		if (!list.includes(address)) {
			window.localStorage.setItem(TRUSTED_KEY, JSON.stringify([...list, address].slice(-500)));
		}
	} catch {
		// Storage unavailable: this message still shows its images.
	}
}

/**
 * One message inside an open thread (Paper "Inbox — Reading, no approval"):
 * avatar, sender and time, the address line with "View original", the body,
 * then the attachments as download cards. Earlier messages render collapsed
 * (one line: who, a preview, when); click to expand. Reply / Forward live in
 * the reading pane's bottom bar, not on each message.
 *
 * Read state speaks the list's language: a new message (unread, or unread when
 * the conversation was opened) is white with the navy dot and a semibold sender;
 * a collapsed read one sits on the quiet read grey in regular weight.
 */
export function MessageItem({
	message,
	mailboxId,
	defaultOpen,
	isNew,
	ownName,
	onReply,
	onForward,
	onMarkUnread,
}: {
	message: Message & { attachments?: Attachment[] };
	mailboxId: string;
	defaultOpen: boolean;
	/** Unread, or was when the conversation opened. Defaults to `is_read === 0`. */
	isNew?: boolean;
	/** The mailbox's display name: how your own messages are labelled ("me" without one). */
	ownName?: string | null;
	/** Reply / reply all to this message (omit to hide, e.g. while an approval is open). */
	onReply?: (mode: "reply" | "reply_all") => void;
	onForward?: () => void;
	/** Mark just this message unread. */
	onMarkUnread?: () => void;
}): ReactElement {
	const [open, setOpen] = useState(defaultOpen);
	const [details, setDetails] = useState(false);
	const [remote, setRemote] = useState(false);
	const isOutbound = message.direction === "outbound";
	const isUnread = isNew ?? message.is_read === 0;
	const senderAddress = extractEmail(message.from_addr);
	// Your own messages say who you are, not the mailbox's local part.
	const senderName = isOutbound
		? ownName?.trim() || "me"
		: displayName(message.from_addr, message.from_name);
	const [showImages, setShowImages] = useState(
		() =>
			isOutbound ||
			(typeof window !== "undefined" && trustedSenders().includes(senderAddress.toLowerCase())),
	);

	if (!open) {
		const preview =
			message.snippet ??
			(message.body_text ? message.body_text.replace(/\s+/g, " ").trim().slice(0, 140) : "");
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				aria-expanded="false"
				className={cn(
					"flex h-12 w-full shrink-0 items-center gap-3 border-b border-[#F1F1F1] pr-4 pl-2 text-left sm:pr-7 sm:pl-3",
					isUnread ? "bg-panel hover:bg-[#FAFBFC]" : "bg-row-read hover:bg-row-read-hover",
				)}
			>
				{isUnread ? <span className="sr-only">Unread.</span> : null}
				<UnreadDot unread={isUnread} className="-mr-1" />
				<Avatar
					from={message.from_addr}
					name={message.from_name}
					size="sm"
					className="h-6 w-6 text-[10px]"
				/>
				<span className="flex w-30 shrink-0 items-center gap-1.75 max-sm:w-auto max-sm:max-w-[40%]">
					<span
						className={cn(
							"truncate text-body",
							isUnread ? "font-semibold text-ink" : "font-normal text-text-secondary",
						)}
						title={senderAddress}
					>
						{senderName}
					</span>
					{isOutbound ? (
						<Pill tone="neutral" className="h-[18px] px-1.75">
							Sent
						</Pill>
					) : null}
				</span>
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-label",
						isUnread ? "text-text-secondary" : "text-text-muted",
					)}
				>
					{preview}
				</span>
				<time
					dateTime={message.received_at}
					title={formatFullDate(message.received_at)}
					className={cn(
						"shrink-0 text-right text-label sm:w-24",
						isUnread ? "font-semibold text-ink" : "text-text-muted",
					)}
				>
					{formatDayTime(message.received_at)}
				</time>
			</button>
		);
	}

	const recipientNames = parseAddressNames(message.recipient_names_json);
	const toList = parseAddressList(message.to_json).map((a) => recipientLabel(a, recipientNames));
	const ccList = parseAddressList(message.cc_json).map((a) => recipientLabel(a, recipientNames));
	const replyToList = parseAddressList(message.reply_to_json);
	const fromFull =
		senderName && senderName !== senderAddress && senderName !== "me"
			? `${senderName} <${senderAddress}>`
			: senderAddress;
	const menuItems = [
		...(onReply
			? [
					{ key: "reply", label: "Reply", icon: <Reply />, onSelect: () => onReply("reply") },
					{
						key: "reply-all",
						label: "Reply all",
						icon: <ReplyAll />,
						onSelect: () => onReply("reply_all"),
					},
				]
			: []),
		...(onForward
			? [{ key: "forward", label: "Forward", icon: <Forward />, onSelect: onForward }]
			: []),
		...(onMarkUnread && !isOutbound
			? [{ key: "unread", label: "Mark as unread", icon: <Mail />, onSelect: onMarkUnread }]
			: []),
		{
			key: "raw",
			label: "View original",
			icon: <FileText />,
			href: rawMessageUrl(mailboxId, message.id),
		},
	];
	const attachments = message.attachments ?? [];
	const images = attachments.filter((att) => isPreviewableImage(att.content_type));

	return (
		<article className="flex items-start gap-3 border-b border-[#F1F1F1] px-4 pt-5 pb-[22px] sm:px-7">
			<Avatar
				from={message.from_addr}
				name={message.from_name}
				size="md"
				className="max-sm:hidden"
			/>
			<div className="flex min-w-0 flex-1 flex-col">
				<button
					type="button"
					onClick={() => setOpen(false)}
					aria-expanded="true"
					className="flex w-full items-center gap-1.5 text-left"
				>
					{isUnread ? (
						<>
							<span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-brand" />
							<span className="sr-only">New.</span>
						</>
					) : null}
					<span
						className={cn(
							"truncate text-sender tracking-[-0.01em]",
							isUnread ? "font-semibold text-ink" : "font-medium text-text",
						)}
						title={senderAddress}
					>
						{senderName}
					</span>
					{isOutbound ? <Pill tone="neutral">Sent</Pill> : null}
					<span className="min-w-2 flex-1" />
					<time
						dateTime={message.received_at}
						title={formatFullDate(message.received_at)}
						className="shrink-0 text-label leading-5 text-text-muted"
					>
						{formatDayTime(message.received_at)}
					</time>
				</button>
				<div className="flex items-start gap-1">
					<p className="m-0 min-w-0 flex-1 text-label text-text-muted [overflow-wrap:anywhere]">
						{/* The real address, always: the name above is the sender's own claim. */}
						{senderAddress}
						{toList.length > 0 ? ` · to ${toList.join(", ")}` : null}
						{ccList.length > 0 ? ` · cc ${ccList.join(", ")}` : null}{" "}
						<button
							type="button"
							aria-expanded={details}
							onClick={() => setDetails((v) => !v)}
							className="inline-flex items-center gap-0.5 rounded-[4px] align-middle text-text-muted hover:text-text"
							title={details ? "Hide details" : "Show details"}
						>
							<span className="sr-only">{details ? "Hide details" : "Show details"}</span>
							<ChevronDown
								aria-hidden="true"
								className={cn("size-3.5 transition-transform", details && "rotate-180")}
							/>
						</button>
					</p>
					<Menu
						label="Message actions"
						align="end"
						triggerClassName="-mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-control text-icon hover:bg-hover hover:text-text [&_svg]:size-4"
						trigger={<MoreHorizontal />}
						items={menuItems}
					/>
				</div>
				{details ? (
					<dl className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-control bg-content px-3 py-2.5 text-label">
						<DetailRow label="From" value={fromFull} />
						{replyToList.length > 0 ? (
							<DetailRow label="Reply-To" value={replyToList.join(", ")} />
						) : null}
						{toList.length > 0 ? <DetailRow label="To" value={toList.join(", ")} /> : null}
						{ccList.length > 0 ? <DetailRow label="Cc" value={ccList.join(", ")} /> : null}
						<DetailRow label="Date" value={formatFullDate(message.received_at)} />
						<DetailRow label="Subject" value={message.subject ?? "(no subject)"} />
					</dl>
				) : null}

				{message.body_html_r2_key && remote && !showImages ? (
					<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-content px-3 py-2 text-label text-text-muted">
						<ImageOff aria-hidden="true" className="size-4 shrink-0 text-icon" />
						<span className="min-w-0 flex-1">
							Images are hidden so the sender can't tell you opened this.
						</span>
						<span className="flex gap-3">
							<button
								type="button"
								className="font-medium text-text underline decoration-1 hover:text-ink"
								onClick={() => setShowImages(true)}
							>
								Show images
							</button>
							<button
								type="button"
								className="font-medium text-text underline decoration-1 hover:text-ink"
								onClick={() => {
									trustSender(senderAddress.toLowerCase());
									setShowImages(true);
								}}
							>
								Always from {senderAddress}
							</button>
						</span>
					</div>
				) : null}

				<div className="pt-3.5">
					{message.body_html_r2_key ? (
						<EmailHtmlBody
							key={showImages ? "images" : "text"}
							src={`${messageHtmlUrl(mailboxId, message.id)}${showImages ? "?images=1" : ""}`}
							fallback={message.body_text ? <PlainTextBody text={message.body_text} /> : null}
							onRemoteContent={setRemote}
						/>
					) : message.body_text ? (
						<PlainTextBody text={message.body_text} />
					) : (
						<p className="m-0 text-body text-text-muted italic">(no text content)</p>
					)}
				</div>

				{images.length ? (
					<div className="flex flex-wrap gap-2 pt-4">
						{images.map((att) => {
							const src = `${attachmentUrl(mailboxId, message.id, att.id)}?inline=1`;
							return (
								<a key={att.id} href={src} target="_blank" rel="noreferrer">
									<img
										src={src}
										alt={att.filename ?? "image attachment"}
										loading="lazy"
										className="max-h-60 max-w-full rounded-control border border-border object-contain"
									/>
								</a>
							);
						})}
					</div>
				) : null}

				{attachments.length ? (
					<div className="flex flex-col gap-2 pt-[18px]">
						<span className="text-meta text-text-muted">
							{attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`}
						</span>
						<ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Attachments">
							{attachments.map((att) => (
								<li key={att.id} className="max-w-full">
									<a
										href={attachmentUrl(mailboxId, message.id, att.id)}
										download={att.filename ?? undefined}
										className="flex h-12 w-59 max-w-full items-center gap-2.5 rounded-[10px] border border-border-card pr-3 pl-2.5 no-underline hover:bg-row-selected"
									>
										<span className="flex size-7.5 shrink-0 items-center justify-center rounded-[7px] bg-pill text-text-secondary [&_svg]:size-[15px]">
											<FileIcon att={att} />
										</span>
										<span className="flex min-w-0 flex-1 flex-col">
											<span className="truncate text-label font-medium text-text">
												{att.filename ?? "attachment"}
											</span>
											<span className="text-meta text-text-muted">
												{fileKind(att)} · {formatBytes(att.size)}
											</span>
										</span>
										<Download aria-hidden="true" className="size-[15px] shrink-0 text-icon" />
									</a>
								</li>
							))}
						</ul>
					</div>
				) : null}
			</div>
		</article>
	);
}

function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<>
			<dt className="text-text-muted">{label}</dt>
			<dd className="m-0 min-w-0 text-text [overflow-wrap:anywhere]">{value}</dd>
		</>
	);
}
