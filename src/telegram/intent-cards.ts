/**
 * Telegram approval cards for MCP intents (sends and control-plane changes).
 *
 * The card is rendered by the server from the kind's own `render()` output, never from
 * anything the agent wrote. The ✅/❌ buttons carry the intent id plus a short prefix of the
 * frozen payload hash; the handler reloads the row and approves against the FULL stored hash,
 * so a button can only ever act on the payload it was rendered for. Who may press is decided
 * by the caller (operator allowlist) and by the bound chat check here.
 */

import { approveIntent, denyIntent, type IntentView } from "../lib/approvals";
import { getApproval } from "../db/d1";
import {
	answerCallbackQuery,
	editMessageText,
	inlineKeyboard,
	TELEGRAM_MAX_MESSAGE_CHARS,
	type TelegramCallbackQuery,
	type TelegramConfig,
} from "./api";
import { resolveTelegramChatId } from "./binding";
import { telegramEscape } from "./format";

export const INTENT_APPROVE_PREFIX = "ia:";
export const INTENT_DENY_PREFIX = "ix:";
/** 8 hex chars = 32 bits: enough to detect a card for a superseded payload, never trusted alone. */
const HASH_PREFIX_LENGTH = 8;

const CARD_BUDGET = 3600;
const TEXT_FIELD_MAX = 240;
const PRE_FIELD_MAX = 400;
const LIST_ITEMS_MAX = 5;
const MORE_IN_LINK = "… ver detalle completo en el enlace.";

export function isIntentCallback(data: string): boolean {
	return data.startsWith(INTENT_APPROVE_PREFIX) || data.startsWith(INTENT_DENY_PREFIX);
}

/** `ia:<intent id>:<hash prefix>`: 3 + 43 + 1 + 8 = 55 bytes, under Telegram's 64. */
export function intentCallbackData(
	action: "approve" | "deny",
	intentId: string,
	payloadHash: string,
): string {
	const prefix = action === "approve" ? INTENT_APPROVE_PREFIX : INTENT_DENY_PREFIX;
	return `${prefix}${intentId}:${payloadHash.slice(0, HASH_PREFIX_LENGTH)}`;
}

function parseIntentCallback(
	data: string,
): { action: "approve" | "deny"; id: string; hashPrefix: string } | null {
	const action = data.startsWith(INTENT_APPROVE_PREFIX) ? "approve" : "deny";
	const rest = data.slice(3);
	const cut = rest.lastIndexOf(":");
	if (cut <= 0) return null;
	const id = rest.slice(0, cut);
	const hashPrefix = rest.slice(cut + 1);
	if (!id || !/^[a-f0-9]{8}$/.test(hashPrefix)) return null;
	return { action, id, hashPrefix };
}

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
	const { text, clipped } = clip(field.value, field.format === "pre" ? PRE_FIELD_MAX : TEXT_FIELD_MAX);
	return { line: `${label}: ${telegramEscape(text)}`, clipped };
}

/** The card body. Warnings come first and are marked; long content is cut, the link has it all. */
export function renderIntentCardText(view: IntentView, options: { compact?: boolean } = {}): string {
	const parts: string[] = [`🔐 <b>${telegramEscape(view.title)}</b>`];
	for (const warning of view.warnings) {
		parts.push(`⚠️ <b>${telegramEscape(warning.message)}</b>`);
	}
	let used = parts.join("\n").length;
	let truncated = false;
	if (!options.compact) {
		for (const field of view.fields) {
			const { line, clipped } = fieldLine(field);
			if (used + line.length + 1 > CARD_BUDGET) {
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
	if (view.webOnly) {
		parts.push("🔑 Esta solicitud muestra un secreto: solo se aprueba desde el enlace.");
	}
	const text = parts.join("\n");
	return text.length <= TELEGRAM_MAX_MESSAGE_CHARS
		? text
		: `🔐 <b>${telegramEscape(view.title)}</b>\n<i>${MORE_IN_LINK}</i>`;
}

export function intentCardKeyboard(
	view: IntentView,
	url: string,
): Record<string, unknown> {
	const rows = [];
	if (view.payloadHash) {
		rows.push([
			{ text: "✅ Aprobar", callback_data: intentCallbackData("approve", view.id, view.payloadHash) },
			{ text: "❌ Rechazar", callback_data: intentCallbackData("deny", view.id, view.payloadHash) },
		]);
	}
	rows.push([{ text: "Ver detalle", url }]);
	return inlineKeyboard(rows);
}

const ERROR_COPY: Record<string, string> = {
	expired: "Caducado",
	stale: "Ya no vale: el contenido cambió",
	forbidden: "No autorizado",
	unsupported_kind: "Tipo no soportado",
	not_sent: "No enviado",
};

type Outcome = { toast: string; line: string; keepKeyboard?: boolean };

function describe(
	result: Awaited<ReturnType<typeof approveIntent>>,
	action: "approve" | "deny",
): Outcome {
	if (result.error === "web_required") {
		return {
			toast: "Abre el enlace para aprobar y ver la clave",
			line: "🔑 Abre el enlace para aprobar y ver la clave.",
			keepKeyboard: true,
		};
	}
	if (result.error) {
		const copy = ERROR_COPY[result.error] ?? `Error: ${result.error}`;
		return { toast: copy, line: `⚠️ ${telegramEscape(copy)}` };
	}
	if (result.resolved) {
		return { toast: "Ya resuelto", line: "ℹ️ Ya resuelto." };
	}
	if (action === "deny") return { toast: "Rechazado", line: "❌ Rechazado." };
	switch (result.status) {
		case "denied":
			return { toast: "Ya resuelto", line: "ℹ️ Ya resuelto (rechazado)." };
		case "expired":
			return { toast: "Caducado", line: "⌛ Caducado." };
		case "stale":
			return { toast: "Ya no vale", line: "⚠️ El contenido cambió; no se ha hecho nada." };
		case "failed":
			return { toast: "Falló", line: "⚠️ Aprobado, pero el cambio no se completó." };
		default:
			return { toast: "Aprobado", line: "✅ Aprobado." };
	}
}

/**
 * Handles a ✅/❌ press. The operator allowlist has already passed; this adds the
 * bound-chat check, loads the row, binds the press to the stored payload hash and
 * defers everything else to approveIntent/denyIntent (single winner, expiry, kind checks).
 */
export async function handleIntentCallback(
	env: Env,
	config: TelegramConfig,
	query: TelegramCallbackQuery,
): Promise<void> {
	const answer = (text?: string) =>
		answerCallbackQuery(config, { callbackQueryId: query.id, ...(text ? { text } : {}) });
	const parsed = parseIntentCallback(query.data ?? "");
	if (!parsed) {
		await answer();
		return;
	}
	const boundChat = await resolveTelegramChatId(env);
	if (!boundChat || !query.message || String(query.message.chat.id) !== boundChat) {
		await answer("No autorizado");
		return;
	}
	const row = await getApproval(env.INDEX_DB, parsed.id);
	if (!row || row.origin !== "mcp" || !row.payload_hash) {
		await answer("Caducado");
		return;
	}
	if (!row.payload_hash.startsWith(parsed.hashPrefix)) {
		await finish(config, query, { toast: "Ya no vale", line: "⚠️ El contenido cambió; no se ha hecho nada." }, answer);
		return;
	}
	const approver = String(query.from.id);
	let outcome: Outcome;
	if (parsed.action === "deny") {
		const preResolved = Boolean(row.consumed_at || row.decision);
		const status = await denyIntent(env, row.token, { channel: "telegram", approver });
		outcome = preResolved
			? { toast: "Ya resuelto", line: "ℹ️ Ya resuelto." }
			: status.status === "denied"
				? { toast: "Rechazado", line: "❌ Rechazado." }
				: status.status === "expired"
					? { toast: "Caducado", line: "⌛ Caducado." }
					: { toast: "Ya resuelto", line: "ℹ️ Ya resuelto." };
	} else {
		const result = await approveIntent(env, {
			id: row.token,
			payloadHash: row.payload_hash,
			channel: "telegram",
			approver,
		});
		outcome = describe(result, "approve");
	}
	await finish(config, query, outcome, answer);
}

async function finish(
	config: TelegramConfig,
	query: TelegramCallbackQuery,
	outcome: Outcome,
	answer: (text?: string) => Promise<void>,
): Promise<void> {
	await answer(outcome.toast).catch(() => undefined);
	if (!query.message) return;
	const original = telegramEscape(query.message.text ?? "");
	const room = TELEGRAM_MAX_MESSAGE_CHARS - outcome.line.length - 2;
	const body = original.length > room ? `${original.slice(0, Math.max(0, room - 1)).replace(/&[a-z]*$/i, "")}…` : original;
	// A web-only intent keeps its keyboard so the link stays one tap away; everything else
	// is resolved, so the buttons go (an omitted replyMarkup drops them).
	await editMessageText(config, {
		chatId: String(query.message.chat.id),
		messageId: query.message.message_id,
		text: `${body}\n\n${outcome.line}`,
		...(outcome.keepKeyboard ? { replyMarkup: query.message.reply_markup } : {}),
	}).catch(() => undefined);
}
