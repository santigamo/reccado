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

/**
 * What has happened to the email since the card announced it.
 *
 * A card with no status is a card about mail nobody has touched yet, which is
 * exactly what "new" means. Everything else is a fact the operator already
 * established on some surface, and a card that keeps claiming "pending" after it
 * is a card that lies.
 */
export const CARD_STATUS_LABELS = {
	archived: "archivado",
	read: "leído",
	unread: "sin leer",
	trashed: "en la papelera",
	inbox: "de vuelta en la bandeja",
	replied: "respondido",
} as const;

export type TelegramCardStatus = keyof typeof CARD_STATUS_LABELS;

/** What the card can say about one attachment: enough to decide whether to fetch it. */
export type CardAttachment = {
	filename: string | null;
	size: number;
};

export type InboundNotification = {
	fromAddr: string;
	mailboxAddress: string;
	subject: string | null;
	snippet: string | null;
	hasAttachments: boolean;
	/**
	 * Names and sizes when they could be read from the mailbox, absent when they
	 * could not. The boolean above stays the fallback rather than being replaced by
	 * this: a Durable Object that did not answer must still produce a card saying
	 * the email has attachments.
	 */
	attachments?: CardAttachment[];
	/**
	 * True when nobody at this deployment has ever heard from this sender. Cheap to
	 * compute and disproportionately useful on an address that receives cold mail:
	 * it separates "a stranger" from "the thread you are already in".
	 */
	firstContact?: boolean;
	/** Absent on the first render; set when the card is restated after an action. */
	status?: TelegramCardStatus | null;
};

const SUBJECT_LIMIT = 200;
const SNIPPET_LIMIT = 700;
const ADDRESS_LIMIT = 120;
const BODY_PREVIEW_LIMIT = 1500;
const FILENAME_LIMIT = 60;
/** Past this many names the list stops informing and starts filling the screen. */
const ATTACHMENT_NAMES_SHOWN = 4;

/**
 * A size a human can judge a download by. Deliberately decimal units: mail
 * clients, Telegram itself and every operator's intuition say a 240 KB PDF, and
 * being right about kibibytes here would only make the number disagree with every
 * other place the same file is shown.
 */
export function formatByteSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes < 1000) return `${Math.round(bytes)} B`;
	const units = ["KB", "MB", "GB"];
	let value = bytes / 1000;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * The attachment line.
 *
 * "📎 con adjuntos" told the operator that a decision existed without giving him
 * anything to decide with — a signed contract and a tracking pixel produced the
 * same six words. Names and sizes are what turn it into a judgement he can make
 * from the card.
 */
function renderAttachmentLine(input: InboundNotification): string {
	if (!input.attachments?.length) {
		return input.hasAttachments ? "\n📎 con adjuntos" : "";
	}
	const shown = input.attachments
		.slice(0, ATTACHMENT_NAMES_SHOWN)
		.map(
			(attachment) =>
				`${escapeAndClip(attachment.filename?.trim() || "(sin nombre)", FILENAME_LIMIT)} (${formatByteSize(attachment.size)})`,
		)
		.join(" · ");
	const rest = input.attachments.length - ATTACHMENT_NAMES_SHOWN;
	return `\n📎 ${shown}${rest > 0 ? ` · +${rest}` : ""}`;
}

/**
 * The new-mail card.
 *
 * Deliberately a preview, not the mail: sender, subject and snippet. Full bodies
 * would put whatever arrives — password resets, 2FA codes — into a cloud chat
 * that is not end-to-end encrypted. Reading the whole one is what the "Leer
 * completo" button is for: still an explicit act, just one the operator can
 * perform where he already is.
 *
 * Rendered from the same inputs every time, so restating a card after an action
 * only ever changes the status line — an edit is not a chance to rewrite what the
 * operator was originally told.
 */
export function renderInboundNotification(input: InboundNotification): string {
	const from = escapeAndClip(input.fromAddr, ADDRESS_LIMIT);
	const header = `📬 <b>${escapeAndClip(input.subject ?? "(sin asunto)", SUBJECT_LIMIT)}</b>`;
	const badge = input.firstContact ? " ✨" : "";
	const addresses = `<i>${from}</i>${badge} → ${escapeAndClip(input.mailboxAddress, ADDRESS_LIMIT)}${
		input.firstContact ? "\n<i>primer correo de este remitente</i>" : ""
	}`;
	const attachments = renderAttachmentLine(input);
	const status = input.status ? `\n· ${CARD_STATUS_LABELS[input.status]}` : "";
	const footer = "\n\n<i>Responde a este mensaje para contestar por email.</i>";

	const fixedLength =
		header.length + addresses.length + attachments.length + status.length + footer.length + 4;
	const budget = Math.max(0, Math.min(SNIPPET_LIMIT, TELEGRAM_MAX_MESSAGE_CHARS - fixedLength));
	const snippet = input.snippet?.trim() ? `\n\n${escapeAndClip(input.snippet, budget)}` : "";

	return withinLimit(
		`${header}\n${addresses}${attachments}${status}${snippet}${footer}`,
		`📬 Nuevo correo de <i>${from}</i>${status}`,
	);
}

/**
 * A message body cut into pieces Telegram will accept, escaped for HTML mode.
 *
 * Escaping happens first and the cuts are measured on the escaped text, for the
 * reason escapeAndClip explains: `&` becomes five characters, so a raw body that
 * fits would produce a piece that does not. Cuts prefer a line break, then a
 * space, and only then the hard limit — and a piece is never allowed to end
 * mid-entity, because `&am` is invalid HTML and Telegram rejects the whole
 * message rather than the character.
 */
export function chunkTelegramText(value: string, max = TELEGRAM_MAX_MESSAGE_CHARS): string[] {
	const chunks: string[] = [];
	let rest = telegramEscape(value);
	while (rest.length > max) {
		const window = rest.slice(0, max);
		// +1 keeps the separator with the piece it ends, so nothing is dropped.
		let cut = window.lastIndexOf("\n") + 1;
		if (cut < max / 2) {
			cut = window.lastIndexOf(" ") + 1;
		}
		if (cut < max / 2) {
			cut = max;
		}
		const piece = rest.slice(0, cut);
		const whole = piece.replace(/&[a-z]{0,6}$/i, "");
		chunks.push(whole.length > 0 ? whole : piece);
		rest = rest.slice(chunks[chunks.length - 1]!.length);
	}
	chunks.push(rest);
	// Telegram refuses an empty message, and a body ending in blank lines would
	// otherwise produce one.
	return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

/**
 * The confirmation card shown before anything is actually sent.
 *
 * The version is not decoration. A correction arrives as a separate Telegram
 * message and lands on a draft the operator cannot see, so without a visible
 * counter the only difference between "your fix was applied" and "your fix went
 * nowhere" is a preview that looks slightly different from what he remembers.
 */
export function renderDraftPreview(input: {
	to: string[];
	subject: string;
	bodyText: string;
	/** 1 (or absent) on the first render; bumped by every correction. */
	version?: number;
}): string {
	const to = escapeAndClip(input.to.join(", "), ADDRESS_LIMIT * 4);
	const subject = escapeAndClip(input.subject, SUBJECT_LIMIT);
	const body = escapeAndClip(input.bodyText, BODY_PREVIEW_LIMIT);
	const version = input.version && input.version > 1 ? ` · v${input.version}` : "";
	const header = `✉️ <b>Borrador listo${version}</b>`;
	return withinLimit(
		[header, `<b>Para:</b> ${to}`, `<b>Asunto:</b> ${subject}`, "", body].join("\n"),
		`${header}\n<b>Para:</b> ${to}`,
	);
}

/**
 * The night, as one message.
 *
 * Sender and subject per line and nothing else: this is an index into mail the
 * operator has not seen, not a second rendering of it, and the numbered buttons
 * under it are what turn any line into the real card.
 */
export function renderNightDigest(input: {
	total: number;
	items: Array<{ fromAddr: string; subject: string | null }>;
}): string {
	const heading = `🌙 <b>${input.total} ${input.total === 1 ? "correo retenido" : "correos retenidos"}</b>`;
	const lines = input.items.map(
		(item, index) =>
			`${index + 1}. <i>${escapeAndClip(item.fromAddr, ADDRESS_LIMIT)}</i> — ${escapeAndClip(
				item.subject ?? "(sin asunto)",
				SUBJECT_LIMIT,
			)}`,
	);
	const rest = input.total - input.items.length;
	const overflow = rest > 0 ? [`… y ${rest} más, en la bandeja.`] : [];
	const footer = ["", "<i>Pulsa un número para abrir su tarjeta.</i>"];
	return withinLimit(
		[heading, "", ...lines, ...overflow, ...footer].join("\n"),
		`${heading}\n<i>Pulsa /inbox para verlos.</i>`,
	);
}

/**
 * The line under a page of retrieved cards.
 *
 * It exists to carry the pagination buttons, and says the range and the total so
 * a page of four cards is legible as a slice of something bigger.
 */
export function renderResultFooter(input: {
	query: string;
	from: number;
	to: number;
	total: number;
}): string {
	return withinLimit(
		`🔎 <b>${escapeAndClip(input.query, SUBJECT_LIMIT)}</b> · ${input.from}-${input.to} de ${input.total}`,
		`🔎 ${input.from}-${input.to} de ${input.total}`,
	);
}
