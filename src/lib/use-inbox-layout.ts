import { useCallback, useEffect, useState } from "react";

/**
 * Which inbox columns are folded, remembered per browser: the mailbox column
 * (left) and the conversation list, so an open message can take the width.
 * Read after mount (the server render always shows both), and every storage
 * access is guarded: private windows and blocked storage just don't remember.
 */
export type InboxLayout = { mailboxesFolded: boolean; listFolded: boolean };

const KEY = "reccado.inbox.layout";
const DEFAULT: InboxLayout = { mailboxesFolded: false, listFolded: false };

export function parseInboxLayout(raw: string | null | undefined): InboxLayout {
	if (!raw) return DEFAULT;
	try {
		const value = JSON.parse(raw) as Partial<InboxLayout> | null;
		return {
			mailboxesFolded: value?.mailboxesFolded === true,
			listFolded: value?.listFolded === true,
		};
	} catch {
		return DEFAULT;
	}
}

export function useInboxLayout() {
	const [layout, setLayout] = useState<InboxLayout>(DEFAULT);

	useEffect(() => {
		try {
			setLayout(parseInboxLayout(window.localStorage.getItem(KEY)));
		} catch {
			// Storage unavailable: start unfolded.
		}
	}, []);

	const update = useCallback((next: (prev: InboxLayout) => InboxLayout) => {
		setLayout((prev) => {
			const value = next(prev);
			try {
				window.localStorage.setItem(KEY, JSON.stringify(value));
			} catch {
				// Not remembered; still applied for now.
			}
			return value;
		});
	}, []);

	const toggleMailboxes = useCallback(
		() => update((p) => ({ ...p, mailboxesFolded: !p.mailboxesFolded })),
		[update],
	);
	const toggleList = useCallback(
		() => update((p) => ({ ...p, listFolded: !p.listFolded })),
		[update],
	);
	/** "Read wider": fold both, or unfold both when both are folded. */
	const toggleWide = useCallback(
		() =>
			update((p) => {
				const wide = p.mailboxesFolded && p.listFolded;
				return { mailboxesFolded: !wide, listFolded: !wide };
			}),
		[update],
	);

	return { ...layout, toggleMailboxes, toggleList, toggleWide };
}
