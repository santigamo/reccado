/**
 * Browser half of the rich-text contract (the server half is
 * lib/html-sanitize.ts): the same allowlist, applied with DOMParser so pasted
 * markup and quoted mail are cleaned before they ever reach the editor, plus the
 * reply/forward quote blocks Gmail users expect.
 *
 * DOMParser documents are inert — no scripts run, no images load, no handlers
 * fire — so parsing hostile HTML here is safe; only the rebuilt, allowlisted
 * nodes are serialised back out.
 */
import { displayName, extractEmail, type Message, parseAddressList } from "#/lib/mail";
import {
	ALLOWED_TAGS,
	allowedAttribute,
	DROP_WITH_CONTENT,
	plainTextToEditorHtml,
	safeHref,
	sanitizeStyle,
} from "#/lib/rich-text";

function cleanInto(source: Node, target: Node, doc: Document): void {
	for (const child of Array.from(source.childNodes)) {
		if (child.nodeType === Node.TEXT_NODE) {
			target.appendChild(doc.createTextNode(child.textContent ?? ""));
			continue;
		}
		if (child.nodeType !== Node.ELEMENT_NODE) continue;
		const el = child as Element;
		const tag = el.tagName.toLowerCase();
		if (DROP_WITH_CONTENT.has(tag)) continue;
		if (!ALLOWED_TAGS.has(tag)) {
			// Unwrap, but keep block structure readable: a table cell or row becomes a line.
			if (tag === "tr" || tag === "table" || tag === "section" || tag === "article") {
				const block = doc.createElement("div");
				cleanInto(el, block, doc);
				target.appendChild(block);
			} else {
				cleanInto(el, target, doc);
				if (tag === "td" || tag === "th") target.appendChild(doc.createTextNode(" "));
			}
			continue;
		}
		const out = doc.createElement(tag);
		for (const attr of Array.from(el.attributes)) {
			const name = attr.name.toLowerCase();
			if (!allowedAttribute(tag, name)) continue;
			if (name === "style") {
				const style = sanitizeStyle(attr.value);
				if (style) out.setAttribute("style", style);
			} else if (name === "href") {
				const href = safeHref(attr.value);
				if (href) out.setAttribute("href", href);
			} else if (name === "start" && /^\d{1,6}$/.test(attr.value)) {
				out.setAttribute("start", attr.value);
			}
		}
		cleanInto(el, out, doc);
		target.appendChild(out);
	}
}

/** `html` reduced to the compose allowlist. Browser only. */
export function sanitizeComposeHtml(html: string): string {
	if (!html) return "";
	const parsed = new DOMParser().parseFromString(html, "text/html");
	const out = document.implementation.createHTMLDocument("");
	const root = out.createElement("div");
	cleanInto(parsed.body, root, out);
	return root.innerHTML;
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function whenOf(message: Message): string {
	const raw = message.date_header ?? message.received_at;
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) return raw;
	return d.toLocaleString("en-US", {
		weekday: "short",
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function personOf(message: Message): string {
	const address = extractEmail(message.from_addr);
	const name = displayName(message.from_addr, message.from_name);
	return name && name !== address ? `${name} <${address}>` : address;
}

const QUOTE_STYLE = "margin: 0 0 0 0.8ex; border-left: 1px solid #cccccc; padding-left: 1ex";

/** The original as editor HTML: its sanitised HTML when it has one, else its text. */
export function originalBodyHtml(message: Message, html: string | null): string {
	const clean = html ? sanitizeComposeHtml(html) : "";
	if (clean.replace(/<[^>]*>/g, "").trim()) return clean;
	return plainTextToEditorHtml(message.body_text ?? message.snippet ?? "");
}

/**
 * The editor's starting content for a reply: room to write on top, then the
 * attribution line and the original in a quote (Gmail's layout). The plain-text
 * alternative turns the quote into "> " lines.
 */
export function replyQuoteHtml(message: Message, html: string | null): string {
	const attribution = `On ${whenOf(message)}, ${personOf(message)} wrote:`;
	return [
		"<div><br></div><div><br></div>",
		`<div>${escapeHtml(attribution)}</div>`,
		`<blockquote style="${QUOTE_STYLE}">${originalBodyHtml(message, html)}</blockquote>`,
	].join("");
}

/** The editor's starting content for a forward: the original headers block, then the body. */
export function forwardQuoteHtml(message: Message, html: string | null): string {
	const to = parseAddressList(message.to_json).join(", ");
	const cc = parseAddressList(message.cc_json).join(", ");
	const lines = [
		"---------- Forwarded message ---------",
		`From: ${personOf(message)}`,
		`Date: ${whenOf(message)}`,
		`Subject: ${message.subject ?? "(no subject)"}`,
		...(to ? [`To: ${to}`] : []),
		...(cc ? [`Cc: ${cc}`] : []),
	];
	return [
		"<div><br></div><div><br></div>",
		`<div>${lines.map(escapeHtml).join("<br>")}</div><div><br></div>`,
		originalBodyHtml(message, html),
	].join("");
}
