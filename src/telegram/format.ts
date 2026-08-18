import { escapeHtml } from "../lib/email-headers";
import type { TelegramEntity } from "./api";
import { TELEGRAM_MAX_MESSAGE_CHARS } from "./api";

// --- Telegram -> email -----------------------------------------------------

/**
 * Telegram entity offsets are UTF-16 code units, which is exactly what a JS
 * string index is — so plain `slice()` is correct here and iterating code points
 * (`[...text]`, `Array.from`) would silently shift every offset after the first
 * emoji or other non-BMP character. Do not "fix" the slicing below.
 */

type EntityNode = {
	entity: TelegramEntity;
	children: EntityNode[];
};

function buildEntityTree(entities: TelegramEntity[]): EntityNode[] {
	const sorted = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
	const roots: EntityNode[] = [];
	const stack: EntityNode[] = [];
	for (const entity of sorted) {
		const end = entity.offset + entity.length;
		while (stack.length > 0) {
			const top = stack[stack.length - 1]!;
			if (top.entity.offset + top.entity.length <= entity.offset) {
				stack.pop();
			} else {
				break;
			}
		}
		const node: EntityNode = { entity, children: [] };
		const parent = stack[stack.length - 1];
		if (parent && end <= parent.entity.offset + parent.entity.length) {
			parent.children.push(node);
		} else {
			// Partially overlapping entities aren't representable as nested markup.
			// Telegram doesn't emit them; if one shows up, treat it as top level.
			stack.length = 0;
			roots.push(node);
		}
		stack.push(node);
	}
	return roots;
}

/** Only web and mail schemes survive into outgoing mail. */
function safeHref(url: string): string | null {
	const trimmed = url.trim();
	return /^(https?:|mailto:)/i.test(trimmed) ? trimmed : null;
}

function wrapEntity(entity: TelegramEntity, inner: string, rawText: string): string {
	switch (entity.type) {
		case "bold":
			return `<strong>${inner}</strong>`;
		case "italic":
			return `<em>${inner}</em>`;
		case "underline":
			return `<u>${inner}</u>`;
		case "strikethrough":
			return `<s>${inner}</s>`;
		case "code":
			return `<code>${inner}</code>`;
		case "pre":
			return `<pre><code>${inner}</code></pre>`;
		case "blockquote":
		case "expandable_blockquote":
			return `<blockquote>${inner}</blockquote>`;
		case "text_link": {
			const href = entity.url ? safeHref(entity.url) : null;
			return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
		}
		case "url": {
			const href = safeHref(rawText);
			return href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner;
		}
		case "email":
			return `<a href="mailto:${escapeHtml(rawText.trim())}">${inner}</a>`;
		default:
			// spoiler, mention, hashtag, custom_emoji… have no email equivalent;
			// their text still goes through, just unstyled.
			return inner;
	}
}

function renderRange(text: string, nodes: EntityNode[], start: number, end: number): string {
	let out = "";
	let cursor = start;
	for (const node of nodes) {
		const nodeStart = node.entity.offset;
		const nodeEnd = nodeStart + node.entity.length;
		if (nodeStart > cursor) {
			out += escapeHtml(text.slice(cursor, nodeStart));
		}
		const inner = renderRange(text, node.children, nodeStart, nodeEnd);
		out += wrapEntity(node.entity, inner, text.slice(nodeStart, nodeEnd));
		cursor = nodeEnd;
	}
	if (cursor < end) {
		out += escapeHtml(text.slice(cursor, end));
	}
	return out;
}

/** A Telegram message body as email-ready HTML paragraphs. */
export function entitiesToHtml(text: string, entities: TelegramEntity[] | undefined): string {
	const rendered = renderRange(text, buildEntityTree(entities ?? []), 0, text.length);
	return rendered
		.split(/\n{2,}/)
		.map((block) => `<p>${block.replace(/\n/g, "<br>")}</p>`)
		.join("\n");
}

// --- email -> Telegram -----------------------------------------------------

/** Telegram's HTML parse mode needs the same three characters escaped. */
export function telegramEscape(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape first, then clip — in that order.
 *
 * Escaping expands: one `&` becomes five characters. Clipping the raw text and
 * escaping afterwards bounds the wrong string, so a subject full of `&` can still
 * blow past Telegram's 4096-character limit and get the whole message rejected.
 * The trailing-entity trim exists for the same reason: a message cut mid-`&amp;`
 * is invalid HTML and Telegram refuses it outright.
 */
function escapeAndClip(value: string, max: number): string {
	const escaped = telegramEscape(value.trim());
	if (escaped.length <= max) {
		return escaped;
	}
	const cut = escaped.slice(0, Math.max(0, max - 1)).replace(/&[a-z]*$/i, "");
	return `${cut}…`;
}

/**
 * Last line of defense. If the assembled card is somehow still over the limit,
 * send a short plain alternative rather than let Telegram reject it: a lost
 * notification is worse than a terse one.
 */
function withinLimit(text: string, fallback: string): string {
	return text.length <= TELEGRAM_MAX_MESSAGE_CHARS ? text : fallback;
}

export type InboundNotification = {
	fromAddr: string;
	mailboxAddress: string;
	subject: string | null;
	snippet: string | null;
	hasAttachments: boolean;
};

const SUBJECT_LIMIT = 200;
const SNIPPET_LIMIT = 700;
const ADDRESS_LIMIT = 120;
const BODY_PREVIEW_LIMIT = 1500;

/**
 * The new-mail card.
 *
 * Deliberately a preview, not the mail: sender, subject and snippet. Full bodies
 * would put whatever arrives — password resets, 2FA codes — into a cloud chat
 * that is not end-to-end encrypted. Reading the whole message stays an explicit
 * act in Reccado itself.
 */
export function renderInboundNotification(input: InboundNotification): string {
	const from = escapeAndClip(input.fromAddr, ADDRESS_LIMIT);
	const header = `📬 <b>${escapeAndClip(input.subject ?? "(sin asunto)", SUBJECT_LIMIT)}</b>`;
	const addresses = `<i>${from}</i> → ${escapeAndClip(input.mailboxAddress, ADDRESS_LIMIT)}`;
	const attachments = input.hasAttachments ? "\n📎 con adjuntos" : "";
	const footer = "\n\n<i>Responde a este mensaje para contestar por email.</i>";

	const fixedLength = header.length + addresses.length + attachments.length + footer.length + 4;
	const budget = Math.max(0, Math.min(SNIPPET_LIMIT, TELEGRAM_MAX_MESSAGE_CHARS - fixedLength));
	const snippet = input.snippet?.trim() ? `\n\n${escapeAndClip(input.snippet, budget)}` : "";

	return withinLimit(
		`${header}\n${addresses}${attachments}${snippet}${footer}`,
		`📬 Nuevo correo de <i>${from}</i>`,
	);
}

/** The confirmation card shown before anything is actually sent. */
export function renderDraftPreview(input: {
	to: string[];
	subject: string;
	bodyText: string;
}): string {
	const to = escapeAndClip(input.to.join(", "), ADDRESS_LIMIT * 4);
	const subject = escapeAndClip(input.subject, SUBJECT_LIMIT);
	const body = escapeAndClip(input.bodyText, BODY_PREVIEW_LIMIT);
	return withinLimit(
		["✉️ <b>Borrador listo</b>", `<b>Para:</b> ${to}`, `<b>Asunto:</b> ${subject}`, "", body].join(
			"\n",
		),
		`✉️ <b>Borrador listo</b>\n<b>Para:</b> ${to}`,
	);
}
