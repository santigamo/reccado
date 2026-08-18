import {
	deleteTelegramAction,
	getTelegramAction,
	getTelegramLinkByMessage,
	getTelegramLinkByTopic,
	insertTelegramAction,
	type TelegramLinkRow,
} from "../db/d1";
import { sha256Hex } from "../lib/crypto";
import {
	plainTextToHtml,
	type QuotedParent,
	quoteHtmlForReply,
	quoteTextForReply,
	replySubject,
} from "../lib/email-headers";
import { confirmDraftSend } from "../lib/outbound-send";
import {
	answerCallbackQuery,
	editMessageText,
	inlineKeyboard,
	readTelegramConfig,
	sendMessage,
	type TelegramCallbackQuery,
	type TelegramConfig,
	type TelegramMessage,
	type TelegramUpdate,
} from "./api";
import { entitiesToHtml, renderDraftPreview, telegramEscape } from "./format";

/** How long an inline Send button stays live. */
const ACTION_TTL_MS = 24 * 60 * 60 * 1000;

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const bytesA = new Uint8Array(digestA);
	const bytesB = new Uint8Array(digestB);
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= bytesA[i]! ^ bytesB[i]!;
	}
	return diff === 0;
}

/**
 * Deterministic action token derived from the Telegram message that produced the
 * draft. Telegram retries updates it thinks failed; a random token would mint a
 * second button (and a second send attempt key) for the same reply.
 */
async function actionToken(chatId: string, messageId: number): Promise<string> {
	const digest = await sha256Hex(new TextEncoder().encode(`tg:${chatId}:${messageId}`));
	return digest.slice(0, 24);
}

type DoMessageRow = {
	id: string;
	subject: string | null;
	from_addr: string;
	date_header: string | null;
	received_at: string;
	body_text: string | null;
};

async function fetchMessage(
	env: Env,
	mailboxId: string,
	messageLocalId: string,
): Promise<DoMessageRow | null> {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const response = await stub.fetch(`https://mailbox-do/messages/${messageLocalId}`);
	if (!response.ok) {
		return null;
	}
	// The DO answers 200 with a hollow object for an unknown id, so presence of the
	// sender — the one field a reply cannot be built without — is the real check.
	const payload = (await response.json()) as { message?: Partial<DoMessageRow> };
	return payload.message?.from_addr ? (payload.message as DoMessageRow) : null;
}

function isAllowed(config: TelegramConfig, userId: string | number | undefined): boolean {
	return userId !== undefined && config.allowedUserIds.has(String(userId));
}

async function resolveLink(
	env: Env,
	chatId: string,
	message: TelegramMessage,
): Promise<TelegramLinkRow | null> {
	if (message.reply_to_message) {
		const byReply = await getTelegramLinkByMessage(
			env.INDEX_DB,
			chatId,
			message.reply_to_message.message_id,
		);
		if (byReply) return byReply;
	}
	if (message.message_thread_id) {
		return getTelegramLinkByTopic(env.INDEX_DB, chatId, message.message_thread_id);
	}
	return null;
}

async function handleMessage(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
): Promise<void> {
	const chatId = String(message.chat.id);
	if (!isAllowed(config, message.from?.id)) {
		console.warn("telegram.unauthorized_user", { chatId, userId: message.from?.id });
		return;
	}
	// A configured notification chat is also the only chat we act on: it stops the
	// bot from taking orders in a group someone added it to.
	if (config.chatId && chatId !== config.chatId) {
		console.warn("telegram.unexpected_chat", { chatId });
		return;
	}

	const text = message.text ?? message.caption;
	if (!text?.trim()) {
		await sendMessage(config, {
			chatId,
			text: "Por ahora solo puedo enviar texto. Los adjuntos hay que subirlos desde Reccado.",
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}

	if (text.startsWith("/start") || text.startsWith("/help") || text.startsWith("/id")) {
		await sendMessage(config, {
			chatId,
			text: [
				"<b>Reccado</b> conectado.",
				`chat_id: <code>${telegramEscape(chatId)}</code>`,
				`user_id: <code>${telegramEscape(String(message.from?.id ?? ""))}</code>`,
				"",
				"Responde a una notificación de correo para contestar por email.",
			].join("\n"),
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}

	const link = await resolveLink(env, chatId, message);
	if (!link) {
		await sendMessage(config, {
			chatId,
			text: "No sé a qué correo responde esto. Contesta citando la notificación del mensaje.",
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}

	const parentMessage = await fetchMessage(env, link.mailbox_id, link.message_local_id);
	if (!parentMessage) {
		await sendMessage(config, {
			chatId,
			text: "No encuentro el mensaje original en el buzón.",
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}

	const parent: QuotedParent = {
		fromAddr: parentMessage.from_addr,
		date: parentMessage.date_header ?? parentMessage.received_at,
		bodyText: parentMessage.body_text,
	};
	const subject = replySubject(parentMessage.subject);
	const bodyText = quoteTextForReply(text, parent);
	const bodyHtml = quoteHtmlForReply(
		message.entities?.length || message.caption_entities?.length
			? entitiesToHtml(text, message.entities ?? message.caption_entities)
			: plainTextToHtml(text),
		parent,
	);

	const stub = env.MAILBOX_DO.getByName(link.mailbox_id);
	const draftResponse = await stub.fetch("https://mailbox-do/drafts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			threadId: link.thread_id,
			to: [parentMessage.from_addr],
			cc: [],
			bcc: [],
			subject,
			bodyText,
			bodyHtml,
			createdBy: `telegram:${message.from?.id ?? "unknown"}`,
			// Same Telegram message => same draft, so a retried update doesn't queue
			// a second reply.
			idempotencyKey: `tg:${chatId}:${message.message_id}`,
		}),
	});
	if (!draftResponse.ok) {
		await sendMessage(config, {
			chatId,
			text: "No he podido crear el borrador.",
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}
	const draft = (await draftResponse.json()) as { id: string };

	const armResponse = await stub.fetch(`https://mailbox-do/drafts/${draft.id}/request-send`, {
		method: "POST",
	});
	const armed = (await armResponse.json()) as { status?: string };
	if (armed.status !== "pending_confirmation") {
		// The draft is already sent or cancelled — which is what a retried Telegram
		// update looks like. Say so instead of offering a Send button that would do
		// nothing.
		await sendMessage(config, {
			chatId,
			text:
				armed.status === "sent"
					? "Esa respuesta ya se envió."
					: "Ese borrador ya no se puede enviar.",
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}

	const token = await actionToken(chatId, message.message_id);
	await insertTelegramAction(env.INDEX_DB, {
		token,
		kind: "confirm_send",
		mailbox_id: link.mailbox_id,
		draft_id: draft.id,
		telegram_user_id: String(message.from?.id ?? ""),
		expires_at: new Date(Date.now() + ACTION_TTL_MS).toISOString(),
	});

	await sendMessage(config, {
		chatId,
		text: renderDraftPreview({ to: [parentMessage.from_addr], subject, bodyText: text }),
		replyToMessageId: message.message_id,
		messageThreadId: message.message_thread_id ?? null,
		replyMarkup: inlineKeyboard([
			[
				{ text: "✅ Enviar", callback_data: `s:${token}` },
				{ text: "✖️ Descartar", callback_data: `x:${token}` },
			],
		]),
	});
}

async function handleCallbackQuery(
	env: Env,
	config: TelegramConfig,
	query: TelegramCallbackQuery,
): Promise<void> {
	if (!isAllowed(config, query.from.id)) {
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "No autorizado" });
		return;
	}
	const data = query.data ?? "";
	const [kind, token] = [data.slice(0, 1), data.slice(2)];
	if (!token || (kind !== "s" && kind !== "x")) {
		await answerCallbackQuery(config, { callbackQueryId: query.id });
		return;
	}

	const action = await getTelegramAction(env.INDEX_DB, token);
	if (!action || new Date(action.expires_at).getTime() < Date.now()) {
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "Caducado" });
		return;
	}
	// The button is bound to the person it was shown to, not just to the allowlist.
	if (action.telegram_user_id !== String(query.from.id)) {
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "No autorizado" });
		return;
	}

	const chatId = query.message ? String(query.message.chat.id) : config.chatId;
	const messageId = query.message?.message_id;

	if (kind === "x") {
		const stub = env.MAILBOX_DO.getByName(action.mailbox_id);
		await stub.fetch(`https://mailbox-do/drafts/${action.draft_id}/cancel`, { method: "POST" });
		await deleteTelegramAction(env.INDEX_DB, token);
		if (chatId && messageId) {
			await editMessageText(config, { chatId, messageId, text: "✖️ Borrador descartado." });
		}
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "Descartado" });
		return;
	}

	// Same send path as the web UI: the D1 ledger and the message index stay
	// consistent regardless of which surface confirmed.
	const { body } = await confirmDraftSend(env, {
		mailboxId: action.mailbox_id,
		draftId: action.draft_id,
		attemptKey: token,
		approvalMode: "telegram_confirmed",
	});
	await deleteTelegramAction(env.INDEX_DB, token);

	const sent = body.sent === true || body.status === "sent";
	if (chatId && messageId) {
		await editMessageText(config, {
			chatId,
			messageId,
			text: sent
				? "✅ Enviado."
				: `⚠️ No enviado: ${telegramEscape(String(body.reason ?? body.error ?? "desconocido"))}`,
		});
	}
	await answerCallbackQuery(config, {
		callbackQueryId: query.id,
		text: sent ? "Enviado" : "No enviado",
	});
}

/**
 * Telegram webhook entry point.
 *
 * This route sits outside the /api/* perimeter on purpose: Telegram cannot carry
 * a Cloudflare Access JWT and sends no Origin header, so it can satisfy neither
 * the Access check nor the CSRF guard. Its own authentication is the secret token
 * header (set with setWebhook) plus the user allowlist — which is why
 * readTelegramConfig refuses to run without both.
 */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
	let config: TelegramConfig | null;
	try {
		config = readTelegramConfig(env);
	} catch (error) {
		console.error("telegram.config_invalid", {
			error: error instanceof Error ? error.message : String(error),
		});
		return Response.json({ error: "telegram_misconfigured" }, { status: 503 });
	}
	if (!config) {
		// Bridge off: behave as if the route doesn't exist.
		return new Response("Not found", { status: 404 });
	}
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (!(await timingSafeEqual(provided, config.webhookSecret))) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	let update: TelegramUpdate;
	try {
		update = (await request.json()) as TelegramUpdate;
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}

	if (update.callback_query) {
		await handleCallbackQuery(env, config, update.callback_query);
	} else if (update.message) {
		await handleMessage(env, config, update.message);
	}

	return Response.json({ ok: true });
}
