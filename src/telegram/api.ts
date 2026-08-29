/**
 * Minimal Telegram Bot API client — only the methods the bridge needs.
 *
 * Everything here is fetch-to-api.telegram.org; there is no SDK, because the
 * surface is six methods and a Worker should not carry a Node-shaped dependency
 * for that.
 */

import { base32urlEncode, hmacSha256 } from "../lib/crypto";
import { fetchWithTimeout } from "../lib/runtime-config";

const TELEGRAM_API_BASE = "https://api.telegram.org";

/** Bot API hard limit on a text message. Longer text is rejected, not truncated. */
export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

/**
 * The credential, and nothing else. The allowlist used to live here and no longer
 * does -- see readTelegramConfig.
 */
export type TelegramConfig = {
	botToken: string;
};

/**
 * Either a button that comes back as a callback_query, or one that just opens a
 * link. The URL variant exists so a card can offer "open this in Reccado" without
 * spending a round trip through the webhook to send back a URL the button could
 * have carried itself.
 */
export type TelegramInlineButton =
	| { text: string; callback_data: string }
	| { text: string; url: string };

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
 * Label that separates this derivation from any other use of the bot token as a
 * key. Changing it rotates every deployment's webhook secret, so don't.
 */
const WEBHOOK_SECRET_LABEL = "reccado:telegram:webhook-secret:v1";

/**
 * The webhook secret, derived rather than configured.
 *
 * No human ever reads this value: the only two parties that need it are this
 * worker and Telegram, which echoes it back in X-Telegram-Bot-Api-Secret-Token.
 * Asking an operator to invent one, store it as a worker secret and re-supply it
 * to a setup script was three manual steps for a number with no human meaning --
 * and the step everyone forgets, which is how the bridge stayed dead in
 * production without a word. Deriving it from the bot token, the one Telegram
 * credential a human genuinely must provide, removes the step entirely, lets any
 * code path recompute it without stored state (so the cron can re-register a
 * drifted webhook), and rotates it automatically with the token.
 *
 * Deliberately NOT persisted in D1. This secret is what stops a forged update
 * from sending mail as the operator, and the allowlist such an update would have
 * to satisfy is itself a D1 row -- so storing it there would let a single
 * database read escalate from reading mail to sending it. A secret's home is
 * decided by what it protects, not by whichever store is most convenient.
 */
export async function deriveWebhookSecret(botToken: string): Promise<string> {
	return base32urlEncode(await hmacSha256(botToken, WEBHOOK_SECRET_LABEL));
}

/**
 * Label for the *fingerprint*, deliberately different from the secret's own.
 * Changing either string forces a re-registration on every deployment, so don't.
 */
const WEBHOOK_SECRET_FINGERPRINT_LABEL = "reccado:telegram:webhook-secret-fingerprint:v1";

/**
 * A name for the secret currently in force, safe to write down.
 *
 * The cron needs to answer "was the live webhook registered with *this* secret?",
 * and getWebhookInfo never echoes the secret back -- so the only way to know is to
 * have recorded what we registered with. Recording the secret itself would undo
 * the reason it is not in D1 at all (see deriveWebhookSecret): a database read
 * would escalate from reading mail to forging updates that send it.
 *
 * An HMAC under a different label is computationally independent of the secret,
 * so this value names the secret without revealing it. And an attacker who can
 * *write* D1 gains nothing either: the worst they can force is a re-registration
 * of our own URL with our own derived secret.
 */
export async function deriveWebhookSecretFingerprint(botToken: string): Promise<string> {
	return base32urlEncode(await hmacSha256(botToken, WEBHOOK_SECRET_FINGERPRINT_LABEL));
}

/**
 * Is the bridge on? Null when there is no bot token, which is the only thing that
 * can be answered without touching a database.
 *
 * This function used to also carry the operator allowlist and throw when it was
 * empty. Both had to go. The allowlist lives in D1 now (see telegram/operators.ts)
 * and cannot be read synchronously -- and, more importantly, "a bot token with no
 * operator" stopped being an error the moment pairing existed. It is the state
 * every deployment starts in and the state /start has to be answered from: a
 * bridge that refuses to serve the webhook until someone is linked can never link
 * anyone. So this stays synchronous and total, the operator set is resolved by
 * whoever needs it, and "on but unpaired" is reported as partial rather than
 * thrown.
 *
 * The webhook secret is still absent on purpose -- it is derived on demand by the
 * only code that needs it, and nothing that merely sends a notification should
 * hold it.
 */
export function readTelegramConfig(env: Env): TelegramConfig | null {
	const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
	return botToken ? { botToken } : null;
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
 * "You addressed a topic that is not there any more."
 *
 * The Bot API has no error code for this -- a deleted forum topic comes back as a
 * generic 400 -- so the description is the only signal, and matching it is
 * matched narrowly on purpose. A topic the operator *closed* answers with
 * TOPIC_CLOSED and is deliberately not included: closing is a decision to make a
 * topic read-only, and silently recreating it would undo that decision. Only a
 * topic that no longer exists gets recreated.
 */
export function isMissingTopicError(error: unknown): boolean {
	if (!(error instanceof TelegramApiError) || error.statusCode !== 400) {
		return false;
	}
	const description = error.description.toLowerCase();
	return (
		description.includes("thread not found") ||
		description.includes("topic_deleted") ||
		description.includes("topic deleted")
	);
}

/**
 * "The edit you asked for would change nothing."
 *
 * Telegram answers 400 rather than 200 when editMessageText produces the text a
 * message already has, which is the ordinary outcome of reconciling the same
 * state twice — the operator archiving from the web an email Telegram already
 * showed as archived. Treating it as a failure would retry an edit that can only
 * ever be refused again, so callers read it as "already in that state".
 */
export function isNotModifiedError(error: unknown): boolean {
	return (
		error instanceof TelegramApiError &&
		error.statusCode === 400 &&
		error.description.toLowerCase().includes("message is not modified")
	);
}

/**
 * Bounded on purpose: these calls run inside the notification queue consumer,
 * whose invocation a hung request would hold open while the rest of the batch
 * waits. Failing fast costs one redelivery, which that queue is built for;
 * hanging costs the whole batch. (Before the notification queue existed this
 * bound protected the ingest ack path, which could not retry at all.)
 */
const TELEGRAM_TIMEOUT_MS = 10_000;

async function readTelegramResult<T>(method: string, response: Response): Promise<T> {
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
	return readTelegramResult<T>(method, response);
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

/**
 * No message_thread_id here on purpose: chat_id plus message_id already names a
 * message wherever it lives, topic or not, and passing a thread the message is
 * not in is an error rather than a filter.
 *
 * An omitted replyMarkup drops the inline keyboard, which is the intended
 * behaviour for a card whose buttons no longer apply.
 */
export async function editMessageText(
	config: TelegramConfig,
	input: {
		chatId: string;
		messageId: number;
		text: string;
		replyMarkup?: Record<string, unknown>;
	},
): Promise<void> {
	await callTelegram(config.botToken, "editMessageText", {
		chat_id: input.chatId,
		message_id: input.messageId,
		text: input.text,
		parse_mode: "HTML",
		link_preview_options: { is_disabled: true },
		...(input.replyMarkup ? { reply_markup: input.replyMarkup } : {}),
	});
}

/**
 * A text file, for the bodies that do not belong in a chat as chat.
 *
 * Multipart rather than JSON because the document travels as a file part, so
 * this is the one Bot API call that cannot go through callTelegram. The upload is
 * an ordinary form field, which is why no boundary is set by hand: FormData in
 * Workers produces the header itself.
 */
export async function sendDocument(
	config: TelegramConfig,
	input: {
		chatId: string;
		filename: string;
		/**
		 * Text for a message body dumped to a file, bytes for a real attachment
		 * pulled out of R2. Both are the same form field; only the Blob's type
		 * changes, which is what decides whether Telegram previews it as a document
		 * or as an image.
		 */
		content: string | ArrayBuffer | ArrayBufferView;
		contentType?: string;
		caption?: string;
		messageThreadId?: number | null;
		replyToMessageId?: number | null;
	},
): Promise<TelegramMessage> {
	const form = new FormData();
	form.set("chat_id", input.chatId);
	if (input.caption) {
		form.set("caption", input.caption);
		form.set("parse_mode", "HTML");
	}
	if (input.messageThreadId) {
		form.set("message_thread_id", String(input.messageThreadId));
	}
	if (input.replyToMessageId) {
		form.set(
			"reply_parameters",
			JSON.stringify({ message_id: input.replyToMessageId, allow_sending_without_reply: true }),
		);
	}
	form.set(
		"document",
		new Blob([input.content as BlobPart], {
			type: input.contentType ?? "text/plain; charset=utf-8",
		}),
		input.filename,
	);
	const response = await fetchWithTimeout(
		`${TELEGRAM_API_BASE}/bot${config.botToken}/sendDocument`,
		{ method: "POST", body: form, timeoutMs: TELEGRAM_TIMEOUT_MS },
	);
	return readTelegramResult<TelegramMessage>("sendDocument", response);
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

export type TelegramChat = {
	id: number | string;
	type: string;
	/** True only for a supergroup with topic mode turned on. */
	is_forum?: boolean;
};

/** What kind of chat this is — asked once at adoption, not once per email. */
export async function getChat(
	config: TelegramConfig,
	input: { chatId: string },
): Promise<TelegramChat> {
	return callTelegram<TelegramChat>(config.botToken, "getChat", { chat_id: input.chatId });
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

/**
 * The update kinds the bridge acts on.
 *
 * `edited_message` is here because correcting your own message is the second
 * gesture a phone suggests for fixing a draft, and Telegram delivers that as its
 * own update kind: without it in this list the bot never hears about the edit at
 * all, and the operator watches a preview that will not change.
 */
export const TELEGRAM_ALLOWED_UPDATES = ["message", "edited_message", "callback_query"] as const;

export type TelegramWebhookInfo = {
	url: string;
	pending_update_count?: number;
	last_error_message?: string;
	/**
	 * Absent means Telegram is using its default set, which is a superset of
	 * everything above — so absence is agreement, not drift.
	 */
	allowed_updates?: string[];
	/**
	 * When the last delivery attempt failed, in epoch *seconds* as Telegram sends
	 * it. This is the machine-readable half of the error: the message is prose
	 * Telegram may reword at any time, the date is a number that can be compared.
	 */
	last_error_date?: number;
};

export async function getWebhookInfo(config: TelegramConfig): Promise<TelegramWebhookInfo> {
	return callTelegram<TelegramWebhookInfo>(config.botToken, "getWebhookInfo", {});
}

export async function setWebhook(
	config: TelegramConfig,
	input: { url: string; secret: string },
): Promise<void> {
	await callTelegram(config.botToken, "setWebhook", {
		url: input.url,
		secret_token: input.secret,
		// Only the update kinds the bridge acts on. Anything else is bandwidth spent
		// to be ignored.
		allowed_updates: [...TELEGRAM_ALLOWED_UPDATES],
	});
}

/**
 * One entry of the bot's "/" menu.
 *
 * Telegram will not accept a command with anything but lowercase letters, digits
 * and underscores, which is why the accented Spanish that fits the descriptions
 * never appears in the command itself.
 */
export type TelegramBotCommand = {
	command: string;
	description: string;
};

export async function getMyCommands(config: TelegramConfig): Promise<TelegramBotCommand[]> {
	return callTelegram<TelegramBotCommand[]>(config.botToken, "getMyCommands", {});
}

export async function setMyCommands(
	config: TelegramConfig,
	commands: TelegramBotCommand[],
): Promise<void> {
	await callTelegram(config.botToken, "setMyCommands", { commands });
}
