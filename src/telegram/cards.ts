/**
 * The inbound card as an object the operator can act on, instead of a dead end.
 *
 * Most mail is not answered, it is dispatched — and until these buttons existed
 * the only thing Telegram could do with an email was reply to it, so the surface
 * served the fifth of the inbox that needs a sentence and ignored the rest.
 *
 * Two things live here: what a card looks like after something happens to it
 * (renderInboundNotification plus a status line, re-rendered from the same D1 row
 * that produced it, so an edit never rewrites what the operator was told), and
 * the two entry points that produce such an edit — a button press arriving on the
 * webhook, and a state change on another surface arriving on the notify queue.
 */

import type { TelegramCardRefreshQueueMessage } from "../cloudflare/types";
import {
	getMailbox,
	getTelegramLinkByMessage,
	insertTelegramLink,
	type TelegramLinkRow,
} from "../db/d1";
import { getRuntimeConfig, RUNTIME_CONFIG_KEYS } from "../db/runtime-config";
import {
	answerCallbackQuery,
	editMessageText,
	inlineKeyboard,
	isNotModifiedError,
	readTelegramConfig,
	sendDocument,
	sendMessage,
	type TelegramCallbackQuery,
	type TelegramConfig,
	type TelegramInlineButton,
	type TelegramMessage,
} from "./api";
import { deliverAttachments, describeDelivery } from "./attachments";
import { resolveTelegramChatId } from "./binding";
import {
	chunkTelegramText,
	type InboundNotification,
	renderInboundNotification,
	type TelegramCardStatus,
} from "./format";
import { getMailIndexRow, isFirstContact, type MailIndexRow } from "./index-rows";
import { findCardForMessage, findCardForThread } from "./links";
import {
	applyMailboxMessageAction,
	fetchMailboxAttachments,
	fetchMailboxMessage,
} from "./messages";
import { getRetainedItem, isSenderMuted, toggleSenderMute } from "./noise";

/**
 * The whole callback protocol: a version and a verb, two bytes of payload.
 *
 * Deliberately not the token table the send-confirmation buttons use. That one
 * exists because callback_data is capped at 64 bytes and a mailbox id plus a
 * draft id do not fit — and because a Send button carries the authority to mail
 * a stranger, so its token is bound to the account it was shown to. A card button
 * needs neither: the callback query carries query.message.message_id, and
 * (chat_id, message_id) is already a row in telegram_links naming the mailbox,
 * the message and the thread. Storing a token to rediscover what Telegram just
 * told us would be a table with no question to answer.
 */
export const CARD_CALLBACK_PREFIX = "v1:";

const CARD_VERBS = {
	a: "archive",
	r: "mark_read",
	x: "read_full",
	/** Stop announcing this sender. The mail keeps arriving and keeps being stored. */
	m: "toggle_mute",
	/** Push the email's files into the chat as documents. */
	f: "attachments",
} as const;

type CardVerb = keyof typeof CARD_VERBS;

/**
 * Trash is missing on purpose. A delete button one thumb-width from archive, on a
 * phone, is a machine for mistakes — and the two mistakes are not symmetric: an
 * email archived by accident costs a search, an email trashed by accident costs
 * the email. Archiving is the verb that makes the inbox empty; deleting is the
 * verb that makes mail disappear, and that one keeps needing a bigger screen.
 */
function inboundCardKeyboard(input: {
	mailboxId: string;
	threadId: string;
	origin: string | null;
	muted: boolean;
	hasAttachments: boolean;
}): TelegramInlineButton[][] {
	const buttons: TelegramInlineButton[] = [
		{ text: "📥 Archivar", callback_data: `${CARD_CALLBACK_PREFIX}a` },
		{ text: "📄 Leer completo", callback_data: `${CARD_CALLBACK_PREFIX}x` },
	];
	// No origin means nobody has ever reached this deployment over its public
	// hostname, so there is no URL to offer. A button pointing at a guess would be
	// a broken link on every card until someone noticed.
	if (input.origin) {
		buttons.push({
			text: "↗ Abrir",
			url: `${input.origin}/mailboxes/${input.mailboxId}/${input.threadId}`,
		});
	}
	// Second row, and deliberately quieter than the first: these two answer
	// questions about the sender and the payload rather than about the mail's
	// state, and neither should sit a thumb-width from Archivar.
	const secondary: TelegramInlineButton[] = [
		{
			text: input.muted ? "🔔 Reactivar" : "🔕 Silenciar",
			callback_data: `${CARD_CALLBACK_PREFIX}m`,
		},
	];
	if (input.hasAttachments) {
		secondary.push({ text: "📎 Adjuntos", callback_data: `${CARD_CALLBACK_PREFIX}f` });
	}
	return [buttons, secondary];
}

/**
 * Statuses that close a card. Archived and trashed mail is dealt with, and
 * leaving buttons under it invites a second decision about a first one that was
 * already made.
 */
const CLOSED_STATUSES = new Set<TelegramCardStatus>(["archived", "trashed"]);

export type CardKeyboardInput = {
	mailboxId: string;
	threadId: string;
	fromAddr: string;
	hasAttachments: boolean;
	status: TelegramCardStatus | null;
};

async function cardKeyboardFor(
	env: Env,
	input: CardKeyboardInput,
): Promise<Record<string, unknown> | undefined> {
	if (input.status && CLOSED_STATUSES.has(input.status)) {
		return undefined;
	}
	// Both reads are indexed single-row lookups, and both have to happen at draw
	// time rather than at delivery time: the mute button is a toggle, so a card
	// restated after a press must come back with the opposite label or the operator
	// cannot tell whether the press did anything.
	const [origin, muted] = await Promise.all([
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.deploymentOrigin),
		isSenderMuted(env.INDEX_DB, input.fromAddr),
	]);
	return inlineKeyboard(inboundCardKeyboard({ ...input, origin, muted }));
}

/** The buttons a freshly delivered card carries. */
export async function inboundNotificationKeyboard(
	env: Env,
	input: Omit<CardKeyboardInput, "status">,
): Promise<Record<string, unknown> | undefined> {
	return cardKeyboardFor(env, { ...input, status: null });
}

function firstRecipient(toJson: string | null): string | null {
	if (!toJson) return null;
	try {
		const parsed = JSON.parse(toJson) as unknown;
		if (!Array.isArray(parsed)) return null;
		const first = parsed.find((entry) => typeof entry === "string" && entry.trim().length > 0);
		return typeof first === "string" ? first : null;
	} catch {
		return null;
	}
}

/**
 * The card's content, re-read rather than remembered.
 *
 * message_index holds exactly the four facts the card shows, written by the
 * ingest consumer before the notification was ever queued — so re-rendering from
 * it reproduces the original card instead of approximating it, and no copy of the
 * card text has to be carried through a queue or stored a second time.
 */
export async function loadCardContent(
	env: Env,
	input: { mailboxId: string; messageLocalId: string },
): Promise<InboundNotification | null> {
	const row = await getMailIndexRow(env.INDEX_DB, input.mailboxId, input.messageLocalId);
	if (!row) return null;
	return cardContentFor(env, row);
}

/**
 * One message_index row as a card.
 *
 * Shared by every producer of cards — the notifier, a search hit, an item pulled
 * out of a digest, a restatement after a button — because "a retrieved card is
 * indistinguishable from one that arrived" is the property the whole retrieval
 * feature rests on. Two renderers would have drifted apart within a week.
 */
export async function cardContentFor(env: Env, row: MailIndexRow): Promise<InboundNotification> {
	const mailboxAddress =
		firstRecipient(row.to_json) ??
		(await getMailbox(env.INDEX_DB, row.mailbox_id))?.primary_address ??
		row.mailbox_id;
	const [attachments, firstContact] = await Promise.all([
		row.has_attachments === 1
			? fetchMailboxAttachments(env, row.mailbox_id, row.message_local_id)
			: Promise.resolve(null),
		isFirstContact(env.INDEX_DB, {
			fromAddr: row.from_addr,
			messageLocalId: row.message_local_id,
		}),
	]);
	return {
		fromAddr: row.from_addr,
		mailboxAddress,
		subject: row.subject,
		snippet: row.snippet,
		hasAttachments: row.has_attachments === 1,
		attachments: attachments?.map((attachment) => ({
			filename: attachment.filename,
			size: attachment.size,
		})),
		firstContact,
	};
}

export type CardEditOutcome = "edited" | "unchanged" | "unknown_message";

/**
 * Restates one card with the state its email is actually in.
 *
 * Throws whatever the Bot API throws, deliberately — on the queue that is the
 * signal to redeliver, and the one caller that cannot retry (a button press)
 * catches it itself.
 */
async function restateCard(
	env: Env,
	config: TelegramConfig,
	input: { link: TelegramLinkRow; status: TelegramCardStatus | null },
): Promise<CardEditOutcome> {
	const content = await loadCardContent(env, {
		mailboxId: input.link.mailbox_id,
		messageLocalId: input.link.message_local_id,
	});
	if (!content) {
		return "unknown_message";
	}
	try {
		await editMessageText(config, {
			chatId: input.link.chat_id,
			messageId: input.link.message_id,
			text: renderInboundNotification({ ...content, status: input.status }),
			replyMarkup: await cardKeyboardFor(env, {
				mailboxId: input.link.mailbox_id,
				threadId: input.link.thread_id,
				fromAddr: content.fromAddr,
				hasAttachments: content.hasAttachments,
				status: input.status,
			}),
		});
		return "edited";
	} catch (error) {
		// Reconciling a state the card already shows is the ordinary outcome of two
		// surfaces agreeing, not a failure worth a redelivery.
		if (isNotModifiedError(error)) {
			return "unchanged";
		}
		throw error;
	}
}

// --- reconciliation from other surfaces ------------------------------------

/**
 * "Something happened to this email somewhere else."
 *
 * Identified by message when the actor knew which message it touched, and by
 * thread when it did not: a reply confirmed on the web or through MCP answers a
 * conversation, and the card worth marking is the newest one of that thread.
 */
export type TelegramCardRefresh = {
	mailboxId: string;
	messageLocalId: string | null;
	threadId: string | null;
	status: TelegramCardStatus;
};

/** Which status an API triage verb leaves the card in. */
export const CARD_STATUS_FOR_ACTION = {
	archive: "archived",
	trash: "trashed",
	restore_inbox: "inbox",
	mark_read: "read",
	mark_unread: "unread",
} as const satisfies Record<string, TelegramCardStatus>;

export type CardRefreshOutcome =
	| { status: "edited" | "unchanged" }
	| {
			status: "skipped";
			reason: "bridge_disabled" | "no_chat" | "no_card" | "unknown_message";
	  };

/**
 * Edits the card that announced an email whose state changed elsewhere.
 *
 * Every skip here is permanent by construction — a bridge with no token, a
 * deployment with no adopted chat, an email Telegram never announced — so the
 * consumer acks them. Only transport failures throw, and those are exactly the
 * ones worth redelivering.
 */
export async function refreshTelegramCard(
	env: Env,
	refresh: TelegramCardRefresh,
): Promise<CardRefreshOutcome> {
	const config = readTelegramConfig(env);
	if (!config) {
		return { status: "skipped", reason: "bridge_disabled" };
	}
	const chatId = await resolveTelegramChatId(env);
	if (!chatId) {
		return { status: "skipped", reason: "no_chat" };
	}
	const link = refresh.messageLocalId
		? await findCardForMessage(env.INDEX_DB, {
				chatId,
				mailboxId: refresh.mailboxId,
				messageLocalId: refresh.messageLocalId,
			})
		: refresh.threadId
			? await findCardForThread(env.INDEX_DB, {
					chatId,
					mailboxId: refresh.mailboxId,
					threadId: refresh.threadId,
				})
			: null;
	// Most mail is never announced in Telegram — the bridge may have been off, the
	// card may predate this chat. Nothing failed; there is simply nothing to edit.
	if (!link) {
		return { status: "skipped", reason: "no_card" };
	}
	const outcome = await restateCard(env, config, { link, status: refresh.status });
	return outcome === "unknown_message"
		? { status: "skipped", reason: "unknown_message" }
		: { status: outcome };
}

/**
 * Queues a card edit, best effort.
 *
 * On the notify queue rather than inline: it is the one place that already
 * serializes work per chat and backs off on 429, and Telegram counts an edit
 * against the same ~1 message per second the cards themselves spend. Doing it
 * inline would also make an API request wait on Telegram to answer something the
 * caller does not care about.
 *
 * Never throws, and never enqueues on a deployment with no bot token: archiving
 * an email must not fail because a chat bridge is unavailable or absent.
 */
export async function enqueueTelegramCardRefresh(
	env: Env,
	refresh: TelegramCardRefresh,
): Promise<void> {
	if (!readTelegramConfig(env)) {
		return;
	}
	try {
		await env.NOTIFY_QUEUE.send({
			schemaVersion: 1,
			eventType: "telegram.card_refresh.v1",
			refresh,
		} satisfies TelegramCardRefreshQueueMessage);
	} catch (error) {
		console.error("telegram.card_refresh_enqueue_failed", {
			mailboxId: refresh.mailboxId,
			status: refresh.status,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

// --- cards for mail nobody just received -----------------------------------

/**
 * Posts a card for an email the operator went looking for, and records the link
 * that makes it operable.
 *
 * The link insert is the whole idea. A card is not a rendering, it is an object:
 * quoting it composes a reply, its buttons archive and read and silence, and all
 * of that resolves through (chat_id, message_id) in telegram_links. Emitting the
 * row at the same moment as the message means a search hit, a digest item and an
 * email that arrived on its own are the same thing to every code path downstream
 * — instead of retrieval being a second, read-only rendering of the inbox that
 * quietly does nothing when you reply to it.
 */
export async function postMailCard(
	env: Env,
	config: TelegramConfig,
	input: {
		chatId: string;
		topicId: number | null;
		row: MailIndexRow;
		replyToMessageId?: number | null;
	},
): Promise<TelegramMessage> {
	const content = await cardContentFor(env, input.row);
	const sent = await sendMessage(config, {
		chatId: input.chatId,
		text: renderInboundNotification(content),
		messageThreadId: input.topicId,
		replyToMessageId: input.replyToMessageId ?? null,
		replyMarkup: await inboundNotificationKeyboard(env, {
			mailboxId: input.row.mailbox_id,
			threadId: input.row.thread_id,
			fromAddr: input.row.from_addr,
			hasAttachments: input.row.has_attachments === 1,
		}),
	});
	await insertTelegramLink(env.INDEX_DB, {
		chat_id: input.chatId,
		message_id: sent.message_id,
		mailbox_id: input.row.mailbox_id,
		thread_id: input.row.thread_id,
		message_local_id: input.row.message_local_id,
		topic_id: input.topicId,
	});
	return sent;
}

/**
 * Turns one numbered line of a digest back into a card.
 *
 * The summary is an index, not a copy: it carries nothing but sender and subject,
 * and the row id in its buttons is the address of the real email. Expanding one
 * posts the ordinary card — link included — so the night's mail is triaged with
 * exactly the buttons the operator already knows.
 */
export async function handleDigestExpand(
	env: Env,
	config: TelegramConfig,
	query: TelegramCallbackQuery,
	retainedId: string,
): Promise<void> {
	const item = await getRetainedItem(env.INDEX_DB, retainedId);
	if (!item) {
		await answer(config, query.id, "Ese resumen ya no está disponible.");
		return;
	}
	const row = await getMailIndexRow(env.INDEX_DB, item.mailbox_id, item.message_local_id);
	if (!row) {
		await answer(config, query.id, "Ese correo ya no está en el índice.");
		return;
	}
	await postMailCard(env, config, {
		chatId: item.chat_id,
		topicId: query.message?.message_thread_id ?? null,
		row,
		replyToMessageId: query.message?.message_id ?? null,
	});
	await answer(config, query.id);
}

// --- reconciliation from the buttons themselves ----------------------------

/** More than this many pieces and the body stops being a chat and becomes a file. */
const MAX_BODY_CHUNKS = 3;

export function isCardCallback(data: string): boolean {
	return data.startsWith(CARD_CALLBACK_PREFIX);
}

function verbOf(data: string): CardVerb | null {
	const verb = data.slice(CARD_CALLBACK_PREFIX.length);
	return verb in CARD_VERBS ? (verb as CardVerb) : null;
}

/** Answers the press, so Telegram stops spinning whatever the outcome was. */
async function answer(config: TelegramConfig, queryId: string, text?: string): Promise<void> {
	await answerCallbackQuery(config, { callbackQueryId: queryId, text });
}

/**
 * Restates the card after an action that already succeeded.
 *
 * A failed edit is reported instead of thrown: the Durable Object has already
 * changed the message, and letting the webhook return non-2xx would have Telegram
 * redeliver the update — replaying the action and, for "leer completo", dumping
 * the body into the chat a second time.
 */
async function restateAfterAction(
	env: Env,
	config: TelegramConfig,
	input: { link: TelegramLinkRow; status: TelegramCardStatus | null; done: string },
): Promise<string> {
	try {
		await restateCard(env, config, input);
		return input.done;
	} catch (error) {
		console.warn("telegram.card_edit_failed", {
			chatId: input.link.chat_id,
			messageId: input.link.message_id,
			error: error instanceof Error ? error.message : String(error),
		});
		return `${input.done} (la tarjeta no se pudo actualizar)`;
	}
}

/** Sends the body under the card: inline while it is readable, as a file when it isn't. */
async function deliverFullBody(
	config: TelegramConfig,
	link: TelegramLinkRow,
	body: string,
): Promise<void> {
	const chunks = chunkTelegramText(body);
	if (chunks.length > MAX_BODY_CHUNKS) {
		// Four screens of quoted newsletter is not something anyone reads in a chat,
		// and posting it would spend the chat's whole rate-limit budget to do it.
		await sendDocument(config, {
			chatId: link.chat_id,
			filename: `${link.message_local_id}.txt`,
			content: body,
			caption: `📄 Cuerpo completo (${body.length} caracteres)`,
			messageThreadId: link.topic_id,
			replyToMessageId: link.message_id,
		});
		return;
	}
	for (const chunk of chunks) {
		await sendMessage(config, {
			chatId: link.chat_id,
			text: chunk,
			messageThreadId: link.topic_id,
			replyToMessageId: link.message_id,
		});
	}
}

/**
 * Runs a card button.
 *
 * The caller has already established that the presser is an operator -- the verb
 * carries no authority of its own, so that check is the whole guard -- and that
 * the data is ours. Everything else is established here.
 */
export async function handleCardCallback(
	env: Env,
	config: TelegramConfig,
	query: TelegramCallbackQuery,
): Promise<void> {
	const verb = verbOf(query.data ?? "");
	// The card is the address: without the message this press came from there is
	// nothing to look up, and Telegram omits it only for presses old enough that
	// acting on them blind would be worse than saying so.
	if (!verb || !query.message) {
		await answer(config, query.id, "Esta tarjeta ya no está disponible.");
		return;
	}
	const chatId = String(query.message.chat.id);
	const link = await getTelegramLinkByMessage(env.INDEX_DB, chatId, query.message.message_id);
	if (!link) {
		await answer(config, query.id, "No sé de qué correo es esta tarjeta.");
		return;
	}

	if (verb === "x") {
		const message = await fetchMailboxMessage(env, link.mailbox_id, link.message_local_id);
		const body = message?.body_text?.trim();
		if (!body) {
			await answer(config, query.id, "Ese correo no tiene cuerpo de texto que mostrar.");
			return;
		}
		try {
			await deliverFullBody(config, link, body);
		} catch (error) {
			// Answered rather than thrown: a non-2xx webhook has Telegram redeliver the
			// update, and a redelivered "leer completo" would dump the body into the
			// chat a second time. The operator is told, and one more tap retries it.
			console.warn("telegram.card_body_failed", {
				chatId: link.chat_id,
				messageId: link.message_id,
				error: error instanceof Error ? error.message : String(error),
			});
			await answer(config, query.id, "No he podido enviar el cuerpo. Inténtalo otra vez.");
			return;
		}
		// Reading it here finally counts as reading it. The card's own argument for
		// not shipping bodies by default was that reading the whole message should be
		// an explicit act — pressing a button is one, and an act the rest of Reccado
		// should know about.
		const marked = await applyMailboxMessageAction(env, {
			mailboxId: link.mailbox_id,
			messageLocalId: link.message_local_id,
			action: "mark_read",
		});
		await answer(
			config,
			query.id,
			marked
				? await restateAfterAction(env, config, { link, status: "read", done: "Leído" })
				: "Enviado, pero no pude marcarlo como leído.",
		);
		return;
	}

	if (verb === "m") {
		const content = await loadCardContent(env, {
			mailboxId: link.mailbox_id,
			messageLocalId: link.message_local_id,
		});
		if (!content) {
			await answer(config, query.id, "No encuentro ese correo en el índice.");
			return;
		}
		const muted = await toggleSenderMute(env.INDEX_DB, {
			sender: content.fromAddr,
			mutedBy: String(query.from.id),
		});
		// Restated with no status change: the only thing that moved is the button's
		// own label, which is also the only place the mute is visible at all — so a
		// restatement that failed is worth saying out loud.
		const restated = await restateAfterAction(env, config, {
			link,
			status: null,
			done: muted
				? `🔕 ${content.fromAddr}: se guardará, no avisaré. Pulsa 🔔 para deshacer.`
				: `🔔 ${content.fromAddr}: vuelvo a avisar.`,
		});
		await answer(config, query.id, restated);
		return;
	}

	if (verb === "f") {
		try {
			const delivery = await deliverAttachments(env, config, link);
			await answer(
				config,
				query.id,
				delivery ? describeDelivery(delivery) : "Ese correo no trae adjuntos.",
			);
		} catch (error) {
			// Answered rather than thrown, for the reason "leer completo" is: a non-2xx
			// makes Telegram redeliver the press, and a redelivered press would upload
			// every file a second time.
			console.warn("telegram.card_attachments_failed", {
				chatId: link.chat_id,
				messageId: link.message_id,
				error: error instanceof Error ? error.message : String(error),
			});
			await answer(config, query.id, "No he podido enviar los adjuntos. Inténtalo otra vez.");
		}
		return;
	}

	const action = verb === "a" ? "archive" : "mark_read";
	const applied = await applyMailboxMessageAction(env, {
		mailboxId: link.mailbox_id,
		messageLocalId: link.message_local_id,
		action,
	});
	if (!applied) {
		await answer(config, query.id, "El buzón no aceptó la acción.");
		return;
	}
	await answer(
		config,
		query.id,
		await restateAfterAction(
			env,
			config,
			verb === "a"
				? { link, status: "archived", done: "Archivado" }
				: { link, status: "read", done: "Marcado como leído" },
		),
	);
}
