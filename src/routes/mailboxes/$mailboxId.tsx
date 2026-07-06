import { createFileRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { Menu, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useState } from "react";
import { ComposeModal } from "#/components/mail/ComposeModal";
import { Sidebar } from "#/components/mail/Sidebar";
import ThemeToggle from "#/components/ThemeToggle";
import { cn } from "#/lib/cn";
import type { FolderKey } from "#/lib/mail";
import { MailSyncProvider, useMailboxSocket } from "#/lib/use-mail";

export type MailboxSearch = {
	folder?: FolderKey;
	q?: string;
	compose?: boolean;
	// Reply/forward prefill carried into the compose modal.
	to?: string;
	subject?: string;
	threadId?: string;
	draftId?: string;
};

const FOLDER_KEYS: FolderKey[] = ["inbox", "sent", "drafts", "archive", "trash", "all"];

export const Route = createFileRoute("/mailboxes/$mailboxId")({
	component: MailboxShell,
	validateSearch: (search: Record<string, unknown>): MailboxSearch => {
		const folder = FOLDER_KEYS.includes(search.folder as FolderKey)
			? (search.folder as FolderKey)
			: undefined;
		const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
		return {
			folder,
			q: str(search.q),
			compose: search.compose === true || search.compose === "true" ? true : undefined,
			to: str(search.to),
			subject: str(search.subject),
			threadId: str(search.threadId),
			draftId: str(search.draftId),
		};
	},
});

function MailboxShell() {
	const { mailboxId } = Route.useParams();
	const search = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const [mobileNavOpen, setMobileNavOpen] = useState(false);

	// Cross-view revalidation token: bumped on new inbound mail so the sidebar,
	// thread list, and open conversation refresh together.
	const [syncToken, setSyncToken] = useState(0);
	const bumpSync = useCallback(() => setSyncToken((n) => n + 1), []);
	useMailboxSocket(
		mailboxId,
		useCallback(
			(event) => {
				if (event.type === "message.created") bumpSync();
			},
			[bumpSync],
		),
	);

	const activeFolder: FolderKey = search.folder ?? "inbox";

	const setSearchQuery = useCallback(
		(value: string) => {
			navigate({
				search: (prev) => ({ ...prev, q: value.length > 0 ? value : undefined }),
				replace: true,
			});
		},
		[navigate],
	);

	const openCompose = useCallback(
		(prefill?: { to?: string; subject?: string; threadId?: string; draftId?: string }) => {
			navigate({ search: (prev) => ({ ...prev, compose: true, ...prefill }) });
			setMobileNavOpen(false);
		},
		[navigate],
	);

	const closeCompose = useCallback(() => {
		navigate({
			search: (prev) => ({
				...prev,
				compose: undefined,
				to: undefined,
				subject: undefined,
				threadId: undefined,
				draftId: undefined,
			}),
		});
	}, [navigate]);

	return (
		<MailSyncProvider token={syncToken}>
			<div className="app-surface-root flex h-[100dvh] w-full overflow-hidden">
				{/* Sidebar — persistent on desktop, slide-over on mobile */}
				<div
					className={cn(
						"fixed inset-0 z-40 lg:static lg:z-auto lg:block",
						mobileNavOpen ? "block" : "hidden",
					)}
				>
					{/* scrim (mobile only) */}
					<button
						type="button"
						aria-label="Close menu"
						className="absolute inset-0 bg-black/30 lg:hidden"
						onClick={() => setMobileNavOpen(false)}
					/>
					<div className="relative h-full w-64 max-w-[80%] bg-[var(--app-bg)] lg:w-64 lg:max-w-none">
						<Sidebar
							mailboxId={mailboxId}
							activeFolder={activeFolder}
							onCompose={() => openCompose()}
						/>
					</div>
				</div>

				{/* Main column */}
				<div className="flex min-w-0 flex-1 flex-col">
					<header className="flex h-16 shrink-0 items-center gap-2 px-2 sm:gap-3 sm:px-4">
						<button
							type="button"
							aria-label="Menu"
							className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--app-text-soft)] hover:bg-[var(--app-hover)] lg:hidden"
							onClick={() => setMobileNavOpen(true)}
						>
							<Menu className="h-5 w-5" />
						</button>

						<div className="flex h-12 max-w-2xl flex-1 items-center gap-2 rounded-full bg-[var(--app-surface-2)] px-4 focus-within:bg-[var(--app-surface)] focus-within:shadow-[var(--app-shadow)]">
							<Search className="h-5 w-5 shrink-0 text-[var(--app-text-soft)]" />
							<input
								value={search.q ?? ""}
								onChange={(e) => setSearchQuery(e.target.value)}
								placeholder="Search mail"
								className="h-full w-full bg-transparent text-[15px] text-[var(--app-text)] outline-none placeholder:text-[var(--app-text-faint)]"
							/>
							{search.q ? (
								<button
									type="button"
									aria-label="Clear search"
									onClick={() => setSearchQuery("")}
									className="inline-flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-text-soft)] hover:bg-[var(--app-hover)]"
								>
									<X className="h-4 w-4" />
								</button>
							) : null}
						</div>

						<button
							type="button"
							aria-label="Refresh"
							title="Refresh"
							onClick={bumpSync}
							className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--app-text-soft)] hover:bg-[var(--app-hover)]"
						>
							<RefreshCw className="h-5 w-5" />
						</button>
						<ThemeToggle />
					</header>

					{/* Content surface — rounded Gmail-style panel */}
					<div className="min-h-0 flex-1 overflow-hidden rounded-tl-2xl border-t border-l border-[var(--app-border)] bg-[var(--app-surface)] lg:rounded-tl-2xl">
						<Outlet />
					</div>
				</div>

				{search.compose ? (
					<ComposeModal
						mailboxId={mailboxId}
						prefill={{
							to: search.to,
							subject: search.subject,
							threadId: search.threadId,
							draftId: search.draftId,
						}}
						onClose={closeCompose}
						onSent={bumpSync}
					/>
				) : null}
			</div>
		</MailSyncProvider>
	);
}
