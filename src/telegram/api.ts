/**
 * Minimal Telegram Bot API client — only the methods the bridge needs.
 *
 * Everything here is fetch-to-api.telegram.org; there is no SDK, because the
 * surface is six methods and a Worker should not carry a Node-shaped dependency
 * for that.
 */

import { fetchWithTimeout } from "../lib/runtime-config";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Bot API hard limit on a text message. Longer text is rejected, not truncated. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export type TelegramConfig = {
	botToken: string;
	webhookSecret: string;
	allowedUserIds: Set<string>;
	/** Chat that receives new-mail notifications. */
	chatId: string | null;
	/** Opt-in: create one forum topic per email thread instead of plain messages. */
	useTopics: boolean;
};

export type TelegramInlineButton = {
	text: string;
	callback_data: string;
};

export type TelegramMessage = {
	message_id: number;
	message_thread_id?: number;
	chat: { id: number | string; type: string };
	from?: { id: number | string; is_bot?: boolean };
	date?: number;
	text?: string;
	caption?: string;
	entities?: TelegramEntity[];
	caption_entities?: TelegramEntity[];
	reply_to_message?: TelegramMessage;
	is_topic_message?: boolean;
};

export type TelegramEntity = {
	type: string;
	/** UTF-16 code-unit offset — the same units JS string indexes use. */
	offset: number;
	length: number;
	url?: string;
	language?: string;
};

export type TelegramCallbackQuery = {
	id: string;
	from: { id: number | string };
	data?: string;
	message?: TelegramMessage;
};

export type TelegramUpdate = {
	update_id: number;
	message?: TelegramMessage;
	edited_message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
};

export type TelegramForumTopic = {
	message_thread_id: number;
	name: string;
};

/**
 * Reads the bridge configuration. Returns null when the bridge is off, and
 * throws when it is half-configured: a bot token without a webhook secret or an
 * allowlist would be an unauthenticated send-mail endpoint, so failing loudly at
 * startup beats discovering it later.
 */
export function readTelegramConfig(env: Env): TelegramConfig | null {
	const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
	if (!botToken) {
		return null;
	}
	const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
	if (!webhookSecret) {
		throw new Error("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set");
	}
	const allowedUserIds = new Set(
		(env.TELEGRAM_ALLOWED_USER_IDS ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
	if (allowedUserIds.size === 0) {
		throw new Error("TELEGRAM_ALLOWED_USER_IDS is required when TELEGRAM_BOT_TOKEN is set");
	}
	return {
		botToken,
		webhookSecret,
		allowedUserIds,
		chatId: env.TELEGRAM_CHAT_ID?.trim() || null,
		useTopics: env.TELEGRAM_TOPICS?.trim() === "1",
	};
}

export class TelegramApiError extends Error {
	constructor(
		readonly method: string,
		readonly statusCode: number,
		readonly description: string,
	) {
		super(`telegram ${method} failed (${statusCode}): ${description}`);
		this.name = "TelegramApiError";
	}
}

/**
 * Bounded on purpose: notifyInboundMail is awaited inside the queue consumer
 * before the message is acked, so a Telegram request that hangs would stall the
 * whole ingest batch. Failing fast loses a notification; hanging loses mail
 * throughput.
 */
const TELEGRAM_TIMEOUT_MS = 10_000;

export async function callTelegram<T>(
	botToken: string,
	method: string,
	params: Record<string, unknown>,
): Promise<T> {
	const response = await fetchWithTimeout(`${TELEGRAM_API_BASE}/bot${botToken}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
		timeoutMs: TELEGRAM_TIMEOUT_MS,
	});
	const payload = (await response.json()) as {
		ok: boolean;
		result?: T;
		description?: string;
		error_code?: number;
	};
	if (!payload.ok) {
		throw new TelegramApiError(
			method,
			payload.error_code ?? response.status,
			payload.description ?? "unknown error",
		);
	}
	return payload.result as T;
}

export function inlineKeyboard(buttons: TelegramInlineButton[][]): Record<string, unknown> {
	return { inline_keyboard: buttons };
}

export async function sendMessage(
	config: TelegramConfig,
	input: {
		chatId: string;
		text: string;
		messageThreadId?: number | null;
		replyToMessageId?: number | null;
		replyMarkup?: Record<string, unknown>;
	},
): Promise<TelegramMessage> {
	return callTelegram<TelegramMessage>(config.botToken, "sendMessage", {
		chat_id: input.chatId,
		text: input.text,
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true },
		...(input.messageThreadId ? { message_thread_id: input.messageThreadId } : {}),
		...(input.replyToMessageId
			? {
					reply_parameters: {
						message_id: input.replyToMessageId,
						allow_sending_without_reply: true,
					},
				}
			: {}),
		...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
	});
}

export async function editMessageText(
	config: TelegramConfig,
	input: { chatId: string; messageId: number; text: string },
): Promise<void> {
	await callTelegram(config.botToken, "editMessageText", {
		chat_id: input.chatId,
		message_id: input.messageId,
		text: input.text,
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true },
	});
}

export async function answerCallbackQuery(
	config: TelegramConfig,
	input: { callbackQueryId: string; text?: string },
): Promise<void> {
	await callTelegram(config.botToken, "answerCallbackQuery", {
		callback_query_id: input.callbackQueryId,
		...(input.text ? { text: input.text } : {}),
	});
}

export async function createForumTopic(
	config: TelegramConfig,
	input: { chatId: string; name: string },
): Promise<TelegramForumTopic> {
	return callTelegram<TelegramForumTopic>(config.botToken, "createForumTopic", {
		chat_id: input.chatId,
		name: input.name.slice(0, 128),
	});
}

export async function closeForumTopic(
	config: TelegramConfig,
	input: { chatId: string; messageThreadId: number },
): Promise<void> {
	await callTelegram(config.botToken, "closeForumTopic", {
		chat_id: input.chatId,
		message_thread_id: input.messageThreadId,
	});
}
