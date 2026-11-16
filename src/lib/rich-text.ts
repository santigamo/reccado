/**
 * The rich-text contract for mail the owner writes: which HTML a message may
 * carry, and how its plain-text alternative is derived.
 *
 * One allowlist, enforced twice: in the browser (compose, and anything pasted
 * into it, via `sanitizeComposeHtml` + DOMParser) and on the server before a
 * draft is stored (`sanitizeOwnerHtml` in html-sanitize.ts, via HTMLRewriter).
 * The server pass is the one that counts; the browser pass keeps the editor
 * honest about what will actually be sent.
 *
 * What is allowed is what the editor can produce: paragraphs, line breaks,
 * bold/italic/underline/strike, links, lists, quotes, code, headings. No images,
 * no tables, no classes, no event handlers, no external anything — nothing that
 * loads a resource when the recipient opens the mail.
 */

/** Tags kept (attributes still filtered). */
export const ALLOWED_TAGS = new Set([
	"a",
	"b",
	"blockquote",
	"br",
	"code",
	"div",
	"em",
	"h1",
	"h2",
	"h3",
	"h4",
	"hr",
	"i",
	"li",
	"ol",
	"p",
	"pre",
	"s",
	"span",
	"strike",
	"strong",
	"sub",
	"sup",
	"u",
	"ul",
]);

/** Tags dropped together with everything inside them. Anything else unknown is unwrapped. */
export const DROP_WITH_CONTENT = new Set([
	"applet",
	"audio",
	"base",
	"button",
	"canvas",
	"embed",
	"form",
	"frame",
	"frameset",
	"head",
	"iframe",
	"img",
	"input",
	"link",
	"math",
	"meta",
	"noscript",
	"object",
	"option",
	"picture",
	"script",
	"select",
	"source",
	"style",
	"svg",
	"template",
	"textarea",
	"title",
	"video",
]);

/** CSS properties kept in a `style` attribute. Layout and colour only; nothing that loads. */
const ALLOWED_STYLE_PROPS = new Set([
	"background-color",
	"border-left",
	"border-left-color",
	"border-left-style",
	"border-left-width",
	"color",
	"font-style",
	"font-weight",
	"margin",
	"margin-bottom",
	"margin-left",
	"margin-top",
	"padding",
	"padding-left",
	"text-align",
	"text-decoration",
]);

/** `style` reduced to the allowed properties with inert values, or null when nothing survives. */
export function sanitizeStyle(style: string | null | undefined): string | null {
	if (!style) return null;
	const kept: string[] = [];
	for (const decl of style.split(";")) {
		const colon = decl.indexOf(":");
		if (colon < 0) continue;
		const prop = decl.slice(0, colon).trim().toLowerCase();
		const value = decl.slice(colon + 1).trim();
		if (!ALLOWED_STYLE_PROPS.has(prop) || !value) continue;
		// Plain values only: no url(), no expression(), no var(), no escapes, no
		// at-rules or comments. Colours, lengths and keywords pass.
		if (!/^[#a-z0-9\s.,%()-]+$/i.test(value)) continue;
		if (/(url|expression|var|attr|image|element|paint)\s*\(/i.test(value)) continue;
		kept.push(`${prop}: ${value}`);
	}
	return kept.length ? kept.join("; ") : null;
}

/** http(s) and mailto links only; everything else (javascript:, data:, relative…) is dropped. */
export function safeHref(href: string | null | undefined): string | null {
	if (!href) return null;
	// Browsers ignore control characters and whitespace inside a scheme
	// ("java\tscript:"), so the check has to as well.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
	const compact = href.replace(/[\u0000- \u007F]/g, "");
	if (/^(https?:\/\/|mailto:)/i.test(compact)) return href.trim();
	return null;
}

/** Which attributes an allowed tag may keep, after value checks. */
export function allowedAttribute(tag: string, name: string): boolean {
	if (name === "style") return true;
	if (tag === "a") return name === "href" || name === "title";
	if (tag === "ol") return name === "start";
	return false;
}

const ENTITY: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	"#39": "'",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, code: string) => {
		const lower = code.toLowerCase();
		if (lower in ENTITY) return ENTITY[lower]!;
		if (lower.startsWith("#x")) {
			const n = Number.parseInt(lower.slice(2), 16);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
		}
		if (lower.startsWith("#")) {
			const n = Number.parseInt(lower.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
		}
		return whole;
	});
}

const BLOCK_TAGS = new Set([
	"address",
	"article",
	"aside",
	"div",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"p",
	"pre",
	"section",
	"table",
	"tr",
]);

/**
 * The text/plain alternative of an HTML body: paragraphs separated by a blank
 * line, list items as "- " / "1. ", quotes as "> ", links as "text <url>".
 * Pure string processing so the Worker and the browser agree on it.
 */
export function htmlToPlainText(html: string): string {
	const src = html
		.replace(/<(script|style|head|title|template)\b[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<!--[\s\S]*?-->/g, "");
	const lines: Array<{ depth: number; text: string }> = [];
	let cur = "";
	let curDepth = 0;
	let quote = 0;
	let pre = 0;
	const lists: Array<{ ordered: boolean; n: number }> = [];
	const links: Array<string | null> = [];
	let linkText = "";

	const flush = () => {
		lines.push({ depth: cur ? curDepth : quote, text: cur.replace(/[ \t]+$/, "") });
		cur = "";
	};
	const breakLine = () => {
		if (cur.trim()) flush();
		else cur = "";
	};
	const blankLine = () => {
		breakLine();
		const last = lines.at(-1);
		if (last && last.text !== "") lines.push({ depth: quote, text: "" });
	};
	const append = (text: string) => {
		if (!text) return;
		if (!cur) {
			curDepth = quote;
			if (!pre) text = text.replace(/^\s+/, "");
			if (!text) return;
		}
		// Never two spaces where markup put a break: "- " + " item" reads "- item".
		if (!pre && /\s$/.test(cur)) text = text.replace(/^\s+/, "");
		cur += text;
		if (links.length) linkText += text;
	};

	const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)|(<)/g;
	for (let m = token.exec(src); m; m = token.exec(src)) {
		if (m[4] !== undefined || m[5] !== undefined) {
			const raw = decodeEntities(m[4] ?? "<");
			if (pre) {
				const parts = raw.split("\n");
				parts.forEach((part, i) => {
					if (i > 0) flush();
					append(part);
				});
			} else {
				append(raw.replace(/\s+/g, " "));
			}
			continue;
		}
		const closing = m[1] === "/";
		const tag = m[2]!.toLowerCase();
		const attrs = m[3] ?? "";
		if (tag === "br") {
			flush();
			continue;
		}
		if (tag === "blockquote") {
			blankLine();
			quote = closing ? Math.max(0, quote - 1) : quote + 1;
			continue;
		}
		if (tag === "ul" || tag === "ol") {
			breakLine();
			if (closing) lists.pop();
			else {
				const start = /\bstart\s*=\s*["']?(\d+)/i.exec(attrs);
				lists.push({ ordered: tag === "ol", n: start ? Number(start[1]) - 1 : 0 });
			}
			if (closing && lists.length === 0) blankLine();
			continue;
		}
		if (tag === "li") {
			breakLine();
			if (!closing) {
				const list = lists.at(-1);
				const indent = "  ".repeat(Math.max(0, lists.length - 1));
				let marker = "- ";
				if (list?.ordered) {
					list.n += 1;
					marker = `${list.n}. `;
				}
				// Written directly: append() would trim the indent of a nested item.
				curDepth = quote;
				cur = `${indent}${marker}`;
			}
			continue;
		}
		if (tag === "pre") {
			blankLine();
			pre = closing ? Math.max(0, pre - 1) : pre + 1;
			continue;
		}
		if (tag === "a") {
			if (closing) {
				const href = links.pop() ?? null;
				const text = linkText.trim();
				linkText = "";
				if (href && !/^mailto:/i.test(href) && text && text !== href && !text.includes(href)) {
					append(` <${href}>`);
				}
			} else {
				const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
				const value = href ? decodeEntities(href[2] ?? href[3] ?? href[4] ?? "") : null;
				links.push(safeHref(value));
				linkText = "";
			}
			continue;
		}
		if (tag === "p" || /^h[1-6]$/.test(tag)) {
			blankLine();
			continue;
		}
		if (tag === "hr") {
			breakLine();
			append("---");
			flush();
			continue;
		}
		if (BLOCK_TAGS.has(tag)) {
			breakLine();
		}
	}
	breakLine();

	// An empty quoted line that closes a quote (the gap a quoted paragraph leaves
	// before </blockquote>) is noise: drop it.
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const next = lines[i + 1];
		if (
			line.depth > 0 &&
			line.text === "" &&
			(!next || next.depth < line.depth || next.text === "")
		) {
			lines.splice(i, 1);
		}
	}
	const out: string[] = [];
	for (const line of lines) {
		const prefix =
			line.depth > 0 ? (line.text ? "> ".repeat(line.depth) : ">".repeat(line.depth)) : "";
		out.push(prefix + line.text);
	}
	return out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** Plain text (an older draft, a text-only reply) as editor HTML: one <div> per line. */
export function plainTextToEditorHtml(text: string): string {
	if (!text) return "";
	return text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => (line ? `<div>${escapeHtml(line)}</div>` : "<div><br></div>"))
		.join("");
}

/** Text with URLs and addresses found, for safe linkifying: never HTML, always segments. */
export type LinkSegment = { text: string; href?: string };

const LINK_PATTERN =
	/\b(https?:\/\/[^\s<>"'()]+(?:\([^\s<>"'()]*\)[^\s<>"'()]*)*|www\.[^\s<>"'()]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi;

/** Split plain text into text and link segments. Trailing punctuation stays text. */
export function linkifySegments(text: string): LinkSegment[] {
	const out: LinkSegment[] = [];
	let last = 0;
	for (const m of text.matchAll(LINK_PATTERN)) {
		let match = m[0];
		const index = m.index ?? 0;
		const trailing = /[.,;:!?)\]]+$/.exec(match)?.[0] ?? "";
		// Keep a closing paren that closes one opened inside the URL.
		let cut = trailing;
		if (cut.startsWith(")") || cut.includes(")")) {
			const opens = (match.match(/\(/g) ?? []).length;
			const closes = (match.match(/\)/g) ?? []).length;
			if (opens >= closes) cut = cut.replace(/^\)+/, "");
		}
		if (cut) match = match.slice(0, match.length - cut.length);
		if (index > last) out.push({ text: text.slice(last, index) });
		const href =
			match.includes("@") && !/^https?:|^www\./i.test(match)
				? `mailto:${match}`
				: /^www\./i.test(match)
					? `https://${match}`
					: match;
		out.push({ text: match, href });
		last = index + match.length;
	}
	if (last < text.length) out.push({ text: text.slice(last) });
	return out;
}
