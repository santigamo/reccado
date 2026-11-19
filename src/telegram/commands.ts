/**
 * The bot's vocabulary: the "/" menu, and the two commands that make the archive
 * reachable from a phone.
 *
 * Until now everything Telegram could do with an email began with an email
 * arriving. Miss the card, or want the invoice from March, and the chat had
 * nothing to offer — the entire mailbox was invisible from the surface the
 * operator actually lives in, and the "/" menu was empty because nothing ever
 * called setMyCommands.
 *
 * The important part is not the search. It is that every result is emitted as a
 * card *with its telegram_link row* (see postMailCard), so mail you went looking
 * for is quotable, archivable and expandable exactly like mail that arrived on
 * its own. Card-plus-link stops being the notification format and becomes the one
 * unit of everything the bot shows.
 */

import { listMailboxes } from "../db/d1";
import { getRuntimeConfig, RUNTIME_CONFIG_KEYS } from "../db/runtime-config";
import { buildApprovalUrl, getIntentCard } from "../lib/approvals";
import { mailboxStub } from "../lib/mailbox-stub";
import {
	answerCallbackQuery,
	editMessageText,
	getMyCommands,
	inlineKeyboard,
	readTelegramConfig,
	sendMessage,
	setMyCommands,
	type TelegramBotCommand,
	type TelegramCallbackQuery,
	type TelegramConfig,
	type TelegramInlineButton,
	type TelegramMessage,
} from "./api";
import { formatExpiry } from "./approval-notices";
import { postMailCard } from "./cards";
import { renderResultFooter, telegramEscape } from "./format";
import { listMailIndexRows, listNewestInboxRowsForThreads, type MailIndexRow } from "./index-rows";
import {
	formatMinutes,
	formatOffset,
	listMutedSenders,
	parseQuietHours,
	readQuietHours,
	writeQuietHours,
} from "./noise";
import { safeSubject, sensitivityOfIndexedMail } from "./sensitive";

/**
 * What the "/" menu offers.
 *
 * Only lowercase letters survive Telegram's validation, which is why "buscar"
 * and "silencio" carry their accents in the description and not in the command.
 * /start, /help and /id are listed even though the webhook answered them long
 * before this file existed: a menu that hides half the vocabulary is worse than
 * no menu, because it reads as the complete list.
 */
export const TELEGRAM_COMMANDS: TelegramBotCommand[] = [
	{ command: "inbox", description: "Tarjetas de los últimos correos sin leer" },
	{ command: "unread", description: "Conversaciones sin leer, en una lista" },
	{ command: "buscar", description: "Busca en todo el archivo: /buscar factura" },
	{ command: "approvals", description: "Aprobaciones pendientes (se aprueban en la web)" },
	{ command: "silencio", description: "Horas de silencio: /silencio 23:00-08:00 +02:00" },
	{ command: "silenciados", description: "Remitentes silenciados" },
	{ command: "help", description: "Qué puede hacer este bot" },
	{ command: "id", description: "Muestra chat_id y user_id" },
	{ command: "start", description: "Vincula este chat con Reccado" },
];

/**
 * Answered by the webhook itself, before the operator allowlist (see
 * handleIdentityCommand): the ids they print are what gets someone onto it.
 */
export const IDENTITY_COMMAND_NAMES = new Set(["start", "help", "id"]);

/**
 * The /help text: the menu above, in the order it is shown, plus the two gestures
 * that are not commands. Generated from TELEGRAM_COMMANDS so the help can never
 * describe a command the menu lacks or miss one it has.
 */
export function renderHelp(): string {
	return [
		"<b>Reccado</b> · lo que puedo hacer",
		"",
		...TELEGRAM_COMMANDS.map(
			(command) => `/${command.command} — ${telegramEscape(command.description)}`,
		),
		"",
		"Responde citando una tarjeta para contestar ese correo por email.",
		"Los botones Archivar y Leído actúan sobre toda la conversación.",
		"Los envíos y cambios que pide un agente se aprueban solo en la web.",
		"",
		"<i>Diagnóstico: /id muestra chat_id y user_id.</i>",
	].join("\n");
}

function sameCommands(live: TelegramBotCommand[], wanted: TelegramBotCommand[]): boolean {
	if (live.length !== wanted.length) return false;
	return wanted.every(
		(command, index) =>
			live[index]?.command === command.command && live[index]?.description === command.description,
	);
}

export type CommandReconciliation =
	| { status: "skipped"; reason: "bridge_disabled" }
	| { status: "ok" }
	| { status: "registered" }
	| { status: "failed"; error: string };

/**
 * Keeps the "/" menu equal to this deployment's vocabulary.
 *
 * Reconciled rather than registered once, and reconciled from Telegram's own
 * answer rather than from a stored flag, for exactly the reason the webhook is:
 * the menu is state living in someone else's system, a deploy that adds a command
 * cannot reach it, and a bot whose menu is a release behind is a bot whose newest
 * feature nobody discovers. getMyCommands is one call an hour, and setMyCommands
 * only runs when the two lists actually differ.
 */
export async function reconcileTelegramCommands(env: Env): Promise<CommandReconciliation> {
	const config = readTelegramConfig(env);
	if (!config) return { status: "skipped", reason: "bridge_disabled" };
	try {
		if (sameCommands(await getMyCommands(config), TELEGRAM_COMMANDS)) {
			return { status: "ok" };
		}
		await setMyCommands(config, TELEGRAM_COMMANDS);
		return { status: "registered" };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

// --- parsing ---------------------------------------------------------------

export type ParsedCommand = { name: string; argument: string };

/**
 * `/buscar@ReccadoBot factura` -> { name: "buscar", argument: "factura" }.
 *
 * The @mention suffix is not optional politeness: Telegram appends it to every
 * command typed in a group, so a parser that ignores it works in a private chat
 * and silently stops working the day the operator moves to a supergroup.
 */
export function parseCommand(text: string | undefined): ParsedCommand | null {
	if (!text?.startsWith("/")) return null;
	const [head, ...rest] = text.trim().split(/\s+/);
	if (!head) return null;
	return {
		name: head.slice(1).split("@")[0]?.toLowerCase() ?? "",
		argument: rest.join(" ").trim(),
	};
}

// --- retrieval -------------------------------------------------------------

/**
 * Cards per page.
 *
 * Four, because a page is a burst of messages against a chat that accepts about
 * one per second, and because five cards do not fit on a phone screen anyway.
 */
const PAGE_SIZE = 4;
/** How deep a single query looks before it starts telling the operator to narrow it. */
const SEARCH_CAP_PER_MAILBOX = 40;
const INBOX_LIMIT = 5;

type SearchResults = { rows: MailIndexRow[]; truncated: boolean };

/**
 * Runs the FTS query across every mailbox and resolves the hits to card content.
 *
 * The Durable Object's search answers with message ids and nothing else, which is
 * the right shape: the four facts a card shows are already in message_index, so
 * hydrating there costs one statement per mailbox instead of one round trip per
 * hit.
 */
async function searchAllMailboxes(env: Env, query: string): Promise<SearchResults> {
	const mailboxes = await listMailboxes(env.INDEX_DB);
	const rows: MailIndexRow[] = [];
	let truncated = false;
	for (const mailbox of mailboxes) {
		const stub = mailboxStub(env, mailbox.mailbox_id);
		const url = new URL("https://mailbox-do/search");
		url.searchParams.set("q", query);
		url.searchParams.set("limit", String(SEARCH_CAP_PER_MAILBOX));
		const response = await stub.fetch(url.toString());
		if (!response.ok) continue;
		const payload = (await response.json()) as { results?: Array<{ message_id: string }> };
		const ids = (payload.results ?? []).map((result) => result.message_id);
		if (ids.length >= SEARCH_CAP_PER_MAILBOX) truncated = true;
		rows.push(...(await listMailIndexRows(env.INDEX_DB, mailbox.mailbox_id, ids)));
	}
	// Sorted by arrival rather than by FTS rank: rank is per mailbox and cannot be
	// compared across Durable Objects, and "newest first" is also the order that
	// makes a page boundary stable while the operator pages through it.
	rows.sort((a, b) => b.received_at.localeCompare(a.received_at));
	return { rows, truncated };
}

type ThreadListRow = {
	id: string;
	/** Unread messages in the conversation (outside the trash). */
	unread_count?: number;
	latest_is_read?: number;
	latest_received_at?: string;
};

/**
 * The unread mail still sitting in an inbox, newest first.
 *
 * Two sources on purpose. Read state and "still in the inbox" are only true in
 * the Durable Object — D1's message_index records the state an email was *filed*
 * under at ingest and is never updated by an archive — while the message a card
 * is about, and everything the card prints, lives in message_index. So the DO is
 * asked which conversations are open, and D1 which email to show for each.
 */
async function collectUnreadInbox(env: Env, limit: number): Promise<MailIndexRow[]> {
	return (await collectUnreadConversations(env, limit)).map((item) => item.row);
}

type UnreadConversation = { row: MailIndexRow; unread: number };

/** The same, with how many messages of each conversation are unread. */
async function collectUnreadConversations(env: Env, limit: number): Promise<UnreadConversation[]> {
	const mailboxes = await listMailboxes(env.INDEX_DB);
	const items: UnreadConversation[] = [];
	for (const mailbox of mailboxes) {
		const stub = mailboxStub(env, mailbox.mailbox_id);
		const response = await stub.fetch(`https://mailbox-do/threads?state=inbox&limit=${limit * 3}`);
		if (!response.ok) continue;
		const payload = (await response.json()) as { threads?: ThreadListRow[] };
		const unread = new Map<string, number>();
		for (const thread of payload.threads ?? []) {
			// Unread as a conversation (any message), the way the web inbox shows it.
			const count =
				thread.unread_count !== undefined
					? Number(thread.unread_count)
					: Number(thread.latest_is_read ?? 0) === 0
						? 1
						: 0;
			if (count > 0) unread.set(thread.id, count);
		}
		const rows = await listNewestInboxRowsForThreads(env.INDEX_DB, mailbox.mailbox_id, [
			...unread.keys(),
		]);
		items.push(...rows.map((row) => ({ row, unread: unread.get(row.thread_id) ?? 1 })));
	}
	items.sort((a, b) => b.row.received_at.localeCompare(a.row.received_at));
	return items.slice(0, limit);
}

/** Callback verb for "show me another page of these results". */
export const SEARCH_PAGE_VERB = "s";

const CALLBACK_DATA_LIMIT = 64;

/**
 * Pagination carries its own query, rather than a token pointing at a stored one.
 *
 * callback_data is 64 bytes, which fits a verb, an offset and most real search
 * terms — and a table of saved queries would be a second short-lived store with a
 * second expiry sweep to answer a question the button can simply hold. When a
 * query genuinely does not fit, the page is emitted with no arrows and the
 * operator is told to narrow it, which is the honest failure.
 */
function pageCallbackData(query: string, offset: number): string | null {
	const data = `v1:${SEARCH_PAGE_VERB}:${offset}:${query}`;
	return new TextEncoder().encode(data).length <= CALLBACK_DATA_LIMIT ? data : null;
}

export function parseSearchPage(data: string): { offset: number; query: string } | null {
	const rest = data.slice(`v1:${SEARCH_PAGE_VERB}:`.length);
	const separator = rest.indexOf(":");
	if (separator < 1) return null;
	const offset = Number(rest.slice(0, separator));
	const query = rest.slice(separator + 1);
	return Number.isInteger(offset) && offset >= 0 && query.length > 0 ? { offset, query } : null;
}

function footerKeyboard(
	query: string,
	offset: number,
	total: number,
): Record<string, unknown> | undefined {
	const buttons: TelegramInlineButton[] = [];
	const previous = offset > 0 ? pageCallbackData(query, Math.max(0, offset - PAGE_SIZE)) : null;
	const next = offset + PAGE_SIZE < total ? pageCallbackData(query, offset + PAGE_SIZE) : null;
	if (previous) buttons.push({ text: "‹", callback_data: previous });
	if (next) buttons.push({ text: "›", callback_data: next });
	return buttons.length > 0 ? inlineKeyboard([buttons]) : undefined;
}

/**
 * Posts one page of cards and the control line under it.
 *
 * The cards go out before the footer so the arrows always end up at the bottom of
 * the chat, where the thumb already is.
 */
async function emitPage(
	env: Env,
	config: TelegramConfig,
	input: {
		chatId: string;
		topicId: number | null;
		query: string;
		offset: number;
		rows: MailIndexRow[];
		truncated: boolean;
	},
): Promise<TelegramMessage | null> {
	const page = input.rows.slice(input.offset, input.offset + PAGE_SIZE);
	for (const row of page) {
		await postMailCard(env, config, {
			chatId: input.chatId,
			// The card is posted where the command was typed, not in the mailbox's own
			// topic: the operator asked here, and scattering the answers across topics
			// would make a search read like an inbox.
			topicId: input.topicId,
			row,
		});
	}
	if (page.length === 0) return null;
	const replyMarkup = footerKeyboard(input.query, input.offset, input.rows.length);
	const hint =
		input.rows.length > PAGE_SIZE && !replyMarkup
			? "\n<i>Búsqueda demasiado larga para paginar: acórtala.</i>"
			: input.truncated
				? "\n<i>Hay más coincidencias de las que puedo listar; afina la búsqueda.</i>"
				: "";
	return sendMessage(config, {
		chatId: input.chatId,
		text:
			renderResultFooter({
				query: input.query,
				from: input.offset + 1,
				to: input.offset + page.length,
				total: input.rows.length,
			}) + hint,
		messageThreadId: input.topicId,
		replyMarkup,
	});
}

// --- command handlers ------------------------------------------------------

async function reply(
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
	text: string,
): Promise<void> {
	await sendMessage(config, {
		chatId,
		text,
		replyToMessageId: message.message_id,
		messageThreadId: message.message_thread_id ?? null,
	});
}

async function runInbox(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
): Promise<void> {
	const rows = await collectUnreadInbox(env, INBOX_LIMIT);
	if (rows.length === 0) {
		await reply(config, message, chatId, "📭 Nada sin leer.");
		return;
	}
	const topicId = message.message_thread_id ?? null;
	for (const row of rows) {
		await postMailCard(env, config, { chatId, topicId, row });
	}
}

async function runSearch(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
	argument: string,
): Promise<void> {
	if (!argument) {
		await reply(config, message, chatId, "Dime qué buscar: <code>/buscar factura</code>");
		return;
	}
	const { rows, truncated } = await searchAllMailboxes(env, argument);
	if (rows.length === 0) {
		await reply(
			config,
			message,
			chatId,
			`🔎 Sin resultados para <b>${telegramEscape(argument)}</b>.`,
		);
		return;
	}
	await emitPage(env, config, {
		chatId,
		topicId: message.message_thread_id ?? null,
		query: argument,
		offset: 0,
		rows,
		truncated,
	});
}

function describeQuietHours(hours: Awaited<ReturnType<typeof readQuietHours>>): string {
	if (hours.startMinutes === null || hours.endMinutes === null) {
		return "🔔 No hay horas de silencio configuradas.";
	}
	return [
		`🌙 Silencio de <b>${formatMinutes(hours.startMinutes)}</b> a <b>${formatMinutes(hours.endMinutes)}</b> (UTC${formatOffset(hours.utcOffsetMinutes)}).`,
		"El correo se guarda y llega por la mañana en un solo resumen.",
	].join("\n");
}

async function runQuietHours(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
	argument: string,
): Promise<void> {
	if (!argument) {
		await reply(
			config,
			message,
			chatId,
			`${describeQuietHours(await readQuietHours(env.INDEX_DB))}\n\n<code>/silencio 23:00-08:00 +02:00</code> · <code>/silencio off</code>`,
		);
		return;
	}
	const parsed = parseQuietHours(argument);
	if (parsed === null) {
		await reply(
			config,
			message,
			chatId,
			"No entiendo esa franja. Prueba <code>/silencio 23:00-08:00 +02:00</code>.",
		);
		return;
	}
	if (parsed === "off") {
		await writeQuietHours(env.INDEX_DB, {
			startMinutes: null,
			endMinutes: null,
			utcOffsetMinutes: 0,
		});
		await reply(config, message, chatId, "🔔 Horas de silencio desactivadas.");
		return;
	}
	await writeQuietHours(env.INDEX_DB, parsed);
	await reply(config, message, chatId, describeQuietHours(parsed));
}

async function runMutedList(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
): Promise<void> {
	const senders = await listMutedSenders(env.INDEX_DB);
	await reply(
		config,
		message,
		chatId,
		senders.length === 0
			? "🔔 No hay remitentes silenciados."
			: [
					`🔕 <b>${senders.length} silenciados</b>`,
					...senders.map((sender) => `· <code>${telegramEscape(sender)}</code>`),
					"",
					"<i>Para reactivar uno, busca un correo suyo y pulsa 🔔.</i>",
				].join("\n"),
	);
}

const UNREAD_LIMIT = 10;

/**
 * Unread conversations as one message: a line each, newest first.
 *
 * The compact sibling of /inbox, which posts a card per email. Each line prints
 * sender and subject only -- never a snippet -- and a subject that belongs to
 * sensitive mail is masked exactly as its card would be (telegram/sensitive.ts).
 */
async function runUnread(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
): Promise<void> {
	const [items, origin] = await Promise.all([
		collectUnreadConversations(env, UNREAD_LIMIT),
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.deploymentOrigin),
	]);
	if (items.length === 0) {
		await reply(config, message, chatId, "📭 Nada sin leer.");
		return;
	}
	const lines: string[] = [];
	for (const [index, item] of items.entries()) {
		const kind = await sensitivityOfIndexedMail(env, item.row);
		const subject = telegramEscape(safeSubject(item.row.subject, kind) ?? "(sin asunto)");
		const link = origin
			? ` · <a href="${telegramEscape(`${origin}/inbox/${item.row.mailbox_id}/${item.row.thread_id}`)}">abrir</a>`
			: "";
		const count = item.unread > 1 ? ` · ${item.unread} sin leer` : "";
		lines.push(
			`${index + 1}. <i>${telegramEscape(item.row.from_addr)}</i> — ${subject}${kind ? " 🔒" : ""}${count}${link}`,
		);
	}
	await reply(
		config,
		message,
		chatId,
		[
			`📬 <b>${items.length} sin leer</b>`,
			"",
			...lines,
			"",
			"<i>/inbox las trae como tarjetas.</i>",
		].join("\n"),
	);
}

const APPROVALS_LIMIT = 10;

/**
 * Pending approval requests, each with its link.
 *
 * Link-only, like the notices: a URL button per request and nothing that could
 * approve or deny from here. Approval happens on /approve/:id with the owner web
 * session, and Telegram's own send confirmations (origin 'telegram') are not
 * listed -- they are buttons the operator already has.
 */
async function runApprovals(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
): Promise<void> {
	const now = new Date().toISOString();
	const [pending, origin, hours] = await Promise.all([
		env.INDEX_DB.prepare(
			`SELECT token, expires_at FROM approvals
       WHERE origin = 'mcp' AND decision IS NULL AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at ASC LIMIT ?`,
		)
			.bind(now, APPROVALS_LIMIT)
			.all<{ token: string; expires_at: string }>(),
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.deploymentOrigin),
		readQuietHours(env.INDEX_DB),
	]);
	const rows = pending.results ?? [];
	if (rows.length === 0) {
		await reply(config, message, chatId, "🔐 No hay aprobaciones pendientes.");
		return;
	}
	const lines: string[] = [];
	const buttons: TelegramInlineButton[][] = [];
	for (const [index, row] of rows.entries()) {
		const view = await getIntentCard(env, row.token);
		const expires = formatExpiry(row.expires_at, hours.utcOffsetMinutes);
		lines.push(
			`${index + 1}. <b>${telegramEscape(view.title)}</b>${expires ? ` · caduca a las ${telegramEscape(expires)}` : ""}`,
		);
		const url = origin ? buildApprovalUrl(origin, row.token) : null;
		if (url) buttons.push([{ text: `${index + 1} · Revisar en la web`, url }]);
	}
	await sendMessage(config, {
		chatId,
		text: [
			`🔐 <b>${rows.length} ${rows.length === 1 ? "aprobación pendiente" : "aprobaciones pendientes"}</b>`,
			"",
			...lines,
			"",
			"🔑 Se aprueban solo en la página web, con tu sesión de propietario.",
		].join("\n"),
		replyToMessageId: message.message_id,
		messageThreadId: message.message_thread_id ?? null,
		replyMarkup: buttons.length > 0 ? inlineKeyboard(buttons) : undefined,
	});
}

type CommandHandler = (
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
	argument: string,
) => Promise<void>;

/** Every operator command the webhook routes here, by name. */
const COMMAND_HANDLERS: Record<string, CommandHandler> = {
	inbox: (env, config, message, chatId) => runInbox(env, config, message, chatId),
	unread: (env, config, message, chatId) => runUnread(env, config, message, chatId),
	buscar: runSearch,
	approvals: (env, config, message, chatId) => runApprovals(env, config, message, chatId),
	silencio: runQuietHours,
	silenciados: (env, config, message, chatId) => runMutedList(env, config, message, chatId),
};

export const RETRIEVAL_COMMANDS = new Set(Object.keys(COMMAND_HANDLERS));

/**
 * Runs a command, having been told the sender is an operator in the bound chat.
 *
 * Returns false when the text is not one of ours; the caller answers that with
 * "comando desconocido" rather than ever treating it as the body of a reply.
 */
export async function handleTelegramCommand(
	env: Env,
	config: TelegramConfig,
	message: TelegramMessage,
	chatId: string,
	command: ParsedCommand,
): Promise<boolean> {
	const handler = COMMAND_HANDLERS[command.name];
	if (!handler) return false;
	await handler(env, config, message, chatId, command.argument);
	return true;
}

/** The answer to a "/word" the bot does not know. */
export function renderUnknownCommand(name: string): string {
	return `Comando desconocido${name ? `: <code>/${telegramEscape(name)}</code>` : ""}. Escribe /help para ver la lista.`;
}

/**
 * Another page of the same search.
 *
 * The query is re-run rather than cached: results are ordered by arrival, so a
 * page boundary stays where it was unless new mail matched — in which case
 * re-running is the behaviour the operator wants anyway.
 */
export async function handleSearchPageCallback(
	env: Env,
	config: TelegramConfig,
	query: TelegramCallbackQuery,
): Promise<void> {
	const page = parseSearchPage(query.data ?? "");
	if (!page || !query.message) {
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "Página no disponible." });
		return;
	}
	const chatId = String(query.message.chat.id);
	const { rows, truncated } = await searchAllMailboxes(env, page.query);
	if (rows.length === 0) {
		await answerCallbackQuery(config, { callbackQueryId: query.id, text: "Ya no hay resultados." });
		return;
	}
	await emitPage(env, config, {
		chatId,
		topicId: query.message.message_thread_id ?? null,
		query: page.query,
		offset: Math.min(page.offset, Math.max(0, rows.length - 1)),
		rows,
		truncated,
	});
	// The previous control line loses its arrows so the chat never shows two live
	// paginators for one search. Best effort: a failed edit costs a stale button,
	// not the page that was just posted.
	try {
		await editMessageText(config, {
			chatId,
			messageId: query.message.message_id,
			// Rewritten rather than re-sent: query.message.text is the *rendered* text,
			// so echoing it back under parse_mode HTML would either lose the formatting
			// or, if the query contained a bracket, be rejected outright.
			text: `🔎 <b>${telegramEscape(page.query)}</b>`,
		});
	} catch {
		// A card the operator already scrolled past is not worth a redelivery.
	}
	await answerCallbackQuery(config, { callbackQueryId: query.id });
}
