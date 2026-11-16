import { Link } from "@tanstack/react-router";
import { ArrowLeft, LogOut, Search, Settings2, ShieldCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar } from "#/components/ui/Avatar";
import { IconButton, iconButtonClassName } from "#/components/ui/IconButton";
import { Menu } from "#/components/ui/Menu";
import { cn } from "#/lib/cn";
import { ownerInitials, useMe } from "#/lib/use-me";

/**
 * Ends the session and returns to the door. A full navigation rather than a
 * router push: the cookie is cleared by the response, and nothing the client
 * holds in memory should outlive it.
 */
export async function signOut(): Promise<void> {
	try {
		await fetch("/api/auth/sign-out", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
	} catch {
		// Offline or refused: go to /login anyway — a signed-in-looking screen
		// with no session is the worse failure.
	}
	window.location.assign("/login");
}

/** The navy square with the white asterisk. */
export function BrandMark({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-brand",
				className,
			)}
		>
			<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
				<path
					d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3L5.3 18.7"
					fill="none"
					stroke="#FFFFFF"
					strokeWidth="2.4"
					strokeLinecap="round"
				/>
			</svg>
		</span>
	);
}

/** Same glyph as the design's settings button (two sliders). */
function SlidersIcon() {
	return (
		<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">
			<path
				d="M4 7h9M19 7h1M4 17h1M11 17h9"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<circle cx="16" cy="7" r="3" fill="currentColor" />
			<circle cx="8" cy="17" r="3" fill="currentColor" />
		</svg>
	);
}

function OwnerMenu() {
	const { data: me } = useMe();
	const email = me?.email ?? null;
	return (
		<Menu
			label={email ? `Account: ${email}` : "Account"}
			align="end"
			triggerClassName="flex h-[30px] w-[30px] items-center justify-center rounded-full"
			trigger={
				<Avatar
					from={email}
					label={ownerInitials(email) || " "}
					tone="neutral"
					size="md"
					className="h-[30px] w-[30px]"
				/>
			}
			items={[
				...(email ? [{ key: "who", heading: email }] : []),
				{ key: "settings", label: "Settings", icon: <Settings2 />, to: "/settings" },
				{
					key: "security",
					label: "Sign-in security",
					icon: <ShieldCheck />,
					to: "/settings/account",
				},
				{ key: "sep", separator: true },
				{ key: "signout", label: "Sign out", icon: <LogOut />, onSelect: () => void signOut() },
			]}
		/>
	);
}

/**
 * The rounded app frame shared by every authenticated screen (Paper artboards
 * "Inbox — Desktop", "Approvals — Desktop", "Settings — Domains & mailboxes").
 *
 *   backdrop ─ shell (fog) ─ main panel (white)
 *     ├ header   64px: logo · title • subtitle · {headerExtra} · ⟷ · {search} · settings · owner
 *     ├ toolbar  58px: {toolbar}  (Compose + folder tabs, or Back + settings tabs + "Add domain")
 *     └ content  grey: {children}
 *
 * The toolbar is a flex row (gap 12px); push items right with `<ToolbarSpacer/>`
 * and separate groups with `<ToolbarDivider/>`. It scrolls horizontally on
 * narrow screens. `children` fill the remaining height (`min-h-0`), so put
 * your own scroll containers inside.
 */
export function AppShell({
	title,
	subtitle,
	headerExtra,
	search,
	searchActive = false,
	toolbar,
	children,
	contentClassName,
	headerLeading,
}: {
	title: ReactNode;
	/** Shown after a dot separator ("14.171 emails", "Domains & mailboxes"). Hidden below `lg`. */
	subtitle?: ReactNode;
	/** Right after the title (the inbox's "All mailboxes ▾" scope switcher). */
	headerExtra?: ReactNode;
	/**
	 * Right-aligned before the settings button (search field). On phones it
	 * collapses into a search icon that opens the field over the header.
	 */
	search?: ReactNode;
	/** A search is in effect: on phones, show the field open instead of the icon. */
	searchActive?: boolean;
	/** Content of the second bar. Omit to hide the bar. */
	toolbar?: ReactNode;
	children: ReactNode;
	/** Extra classes on the grey content region (default: flex row, 16px padding/gap). */
	contentClassName?: string;
	/** Rendered before the logo (e.g. a drawer toggle on narrow screens). */
	headerLeading?: ReactNode;
}) {
	const [searchOpen, setSearchOpen] = useState(searchActive);
	const overlayRef = useRef<HTMLDivElement>(null);
	const toolbarRef = useRef<HTMLElement>(null);

	useEffect(() => {
		if (searchActive) setSearchOpen(true);
	}, [searchActive]);

	// Phone search overlay: focus the field when it opens (not on first render
	// with a query already in effect, which would pop the keyboard).
	const openedByTap = useRef(false);
	useEffect(() => {
		if (!searchOpen || !openedByTap.current) return;
		openedByTap.current = false;
		overlayRef.current?.querySelector<HTMLInputElement>("input")?.focus();
	}, [searchOpen]);

	// On narrow screens the tabs scroll sideways: bring the current one into
	// view when it changes (not on every render, so a manual scroll sticks).
	const lastCurrent = useRef<Element | null>(null);
	useEffect(() => {
		const current = toolbarRef.current?.querySelector('[aria-current="page"]') ?? null;
		if (!current || current === lastCurrent.current) return;
		lastCurrent.current = current;
		current.scrollIntoView({ block: "nearest", inline: "nearest" });
	});

	return (
		<div className="flex h-[100dvh] w-full bg-panel">
			<div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
				<div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-panel">
					<header className="relative flex h-16 shrink-0 items-center gap-2 border-b border-divider px-3 sm:gap-3.5 sm:px-[18px]">
						{headerLeading}
						<Link to="/inbox" aria-label="Reccado — go to inbox" className="shrink-0 rounded-[7px]">
							<BrandMark />
						</Link>
						<h1 className="m-0 flex min-w-0 shrink items-center gap-3.5 text-title font-normal tracking-[-0.01em]">
							<span className="shrink-0 whitespace-nowrap text-[#5C5C5C]">{title}</span>
							{subtitle ? (
								<>
									<span
										aria-hidden="true"
										className="hidden h-1 w-1 shrink-0 rounded-[2px] bg-[#CFCFCF] lg:inline-block"
									/>
									<span className="hidden truncate text-[#3A3A3A] lg:inline">{subtitle}</span>
								</>
							) : null}
						</h1>
						{headerExtra}
						<div className="min-w-0 flex-1" />
						{search ? (
							<>
								<div className="flex min-w-0 shrink justify-end max-sm:hidden">{search}</div>
								<IconButton
									title="Search"
									size="lg"
									className="sm:hidden"
									onClick={() => {
										openedByTap.current = true;
										setSearchOpen(true);
									}}
								>
									<Search />
								</IconButton>
								{searchOpen ? (
									<div
										ref={overlayRef}
										className="absolute inset-0 z-10 flex items-center gap-2 bg-panel px-3 sm:hidden"
									>
										<IconButton title="Close search" size="lg" onClick={() => setSearchOpen(false)}>
											<ArrowLeft />
										</IconButton>
										<div className="flex min-w-0 flex-1 [&>*]:max-w-none [&>*]:flex-1">
											{search}
										</div>
									</div>
								) : null}
							</>
						) : null}
						<Link
							to="/settings"
							title="Settings"
							aria-label="Settings"
							className={iconButtonClassName("lg")}
						>
							<SlidersIcon />
						</Link>
						<OwnerMenu />
					</header>
					{toolbar ? (
						<nav
							ref={toolbarRef}
							aria-label="Sections"
							className="no-scrollbar flex h-[58px] shrink-0 items-center gap-2 overflow-x-auto sm:gap-3 border-b border-divider px-2 sm:pr-5 sm:pl-4"
						>
							{toolbar}
						</nav>
					) : null}
					<div
						className={cn(
							"flex min-h-0 flex-1 gap-4 bg-content px-2 pt-2 sm:px-4 sm:pt-4",
							contentClassName,
						)}
					>
						{children}
					</div>
				</div>
			</div>
		</div>
	);
}

export function ToolbarSpacer() {
	return <div aria-hidden="true" className="flex-1 sm:min-w-2" />;
}

export function ToolbarDivider() {
	return <div aria-hidden="true" className="h-[22px] w-px shrink-0 bg-[#E3E3E3] max-sm:hidden" />;
}
