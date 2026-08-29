import { getMailbox, insertOpsEvent, insertTelegramLink } from "../db/d1";
import {
	claimTelegramTopic,
	forgetTelegramTopic,
	getTelegramTopicForMailbox,
} from "../db/telegram-topics";
import {
	createForumTopic,
	isMissingTopicError,
	readTelegramConfig,
	sendMessage,
	TelegramApiError,
	type TelegramConfig,
	type TelegramMessage,
} from "./api";
import { chatSupportsTopics, resolveTelegramChatId } from "./binding";
import { inboundNotificationKeyboard } from "./cards";
import { renderInboundNotification } from "./format";
import { isFirstContact } from "./index-rows";
import { fetchMailboxAttachments } from "./messages";
import { flushTelegramDigest, isQuietNow, isSenderMuted, retainNotification } from "./noise";

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
 * What a mailbox is called in the Telegram sidebar.
 *
 * The operator's own words for his own mailbox -- display_name if he set one,
 * otherwise the address itself. Pointedly NOT the email subject: a topic name is
 * permanent chrome in the operator's client, and deriving it from inbound mail
 * would hand every stranger who can send to this address a pen for the sidebar.
 */
function topicNameFor(
	mailbox: { display_name: string | null; primary_address: string } | null,
	fallbackAddress: string,
): string {
	return mailbox?.display_name?.trim() || mailbox?.primary_address || fallbackAddress;
}

/**
 * Retryable in the sense the notification queue means it: worth redelivering.
 *
 * Mirrors the consumer's own rule (429 and 5xx are about the moment, other 4xx
 * are about the request) so a topic that cannot be created *right now* costs a
 * redelivery instead of silently demoting this mailbox to flat messages, while a
 * bot that simply lacks manage_topics rights degrades once and stays useful.
 */
function isRetryable(error: unknown): boolean {
	if (error instanceof TelegramApiError) {
		return error.statusCode === 429 || error.statusCode >= 500;
	}
	return true;
}

/**
 * The topic this mailbox's mail belongs in, creating it the first time.
 *
 * One topic per mailbox, not per email thread: mailboxes are a bounded namespace
 * the operator curated, threads are unbounded input from strangers. See
 * migrations/d1/0010_telegram_topics.sql.
 *
 * Returns null when the chat has no topics at all, which is the ordinary case: a
 * private chat with the bot is a flat message stream, and replies there thread
 * through reply_to_message exactly as they always have.
 */
async function resolveTopicId(
	config: TelegramConfig,
	env: Env,
	input: InboundNotificationInput,
	chatId: string,
): Promise<number | null> {
	if (!(await chatSupportsTopics(env))) {
		return null;
	}
	const existing = await getTelegramTopicForMailbox(env.INDEX_DB, chatId, input.mailboxId);
	if (existing !== null) {
		return existing;
	}
	const mailbox = await getMailbox(env.INDEX_DB, input.mailboxId);
	try {
		const topic = await createForumTopic(config, {
			chatId,
			name: topicNameFor(mailbox, input.mailboxAddress),
		});
		return claimTelegramTopic(env.INDEX_DB, {
			chatId,
			mailboxId: input.mailboxId,
			topicId: topic.message_thread_id,
		});
	} catch (error) {
		if (isRetryable(error)) {
			throw error;
		}
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
 * Why a notification did not go out when nothing actually failed. These are
 * decisions about this deployment, identical on every redelivery, so the
 * consumer acks them instead of retrying a bridge that is simply off.
 */
export type NotifyOutcome =
	| { status: "sent" }
	| {
			status: "skipped";
			reason: "bridge_disabled" | "no_chat" | "muted_sender" | "quiet_hours";
	  };

/**
 * Pushes a new-mail card to Telegram and records the link that makes a reply to
 * it resolvable.
 *
 * Throws on transport failure, deliberately: this runs on the notification
 * queue, whose entire reason to exist is that Cloudflare can redeliver what
 * Telegram refused. The older swallow-everything contract belonged to the days
 * when this was awaited on the ingest ack path, where a throw would have
 * re-delivered an already-stored email.
 */
export async function deliverInboundNotification(
	env: Env,
	input: InboundNotificationInput,
): Promise<NotifyOutcome> {
	const config = readTelegramConfig(env);
	if (!config) {
		return { status: "skipped", reason: "bridge_disabled" };
	}
	// No operator check here on purpose: the allowlist governs who may give the bot
	// orders, not who may be told about mail. An unpaired bridge simply has no
	// adopted chat yet, and that is the skip that fires.
	// The adopted chat wins over anything a deploy manifest claims: it is the chat
	// the operator actually spoke from, observed rather than transcribed.
	const chatId = await resolveTelegramChatId(env);
	if (!chatId) {
		return { status: "skipped", reason: "no_chat" };
	}

	// Checked here rather than at ingest, and only ever against notifying: a muted
	// sender's mail is stored, indexed, searchable and answerable exactly like any
	// other. The decision is "do not interrupt me", not "do not keep this".
	if (await isSenderMuted(env.INDEX_DB, input.fromAddr)) {
		return { status: "skipped", reason: "muted_sender" };
	}

	// Before the quiet-hours check, so the first email after the window closes is
	// also what releases everything the window held. The hourly cron does the same
	// for a morning with no new mail; see docs/plans/telegram-roadmap.md.
	await flushTelegramDigest(env).catch((error: unknown) => {
		console.warn("telegram.digest_flush_failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
	if (await isQuietNow(env.INDEX_DB)) {
		await retainNotification(env.INDEX_DB, {
			chatId,
			mailboxId: input.mailboxId,
			mailboxAddress: input.mailboxAddress,
			messageLocalId: input.messageLocalId,
			threadId: input.threadId,
			fromAddr: input.fromAddr,
		});
		return { status: "skipped", reason: "quiet_hours" };
	}

	// Two extra reads, both earned. The badge is one indexed lookup and is the
	// single most useful thing a card can say about an address that receives cold
	// mail; the filenames are one Durable Object round trip taken only for the
	// minority of mail that carries files, and a failure degrades the card to the
	// old boolean rather than costing the notification.
	const [firstContact, attachments] = await Promise.all([
		isFirstContact(env.INDEX_DB, {
			fromAddr: input.fromAddr,
			messageLocalId: input.messageLocalId,
		}),
		input.hasAttachments
			? fetchMailboxAttachments(env, input.mailboxId, input.messageLocalId)
			: Promise.resolve(null),
	]);

	const text = renderInboundNotification({
		fromAddr: input.fromAddr,
		mailboxAddress: input.mailboxAddress,
		subject: input.subject,
		snippet: input.snippet,
		hasAttachments: input.hasAttachments,
		attachments: attachments?.map((attachment) => ({
			filename: attachment.filename,
			size: attachment.size,
		})),
		firstContact,
	});
	// The card carries what can be done with the mail, not just what it says: most
	// email is dispatched rather than answered, and a card with no buttons made
	// Telegram useful only for the minority that needs a sentence back.
	const replyMarkup = await inboundNotificationKeyboard(env, {
		mailboxId: input.mailboxId,
		threadId: input.threadId,
		fromAddr: input.fromAddr,
		hasAttachments: input.hasAttachments,
	});

	let topicId = await resolveTopicId(config, env, input, chatId);
	let sent: TelegramMessage;
	try {
		sent = await sendMessage(config, { chatId, text, messageThreadId: topicId, replyMarkup });
	} catch (error) {
		// The operator deleted the topic. Nothing here is broken -- deleting a topic
		// is a normal thing to do -- but the stored id is now a dead address, and
		// without healing it every future email for this mailbox would fail the same
		// way, which is exactly the silent failure this bridge keeps rediscovering.
		if (topicId === null || !isMissingTopicError(error)) {
			throw error;
		}
		await forgetTelegramTopic(env.INDEX_DB, chatId, input.mailboxId);
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "telegram.topic_recreated",
			severity: "info",
			subject: input.mailboxId,
			payload_json: JSON.stringify({ chatId, staleTopicId: topicId }),
		}).catch(() => undefined);
		// Exactly one retry: a second miss means the failure is not the topic, and
		// looping on it would burn the chat's rate-limit budget instead of the
		// queue's backoff.
		topicId = await resolveTopicId(config, env, input, chatId);
		sent = await sendMessage(config, { chatId, text, messageThreadId: topicId, replyMarkup });
	}
	// Inside the retried path on purpose: without this row a reply typed in
	// Telegram resolves to no thread and is dropped, and a card the operator sees
	// twice is a cheaper failure than an answer that never leaves the phone.
	await insertTelegramLink(env.INDEX_DB, {
		chat_id: chatId,
		message_id: sent.message_id,
		mailbox_id: input.mailboxId,
		thread_id: input.threadId,
		message_local_id: input.messageLocalId,
		topic_id: topicId,
	});
	return { status: "sent" };
}
