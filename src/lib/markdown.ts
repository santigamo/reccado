/**
 * Markdown for mail an agent writes (MCP `save_draft` → `bodyMarkdown`).
 *
 * One parse, two renderings: the same tree becomes the HTML part and the
 * text/plain part, so the two halves of the multipart/alternative can never say
 * different things. Deliberately small — the subset an agent needs to write a
 * readable email, nothing that loads or runs:
 *
 *  - paragraphs; a single newline inside a paragraph is a line break (mail is
 *    written that way: "Thanks,\nSanti");
 *  - **bold** / __bold__, *italic* / _italic_ (never inside a word, so
 *    snake_case stays as written), `inline code`, fenced code blocks;
 *  - [links](https://…), <https://…> and bare http(s) URLs — http, https and
 *    mailto only; any other target (javascript:, data:, relative…) is not a
 *    link and the source is shown as plain text, so nothing is hidden;
 *  - `-` / `*` / `+` and `1.` lists, nested by indentation;
 *  - `#` headings (rendered as a bold line, not a large title), `>` quotes,
 *    `---` rules, and backslash escapes.
 *
 * Raw HTML is never passed through: every `<` reaches the HTML as `&lt;`.
 * The HTML still goes through the owner sanitiser (lib/html-sanitize.ts)
 * before it is stored; this module only ever emits tags from that allowlist.
 */
import { linkifySegments, safeHref } from "./rich-text";

type Inline =
	| { t: "text"; v: string }
	| { t: "code"; v: string }
	| { t: "strong"; c: Inline[] }
	| { t: "em"; c: Inline[] }
	| { t: "link"; href: string; c: Inline[] };

type Block =
	| { t: "p"; lines: Inline[][] }
	| { t: "h"; c: Inline[] }
	| { t: "hr" }
	| { t: "code"; v: string }
	| { t: "quote"; c: Block[] }
	| { t: "list"; ordered: boolean; start: number; items: Block[][] };

/** Nesting cap for quotes/lists and for emphasis: deeper input is kept as text. */
const MAX_BLOCK_DEPTH = 6;
const MAX_INLINE_DEPTH = 8;

// ─── Block structure ─────────────────────────────────────────────────────────

const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;

function isBlank(line: string): boolean {
	return !line.trim();
}

/** Width of leading whitespace, tabs counting as 4. */
function indentOf(line: string): number {
	let width = 0;
	for (const ch of line) {
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4 - (width % 4);
		else break;
	}
	return width;
}

/** `line` with up to `n` columns of leading whitespace removed. */
function dedent(line: string, n: number): string {
	let width = 0;
	let i = 0;
	while (i < line.length && width < n) {
		const ch = line[i];
		if (ch === " ") width += 1;
		else if (ch === "\t") width += 4 - (width % 4);
		else break;
		i += 1;
	}
	return line.slice(i);
}

type ItemMarker = { ordered: boolean; number: number; bullet: string; contentIndent: number };

function itemMarker(line: string): ItemMarker | null {
	const m = ITEM.exec(line);
	if (!m) return null;
	const marker = m[2]!;
	const ordered = /\d/.test(marker);
	const gap = m[4] ? (m[3] ?? " ").length : 1;
	return {
		ordered,
		number: ordered ? Number.parseInt(marker, 10) : 0,
		bullet: ordered ? marker.slice(-1) : marker,
		// Content starts after the marker and its spaces (more than 4 is code-ish: count one).
		contentIndent: m[1]!.length + marker.length + (gap > 4 ? 1 : gap),
	};
}

/** Whether `line` starts a block other than a paragraph (so it ends one). */
function startsBlock(line: string): boolean {
	if (FENCE.test(line) || HR.test(line) || HEADING.test(line) || QUOTE.test(line)) return true;
	const item = itemMarker(line);
	// An ordered item interrupts a paragraph only from 1, so "2024. was a year"
	// mid-paragraph stays text.
	return Boolean(item && (!item.ordered || item.number === 1) && ITEM.exec(line)?.[4]);
}

function parseBlocks(lines: string[], depth: number): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (isBlank(line)) {
			i += 1;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const mark = fence[1]!;
			const indent = indentOf(line);
			const body: string[] = [];
			i += 1;
			while (i < lines.length) {
				const close = lines[i]!.trim();
				if (close.startsWith(mark[0]!.repeat(mark.length)) && /^(`+|~+)$/.test(close)) {
					i += 1;
					break;
				}
				body.push(dedent(lines[i]!, indent));
				i += 1;
			}
			blocks.push({ t: "code", v: body.join("\n") });
			continue;
		}
		if (HR.test(line)) {
			blocks.push({ t: "hr" });
			i += 1;
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ t: "h", c: parseInline(heading[2] ?? "", 0) });
			i += 1;
			continue;
		}
		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length) {
				const m = QUOTE.exec(lines[i]!);
				if (!m) break;
				inner.push(m[1]!);
				i += 1;
			}
			blocks.push(
				depth < MAX_BLOCK_DEPTH
					? { t: "quote", c: parseBlocks(inner, depth + 1) }
					: { t: "p", lines: inner.filter((l) => !isBlank(l)).map((l) => parseInline(l, 0)) },
			);
			continue;
		}
		const first = itemMarker(line);
		if (first && depth < MAX_BLOCK_DEPTH) {
			const items: Block[][] = [];
			let raw: string[] | null = null;
			let indent = first.contentIndent;
			const flush = () => {
				if (raw) items.push(parseBlocks(raw, depth + 1));
			};
			while (i < lines.length) {
				const current = lines[i]!;
				const marker = itemMarker(current);
				if (
					marker &&
					marker.ordered === first.ordered &&
					marker.bullet === first.bullet &&
					indentOf(current) < first.contentIndent
				) {
					flush();
					raw = [ITEM.exec(current)?.[4] ?? ""];
					indent = marker.contentIndent;
					i += 1;
					continue;
				}
				if (isBlank(current)) {
					// A blank line continues the list only if more of it follows.
					let next = i + 1;
					while (next < lines.length && isBlank(lines[next]!)) next += 1;
					const following = lines[next];
					if (following === undefined) break;
					const followingMarker = itemMarker(following);
					const continues =
						indentOf(following) >= Math.min(indent, 2) ||
						(followingMarker &&
							followingMarker.ordered === first.ordered &&
							followingMarker.bullet === first.bullet);
					if (!continues) break;
					raw?.push("");
					i += 1;
					continue;
				}
				if (indentOf(current) >= Math.min(indent, 2)) {
					raw?.push(dedent(current, indent));
					i += 1;
					continue;
				}
				// Lazy continuation of the item's paragraph.
				if (raw && !startsBlock(current) && raw.length && !isBlank(raw[raw.length - 1]!)) {
					raw.push(current.trim());
					i += 1;
					continue;
				}
				break;
			}
			flush();
			blocks.push({ t: "list", ordered: first.ordered, start: first.number || 1, items });
			continue;
		}
		const para: string[] = [];
		while (
			i < lines.length &&
			!isBlank(lines[i]!) &&
			(para.length === 0 || !startsBlock(lines[i]!))
		) {
			para.push(lines[i]!);
			i += 1;
		}
		blocks.push({
			t: "p",
			lines: para.map((l) => parseInline(l.trim().replace(/\\$/, "").trimEnd(), 0)),
		});
	}
	return blocks;
}

// ─── Inline ──────────────────────────────────────────────────────────────────

const MAX_LABEL = 1000;
const MAX_TARGET = 2048;
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const AUTOLINK = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i;
const BARE_URL = /^https?:\/\/[^\s<>"']+/i;

function isWordChar(ch: string | undefined): boolean {
	return Boolean(ch && /[\p{L}\p{N}]/u.test(ch));
}

/** Web and mail targets only. */
function linkTarget(raw: string): string | null {
	const href = safeHref(raw);
	return href && /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(href) ? href : null;
}

/** Index of the backtick run of exactly `n` closing a code span opened before `from`. */
function findBackticks(s: string, from: number, n: number): number {
	let i = from;
	while (i < s.length) {
		const at = s.indexOf("`", i);
		if (at < 0) return -1;
		let end = at;
		while (s[end] === "`") end += 1;
		if (end - at === n) return at;
		i = end;
	}
	return -1;
}

/**
 * Where the emphasis opened at `from` with `delim` ("*", "_", "**" or "__")
 * closes, skipping escapes and the other emphasis width. One linear scan: code
 * spans are not skipped here (a closer inside one is an edge case not worth a
 * quadratic search).
 */
function findCloser(s: string, from: number, delim: string): number {
	const ch = delim[0]!;
	const double = delim.length === 2;
	let i = from;
	while (i < s.length) {
		const c = s[i]!;
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c !== ch) {
			i += 1;
			continue;
		}
		let run = 0;
		while (s[i + run] === ch) run += 1;
		const before = s[i - 1];
		const after = s[i + run];
		const canClose =
			before !== undefined && !/\s/.test(before) && (ch === "*" || !isWordChar(after)) && i > from;
		if (canClose) {
			if (double && run >= 2) return i + run - 2;
			if (!double && run === 1) return i;
			if (!double && run === 3) return i + 2;
		}
		i += run;
	}
	return -1;
}

/** `[label](target)` starting at `i`: the label, the raw target and where it ends. */
function parseLink(s: string, i: number): { label: string; target: string; end: number } | null {
	let depth = 0;
	let j = i;
	// Bounded, so a line of unmatched "[" stays linear.
	const limit = Math.min(s.length, i + MAX_LABEL);
	for (; j < limit; j += 1) {
		const c = s[j];
		if (c === "\\") {
			j += 1;
			continue;
		}
		if (c === "[") depth += 1;
		else if (c === "]") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	if (j >= limit || s[j + 1] !== "(") return null;
	// The target ends at the ")" that balances its "(": wiki-style URLs keep theirs.
	let close = -1;
	let parens = 0;
	const end = Math.min(s.length, j + 2 + MAX_TARGET);
	for (let k = j + 2; k < end; k += 1) {
		if (s[k] === "(") parens += 1;
		else if (s[k] === ")") {
			if (parens === 0) {
				close = k;
				break;
			}
			parens -= 1;
		}
	}
	if (close < 0) return null;
	let target = s.slice(j + 2, close).trim();
	// An optional "title" is accepted and dropped.
	target = target.replace(/\s+(?:"[^"]*"|'[^']*')$/, "");
	if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
	if (/\s/.test(target)) return null;
	return { label: s.slice(i + 1, j), target, end: close + 1 };
}

function pushText(out: Inline[], v: string): void {
	const last = out[out.length - 1];
	if (last?.t === "text") last.v += v;
	else if (v) out.push({ t: "text", v });
}

function parseInline(s: string, depth: number): Inline[] {
	const out: Inline[] = [];
	// Delimiters already known to have no closer further on: an unmatched "**" is
	// not searched for again, which keeps hostile input linear.
	const noCloser = new Set<string>();
	// Same for a backtick run of a given length with no matching run after it.
	const noBackticks = new Set<number>();
	let i = 0;
	while (i < s.length) {
		const c = s[i]!;
		if (c === "\\" && i + 1 < s.length && ESCAPABLE.test(s[i + 1]!)) {
			pushText(out, s[i + 1]!);
			i += 2;
			continue;
		}
		if (c === "`") {
			let n = 0;
			while (s[i + n] === "`") n += 1;
			const close = noBackticks.has(n) ? -1 : findBackticks(s, i + n, n);
			if (close < 0) {
				noBackticks.add(n);
				pushText(out, "`".repeat(n));
				i += n;
				continue;
			}
			let code = s.slice(i + n, close);
			if (/^ .*[^ ].* $/.test(code)) code = code.slice(1, -1);
			out.push({ t: "code", v: code });
			i = close + n;
			continue;
		}
		if (c === "[" && depth < MAX_INLINE_DEPTH) {
			const link = parseLink(s, i);
			if (link) {
				const href = linkTarget(link.target);
				const source = s.slice(i, link.end);
				if (href && link.label.trim()) {
					// No link inside a link: the label's own links stay text.
					const label = parseInline(link.label, depth + 1).flatMap((node) =>
						node.t === "link" ? node.c : [node],
					);
					out.push({ t: "link", href, c: label });
				} else {
					// Not a target we link to: show exactly what was written.
					pushText(out, source);
				}
				i = link.end;
				continue;
			}
		}
		if (c === "<") {
			const auto = AUTOLINK.exec(s.slice(i, i + 2048));
			const href = auto ? linkTarget(auto[1]!) : null;
			if (auto && href) {
				out.push({ t: "link", href, c: [{ t: "text", v: auto[1]!.replace(/^mailto:/i, "") }] });
				i += auto[0].length;
				continue;
			}
			pushText(out, "<");
			i += 1;
			continue;
		}
		if ((c === "h" || c === "H") && !isWordChar(s[i - 1])) {
			const bare = BARE_URL.exec(s.slice(i, i + 2048));
			if (bare) {
				// Same trailing-punctuation rule as the inbox's own linkifier.
				const url = linkifySegments(bare[0])[0]?.text ?? bare[0];
				const href = linkTarget(url);
				if (href) {
					out.push({ t: "link", href, c: [{ t: "text", v: url }] });
					i += url.length;
					continue;
				}
			}
		}
		if ((c === "*" || c === "_") && depth < MAX_INLINE_DEPTH) {
			let run = 0;
			while (s[i + run] === c) run += 1;
			const after = s[i + run];
			const opens =
				after !== undefined && !/\s/.test(after) && (c === "*" || !isWordChar(s[i - 1]));
			if (opens && run <= 3) {
				const delim = run >= 2 ? c + c : c;
				const close = noCloser.has(delim) ? -1 : findCloser(s, i + delim.length, delim);
				if (close < 0) {
					noCloser.add(delim);
				} else {
					const inner = s.slice(i + delim.length, close);
					const children = parseInline(inner, depth + 1);
					out.push(delim.length === 2 ? { t: "strong", c: children } : { t: "em", c: children });
					i = close + delim.length;
					continue;
				}
			}
			pushText(out, c.repeat(run));
			i += run;
			continue;
		}
		pushText(out, c);
		i += 1;
	}
	return out;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function nodeHtml(node: Inline): string {
	switch (node.t) {
		case "text":
			return escapeHtml(node.v);
		case "code":
			return `<code>${escapeHtml(node.v)}</code>`;
		case "strong":
			return `<strong>${inlineHtml(node.c)}</strong>`;
		case "em":
			return `<em>${inlineHtml(node.c)}</em>`;
		case "link":
			return `<a href="${escapeHtml(node.href)}">${inlineHtml(node.c)}</a>`;
	}
}

function inlineHtml(nodes: Inline[]): string {
	return nodes.map(nodeHtml).join("");
}

const QUOTE_STYLE = "margin: 0 0 0 0.8ex; border-left: 2px solid #cccccc; padding-left: 1ex";
const PRE_STYLE = "background-color: #f5f5f5; padding: 8px";

function itemHtml(item: Block[]): string {
	// A one-paragraph item stays tight (no <p> margins), like most mail.
	const single = item[0]?.t === "p";
	const head = single ? blockHtml(item[0]!, true) : "";
	const rest = blocksHtml(single ? item.slice(1) : item);
	return `<li>${head}${rest}</li>`;
}

function blockHtml(block: Block, tight = false): string {
	switch (block.t) {
		case "p": {
			const body = block.lines.map(inlineHtml).join("<br>\n");
			return tight ? body : `<p>${body}</p>`;
		}
		case "h":
			return `<p><strong>${inlineHtml(block.c)}</strong></p>`;
		case "hr":
			return "<hr>";
		case "code":
			return `<pre style="${PRE_STYLE}"><code>${escapeHtml(block.v)}</code></pre>`;
		case "quote":
			return `<blockquote style="${QUOTE_STYLE}">${blocksHtml(block.c)}</blockquote>`;
		case "list": {
			const tag = block.ordered ? "ol" : "ul";
			const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
			return `<${tag}${start}>\n${block.items.map(itemHtml).join("\n")}\n</${tag}>`;
		}
	}
}

function blocksHtml(blocks: Block[]): string {
	return blocks.map((block) => blockHtml(block)).join("\n");
}

function nodeText(node: Inline): string {
	switch (node.t) {
		case "text":
		case "code":
			return node.v;
		case "strong":
		case "em":
			return inlineText(node.c);
		case "link": {
			const label = inlineText(node.c);
			const shown = node.href.replace(/^mailto:/i, "");
			return label.trim() === shown || label.trim() === node.href ? label : `${label} (${shown})`;
		}
	}
}

function inlineText(nodes: Inline[]): string {
	return nodes.map(nodeText).join("");
}

function blocksText(blocks: Block[]): string[] {
	const out: string[] = [];
	for (const block of blocks) {
		if (out.length) out.push("");
		switch (block.t) {
			case "p":
				out.push(...block.lines.map(inlineText));
				break;
			case "h":
				out.push(inlineText(block.c));
				break;
			case "hr":
				out.push("---");
				break;
			case "code":
				out.push(...block.v.split("\n"));
				break;
			case "quote":
				out.push(...blocksText(block.c).map((line) => (line ? `> ${line}` : ">")));
				break;
			case "list": {
				// Items sit on consecutive lines; their own blocks follow indented.
				block.items.forEach((item, n) => {
					const marker = block.ordered ? `${block.start + n}. ` : "- ";
					const pad = " ".repeat(marker.length);
					const lines = blocksText(item);
					// Drop the blank line blocksText puts between a tight item's paragraph and its sublist.
					const compact = lines.filter(
						(line, k) => line !== "" || !(lines[k + 1] ?? "").match(/^(\s*)(- |\d+\. )/),
					);
					compact.forEach((line, k) => {
						out.push(k === 0 ? `${marker}${line}` : line ? `${pad}${line}` : "");
					});
					if (!compact.length) out.push(marker.trimEnd());
				});
				break;
			}
		}
	}
	return out;
}

export type RenderedMarkdown = { html: string; text: string };

/**
 * Markdown to the two parts of a mail. `html` is a fragment built only from
 * tags in the rich-text allowlist (it is still run through the owner sanitiser
 * before being stored); `text` is its readable plain-text twin.
 */
export function renderMarkdown(markdown: string): RenderedMarkdown {
	const lines = markdown.replace(/\r\n?/g, "\n").replaceAll("\0", "�").split("\n");
	const blocks = parseBlocks(lines, 0);
	const text = blocksText(blocks)
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+|\n+$/g, "");
	return { html: blocksHtml(blocks), text };
}
