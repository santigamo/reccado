/**
 * GET /api/telegram/status: everything the operator needs to know about the
 * bridge, in one read.
 *
 * Read-only toward Telegram -- getMe, getChat and getChatMember only. Topic
 * existence is reported as unverified; see TOPIC_UNVERIFIED_REASON for why no
 * probe can prove it without side effects.
 */

import { listMailboxes } from "../../db/d1";
import {
	getTelegramWebhookObservation,
	getTelegramWebhookRegistration,
	type TelegramWebhookObservation,
} from "../../db/runtime-config";
import { listTelegramTopics } from "../../db/telegram-topics";
import { getChat, getChatMember, getMe, readTelegramConfig } from "../api";
import { getTelegramStatus, type TelegramStatus } from "../status";
import {
	type BindingState,
	type BotView,
	botView,
	type ChatView,
	chatView,
	evaluateBotMembership,
	type MembershipVerdict,
	mappingView,
	type Probe,
	probe,
	readBinding,
	TOPIC_UNVERIFIED_REASON,
	type TopicMappingView,
} from "./shared";

export type TelegramOperatorStatus = {
	/** The same summary /api/health reports. */
	bridge: TelegramStatus;
	/** Null when the bridge is off (no token). */
	bot: Probe<BotView> | null;
	binding: BindingState;
	/** Telegram's own view of the bound chat; null when none is bound. */
	chat: Probe<ChatView> | null;
	/** Null with no bound chat, an unknown bot, or a private chat (no membership to read). */
	membership: Probe<MembershipVerdict> | null;
	webhook: {
		registration: { url: string; registeredAt: string } | null;
		observation: TelegramWebhookObservation | null;
	};
	/** One entry per active mailbox, with its mapping in the bound chat. */
	mailboxes: Array<{
		mailboxId: string;
		address: string;
		displayName: string | null;
		topic: TopicMappingView | null;
		topicVerified: false;
	}>;
	topicVerification: { verified: false; reason: string };
};

export async function getTelegramOperatorStatus(env: Env): Promise<TelegramOperatorStatus> {
	const config = readTelegramConfig(env);
	const [bridge, binding, registration, observation, mailboxes, topics] = await Promise.all([
		getTelegramStatus(env),
		readBinding(env),
		getTelegramWebhookRegistration(env.INDEX_DB),
		getTelegramWebhookObservation(env.INDEX_DB),
		listMailboxes(env.INDEX_DB),
		listTelegramTopics(env.INDEX_DB),
	]);

	let bot: TelegramOperatorStatus["bot"] = null;
	let chat: TelegramOperatorStatus["chat"] = null;
	let membership: TelegramOperatorStatus["membership"] = null;
	if (config) {
		const me = await probe(config, async () => ({ user: await getMe(config) }));
		bot = me.ok ? { ok: true, ...botView(me.user) } : me;
		const chatId = binding.chatId;
		if (chatId) {
			const observed = await probe(config, async () => ({
				chat: await getChat(config, { chatId }),
			}));
			chat = observed.ok ? { ok: true, ...chatView(observed.chat) } : observed;
			if (observed.ok && observed.chat.type !== "private" && me.ok) {
				const userId = me.user.id;
				const member = await probe(config, async () => ({
					member: await getChatMember(config, { chatId, userId }),
				}));
				membership = member.ok
					? { ok: true, ...evaluateBotMembership(member.member, observed.chat) }
					: member;
			}
		}
	}

	const inBoundChat = new Map(
		topics.filter((row) => row.chat_id === binding.chatId).map((row) => [row.mailbox_id, row]),
	);
	return {
		bridge,
		bot,
		binding,
		chat,
		membership,
		webhook: {
			// The fingerprint names the webhook secret without revealing it, but
			// nothing reading this needs it, so it stays in D1.
			registration: registration
				? { url: registration.url, registeredAt: registration.registeredAt }
				: null,
			observation,
		},
		mailboxes: mailboxes
			.filter((mailbox) => mailbox.status === "active")
			.map((mailbox) => {
				const row = inBoundChat.get(mailbox.mailbox_id);
				return {
					mailboxId: mailbox.mailbox_id,
					address: mailbox.primary_address,
					displayName: mailbox.display_name,
					topic: row ? mappingView(row, mailbox) : null,
					topicVerified: false as const,
				};
			}),
		topicVerification: { verified: false, reason: TOPIC_UNVERIFIED_REASON },
	};
}
