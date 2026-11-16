import { Link, type LinkProps } from "@tanstack/react-router";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { cn } from "#/lib/cn";

export type MenuItem =
	| {
			key: string;
			label: ReactNode;
			icon?: ReactNode;
			/** Trailing content (count, shortcut, check). */
			trailing?: ReactNode;
			active?: boolean;
			disabled?: boolean;
			danger?: boolean;
			onSelect?: () => void;
			/** In-app route to navigate to instead of running an action. */
			to?: LinkProps["to"];
			/** Non-route URL (an API download such as the raw message); opens in a new tab. */
			href?: string;
	  }
	| { key: string; separator: true }
	| { key: string; heading: ReactNode };

/**
 * Small dropdown menu: a trigger button and a popover list of items.
 * Keyboard: Enter/Space/ArrowDown open, Up/Down move, Esc closes and returns
 * focus to the trigger; outside click closes.
 */
export function Menu({
	label,
	trigger,
	triggerClassName,
	items,
	align = "start",
	menuClassName,
}: {
	/** Accessible name of the trigger. */
	label: string;
	trigger: ReactNode;
	triggerClassName?: string;
	items: MenuItem[];
	align?: "start" | "end";
	menuClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const menuId = useId();

	const focusItem = useCallback((index: number) => {
		const nodes = listRef.current?.querySelectorAll<HTMLElement>(
			'[role="menuitem"]:not([aria-disabled="true"])',
		);
		if (!nodes || nodes.length === 0) return;
		const i = ((index % nodes.length) + nodes.length) % nodes.length;
		nodes[i]?.focus({ preventScroll: true });
	}, []);

	// Fixed to the viewport, anchored under the trigger: a trigger inside a
	// scrolling container (the toolbar is overflow-x: auto, which also clips
	// vertically) would otherwise clip the list and scroll the bar out of view.
	const [anchor, setAnchor] = useState<{ top: number; left: number; right: number } | null>(null);
	useLayoutEffect(() => {
		if (!open) return;
		const place = () => {
			const r = triggerRef.current?.getBoundingClientRect();
			if (r) setAnchor({ top: r.bottom + 6, left: r.left, right: window.innerWidth - r.right });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		focusItem(0);
		function onPointerDown(event: PointerEvent) {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		}
		document.addEventListener("pointerdown", onPointerDown);
		return () => document.removeEventListener("pointerdown", onPointerDown);
	}, [open, focusItem]);

	function close(returnFocus = true) {
		setOpen(false);
		if (returnFocus) triggerRef.current?.focus();
	}

	function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		const nodes = Array.from(
			listRef.current?.querySelectorAll<HTMLElement>(
				'[role="menuitem"]:not([aria-disabled="true"])',
			) ?? [],
		);
		const current = nodes.indexOf(document.activeElement as HTMLElement);
		if (event.key === "ArrowDown") {
			event.preventDefault();
			focusItem(current + 1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			focusItem(current - 1);
		} else if (event.key === "Home") {
			event.preventDefault();
			focusItem(0);
		} else if (event.key === "End") {
			event.preventDefault();
			focusItem(nodes.length - 1);
		} else if (event.key === "Escape") {
			event.preventDefault();
			close();
		} else if (event.key === "Tab") {
			close(false);
		}
	}

	const itemClass = (active?: boolean, danger?: boolean, disabled?: boolean) =>
		cn(
			"flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-body no-underline outline-none [&_svg]:size-4 [&_svg]:shrink-0",
			danger ? "text-danger" : "text-text",
			active && "bg-row-selected font-medium",
			disabled ? "cursor-not-allowed opacity-50" : "hover:bg-hover focus:bg-hover",
		);

	return (
		<div ref={rootRef} className="relative">
			<button
				ref={triggerRef}
				type="button"
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-controls={open ? menuId : undefined}
				className={triggerClassName}
				onClick={() => setOpen((v) => !v)}
				onKeyDown={(event) => {
					if (event.key === "ArrowDown" && !open) {
						event.preventDefault();
						setOpen(true);
					}
				}}
			>
				{trigger}
			</button>
			{open ? (
				<div
					ref={listRef}
					id={menuId}
					role="menu"
					aria-label={label}
					tabIndex={-1}
					onKeyDown={onListKeyDown}
					style={
						anchor
							? align === "end"
								? { position: "fixed", top: anchor.top, right: anchor.right }
								: {
										position: "fixed",
										top: anchor.top,
										left: Math.max(8, Math.min(anchor.left, window.innerWidth - 232)),
									}
							: undefined
					}
					className={cn(
						"absolute top-[calc(100%+6px)] z-40 flex min-w-56 flex-col gap-0.5 rounded-[12px] border border-border-card bg-panel p-1.5 shadow-popover",
						align === "end" ? "right-0" : "left-0",
						menuClassName,
					)}
				>
					{items.map((item) => {
						if ("separator" in item) {
							return <hr key={item.key} className="my-1 border-0 border-t border-border" />;
						}
						if ("heading" in item) {
							return (
								<div
									key={item.key}
									className="px-2.5 pt-2 pb-1 text-meta font-medium tracking-[0.02em] text-text-muted"
								>
									{item.heading}
								</div>
							);
						}
						const content = (
							<>
								{item.icon}
								<span className="min-w-0 flex-1 truncate">{item.label}</span>
								{item.trailing}
							</>
						);
						if (item.href && !item.disabled) {
							return (
								<a
									key={item.key}
									role="menuitem"
									tabIndex={-1}
									href={item.href}
									target="_blank"
									rel="noreferrer"
									className={itemClass(item.active, item.danger)}
									onClick={() => setOpen(false)}
								>
									{content}
								</a>
							);
						}
						if (item.to && !item.disabled) {
							return (
								<Link
									key={item.key}
									role="menuitem"
									tabIndex={-1}
									to={item.to}
									className={itemClass(item.active, item.danger)}
									onClick={() => setOpen(false)}
								>
									{content}
								</Link>
							);
						}
						return (
							<button
								key={item.key}
								type="button"
								role="menuitem"
								tabIndex={-1}
								aria-disabled={item.disabled || undefined}
								aria-current={item.active ? "true" : undefined}
								className={itemClass(item.active, item.danger, item.disabled)}
								onClick={() => {
									if (item.disabled) return;
									close();
									item.onSelect?.();
								}}
							>
								{content}
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
