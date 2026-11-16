/**
 * Telegram notices for MCP approval requests (sends and the critical control-plane kinds).
 *
 * The notice is rendered by the server from the kind's own `render()` output, never from
 * anything the agent wrote. There are no approve/deny buttons: approval happens only on the
 * `/approve/:id` web page with the owner session; the notice carries the link.
 */

import type { IntentView } from "../lib/approvals";
import { inlineKeyboard, TELEGRAM_MAX_MESSAGE_CHARS } from "./api";
import { telegramEscape } from "./format";

const CARD_BUDGET = 3600;
const TEXT_FIELD_MAX = 240;
const PRE_FIELD_MAX = 400;
const LIST_ITEMS_MAX = 5;
/** A notice is a summary; the request itself is one tap away. */
const SUMMARY_FIELDS = 4;
const MORE_IN_LINK = "… ver detalle completo en el enlace.";

function clip(value: string, max: number): { text: string; clipped: boolean } {
	const trimmed = value.trim();
	if (trimmed.length <= max) return { text: trimmed, clipped: false };
	return { text: `${trimmed.slice(0, max)}…`, clipped: true };
}

function fieldLine(field: IntentView["fields"][number]): { line: string; clipped: boolean } {
	const label = `<b>${telegramEscape(field.label)}</b>`;
	if (field.format === "list") {
		const items = field.value.split("\n").filter(Boolean);
		const shown = items.slice(0, LIST_ITEMS_MAX).map((item) => clip(item, TEXT_FIELD_MAX));
		const clipped = items.length > LIST_ITEMS_MAX || shown.some((item) => item.clipped);
		return {
			line: `${label}\n${shown.map((item) => `• ${telegramEscape(item.text)}`).join("\n")}`,
			clipped,
		};
	}
	const { text, clipped } = clip(
		field.value,
		field.format === "pre" ? PRE_FIELD_MAX : TEXT_FIELD_MAX,
	);
	return { line: `${label}: ${telegramEscape(text)}`, clipped };
}

/**
 * The card body: a short summary, not the request. Warnings come first and are
 * marked; at most SUMMARY_FIELDS fields follow, each clipped -- the page behind
 * the button has it all. The URL is carried once, by the button, never in the text.
 */
export function renderIntentCardText(
	view: IntentView,
	options: { compact?: boolean; expires?: string | null } = {},
): string {
	const parts: string[] = [`🔐 <b>${telegramEscape(view.title)}</b>`];
	for (const warning of view.warnings) {
		parts.push(`⚠️ <b>${telegramEscape(warning.message)}</b>`);
	}
	let used = parts.join("\n").length;
	let truncated = false;
	if (!options.compact) {
		for (const [index, field] of view.fields.entries()) {
			const { line, clipped } = fieldLine(field);
			if (index >= SUMMARY_FIELDS || used + line.length + 1 > CARD_BUDGET) {
				truncated = true;
				break;
			}
			parts.push(line);
			used += line.length + 1;
			truncated ||= clipped;
		}
	} else if (view.fields.length) {
		truncated = true;
	}
	if (truncated) parts.push(`<i>${MORE_IN_LINK}</i>`);
	if (options.expires) parts.push(`⏳ Caduca a las ${telegramEscape(options.expires)}.`);
	parts.push("🔑 Se aprueba solo en la página web, con tu sesión de propietario.");
	const text = parts.join("\n");
	return text.length <= TELEGRAM_MAX_MESSAGE_CHARS
		? text
		: `🔐 <b>${telegramEscape(view.title)}</b>\n<i>${MORE_IN_LINK}</i>`;
}

/** What a notice says once the request is no longer pending. */
export const DECIDED_LABELS = {
	approved: "✅ Aprobado",
	denied: "⛔ Denegado",
	expired: "⌛ Caducado",
	stale: "⌛ Ya no es válido: la petición cambió",
} as const;

export type DecidedNoticeState = keyof typeof DECIDED_LABELS;

/**
 * The notice after the fact: the state first, then the title. No fields and no
 * button -- nothing left to review, and a live-looking link under a dead request
 * is exactly the staleness this replaces.
 */
export function renderDecidedNotice(view: IntentView, state: DecidedNoticeState): string {
	return `🔐 <b>${DECIDED_LABELS[state]}</b> · ${telegramEscape(view.title)}`;
}

/** One URL button: Telegram only notifies, the owner approves on the web page. */
export function intentCardKeyboard(url: string): Record<string, unknown> {
	return inlineKeyboard([[{ text: "Revisar y aprobar", url }]]);
}
