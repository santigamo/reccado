/**
 * Per-mailbox colour, assigned on the client. There is no colour column in the
 * backend: every screen derives the same colour from the same mailbox list, so
 * the stripe in the thread list, the dot in the mailbox column and the tint of
 * the reading-pane header always agree.
 *
 * Assignment: mailboxes are put in a stable order (creation time, then primary
 * address, then id) and the n-th mailbox gets palette slot n mod 8. Adding a
 * mailbox never recolours an older one; deleting one can shift the ones created
 * after it, which is acceptable for a client-side hint.
 */

import { useCallback, useMemo } from "react";

/** Palette slots, in assignment order. Each maps to a `--color-mbx-<name>` token in styles.css. */
export const MAILBOX_PALETTE = [
	"hello",
	"billing",
	"support",
	"security",
	"hola",
	"free-1",
	"free-2",
	"free-3",
] as const;

export type MailboxPaletteName = (typeof MAILBOX_PALETTE)[number];

/** Raw hex values, for places that cannot read a CSS variable (canvas, tests). */
export const MAILBOX_PALETTE_HEX: Record<MailboxPaletteName, string> = {
	hello: "#4F84C4",
	billing: "#4A9B7E",
	support: "#8474C2",
	security: "#3E9AAB",
	hola: "#C2688C",
	"free-1": "#7F9651",
	"free-2": "#B8806A",
	"free-3": "#68788F",
};

export type MailboxColor = {
	name: MailboxPaletteName;
	/** `var(--color-mbx-<name>)` — use for backgrounds, borders, dots. */
	css: string;
	hex: string;
};

type MailboxLike = {
	mailbox_id: string;
	primary_address: string;
	created_at?: string | null;
};

export function paletteColor(index: number): MailboxColor {
	const slot = ((index % MAILBOX_PALETTE.length) + MAILBOX_PALETTE.length) % MAILBOX_PALETTE.length;
	const name = MAILBOX_PALETTE[slot]!;
	return { name, css: `var(--color-mbx-${name})`, hex: MAILBOX_PALETTE_HEX[name] };
}

/** The fallback for an id that is not in the list (e.g. still loading). */
export const UNKNOWN_MAILBOX_COLOR: MailboxColor = {
	name: "free-3",
	css: "var(--color-mbx-free-3)",
	hex: MAILBOX_PALETTE_HEX["free-3"],
};

/** Stable order used for colour assignment (and the mailbox column). */
export function sortMailboxesForColor<T extends MailboxLike>(mailboxes: readonly T[]): T[] {
	return [...mailboxes].sort((a, b) => {
		const ca = a.created_at ?? "";
		const cb = b.created_at ?? "";
		if (ca !== cb) return ca < cb ? -1 : 1;
		if (a.primary_address !== b.primary_address) {
			return a.primary_address < b.primary_address ? -1 : 1;
		}
		return a.mailbox_id < b.mailbox_id ? -1 : a.mailbox_id > b.mailbox_id ? 1 : 0;
	});
}

/** mailbox_id -> colour, for the whole list at once. */
export function assignMailboxColors(mailboxes: readonly MailboxLike[]): Map<string, MailboxColor> {
	const map = new Map<string, MailboxColor>();
	sortMailboxesForColor(mailboxes).forEach((m, i) => {
		map.set(m.mailbox_id, paletteColor(i));
	});
	return map;
}

/** Colour of one mailbox given the full list (falls back to a neutral slot). */
export function mailboxColor(mailboxes: readonly MailboxLike[], mailboxId: string): MailboxColor {
	return assignMailboxColors(mailboxes).get(mailboxId) ?? UNKNOWN_MAILBOX_COLOR;
}

/** The colour the *next* mailbox will get — for an "Add mailbox" dialog preview. */
export function nextMailboxColor(mailboxes: readonly MailboxLike[]): MailboxColor {
	return paletteColor(mailboxes.length);
}

/** `color` mixed with transparency, e.g. tint(c, 7) for the reading-pane header wash. */
export function tint(color: MailboxColor | string, percent: number): string {
	const css = typeof color === "string" ? color : color.css;
	return `color-mix(in srgb, ${css} ${percent}%, transparent)`;
}

/** A darker shade of the colour for text on its own tint (chip labels). */
export function shade(color: MailboxColor | string, percent = 60): string {
	const css = typeof color === "string" ? color : color.css;
	return `color-mix(in srgb, ${css} ${percent}%, black)`;
}

/**
 * React helper: memoised `colorOf(mailboxId)` for a mailbox list. Re-derives
 * only when the list identity changes.
 */
export function useMailboxColors(
	mailboxes: readonly MailboxLike[],
): (mailboxId: string) => MailboxColor {
	const map = useMemo(() => assignMailboxColors(mailboxes), [mailboxes]);
	return useCallback((mailboxId: string) => map.get(mailboxId) ?? UNKNOWN_MAILBOX_COLOR, [map]);
}
