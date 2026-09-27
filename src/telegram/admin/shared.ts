/**
 * Operator control of the Telegram bridge: the pieces every /api/telegram/*
 * route shares.
 *
 * Everything under src/telegram/admin runs inside the worker with the worker's
 * own bot token. That is the point: TELEGRAM_BOT_TOKEN is a write-only secret,
 * so before these routes existed nobody could even ask Telegram for the bot's
 * @username, and moving the bridge to a forum meant deleting runtime_config
 * rows by hand in D1 (with the key spelled exactly right -- `telegram.chat_id`,
 * dots, or the DELETE silently matches nothing) and INSERTing topic mappings
 * created with a different bot.
 *
 * Reached only through /api/telegram/* (src/api/telegram-routes.ts), behind the
 * owner session and, for writes, the Origin CSRF check. Nothing here returns the
 * token: every Telegram error string that leaves these modules goes through
 * describeTelegramError, which redacts it.
 *
 * The decisions are pure functions, exported for unit tests; the rest is thin
 * IO around them.
 */

import type { MailboxRow } from "../../db/d1";
import { getRuntimeConfig, RUNTIME_CONFIG_KEYS } from "../../db/runtime-config";
import type { TelegramTopicRow } from "../../db/telegram-topics";
import {
	TelegramApiError,
	type TelegramBotUser,
	type TelegramChat,
	type TelegramChatMember,
	type TelegramConfig,
} from "../api";
import { topicNameFor } from "../notify";

/**
 * Why a topic mapping cannot be proven from here.
 *
 * The Bot API has no read-only "does this topic exist" call. The one method
 * that addresses a topic without posting is editForumTopic, and in this API that
 * call RENAMES the topic -- probing with it would overwrite whatever the
 * operator named it. So existence is reported as unverified, and the delivery
 * test (which posts a labelled message and checks where it landed) is how to
 * verify it.
 */
export const TOPIC_UNVERIFIED_REASON =
	"The Bot API has no read-only way to check that a forum topic exists (editForumTopic would rename it). Run the delivery test (pnpm smoke:telegram) to verify.";

/**
 * A Telegram failure as text that is safe to return, log or print.
 *
 * TelegramApiError never carries the token, but a transport error from fetch
 * may echo the request URL, and that URL is /bot<token>/<method>. Redacting here
 * means no caller has to remember to.
 */
export function describeTelegramError(error: unknown, botToken: string): string {
	const text =
		error instanceof TelegramApiError
			? `${error.method}: ${error.description} (${error.statusCode})`
			: error instanceof Error
				? error.message
				: String(error);
	return botToken ? text.split(botToken).join("[redacted]") : text;
}

/** Both halves matter: is_forum is only ever true on a supergroup. Same rule as /start. */
export function isForumChat(chat: Pick<TelegramChat, "type" | "is_forum">): boolean {
	return chat.type === "supergroup" && chat.is_forum === true;
}

export type MembershipVerdict = {
	status: string;
	/** Whether the bot may create and manage forum topics here. */
	canManageTopics: boolean;
	/** Whether the bot may post at all, which the bridge cannot work without. */
	canSendMessages: boolean;
	/** Whether a rebind to this chat is allowed. */
	eligible: boolean;
	reason: string;
};

/**
 * Can the bridge live in this chat, judged from the bot's own membership?
 *
 * An administrator can always post; whether it can also create topics is a
 * separate right, reported on its own because a forum where the bot cannot
 * create topics still works with topics a person creates and the operator
 * adopts. A plain member posts under the chat's default permissions; a
 * restricted member only if the restriction still allows messages. A bot that
 * has left or been removed cannot be bound to at all.
 */
export function evaluateBotMembership(
	member: TelegramChatMember,
	chat: Pick<TelegramChat, "permissions">,
): MembershipVerdict {
	const status = member.status;
	if (status === "administrator" || status === "creator") {
		const canManageTopics = status === "creator" || member.can_manage_topics === true;
		return {
			status,
			canManageTopics,
			canSendMessages: true,
			eligible: true,
			reason: canManageTopics
				? "The bot is an administrator and may manage topics."
				: "The bot is an administrator but lacks can_manage_topics: it can post, but topics must be created by a person and adopted.",
		};
	}
	if (status === "member") {
		const canSendMessages = chat.permissions?.can_send_messages !== false;
		const canManageTopics = chat.permissions?.can_manage_topics === true;
		return {
			status,
			canManageTopics,
			canSendMessages,
			eligible: canSendMessages,
			reason: canSendMessages
				? `The bot is a member with send rights${canManageTopics ? "." : " but cannot manage topics (make it an administrator with can_manage_topics)."}`
				: "The bot is a member, but members may not send messages in this chat. Make the bot an administrator.",
		};
	}
	if (status === "restricted") {
		const canSendMessages = member.is_member !== false && member.can_send_messages === true;
		return {
			status,
			canManageTopics: member.can_manage_topics === true,
			canSendMessages,
			eligible: canSendMessages,
			reason: canSendMessages
				? "The bot is restricted but may still send messages."
				: "The bot is restricted and may not send messages here. Lift the restriction or make it an administrator.",
		};
	}
	return {
		status,
		canManageTopics: false,
		canSendMessages: false,
		eligible: false,
		reason: `The bot is "${status}" in this chat. Add it to the chat (as an administrator with can_manage_topics for a forum).`,
	};
}

/** A route answer: the body, and the status it goes out with. */
export type AdminResult<T> =
	| { ok: true; status: 200 | 201; body: T }
	| {
			ok: false;
			status: 400 | 404 | 409 | 502;
			body: { error: string; message: string } & Record<string, unknown>;
	  };

export function refuse(
	status: 400 | 404 | 409 | 502,
	error: string,
	message: string,
	extra: Record<string, unknown> = {},
): AdminResult<never> {
	return { ok: false, status, body: { error, message, ...extra } };
}

export const bridgeDisabled = () =>
	refuse(409, "telegram_disabled", "The Telegram bridge is off: TELEGRAM_BOT_TOKEN is not set.");

export const noChatBound = () =>
	refuse(
		409,
		"no_chat_bound",
		"No Telegram chat is bound. Send /start to the bot from the chat, or run pnpm operator telegram rebind --chat <id> --apply.",
	);

export type TopicMappingView = {
	chatId: string;
	mailboxId: string;
	topicId: number;
	/** The stored name, or null when the topic follows the mailbox's name. */
	topicName: string | null;
	/** The name a (re)created topic gets: topicName, else display_name, else the address. */
	effectiveName: string;
	createdAt: string;
};

export function mappingView(
	row: TelegramTopicRow,
	mailbox: Pick<MailboxRow, "display_name" | "primary_address"> | null,
): TopicMappingView {
	return {
		chatId: row.chat_id,
		mailboxId: row.mailbox_id,
		topicId: row.topic_id,
		topicName: row.topic_name,
		effectiveName: topicNameFor(mailbox, row.mailbox_id, row.topic_name),
		createdAt: row.created_at,
	};
}

export type BindingState = {
	chatId: string | null;
	/** The stored forum flag the notifier reads; null when it was never observed. */
	isForum: boolean | null;
};

/** The binding exactly as the notifier and the webhook will read it: straight from D1. */
export async function readBinding(env: Env): Promise<BindingState> {
	const [chatId, forum] = await Promise.all([
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.telegramChatId),
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.telegramChatIsForum),
	]);
	return { chatId, isForum: forum === null ? null : forum === "1" };
}

/** A Telegram read that may fail without failing the whole answer. */
export type Probe<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function probe<T extends object>(
	config: TelegramConfig,
	run: () => Promise<T>,
): Promise<Probe<T>> {
	try {
		return { ok: true, ...(await run()) };
	} catch (error) {
		return { ok: false, error: describeTelegramError(error, config.botToken) };
	}
}

export type BotView = { id: number; username: string | null; firstName: string };

export function botView(bot: TelegramBotUser): BotView {
	return { id: bot.id, username: bot.username ?? null, firstName: bot.first_name };
}

export type ChatView = { id: string; type: string; title: string | null; isForum: boolean };

export function chatView(chat: TelegramChat): ChatView {
	return {
		id: String(chat.id),
		type: chat.type,
		title: chat.title ?? null,
		isForum: isForumChat(chat),
	};
}
