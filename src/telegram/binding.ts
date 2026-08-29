/**
 * Which chat this deployment talks to, and how it came to know that.
 *
 * Kept out of api.ts (which is pure Bot API plumbing) and out of webhook.ts (which
 * would make it unreachable from the notification path) so both the update handler
 * and the notifier can agree on one answer.
 */

import {
	adoptRuntimeConfig,
	getRuntimeConfig,
	RUNTIME_CONFIG_KEYS,
	setRuntimeConfig,
} from "../db/runtime-config";
import { getChat, type TelegramConfig } from "./api";

/**
 * The chat that receives new-mail cards, as observed rather than declared.
 *
 * There is no configured fallback on purpose: a deployment that has never been
 * spoken to has no chat, and saying so is more useful than sending mail to an id
 * someone typed into a manifest months ago.
 */
export async function resolveTelegramChatId(env: Env): Promise<string | null> {
	return getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.telegramChatId);
}

export type ChatAdoption = {
	/** The chat this deployment is bound to after the attempt. */
	chatId: string;
	/** False when another chat already held the binding, so the caller can say so. */
	adopted: boolean;
};

/**
 * Binds this deployment to a chat the first time an allowlisted operator speaks.
 *
 * This is the whole reason TELEGRAM_CHAT_ID no longer needs to exist: the value
 * arrives inside the update, so the bot already knows it. The old flow had the bot
 * print the chat id in a message and ask the human to copy it into a config file
 * and redeploy -- the system observing a value, telling a human, and then asking
 * that human to tell it back.
 */
export async function adoptTelegramChat(env: Env, chatId: string): Promise<ChatAdoption> {
	const effective = await adoptRuntimeConfig(
		env.INDEX_DB,
		RUNTIME_CONFIG_KEYS.telegramChatId,
		chatId,
	);
	return { chatId: effective, adopted: effective === chatId };
}

/**
 * Whether the bound chat can hold topics, as last observed.
 *
 * Read on the notification path, which is why it is a stored fact and not a
 * getChat call: Telegram accepts roughly one message per second per chat, and
 * asking "is this a forum?" before every email would spend half that budget
 * re-learning something that changes about once in the life of a deployment.
 */
export async function chatSupportsTopics(env: Env): Promise<boolean> {
	return (await getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.telegramChatIsForum)) === "1";
}

/**
 * Re-observes whether the chat is a forum, and remembers the answer.
 *
 * Called from /start -- the one moment the operator is already waiting on a round
 * trip and an extra API call costs nothing -- so turning topic mode on (or off)
 * in Telegram and sending /start again is the whole reconfiguration procedure.
 * There is no TELEGRAM_TOPICS var to set, because a var would only ever be a
 * human transcribing what getChat already knows, and transcriptions go stale
 * silently.
 *
 * Never throws: a getChat that fails must not cost the operator the adoption
 * itself. The previously stored answer is kept rather than being clobbered with a
 * guess, since a failed probe is not evidence that the chat stopped being a forum.
 */
export async function refreshChatTopicSupport(
	env: Env,
	config: TelegramConfig,
	chatId: string,
): Promise<boolean> {
	let chat: Awaited<ReturnType<typeof getChat>>;
	try {
		chat = await getChat(config, { chatId });
	} catch (error) {
		console.warn("telegram.get_chat_failed", {
			chatId,
			error: error instanceof Error ? error.message : String(error),
		});
		return chatSupportsTopics(env);
	}
	// Both halves matter: is_forum is only ever true on a supergroup, and a plain
	// private chat with the bot has no topics to post into at all.
	const isForum = chat.type === "supergroup" && chat.is_forum === true;
	await setRuntimeConfig(
		env.INDEX_DB,
		RUNTIME_CONFIG_KEYS.telegramChatIsForum,
		isForum ? "1" : "0",
	);
	return isForum;
}
