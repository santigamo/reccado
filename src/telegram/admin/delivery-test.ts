/**
 * POST /api/telegram/test: does each mailbox's card actually land in its topic?
 *
 * Before this, the only way to find out was to wait for real mail -- and a
 * wrong topic id does not even fail: Telegram answers ok:true and files the
 * message under General. So the test posts one clearly labelled message per
 * mailbox and reads where Telegram says it went.
 */

import { getMailbox, insertOpsEvent, listMailboxes, type MailboxRow } from "../../db/d1";
import { getTelegramTopicMapping } from "../../db/telegram-topics";
import { isMissingTopicError, readTelegramConfig, type TelegramMessage } from "../api";
import { chatSupportsTopics } from "../binding";
import { telegramEscape } from "../format";
import { sendToMailboxTopic, topicNameFor } from "../notify";
import {
	type AdminResult,
	bridgeDisabled,
	describeTelegramError,
	noChatBound,
	readBinding,
	refuse,
} from "./shared";

export type TopicDeliveryOutcome =
	| "delivered_to_topic"
	| "fell_back_to_general"
	/** Not a forum: there are no topics, and the message went to the chat itself. */
	| "delivered_to_chat"
	| "failed";

/**
 * Where a message landed, compared with where it was addressed.
 *
 * The comparison is the whole test: "the send succeeded" says nothing about
 * which topic the operator will find the message in. Only the
 * message_thread_id Telegram hands back does -- absent means General.
 */
export function classifyTopicDelivery(
	expectedTopicId: number | null,
	isForum: boolean,
	sent: Pick<TelegramMessage, "message_thread_id">,
): { outcome: TopicDeliveryOutcome; reason: string | null } {
	if (!isForum) {
		return { outcome: "delivered_to_chat", reason: null };
	}
	const landed = sent.message_thread_id ?? null;
	if (expectedTopicId !== null && landed === expectedTopicId) {
		return { outcome: "delivered_to_topic", reason: null };
	}
	if (landed === null) {
		return {
			outcome: "fell_back_to_general",
			reason:
				expectedTopicId === null
					? "No topic id was sent, so Telegram filed the message under General."
					: `Addressed to topic ${expectedTopicId}, but Telegram filed it under General.`,
		};
	}
	return {
		outcome: "failed",
		reason: `Addressed to topic ${expectedTopicId ?? "none"}, but it landed in thread ${landed}.`,
	};
}

/** Labelled so nobody mistakes it for mail, in the bot's own language. */
export function renderDeliveryTestMessage(input: {
	address: string;
	topicId: number | null;
}): string {
	return [
		"🧪 <b>Reccado · prueba de entrega</b>",
		`Buzón: <code>${telegramEscape(input.address)}</code>`,
		input.topicId === null ? "Chat sin topics." : `Topic esperado: <code>${input.topicId}</code>`,
		"",
		"Mensaje de prueba: no es un correo, y responder aquí no envía nada.",
	].join("\n");
}

export type DeliveryTestEntry = {
	mailboxId: string;
	address: string;
	/** The topic the message was addressed to; null in a non-forum chat or with no mapping. */
	topicId: number | null;
	outcome: TopicDeliveryOutcome;
	reason: string | null;
	messageId: number | null;
	/** The message_thread_id Telegram reported back, which the verdict is read from. */
	landedThreadId: number | null;
};

export type DeliveryTestResult = {
	chatId: string;
	isForum: boolean;
	/** True when every mailbox's message landed where its cards would. */
	ok: boolean;
	results: DeliveryTestEntry[];
};

/**
 * Posts the test message for each active mailbox (or the one given).
 *
 * Same stored forum flag, same mapping lookup and the same sendToMailboxTopic
 * as deliverInboundNotification, so a pass here means a card would land there
 * too. Two things a card does are deliberately left out:
 *
 * - no telegram_links row is written, so a reply to a test message resolves to
 *   no email and can never become an email reply;
 * - a missing mapping or a deleted topic is reported, not healed: the test must
 *   not create topics as a side effect of looking.
 */
export async function sendTelegramDeliveryTest(
	env: Env,
	input: { mailboxId?: string },
): Promise<AdminResult<DeliveryTestResult>> {
	const config = readTelegramConfig(env);
	if (!config) return bridgeDisabled();
	const binding = await readBinding(env);
	if (!binding.chatId) return noChatBound();
	const chatId = binding.chatId;
	const isForum = await chatSupportsTopics(env);

	let mailboxes: MailboxRow[];
	if (input.mailboxId) {
		const mailbox = await getMailbox(env.INDEX_DB, input.mailboxId);
		if (mailbox?.status !== "active") {
			return refuse(404, "mailbox_not_found", `No active mailbox ${input.mailboxId}.`);
		}
		mailboxes = [mailbox];
	} else {
		mailboxes = (await listMailboxes(env.INDEX_DB)).filter(
			(mailbox) => mailbox.status === "active",
		);
	}

	const results: DeliveryTestEntry[] = [];
	// Sequential on purpose: Telegram rate-limits a group to roughly one message
	// per second, and a burst would turn a routing test into a 429 test.
	for (const mailbox of mailboxes) {
		const mapping = isForum
			? await getTelegramTopicMapping(env.INDEX_DB, chatId, mailbox.mailbox_id)
			: null;
		const topicId = mapping?.topic_id ?? null;
		const base = { mailboxId: mailbox.mailbox_id, address: mailbox.primary_address, topicId };
		if (isForum && topicId === null) {
			results.push({
				...base,
				outcome: "failed",
				reason: `No topic is mapped in ${chatId}. The next real card creates one named "${topicNameFor(mailbox, mailbox.primary_address)}"; to choose it now: pnpm operator telegram topic ${mailbox.primary_address} --name "..." --apply.`,
				messageId: null,
				landedThreadId: null,
			});
			continue;
		}
		try {
			const sent = await sendToMailboxTopic(config, {
				chatId,
				topicId,
				text: renderDeliveryTestMessage({ address: mailbox.primary_address, topicId }),
			});
			const verdict = classifyTopicDelivery(topicId, isForum, sent);
			results.push({
				...base,
				...verdict,
				messageId: sent.message_id,
				landedThreadId: sent.message_thread_id ?? null,
			});
		} catch (error) {
			results.push({
				...base,
				outcome: "failed",
				reason: isMissingTopicError(error)
					? `Topic ${topicId} no longer exists in ${chatId}. The next real card recreates it; to choose now: pnpm operator telegram topic ${mailbox.primary_address} (--name "..." | --adopt <threadId>) --replace --apply.`
					: describeTelegramError(error, config.botToken),
				messageId: null,
				landedThreadId: null,
			});
		}
	}

	const ok =
		results.length > 0 &&
		results.every(
			(entry) => entry.outcome === "delivered_to_topic" || entry.outcome === "delivered_to_chat",
		);
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "telegram.delivery_test",
		severity: ok ? "info" : "warning",
		subject: chatId,
		payload_json: JSON.stringify({
			chatId,
			results: results.map((entry) => ({ mailboxId: entry.mailboxId, outcome: entry.outcome })),
		}),
	}).catch(() => undefined);

	return { ok: true, status: 200, body: { chatId, isForum, ok, results } };
}
