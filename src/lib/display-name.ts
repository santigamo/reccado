/**
 * Display names from mail headers ("Noor Haddad" in `Noor Haddad <noor@haddad.dev>`).
 *
 * A display name is text the sender chose, so it is attacker-controlled: it can
 * carry control characters, bidi overrides that reorder what is drawn, invisible
 * padding, or simply claim to be a different address ("support@bank.com"
 * <evil@x.io>). This module is the one place that decides what part of it is
 * shown. It runs at ingest (what is stored) and again in the client (rows stored
 * before, or by another path), and it never makes the address less visible: a
 * name is something drawn *next to* the real address, never instead of it.
 *
 * Pure and dependency-free so the Worker and the browser share it.
 */

/** Longest name kept, in code points. Real names are far shorter. */
export const MAX_DISPLAY_NAME_LENGTH = 80;

// Characters that break a line or are control codes: replaced by a space, so
// "Noor\nHaddad" reads as two words, not one.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const BREAKING = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

// Invisible format characters: bidi embeddings/overrides/isolates and marks
// (they reorder what is drawn), zero-width and word-joiner padding, BOM, soft
// hyphen, and the Unicode "tag" block (invisible ASCII look-alikes used to hide
// text from a reader). Removed outright.
const INVISIBLE =
	/[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/gu;

// Anything shaped like local@domain once compatibility forms are folded
// (NFKC turns "＠" and "﹫" into "@").
const EMAIL_LIKE = /[^\s<>()[\]"',;:]+@[^\s<>()[\]"',;:]+/g;

function stripQuotes(value: string): string {
	return value.replace(/^["'\s]+|["'\s]+$/g, "");
}

/**
 * The name to show for `address`, or null when there is nothing trustworthy to
 * show (missing, empty after cleaning, the address itself, or naming a
 * *different* address — the classic `"ceo@corp.com" <attacker@x.io>`).
 */
export function sanitizeDisplayName(
	raw: unknown,
	address: string | null | undefined,
): string | null {
	if (typeof raw !== "string") return null;
	const cleaned = stripQuotes(
		raw.replace(BREAKING, " ").replace(INVISIBLE, "").replace(/\s+/g, " "),
	);
	if (!cleaned) return null;

	const real = (address ?? "").trim().toLowerCase();
	const folded = cleaned.normalize("NFKC").toLowerCase();
	if (folded === real) return null;
	for (const match of folded.match(EMAIL_LIKE) ?? []) {
		const candidate = match.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");
		if (candidate !== real) return null;
	}

	const points = Array.from(cleaned);
	const capped =
		points.length > MAX_DISPLAY_NAME_LENGTH
			? points.slice(0, MAX_DISPLAY_NAME_LENGTH).join("").trimEnd()
			: cleaned;
	return capped || null;
}

/**
 * `{ address: name }` for the recipients that had a usable name, or null when
 * none did (the column stays NULL rather than holding "{}").
 */
export function sanitizeAddressNames(
	entries: ReadonlyArray<{ address: string; name: string | null | undefined }>,
): Record<string, string> | null {
	const out: Record<string, string> = {};
	for (const { address, name } of entries) {
		if (!address) continue;
		const clean = sanitizeDisplayName(name, address);
		if (clean) out[address.toLowerCase()] = clean;
	}
	return Object.keys(out).length ? out : null;
}
