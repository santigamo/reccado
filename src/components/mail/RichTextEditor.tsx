import {
	Bold,
	Italic,
	Link2,
	List,
	ListOrdered,
	RemoveFormatting,
	TextQuote,
	Underline,
} from "lucide-react";
import {
	type ClipboardEvent,
	forwardRef,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/cn";
import { safeHref } from "#/lib/rich-text";
import { sanitizeComposeHtml } from "./compose-html";

export type RichTextEditorHandle = {
	/** Replace the content; returns the HTML as the editor normalised it. */
	setHtml: (html: string) => string;
	getHtml: () => string;
	/** Focus with the caret at the very start (above a quote). */
	focusStart: () => void;
};

type Format = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

/**
 * Dependency-free rich text for compose: a `contenteditable` driven by the
 * browser's own editing commands, which is all an email body needs (bold,
 * italic, underline, links, lists, quotes, clear formatting). Everything that
 * enters — typed structure, pasted HTML — is reduced to the compose allowlist,
 * and the server sanitises again before the draft is stored.
 *
 * Shortcuts: ⌘B / ⌘I / ⌘U, ⌘K link, ⌘⇧7 numbered list, ⌘⇧8 bullets,
 * ⌘⇧9 quote, ⌘\ clear formatting (Gmail's set).
 */
export const RichTextEditor = forwardRef<
	RichTextEditorHandle,
	{
		onChange: (html: string) => void;
		disabled?: boolean;
		placeholder?: string;
		className?: string;
		"aria-label"?: string;
	}
>(function RichTextEditor(
	{ onChange, disabled, placeholder, className, "aria-label": ariaLabel },
	ref,
) {
	const editorRef = useRef<HTMLDivElement>(null);
	const savedRange = useRef<Range | null>(null);
	const [active, setActive] = useState<Record<string, boolean>>({});
	const [linkOpen, setLinkOpen] = useState(false);
	const [linkValue, setLinkValue] = useState("");
	const [empty, setEmpty] = useState(true);

	const emit = useCallback(() => {
		const el = editorRef.current;
		if (!el) return;
		setEmpty(!el.textContent?.trim() && !el.querySelector("li, blockquote, hr"));
		onChange(el.innerHTML);
	}, [onChange]);

	useImperativeHandle(
		ref,
		() => ({
			setHtml(html: string) {
				const el = editorRef.current;
				if (!el) return html;
				el.innerHTML = sanitizeComposeHtml(html);
				setEmpty(!el.textContent?.trim() && !el.querySelector("li, blockquote, hr"));
				return el.innerHTML;
			},
			getHtml() {
				return editorRef.current?.innerHTML ?? "";
			},
			focusStart() {
				const el = editorRef.current;
				if (!el) return;
				el.focus();
				const range = document.createRange();
				range.setStart(el, 0);
				range.collapse(true);
				const selection = window.getSelection();
				selection?.removeAllRanges();
				selection?.addRange(range);
				el.scrollTop = 0;
			},
		}),
		[],
	);

	// New lines are <div>s (what every mail client renders the same way).
	useEffect(() => {
		try {
			document.execCommand("defaultParagraphSeparator", false, "div");
		} catch {
			// Older engines: they pick their own separator, which is fine too.
		}
	}, []);

	const refreshActive = useCallback(() => {
		const el = editorRef.current;
		const selection = window.getSelection();
		if (!el || !selection?.anchorNode || !el.contains(selection.anchorNode)) return;
		const next: Record<string, boolean> = {};
		for (const cmd of [
			"bold",
			"italic",
			"underline",
			"insertUnorderedList",
			"insertOrderedList",
		] as Format[]) {
			try {
				next[cmd] = document.queryCommandState(cmd);
			} catch {
				next[cmd] = false;
			}
		}
		next.blockquote = Boolean(closest(selection.anchorNode, "blockquote", el));
		next.link = Boolean(closest(selection.anchorNode, "a", el));
		setActive(next);
	}, []);

	useEffect(() => {
		document.addEventListener("selectionchange", refreshActive);
		return () => document.removeEventListener("selectionchange", refreshActive);
	}, [refreshActive]);

	function run(command: string, value?: string) {
		editorRef.current?.focus();
		document.execCommand(command, false, value);
		emit();
		refreshActive();
	}

	function toggleQuote() {
		const el = editorRef.current;
		const node = window.getSelection()?.anchorNode;
		if (el && node && closest(node, "blockquote", el)) run("formatBlock", "div");
		else run("formatBlock", "blockquote");
	}

	function clearFormatting() {
		run("removeFormat");
		run("unlink");
	}

	function openLink() {
		const selection = window.getSelection();
		const el = editorRef.current;
		const node = selection?.anchorNode ?? null;
		if (selection && node && el && selection.rangeCount > 0 && el.contains(node)) {
			savedRange.current = selection.getRangeAt(0).cloneRange();
			const anchor = closest(node, "a", el) as HTMLAnchorElement | null;
			setLinkValue(anchor?.getAttribute("href") ?? "");
		} else {
			savedRange.current = null;
			setLinkValue("");
		}
		setLinkOpen(true);
	}

	function applyLink() {
		const raw = linkValue.trim();
		setLinkOpen(false);
		const el = editorRef.current;
		if (!el) return;
		el.focus();
		const selection = window.getSelection();
		if (savedRange.current && selection) {
			selection.removeAllRanges();
			selection.addRange(savedRange.current);
		}
		if (!raw) {
			run("unlink");
			return;
		}
		const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw)
			? raw
			: raw.includes("@") && !raw.includes("/")
				? `mailto:${raw}`
				: `https://${raw}`;
		const href = safeHref(withScheme);
		if (!href) return;
		if (selection?.isCollapsed) {
			// Nothing selected: insert the address itself as the link text.
			run("insertHTML", `<a href="${escapeAttr(href)}">${escapeText(raw)}</a>`);
		} else {
			run("createLink", href);
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const mod = isMac ? event.metaKey : event.ctrlKey;
		if (!mod) return;
		const key = event.key.toLowerCase();
		if (!event.shiftKey && key === "k") {
			event.preventDefault();
			openLink();
		} else if (!event.shiftKey && (key === "\\" || event.code === "Backslash")) {
			event.preventDefault();
			clearFormatting();
		} else if (event.shiftKey && (event.code === "Digit7" || key === "&")) {
			event.preventDefault();
			run("insertOrderedList");
		} else if (event.shiftKey && (event.code === "Digit8" || key === "*")) {
			event.preventDefault();
			run("insertUnorderedList");
		} else if (event.shiftKey && (event.code === "Digit9" || key === "(")) {
			event.preventDefault();
			toggleQuote();
		} else if (!event.shiftKey && (key === "b" || key === "i" || key === "u")) {
			// Native in every engine, but routed through run() so state and onChange follow.
			event.preventDefault();
			run(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
		}
	}

	function onPaste(event: ClipboardEvent<HTMLDivElement>) {
		const data = event.clipboardData;
		const html = data.getData("text/html");
		event.preventDefault();
		if (html) {
			const clean = sanitizeComposeHtml(html);
			if (clean) {
				run("insertHTML", clean);
				return;
			}
		}
		run("insertText", data.getData("text/plain"));
	}

	return (
		<div className={cn("flex min-h-0 flex-1 flex-col", className)}>
			<div
				role="toolbar"
				aria-label="Formatting"
				className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border-card px-5 py-1.5 max-sm:px-3"
			>
				<ToolButton
					label={`Bold (${MOD}B)`}
					pressed={active.bold}
					onClick={() => run("bold")}
					disabled={disabled}
				>
					<Bold />
				</ToolButton>
				<ToolButton
					label={`Italic (${MOD}I)`}
					pressed={active.italic}
					onClick={() => run("italic")}
					disabled={disabled}
				>
					<Italic />
				</ToolButton>
				<ToolButton
					label={`Underline (${MOD}U)`}
					pressed={active.underline}
					onClick={() => run("underline")}
					disabled={disabled}
				>
					<Underline />
				</ToolButton>
				<ToolButton
					label={`Link (${MOD}K)`}
					pressed={active.link || linkOpen}
					onClick={openLink}
					disabled={disabled}
				>
					<Link2 />
				</ToolButton>
				<span aria-hidden="true" className="mx-1 h-4 w-px bg-border-card" />
				<ToolButton
					label={`Bulleted list (${MOD}⇧8)`}
					pressed={active.insertUnorderedList}
					onClick={() => run("insertUnorderedList")}
					disabled={disabled}
				>
					<List />
				</ToolButton>
				<ToolButton
					label={`Numbered list (${MOD}⇧7)`}
					pressed={active.insertOrderedList}
					onClick={() => run("insertOrderedList")}
					disabled={disabled}
				>
					<ListOrdered />
				</ToolButton>
				<ToolButton
					label={`Quote (${MOD}⇧9)`}
					pressed={active.blockquote}
					onClick={toggleQuote}
					disabled={disabled}
				>
					<TextQuote />
				</ToolButton>
				<ToolButton
					label={`Clear formatting (${MOD}\\)`}
					onClick={clearFormatting}
					disabled={disabled}
				>
					<RemoveFormatting />
				</ToolButton>
				{linkOpen ? (
					<form
						className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 max-sm:basis-full max-sm:ml-0"
						onSubmit={(e) => {
							e.preventDefault();
							applyLink();
						}}
					>
						<input
							// biome-ignore lint/a11y/noAutofocus: the field exists only because the person just asked for it.
							autoFocus
							type="text"
							inputMode="url"
							aria-label="Link address"
							placeholder="https://example.com"
							value={linkValue}
							onChange={(e) => setLinkValue(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Escape") {
									e.preventDefault();
									e.stopPropagation();
									setLinkOpen(false);
									editorRef.current?.focus();
								}
							}}
							className="h-7 min-w-0 flex-1 rounded-control border border-border-card bg-panel px-2 text-label text-ink outline-none focus:border-text-muted"
						/>
						<button
							type="submit"
							className="h-7 shrink-0 rounded-control px-2 text-label font-medium text-text hover:bg-hover"
						>
							{linkValue.trim() ? "Apply" : "Remove"}
						</button>
					</form>
				) : null}
			</div>
			<div className="relative flex min-h-0 flex-1 flex-col">
				{empty && placeholder ? (
					<span
						aria-hidden="true"
						className="pointer-events-none absolute top-[18px] left-7 text-sender leading-[22px] text-text-faint max-sm:left-5"
					>
						{placeholder}
					</span>
				) : null}
				{/* biome-ignore lint/a11y/useSemanticElements: a rich-text field has no native element; role=textbox + aria-multiline is the documented pattern. */}
				<div
					ref={editorRef}
					role="textbox"
					tabIndex={0}
					aria-multiline="true"
					aria-label={ariaLabel}
					contentEditable={!disabled}
					suppressContentEditableWarning
					onInput={emit}
					onBlur={emit}
					onKeyDown={onKeyDown}
					onPaste={onPaste}
					onDrop={(e) => e.preventDefault()}
					className="compose-body app-scroll min-h-62 w-full flex-1 overflow-y-auto px-7 pt-[18px] pb-6 text-sender leading-[22px] text-text outline-none max-sm:min-h-48 max-sm:px-5"
				/>
			</div>
		</div>
	);
});

function ToolButton({
	label,
	pressed,
	onClick,
	disabled,
	children,
}: {
	label: string;
	pressed?: boolean;
	onClick: () => void;
	disabled?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			aria-pressed={pressed ?? undefined}
			disabled={disabled}
			// Keep the selection in the editor: a click would otherwise move focus first.
			onMouseDown={(e) => e.preventDefault()}
			onClick={onClick}
			className={cn(
				"inline-flex size-7 items-center justify-center rounded-control text-icon hover:bg-hover hover:text-text disabled:opacity-40 [&_svg]:size-[15px]",
				pressed && "bg-hover text-ink",
			)}
		>
			{children}
		</button>
	);
}

function closest(node: Node, tag: string, root: HTMLElement): Element | null {
	let current: Node | null = node;
	while (current && current !== root) {
		if (
			current.nodeType === Node.ELEMENT_NODE &&
			(current as Element).tagName.toLowerCase() === tag
		) {
			return current as Element;
		}
		current = current.parentNode;
	}
	return null;
}

function escapeAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
