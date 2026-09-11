import { Link, useLocation } from "@tanstack/react-router";
import {
	Archive,
	FileText,
	Inbox,
	KeyRound,
	LogOut,
	Mail,
	Pencil,
	Send,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "#/lib/cn";
import { FOLDERS, type FolderKey } from "#/lib/mail";
import { useMailboxes } from "#/lib/use-mail";

/**
 * Ends the session and returns to the door.
 *
 * A full navigation rather than a router push: the session cookie is cleared by
 * the response, and anything the client already holds in memory should not
 * outlive it.
 */
async function signOut(): Promise<void> {
	try {
		await fetch("/api/auth/sign-out", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
	} catch {
		// Offline, or the endpoint refused. Send them to /login anyway: the cookie
		// may well be gone, and stranding someone on a signed-in-looking screen is
		// the worse failure.
	}
	window.location.assign("/login");
}

const FOLDER_ICONS: Record<FolderKey, typeof Inbox> = {
	inbox: Inbox,
	sent: Send,
	drafts: FileText,
	archive: Archive,
	trash: Trash2,
	all: Mail,
};

export function Sidebar({
	mailboxId,
	activeFolder,
	onCompose,
}: {
	mailboxId: string;
	activeFolder: FolderKey;
	onCompose: () => void;
}): ReactElement {
	const { data: mailboxes, loading: mailboxesLoading } = useMailboxes();
	const currentMailbox = mailboxes.find((m) => m.mailbox_id === mailboxId);
	// Non-folder pages live under the same mailbox shell, so folder highlighting
	// has to yield to them — otherwise Inbox stays lit on the keys page.
	const pathname = useLocation({ select: (location) => location.pathname });
	const onKeysPage = pathname.endsWith("/keys");

	return (
		<div className="flex h-full flex-col gap-1 overflow-y-auto app-scroll pb-3">
			{/* Brand */}
			<div className="flex items-center gap-2 px-3 py-4">
				<span className="h-2 w-2 shrink-0 rounded-full bg-[linear-gradient(135deg,var(--lagoon),var(--palm))]" />
				<span className="text-lg font-medium tracking-tight text-[var(--app-text)]">Reccado</span>
			</div>

			{/* Compose — a tinted-glass "prominent" pill: translucent enough to
			    pick up the sidebar's blur, opaque enough to keep the label legible. */}
			<div className="px-3 pb-2">
				<button
					type="button"
					onClick={onCompose}
					className="flex h-12 w-full items-center gap-3 rounded-full border border-[var(--glass-border)] bg-[color-mix(in_oklab,var(--app-accent)_90%,transparent)] px-4 text-sm font-medium text-[var(--app-on-accent)] shadow-[var(--glass-shadow)] backdrop-blur-md transition hover:brightness-95 active:scale-[0.98]"
				>
					<Pencil className="h-5 w-5 shrink-0" />
					<span>Compose</span>
				</button>
			</div>

			{/* Folder nav */}
			<nav className="flex flex-col gap-0.5 pr-3">
				{FOLDERS.map((f) => {
					const Icon = FOLDER_ICONS[f.key];
					const active = !onKeysPage && f.key === activeFolder;
					return (
						<Link
							key={f.key}
							to="/mailboxes/$mailboxId"
							params={{ mailboxId }}
							search={(prev) => ({ ...prev, folder: f.key, q: undefined })}
							className={cn(
								"flex h-9 items-center gap-4 rounded-r-full px-4 text-sm transition active:scale-[0.98]",
								active
									? "bg-[var(--app-selected)] font-medium text-[var(--app-selected-text)]"
									: "text-[var(--app-text-soft)] hover:bg-[var(--app-hover)]",
							)}
						>
							<Icon className="h-4 w-4 shrink-0" />
							<span className="truncate">{f.label}</span>
						</Link>
					);
				})}
			</nav>

			{/* Mailbox settings — not folders, so they sit under their own divider. */}
			<div className="mt-3 border-t border-[var(--app-border)] pr-3 pt-3">
				<Link
					to="/mailboxes/$mailboxId/keys"
					params={{ mailboxId }}
					search={(prev) => prev}
					className={cn(
						"flex h-9 items-center gap-4 rounded-r-full px-4 text-sm transition active:scale-[0.98]",
						onKeysPage
							? "bg-[var(--app-selected)] font-medium text-[var(--app-selected-text)]"
							: "text-[var(--app-text-soft)] hover:bg-[var(--app-hover)]",
					)}
				>
					<KeyRound className="h-4 w-4 shrink-0" />
					<span className="truncate">API keys</span>
				</Link>
			</div>

			{/* Mailbox switcher, then the account itself. Sign-in security and signing
			    out belong to the person, not to the mailbox they happen to be reading,
			    so they sit below the switcher rather than under mailbox settings. */}
			<div className="mt-auto border-t border-[var(--app-border)] px-3 pt-3">
				{mailboxesLoading ? null : (
					<div className="flex items-center gap-2 px-1 text-xs text-[var(--app-text-soft)]">
						<Mail className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{currentMailbox?.primary_address ?? ""}</span>
					</div>
				)}
				{mailboxes.length > 1 ? (
					<Link
						to="/mailboxes"
						className="mt-1 inline-block px-1 text-xs text-[var(--app-text-faint)] hover:text-[var(--app-text-soft)] hover:underline"
					>
						Switch mailbox
					</Link>
				) : null}

				<div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--app-border)] pt-3">
					<Link
						to="/security"
						className="flex items-center gap-2 rounded-full px-1 py-1 text-xs text-[var(--app-text-faint)] transition hover:text-[var(--app-text-soft)]"
					>
						<ShieldCheck className="h-3.5 w-3.5 shrink-0" />
						<span>Sign-in security</span>
					</Link>
					<button
						type="button"
						onClick={signOut}
						className="flex items-center gap-2 rounded-full px-1 py-1 text-xs text-[var(--app-text-faint)] transition hover:text-[var(--app-text-soft)] active:scale-[0.98]"
					>
						<LogOut className="h-3.5 w-3.5 shrink-0" />
						<span>Sign out</span>
					</button>
				</div>
			</div>
		</div>
	);
}
