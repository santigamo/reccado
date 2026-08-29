import {
	deleteTelegramAction,
	getTelegramAction,
	getTelegramLinkByMessage,
	insertOpsEvent,
	insertTelegramAction,
	type TelegramLinkRow,
} from "../db/d1";
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
	deriveWebhookSecret,
	inlineKeyboard,
	isNotModifiedError,
	readTelegramConfig,
	sendMessage,
	type TelegramCallbackQuery,
	type TelegramConfig,
	type TelegramEntity,
	type TelegramMessage,
	type TelegramUpdate,
} from "./api";
import { adoptTelegramChat, refreshChatTopicSupport, resolveTelegramChatId } from "./binding";
import {
	CARD_CALLBACK_PREFIX,
	handleCardCallback,
	handleDigestExpand,
	isCardCallback,
} from "./cards";
import {
	handleSearchPageCallback,
	handleTelegramCommand,
	parseCommand,
	RETRIEVAL_COMMANDS,
	SEARCH_PAGE_VERB,
} from "./commands";
import {
	actionToken,
	applyDraftEdit,
	DRAFT_PREVIEW_TTL_MS,
	getDraftByPreview,
	getDraftBySource,
	rememberDraftPreview,
	type TelegramDraftRow,
} from "./drafts";
import { entitiesToHtml, renderDraftPreview, telegramEscape } from "./format";
import { fetchMailboxMessage } from "./messages";
import { DIGEST_CALLBACK_VERB } from "./noise";
import { claimTelegramPairing, type PairingOutcome, resolveTelegramOperators } from "./operators";

/** How long an inline Send button stays live. */
const ACTION_TTL_MS = DRAFT_PREVIEW_TTL_MS;

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

function isAllowed(operators: Set<string>, userId: string | number | undefined): boolean {
	return userId !== undefined && operators.has(String(userId));
}

/**
 * Which email a Telegram message is answering — quoted card only.
 *
 * There used to be a second route: any message inside a topic resolved to the
 * newest email posted in that topic. That was defensible while a topic *was* an
 * email thread. Now a topic is a mailbox, so "newest email in this topic" means
 * "whatever arrived last in this mailbox" — a message typed loosely into the
 * topic would answer the card that landed while the operator was typing, not the
 * one he was reading. A reply that goes to the wrong stranger is worse than a
 * reply the bot admits it cannot place, so the loose case gets the existing
 * "quote the notification" guidance instead of a guess.
 */
async function resolveLink(
	env: Env,
	chatId: string,
	message: TelegramMessage,
): Promise<TelegramLinkRow | null> {
	if (!message.reply_to_message) {
		return null;
	}
	return getTelegramLinkByMessage(env.INDEX_DB, chatId, message.reply_to_message.message_id);
}

const IDENTITY_COMMANDS = ["/start", "/help", "/id"] as const;

/** `/start abc123` -> the argument; `/start` -> null. */
function commandArgument(text: string): string | null {
	const argument = text.slice(text.indexOf(" ") + 1).trim();
	return text.includes(" ") && argument ? argument : null;
}

/** What the operator is told when a code did not work, per reason. */
const PAIRING_REJECTIONS: Record<string, string> = {
	unknown: "Ese código de emparejamiento no existe.",
	expired: "Ese código de emparejamiento ha caducado.",
	used: "Ese código de emparejamiento ya se usó.",
	already_owner: "Ese código ya no hacía falta: esta cuenta ya estaba autorizada.",
};

/**
 * Answers "who am I and where am I", and binds the deployment to this chat when
 * an operator asks. Runs for strangers too -- see the call site for why -- but a
 * stranger only ever gets their own ids back, never an adoption and never an
 * action.
 */
async function handleIdentityCommand(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
	allowed: boolean,
	/**
	 * Only /start binds the deployment to a chat. /help and /id are read-only
	 * questions, and answering one in some group the operator happens to be in must
	 * not silently move where their mail lands.
	 */
	adopts: boolean,
	/** Present only when this /start carried a code. Null means none was offered. */
	pairing: PairingOutcome | null,
): Promise<void> {
	const userId = String(message.from?.id ?? "");
	const reply = (lines: string[]) =>
		sendMessage(config, {
			chatId,
			text: lines.join("\n"),
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});

	if (!allowed) {
		await reply([
			"<b>Reccado</b>",
			`user_id: <code>${telegramEscape(userId)}</code>`,
			`chat_id: <code>${telegramEscape(chatId)}</code>`,
			"",
			pairing
				? (PAIRING_REJECTIONS[pairing.claim] ?? "Ese código de emparejamiento no es válido.")
				: "Este usuario todavía no está autorizado.",
			"Pide al operador un código de emparejamiento y envía <code>/start &lt;código&gt;</code>.",
		]);
		return;
	}

	if (!adopts) {
		await reply([
			"<b>Reccado</b>",
			`chat_id: <code>${telegramEscape(chatId)}</code>`,
			`user_id: <code>${telegramEscape(userId)}</code>`,
			"",
			"Envía /start para vincular este chat.",
		]);
		return;
	}

	const binding = await adoptTelegramChat(env, chatId);
	if (!binding.adopted) {
		await reply([
			"<b>Reccado</b>",
			`user_id: <code>${telegramEscape(userId)}</code>`,
			`chat_id: <code>${telegramEscape(chatId)}</code>`,
			"",
			`Ya hay otro chat vinculado (<code>${telegramEscape(binding.chatId)}</code>).`,
			"Este chat no recibirá correo nuevo.",
		]);
		return;
	}

	// Asked here and only here: /start is the one moment the operator is already
	// waiting on a round trip, so the notifier can read the answer instead of
	// spending a getChat per email on a rate-limited path. Sending /start again is
	// what re-observes it after turning topic mode on or off.
	const isForum = await refreshChatTopicSupport(env, config, chatId);

	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "telegram.chat_adopted",
		severity: "info",
		subject: chatId,
		payload_json: JSON.stringify({ chatId, userId, isForum }),
	}).catch(() => undefined);

	await reply([
		pairing?.claim === "linked"
			? "<b>Reccado</b> conectado. Esta cuenta queda vinculada como operador."
			: "<b>Reccado</b> conectado.",
		`chat_id: <code>${telegramEscape(chatId)}</code>`,
		`user_id: <code>${telegramEscape(userId)}</code>`,
		"",
		"Este chat recibirá el correo nuevo.",
		isForum
			? "Cada buzón tendrá su propio topic."
			: "Las notificaciones llegan como mensajes normales.",
		"Responde a una notificación de correo para contestar por email.",
	]);
}

/**
 * The two buttons under a preview.
 *
 * Rebuilt from the source message rather than stored, because the send token is
 * derived from it: a corrected draft keeps the same token, so the button that was
 * already under the preview keeps pointing at the same draft and a redelivered
 * press still resolves to one send.
 */
async function previewKeyboard(chatId: string, sourceMessageId: number) {
	const token = await actionToken(chatId, sourceMessageId);
	return inlineKeyboard([
		[
			{ text: "✅ Enviar", callback_data: `s:${token}` },
			{ text: "✖️ Descartar", callback_data: `x:${token}` },
		],
	]);
}

/**
 * Applies a correction to a draft and shows the result where the operator is
 * looking: in the preview itself.
 *
 * Editing in place rather than posting a second preview is the whole point. Two
 * previews under one reply is exactly the ambiguity the operator was trying to
 * resolve — which of these is going to be sent? — and it would also mint a second
 * Send button for a draft that has one.
 */
async function applyPreviewCorrection(
	env: Env,
	config: TelegramConfig,
	input: {
		row: TelegramDraftRow;
		chatId: string;
		text: string;
		entities: TelegramEntity[] | undefined;
		/** The message to hang an explanation off, when there is one to give. */
		replyToMessageId: number;
		messageThreadId: number | null;
	},
): Promise<void> {
	const say = (text: string) =>
		sendMessage(config, {
			chatId: input.chatId,
			text,
			replyToMessageId: input.replyToMessageId,
			messageThreadId: input.messageThreadId,
		});

	const outcome = await applyDraftEdit(env, input.row, {
		text: input.text,
		entities: input.entities,
	});
	if (outcome.status === "closed") {
		await say(
			outcome.draftStatus === "sent"
				? "Esa respuesta ya se envió: no puedo cambiarla."
				: "Ese borrador ya se descartó. Cita la tarjeta del correo para escribir otro.",
		);
		return;
	}
	if (outcome.status === "unknown_draft") {
		await say("Ese borrador ya no existe.");
		return;
	}
	if (outcome.status === "no_parent") {
		await say("No encuentro el mensaje original en el buzón.");
		return;
	}

	try {
		await editMessageText(config, {
			chatId: input.row.chat_id,
			messageId: input.row.preview_message_id,
			text: renderDraftPreview({
				to: outcome.to,
				subject: outcome.subject,
				bodyText: input.text,
				version: outcome.version,
			}),
			replyMarkup: await previewKeyboard(input.row.chat_id, input.row.source_message_id),
		});
	} catch (error) {
		// The draft is already patched, so a failed edit is a display problem, not a
		// reason to make Telegram redeliver an update that would patch it again.
		if (!isNotModifiedError(error)) {
			console.warn("telegram.preview_edit_failed", {
				chatId: input.row.chat_id,
				messageId: input.row.preview_message_id,
				error: error instanceof Error ? error.message : String(error),
			});
			await say("He guardado el cambio, pero no he podido actualizar el borrador en pantalla.");
		}
	}
}

/**
 * An operator editing his own Telegram message.
 *
 * The gesture is the same correction as replying to the preview, arriving through
 * the other door Telegram offers — which is why it lands on the same code. Silence
 * is the right answer when the edited message produced no draft: people edit their
 * own typos in a chat all day long, and a bot that comments on each one is worse
 * than one that misses this feature entirely.
 */
async function handleEditedMessage(
	env: Env,
	config: TelegramConfig,
	operators: Set<string>,
	message: TelegramMessage,
): Promise<void> {
	if (!isAllowed(operators, message.from?.id)) {
		return;
	}
	const chatId = String(message.chat.id);
	const boundChatId = await resolveTelegramChatId(env);
	if (boundChatId && chatId !== boundChatId) {
		return;
	}
	const text = message.text ?? message.caption;
	if (!text?.trim()) {
		return;
	}
	const row = await getDraftBySource(env.INDEX_DB, chatId, message.message_id);
	if (!row) {
		return;
	}
	await applyPreviewCorrection(env, config, {
		row,
		chatId,
		text,
		entities: message.entities ?? message.caption_entities,
		replyToMessageId: message.message_id,
		messageThreadId: message.message_thread_id ?? null,
	});
}

async function handleMessage(
	env: Env,
	config: TelegramConfig,
	operators: Set<string>,
	message: TelegramMessage,
): Promise<void> {
	const chatId = String(message.chat.id);
	const rawText = message.text ?? message.caption;
	const userId = String(message.from?.id ?? "");
	let allowed = isAllowed(operators, message.from?.id);

	// Identity commands answer BEFORE the allowlist gate, deliberately: the ids they
	// print are the very ids you need in order to be on that allowlist. Gating them
	// made onboarding a closed loop -- setup:telegram told you to send /start to learn
	// your user id, but /start only replied to users whose id was already configured,
	// so a first-time operator got silence with no way to tell whether the webhook,
	// the secret, or the allowlist was at fault. Answering costs nothing an attacker
	// could not already get from @userinfobot, and no action is taken for a stranger.
	if (rawText && IDENTITY_COMMANDS.some((command) => rawText.startsWith(command))) {
		const adopts = rawText.startsWith("/start");
		// The one path from stranger to operator. Attempted only for a stranger and
		// only on /start: a code offered by someone who is already an operator would
		// spend an invitation to grant an authority they hold, and /help must stay a
		// question that changes nothing.
		const code = adopts && !allowed ? commandArgument(rawText) : null;
		const pairing = code ? await claimTelegramPairing(env, { code, userId, chatId }) : null;
		allowed = allowed || pairing?.claim === "linked";
		await handleIdentityCommand(env, config, message, chatId, allowed, adopts, pairing);
		return;
	}

	if (!allowed) {
		console.warn("telegram.unauthorized_user", { chatId, userId: message.from?.id });
		return;
	}
	// The bound chat is also the only chat we act on: it stops the bot from taking
	// orders in a group someone added it to.
	const boundChatId = await resolveTelegramChatId(env);
	if (boundChatId && chatId !== boundChatId) {
		console.warn("telegram.unexpected_chat", { chatId });
		return;
	}

	const text = rawText;
	if (!text?.trim()) {
		await sendMessage(config, {
			chatId,
			text: "Por ahora solo puedo enviar texto. Los adjuntos hay que subirlos desde Reccado.",
			replyToMessageId: message.message_id,
			messageThreadId: message.message_thread_id ?? null,
		});
		return;
	}

	// Before anything that treats the text as prose: /buscar sends its argument to
	// FTS, not to a stranger.
	const command = parseCommand(text);
	if (command && RETRIEVAL_COMMANDS.has(command.name)) {
		await handleTelegramCommand(env, config, message, chatId, command);
		return;
	}

	// A reply to a preview is a correction of the draft it is showing, not a new
	// reply to the email. Checked before resolveLink because a preview is not a
	// card: it has no telegram_links row, which is exactly why this gesture used to
	// answer "No sé a qué correo responde esto" and send the operator back to
	// scroll for the original notification.
	if (message.reply_to_message) {
		const draftRow = await getDraftByPreview(
			env.INDEX_DB,
			chatId,
			message.reply_to_message.message_id,
		);
		if (draftRow) {
			await applyPreviewCorrection(env, config, {
				row: draftRow,
				chatId,
				text,
				entities: message.entities ?? message.caption_entities,
				replyToMessageId: message.message_id,
				messageThreadId: message.message_thread_id ?? null,
			});
			return;
		}
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

	const parentMessage = await fetchMailboxMessage(env, link.mailbox_id, link.message_local_id);
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
			// The message actually being answered, not just its thread: In-Reply-To and
			// the reply's own From are both derived from it, and "newest in the thread"
			// is the wrong answer to both when the operator replies to an older card.
			parentMessageId: link.message_local_id,
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

	const preview = await sendMessage(config, {
		chatId,
		text: renderDraftPreview({ to: [parentMessage.from_addr], subject, bodyText: text }),
		replyToMessageId: message.message_id,
		messageThreadId: message.message_thread_id ?? null,
		replyMarkup: await previewKeyboard(chatId, message.message_id),
	});
	// After the send, because the preview's own message id is the key a correction
	// arrives with. A failure here costs the ability to edit this one draft; doing
	// it before the send would cost nothing less than a row pointing at a message
	// that does not exist.
	await rememberDraftPreview(env.INDEX_DB, {
		chat_id: chatId,
		preview_message_id: preview.message_id,
		source_message_id: message.message_id,
		mailbox_id: link.mailbox_id,
		draft_id: draft.id,
		telegram_user_id: String(message.from?.id ?? ""),
		expires_at: new Date(Date.now() + DRAFT_PREVIEW_TTL_MS).toISOString(),
	});
}

async function handleCallbackQuery(
	env: Env,
	config: TelegramConfig,
	operators: Set<string>,
	query: TelegramCallbackQuery,
): Promise<void> {
	if (!isAllowed(operators, query.from.id)) {
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "No autorizado" });
		return;
	}
	const data = query.data ?? "";
	// Routed after the allowlist check and before anything else: the triage buttons
	// carry a verb, not a token, so their guard is entirely the check above. The
	// send-confirmation protocol below keeps its token table -- a draft id does not
	// fit in 64 bytes, and that button also has to be bound to the account it was
	// shown to, which a verb cannot express.
	if (isCardCallback(data)) {
		// Two of the v1 verbs do not address a card at all: one addresses a page of
		// results, the other a line of a digest. They are routed here rather than
		// inside handleCardCallback because that function's first act is to resolve
		// (chat_id, message_id) in telegram_links, and neither of these has such a
		// row -- the paginator is a control, and a digest line is an email that has
		// no card yet, which pressing it is what creates.
		const verb = data.slice(CARD_CALLBACK_PREFIX.length).split(":")[0];
		if (verb === SEARCH_PAGE_VERB) {
			await handleSearchPageCallback(env, config, query);
			return;
		}
		if (verb === DIGEST_CALLBACK_VERB) {
			await handleDigestExpand(
				env,
				config,
				query,
				data.slice(CARD_CALLBACK_PREFIX.length + DIGEST_CALLBACK_VERB.length + 1),
			);
			return;
		}
		await handleCardCallback(env, config, query);
		return;
	}
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

	// A callback always carries its message, but Telegram may omit it for very old
	// ones; fall back to the adopted chat rather than dropping the confirmation.
	const chatId = query.message ? String(query.message.chat.id) : await resolveTelegramChatId(env);
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
 * header (set with setWebhook) plus the operator allowlist, which is why the
 * secret is derived from the bot token rather than left to be forgotten.
 *
 * It serves an unpaired deployment on purpose. The route used to answer 503 when
 * no operator was declared, which was self-defeating once pairing moved here:
 * /start is how an account becomes an operator, so refusing to answer until one
 * exists is refusing to ever have one. The secret still gates every update, so an
 * unpaired bridge is not an open one -- it is a bridge whose only useful command
 * is the one that pairs it.
 */
export async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
	const config = readTelegramConfig(env);
	if (!config) {
		// Bridge off: behave as if the route doesn't exist.
		return new Response("Not found", { status: 404 });
	}
	if (request.method !== "POST") {
		return new Response("Method not allowed", { status: 405 });
	}

	const provided = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
	if (!(await timingSafeEqual(provided, await deriveWebhookSecret(config.botToken)))) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	let update: TelegramUpdate;
	try {
		update = (await request.json()) as TelegramUpdate;
	} catch {
		return Response.json({ error: "invalid_json" }, { status: 400 });
	}

	// After the secret check, never before: an unauthenticated request must not be
	// able to make this worker read D1.
	const operators = await resolveTelegramOperators(env);

	if (update.callback_query) {
		await handleCallbackQuery(env, config, operators, update.callback_query);
	} else if (update.message) {
		await handleMessage(env, config, operators, update.message);
	} else if (update.edited_message) {
		await handleEditedMessage(env, config, operators, update.edited_message);
	}

	return Response.json({ ok: true });
}
