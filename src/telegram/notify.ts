import { getTelegramTopicForThread, insertOpsEvent, insertTelegramLink } from "../db/d1";
import { createForumTopic, readTelegramConfig, sendMessage, type TelegramConfig } from "./api";
import { renderInboundNotification } from "./format";

export type InboundNotificationInput = {
	mailboxId: string;
	mailboxAddress: string;
	messageLocalId: string;
	threadId: string;
	subject: string | null;
	fromAddr: string;
	snippet: string | null;
	hasAttachments: boolean;
};

/**
 * One forum topic per email thread, when the operator opted in.
 *
 * Topics in a private chat with a bot are a recent Bot API capability (9.3/9.4)
 * and depend on the user having topic mode enabled for this bot, so a failure
 * here is expected rather than exceptional: we fall back to a plain message,
 * which threads through reply_to_message instead and works everywhere.
 */
async function resolveTopicId(
	config: TelegramConfig,
	env: Env,
	input: InboundNotificationInput,
	chatId: string,
): Promise<number | null> {
	if (!config.useTopics) {
		return null;
	}
	const existing = await getTelegramTopicForThread(env.INDEX_DB, input.mailboxId, input.threadId);
	if (existing) {
		return existing;
	}
	try {
		const topic = await createForumTopic(config, {
			chatId,
			name: input.subject?.trim() || `Mail de ${input.fromAddr}`,
		});
		return topic.message_thread_id;
	} catch (error) {
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "telegram.topic_unavailable",
			severity: "warning",
			subject: input.mailboxId,
			payload_json: JSON.stringify({
				error: error instanceof Error ? error.message : String(error),
				hint: "Falling back to plain messages; replies still work via reply_to_message.",
			}),
		});
		return null;
	}
}

/**
 * Pushes a new-mail card to Telegram and records the link that makes a reply to
 * it resolvable. Never throws: a Telegram outage must not fail email ingest,
 * because the queue would retry the whole message and re-deliver it.
 */
export async function notifyInboundMail(env: Env, input: InboundNotificationInput): Promise<void> {
	let config: TelegramConfig | null;
	try {
		config = readTelegramConfig(env);
	} catch (error) {
		console.error("telegram.config_invalid", {
			error: error instanceof Error ? error.message : String(error),
		});
		return;
	}
	if (!config?.chatId) {
		return;
	}
	const chatId = config.chatId;

	try {
		const topicId = await resolveTopicId(config, env, input, chatId);
		const sent = await sendMessage(config, {
			chatId,
			text: renderInboundNotification({
				fromAddr: input.fromAddr,
				mailboxAddress: input.mailboxAddress,
				subject: input.subject,
				snippet: input.snippet,
				hasAttachments: input.hasAttachments,
			}),
			messageThreadId: topicId,
		});
		await insertTelegramLink(env.INDEX_DB, {
			chat_id: chatId,
			message_id: sent.message_id,
			mailbox_id: input.mailboxId,
			thread_id: input.threadId,
			message_local_id: input.messageLocalId,
			topic_id: topicId,
		});
	} catch (error) {
		console.error("telegram.notify_failed", {
			mailboxId: input.mailboxId,
			error: error instanceof Error ? error.message : String(error),
		});
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "telegram.notify_failed",
			severity: "warning",
			subject: input.messageLocalId,
			payload_json: JSON.stringify({
				mailboxId: input.mailboxId,
				error: error instanceof Error ? error.message : String(error),
			}),
		}).catch(() => undefined);
	}
}
