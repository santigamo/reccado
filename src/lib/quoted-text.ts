/**
 * The quoted tail of a plain-text reply ("On Mon, 16 Nov 2026, Rico wrote:"
 * followed by "> " lines), split off so a reader can collapse it behind "…"
 * the way Gmail does, and so a list snippet previews the reply, not the quote.
 *
 * Only a *trailing* quote is split: interleaved replies ("> question" / answer /
 * "> question" / answer) are the message itself and stay whole.
 *
 * Pure: shared by the mailbox Durable Object and the browser.
 */

// Attribution lines in the languages Reccado's users actually receive.
const ATTRIBUTION = /(wrote|escribió|escribio|a écrit|schrieb|ha scritto|escreveu)\s*:\s*$/i;

export type SplitText = {
	/** What the sender wrote. */
	body: string;
	/** The trailing quote including its attribution line, or null when there is none. */
	quoted: string | null;
};

export function splitQuotedText(text: string): SplitText {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let start = lines.length;
	let sawQuote = false;
	while (start > 0) {
		const line = lines[start - 1]!;
		if (line.trim() === "") {
			start--;
			continue;
		}
		if (/^\s*>/.test(line)) {
			sawQuote = true;
			start--;
			continue;
		}
		break;
	}
	if (!sawQuote) return { body: text, quoted: null };
	// The attribution sits right above the quote, sometimes wrapped over two lines
	// ("On Mon, 16 Nov 2026 at 10:00, Rico <rico@x.org>" / "wrote:").
	if (start > 0 && ATTRIBUTION.test(lines[start - 1]!)) {
		start--;
		// A bare "wrote:" line is the wrapped end of the line above it.
		if (start > 0 && /^\s*\S+\s*:\s*$/.test(lines[start]!) && lines[start - 1]!.trim()) start--;
	}
	const body = lines.slice(0, start).join("\n").replace(/\s+$/, "");
	// A message that is nothing but a quote has nothing to collapse to.
	if (!body.trim()) return { body: text, quoted: null };
	return { body, quoted: lines.slice(start).join("\n").replace(/^\n+/, "") };
}

/** `text` without its trailing quote. */
export function stripQuotedText(text: string): string {
	return splitQuotedText(text).body;
}
