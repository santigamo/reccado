import { Dialog } from "#/components/ui/Dialog";

const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
	{
		title: "Anywhere",
		keys: [
			["c", "Compose"],
			["/", "Search"],
			["?", "Show these shortcuts"],
			["[", "Hide / show the mailboxes"],
			["]", "Hide / show the list (conversation open)"],
		],
	},
	{
		title: "In the list",
		keys: [
			["j / k", "Next / previous conversation"],
			["Enter", "Open"],
			["x", "Select"],
			["e", "Archive (or move to inbox)"],
			["#", "Delete (in Trash: delete forever, asks first)"],
			["Shift + i", "Mark as read"],
			["Shift + u", "Mark as unread"],
			["Esc", "Clear the selection"],
		],
	},
	{
		title: "In a conversation",
		keys: [
			["r", "Reply"],
			["a", "Reply all"],
			["f", "Forward"],
			["e", "Archive (or move to inbox)"],
			["#", "Delete (in Trash: delete forever, asks first)"],
			["Shift + u", "Mark as unread"],
			["j / k", "Older / newer conversation"],
			["Esc or u", "Back to the list"],
		],
	},
	{
		title: "Writing",
		keys: [
			["⌘ / Ctrl + Enter", "Send"],
			["Esc", "Close and keep the draft"],
		],
	},
];

/** "?" — the keyboard shortcuts, Gmail's sheet in miniature. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
	return (
		<Dialog onClose={onClose} title="Keyboard shortcuts" size="md">
			<div className="grid gap-6 sm:grid-cols-2">
				{GROUPS.map((group) => (
					<section key={group.title} aria-label={group.title}>
						<h3 className="m-0 mb-2 text-meta font-medium tracking-[0.02em] text-text-muted">
							{group.title}
						</h3>
						<dl className="m-0 flex flex-col gap-1.5">
							{group.keys.map(([key, what]) => (
								<div key={key + what} className="flex items-center gap-3">
									<dt className="w-[118px] shrink-0">
										<kbd className="inline-flex h-[22px] items-center rounded-[6px] border border-border bg-content px-1.5 font-sans text-meta text-text">
											{key}
										</kbd>
									</dt>
									<dd className="m-0 text-label text-text-secondary">{what}</dd>
								</div>
							))}
						</dl>
					</section>
				))}
			</div>
		</Dialog>
	);
}
