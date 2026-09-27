/**
 * POST /api/telegram/rebind: moves the bridge to another chat.
 *
 * This is the explicit override of first-write-wins. Chat adoption is sticky by
 * design (adoptRuntimeConfig, and /start only adopts an unbound chat): an
 * operator typing /start in some group must not silently move where his mail
 * lands. That guarantee is about *accidental* moves, and this is a deliberate
 * one:
 *
 * - it is reachable only by an authenticated owner, through /api/telegram/*,
 *   behind the session perimeter and the Origin CSRF check;
 * - it asks Telegram, before writing anything, that the chat exists and that
 *   the bot can post there -- so it can never bind to a chat the bridge would
 *   go silent in;
 * - it writes a `telegram.rebound` ops_event naming the old and new chat ids,
 *   in the same D1 batch as the binding itself.
 *
 * Replacing it with "delete the two runtime_config rows in D1 and send /start"
 * is what it removes: that took the key names spelled exactly (dots, not
 * underscores -- the wrong spelling deletes nothing and says nothing), and left
 * notifications with nowhere to go until someone typed /start.
 */

import { RUNTIME_CONFIG_KEYS, runtimeConfigUpsert } from "../../db/runtime-config";
import { listTelegramTopics } from "../../db/telegram-topics";
import {
	getChat,
	getChatMember,
	getMe,
	readTelegramConfig,
	TelegramApiError,
	type TelegramChat,
	type TelegramChatMember,
} from "../api";
import {
	type AdminResult,
	type BindingState,
	bridgeDisabled,
	describeTelegramError,
	evaluateBotMembership,
	isForumChat,
	type MembershipVerdict,
	readBinding,
	refuse,
} from "./shared";

export type RebindResult = {
	outcome: "rebound" | "unchanged" | "would_rebind" | "would_be_unchanged";
	dryRun: boolean;
	previous: BindingState;
	current: { chatId: string; isForum: boolean; type: string; title: string | null };
	/** Null for a private chat, where the bot has no membership to read. */
	membership: MembershipVerdict | null;
	topics: { mappedInNewChat: number; keptForOtherChats: number };
	notes: string[];
};

/**
 * Validates the target with Telegram and, unless this is a dry run, rebinds.
 *
 * The two runtime_config keys and the audit row are one D1 batch (one
 * transaction), so the binding can never point at the new chat while carrying
 * the old chat's forum flag.
 *
 * There is no cache to invalidate: resolveTelegramChatId and chatSupportsTopics
 * read D1 on every call, so the very next notification goes to the new chat and
 * the webhook's bound-chat check starts ignoring orders from the old one.
 *
 * Topic mappings of the old chat are kept. Their key is (chat_id, mailbox_id),
 * so they cannot collide with the new chat's, and rebinding back later finds
 * them where they were.
 */
export async function rebindTelegramChat(
	env: Env,
	input: { chatId: string; dryRun: boolean },
): Promise<AdminResult<RebindResult>> {
	const config = readTelegramConfig(env);
	if (!config) return bridgeDisabled();

	let chat: TelegramChat;
	try {
		chat = await getChat(config, { chatId: input.chatId });
	} catch (error) {
		const message = describeTelegramError(error, config.botToken);
		if (error instanceof TelegramApiError && error.statusCode === 400) {
			return refuse(404, "chat_not_found", `Telegram does not know that chat: ${message}`);
		}
		if (error instanceof TelegramApiError && error.statusCode === 403) {
			return refuse(409, "bot_not_in_chat", `The bot cannot see that chat: ${message}`);
		}
		return refuse(502, "telegram_unavailable", `getChat failed: ${message}`);
	}
	if (chat.type === "channel") {
		return refuse(
			409,
			"unsupported_chat_type",
			"That chat is a channel. The bridge needs a chat where the operator can reply to cards: a private chat with the bot, a group or a supergroup.",
		);
	}

	let membership: MembershipVerdict | null = null;
	if (chat.type !== "private") {
		let member: TelegramChatMember;
		try {
			const me = await getMe(config);
			member = await getChatMember(config, { chatId: String(chat.id), userId: me.id });
		} catch (error) {
			return refuse(
				502,
				"telegram_unavailable",
				`Could not read the bot's membership: ${describeTelegramError(error, config.botToken)}`,
			);
		}
		membership = evaluateBotMembership(member, chat);
		if (!membership.eligible) {
			return refuse(409, "bot_not_eligible", membership.reason, { membership });
		}
	}

	// The id Telegram answers with, not the one typed: getChat also accepts an
	// @username, and the webhook compares the binding with String(message.chat.id).
	const newChatId = String(chat.id);
	const isForum = isForumChat(chat);
	const previous = await readBinding(env);
	const unchanged = previous.chatId === newChatId && previous.isForum === isForum;

	const notes: string[] = [];
	if (isForum && membership && !membership.canManageTopics) {
		notes.push(
			"The bot cannot create topics here. Map each mailbox to a topic a person created: pnpm operator telegram topic <mailbox> --adopt <threadId> --apply.",
		);
	}
	if (previous.chatId && previous.chatId !== newChatId) {
		notes.push(
			`Cards already posted in ${previous.chatId} stay there, and replies to them are ignored once the binding moves. Mail held for the quiet-hours digest of that chat is not moved.`,
		);
	}

	if (!input.dryRun && !unchanged) {
		const db = env.INDEX_DB;
		await db.batch([
			runtimeConfigUpsert(db, RUNTIME_CONFIG_KEYS.telegramChatId, newChatId),
			runtimeConfigUpsert(db, RUNTIME_CONFIG_KEYS.telegramChatIsForum, isForum ? "1" : "0"),
			db
				.prepare(
					`INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					crypto.randomUUID(),
					"telegram.rebound",
					"info",
					newChatId,
					// Ids only: a chat title is text other people wrote.
					JSON.stringify({ oldChatId: previous.chatId, newChatId }),
					new Date().toISOString(),
				),
		]);
	}

	const topics = await listTelegramTopics(env.INDEX_DB);
	const outcome: RebindResult["outcome"] = input.dryRun
		? unchanged
			? "would_be_unchanged"
			: "would_rebind"
		: unchanged
			? "unchanged"
			: "rebound";
	return {
		ok: true,
		status: 200,
		body: {
			outcome,
			dryRun: input.dryRun,
			previous,
			current: { chatId: newChatId, isForum, type: chat.type, title: chat.title ?? null },
			membership,
			topics: {
				mappedInNewChat: topics.filter((row) => row.chat_id === newChatId).length,
				keptForOtherChats: topics.filter((row) => row.chat_id !== newChatId).length,
			},
			notes,
		},
	};
}
