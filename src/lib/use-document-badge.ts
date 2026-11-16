import { useEffect } from "react";

/**
 * The browser tab says where you are and what is waiting: "(3) Inbox — Reccado",
 * and the favicon gets a dot while anything is unread. Restored on unmount.
 */
export function documentTitle(label: string, unread: number): string {
	return `${unread > 0 ? `(${unread > 999 ? "999+" : unread}) ` : ""}${label} — Reccado`;
}

/** The brand mark as an SVG favicon, with an unread dot when `dot`. */
export function faviconHref(dot: boolean): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="7" fill="#1b2a41"/><path d="M16 7.5v17M7.5 16h17M10 10l12 12M22 10L10 22" stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none"/>${dot ? '<circle cx="25" cy="7" r="6.5" fill="#d93f33" stroke="#fff" stroke-width="2"/>' : ""}</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function useDocumentBadge(label: string, unread: number | null): void {
	useEffect(() => {
		if (typeof document === "undefined") return;
		document.title = documentTitle(label, unread ?? 0);
	}, [label, unread]);

	const dot = (unread ?? 0) > 0;
	useEffect(() => {
		if (typeof document === "undefined") return;
		let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-unread-badge]');
		if (!link) {
			link = document.createElement("link");
			link.rel = "icon";
			link.type = "image/svg+xml";
			link.dataset.unreadBadge = "";
			document.head.appendChild(link);
		}
		link.href = faviconHref(dot);
	}, [dot]);

	useEffect(
		() => () => {
			document.querySelector('link[rel="icon"][data-unread-badge]')?.remove();
		},
		[],
	);
}
