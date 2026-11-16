import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "#/lib/cn";

/**
 * Header search pill. Types locally and commits to the URL after a short pause
 * (searching fans out to every mailbox in scope, so not on every keystroke).
 * ⌘K / Ctrl+K (or "/" outside a field) focuses it from anywhere; Esc clears
 * the search — back to the folder as it was — and blurs.
 */
export function SearchField({
	value,
	onCommit,
	placeholder,
	className,
}: {
	value: string;
	onCommit: (value: string) => void;
	placeholder: string;
	className?: string;
}) {
	const [draft, setDraft] = useState(value);
	const inputRef = useRef<HTMLInputElement>(null);
	const commitRef = useRef(onCommit);
	commitRef.current = onCommit;

	// URL changed elsewhere (back button, folder switch): follow it — but not
	// while the person is typing, or a committed value would eat newer keystrokes.
	useEffect(() => {
		if (typeof document !== "undefined" && document.activeElement === inputRef.current) return;
		setDraft(value);
	}, [value]);

	useEffect(() => {
		if (draft.trim() === value.trim()) return;
		const t = window.setTimeout(() => commitRef.current(draft.trim()), 350);
		return () => window.clearTimeout(t);
	}, [draft, value]);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			const input = inputRef.current;
			// Only the copy of the field that is on screen (phones keep a second one).
			if (!input || input.offsetParent === null) return;
			const target = event.target as HTMLElement | null;
			const typing =
				!!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
			const slash =
				event.key === "/" &&
				!typing &&
				!event.metaKey &&
				!event.ctrlKey &&
				!event.altKey &&
				!document.querySelector('[role="dialog"]');
			// ⌘K inside a dialog belongs to it (the compose editor's "Link").
			const commandK =
				(event.metaKey || event.ctrlKey) &&
				event.key.toLowerCase() === "k" &&
				!document.querySelector('[role="dialog"]');
			if (slash || commandK) {
				event.preventDefault();
				input.focus();
				input.select();
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return (
		<search
			className={cn(
				"flex h-9 min-w-0 items-center gap-[9px] rounded-pill bg-pill pr-2 pl-[13px] focus-within:bg-panel focus-within:shadow-[0_0_0_1px_var(--color-border),0_0_0_4px_color-mix(in_srgb,var(--color-brand)_8%,transparent)]",
				className,
			)}
		>
			<Search aria-hidden="true" className="size-4 shrink-0 text-text-muted" />
			<input
				ref={inputRef}
				type="search"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						onCommit(draft.trim());
					} else if (e.key === "Escape") {
						setDraft("");
						onCommit("");
						e.currentTarget.blur();
					}
				}}
				placeholder={placeholder}
				aria-label={placeholder}
				className="h-full min-w-0 flex-1 bg-transparent text-body text-text outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
			/>
			{draft ? (
				<button
					type="button"
					aria-label="Clear search"
					onClick={() => {
						setDraft("");
						onCommit("");
						inputRef.current?.focus();
					}}
					className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-icon hover:bg-hover"
				>
					<X className="size-3.5" />
				</button>
			) : (
				<kbd className="hidden h-[22px] shrink-0 items-center rounded-[11px] border border-border bg-panel px-[7px] font-sans text-meta text-text-muted sm:inline-flex">
					⌘K
				</kbd>
			)}
		</search>
	);
}
