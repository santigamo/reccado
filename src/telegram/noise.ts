/**
 * What the bridge is allowed to interrupt you with.
 *
 * A catch-all address on a public domain grows noise until the operator mutes the
 * whole bot, and a bridge nobody looks at is a bridge that died of success. The
 * three answers here are deliberately narrow, and none of them ever stops mail
 * from being *stored*: a muted sender, a night that batches into one summary, and
 * a badge that says this address has never written before — the one piece of
 * context that makes a cold inbox readable at all.
 *
 * Storage lives beside the bridge, like telegram_topics: nothing outside
 * src/telegram reads it, and losing the whole thing costs a night of grouping,
 * never an email.
 */

import { insertOpsEvent } from "../db/d1";
import {
	inlineKeyboard,
	readTelegramConfig,
	sendMessage,
	type TelegramConfig,
	type TelegramInlineButton,
} from "./api";
import { resolveTelegramChatId } from "./binding";
import { renderNightDigest } from "./format";
import { listMailIndexRows } from "./index-rows";

const nowIso = () => new Date().toISOString();

// --- muted senders ---------------------------------------------------------

/** Addresses compare case-insensitively in practice; the table stores one form. */
function normalizeSender(sender: string): string {
	return sender.trim().toLowerCase();
}

export async function isSenderMuted(db: D1Database, sender: string): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS hit FROM telegram_muted_senders WHERE sender = ?")
		.bind(normalizeSender(sender))
		.first<{ hit: number }>();
	return row !== null;
}

/**
 * Flips the mute for a sender and answers with the state it is now in.
 *
 * A toggle rather than a one-way switch because the button is the only place the
 * decision is ever visible: a sender you silenced still appears in /buscar and in
 * a digest, and pressing the same button there is how you take it back. A mute
 * you cannot find your way out of is a mute nobody dares to press.
 */
export async function toggleSenderMute(
	db: D1Database,
	input: { sender: string; mutedBy: string },
): Promise<boolean> {
	const sender = normalizeSender(input.sender);
	if (await isSenderMuted(db, sender)) {
		await db.prepare("DELETE FROM telegram_muted_senders WHERE sender = ?").bind(sender).run();
		return false;
	}
	await db
		.prepare(
			"INSERT OR REPLACE INTO telegram_muted_senders (sender, muted_at, muted_by) VALUES (?, ?, ?)",
		)
		.bind(sender, nowIso(), input.mutedBy)
		.run();
	return true;
}

export async function listMutedSenders(db: D1Database, limit = 50): Promise<string[]> {
	const result = await db
		.prepare("SELECT sender FROM telegram_muted_senders ORDER BY muted_at DESC LIMIT ?")
		.bind(limit)
		.all<{ sender: string }>();
	return (result.results ?? []).map((row) => row.sender);
}

// --- quiet hours -----------------------------------------------------------

export type QuietHours = {
	/** Minutes from local midnight. Null on both ends means quiet hours are off. */
	startMinutes: number | null;
	endMinutes: number | null;
	/** The operator states a window in his own clock; the worker only knows UTC. */
	utcOffsetMinutes: number;
};

const QUIET_HOURS_OFF: QuietHours = {
	startMinutes: null,
	endMinutes: null,
	utcOffsetMinutes: 0,
};

export async function readQuietHours(db: D1Database): Promise<QuietHours> {
	const row = await db
		.prepare(
			"SELECT quiet_start_minutes, quiet_end_minutes, utc_offset_minutes FROM telegram_settings WHERE id = 1",
		)
		.first<{
			quiet_start_minutes: number | null;
			quiet_end_minutes: number | null;
			utc_offset_minutes: number;
		}>();
	if (!row) return QUIET_HOURS_OFF;
	return {
		startMinutes: row.quiet_start_minutes,
		endMinutes: row.quiet_end_minutes,
		utcOffsetMinutes: row.utc_offset_minutes ?? 0,
	};
}

export async function writeQuietHours(db: D1Database, hours: QuietHours): Promise<void> {
	await db
		.prepare(
			`INSERT INTO telegram_settings (id, quiet_start_minutes, quiet_end_minutes, utc_offset_minutes, updated_at)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         quiet_start_minutes = excluded.quiet_start_minutes,
         quiet_end_minutes = excluded.quiet_end_minutes,
         utc_offset_minutes = excluded.utc_offset_minutes,
         updated_at = excluded.updated_at`,
		)
		.bind(hours.startMinutes, hours.endMinutes, hours.utcOffsetMinutes, nowIso())
		.run();
}

/**
 * Is `at` inside the window?
 *
 * The wrap-around case is the only one anybody configures — 23:00 to 08:00 is a
 * night, not an empty interval — so the comparison is deliberately two-branched
 * rather than a clever modulo that reads correctly and behaves wrongly at 00:00.
 */
export function isWithinQuietHours(hours: QuietHours, at: Date): boolean {
	if (hours.startMinutes === null || hours.endMinutes === null) return false;
	if (hours.startMinutes === hours.endMinutes) return false;
	const utcMinutes = at.getUTCHours() * 60 + at.getUTCMinutes();
	const local = (((utcMinutes + hours.utcOffsetMinutes) % 1440) + 1440) % 1440;
	return hours.startMinutes < hours.endMinutes
		? local >= hours.startMinutes && local < hours.endMinutes
		: local >= hours.startMinutes || local < hours.endMinutes;
}

export async function isQuietNow(db: D1Database, at = new Date()): Promise<boolean> {
	return isWithinQuietHours(await readQuietHours(db), at);
}

function twoDigits(value: number): string {
	return String(value).padStart(2, "0");
}

export function formatMinutes(minutes: number): string {
	return `${twoDigits(Math.floor(minutes / 60))}:${twoDigits(minutes % 60)}`;
}

export function formatOffset(minutes: number): string {
	const sign = minutes < 0 ? "-" : "+";
	const absolute = Math.abs(minutes);
	return `${sign}${twoDigits(Math.floor(absolute / 60))}:${twoDigits(absolute % 60)}`;
}

/**
 * `23:00-08:00 +02:00` -> a window. `off` -> quiet hours disabled.
 *
 * The offset is part of the command rather than a separate setting because the
 * two are only ever meaningful together: a window without the clock it was stated
 * in is a window that silences the wrong nine hours.
 */
export function parseQuietHours(argument: string): QuietHours | "off" | null {
	const text = argument.trim().toLowerCase();
	if (!text || text === "off" || text === "no" || text === "nunca") return "off";
	const match = text.match(
		/^(\d{1,2}):(\d{2})\s*[-–a]\s*(\d{1,2}):(\d{2})(?:\s*(?:utc)?\s*([+-])(\d{1,2})(?::?(\d{2}))?)?$/,
	);
	if (!match) return null;
	const [, startHour, startMinute, endHour, endMinute, sign, offsetHour, offsetMinute] = match;
	const start = Number(startHour) * 60 + Number(startMinute);
	const end = Number(endHour) * 60 + Number(endMinute);
	if (start >= 1440 || end >= 1440 || Number(startMinute) > 59 || Number(endMinute) > 59) {
		return null;
	}
	const offsetMagnitude = Number(offsetHour ?? 0) * 60 + Number(offsetMinute ?? 0);
	if (offsetMagnitude > 14 * 60) return null;
	return {
		startMinutes: start,
		endMinutes: end,
		utcOffsetMinutes: sign === "-" ? -offsetMagnitude : offsetMagnitude,
	};
}

// --- retention and the morning digest --------------------------------------

export type RetainedRow = {
	id: string;
	chat_id: string;
	mailbox_id: string;
	mailbox_address: string;
	message_local_id: string;
	thread_id: string;
	from_addr: string;
	retained_at: string;
	digest_at: string | null;
};

/**
 * Short enough to ride in callback_data next to a verb, long enough that two
 * retained emails never collide inside one night.
 */
function retainedId(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function retainNotification(
	db: D1Database,
	input: {
		chatId: string;
		mailboxId: string;
		mailboxAddress: string;
		messageLocalId: string;
		threadId: string;
		fromAddr: string;
	},
): Promise<void> {
	// One row per email, whatever the queue does: a redelivered notification must
	// not put the same message in the digest twice.
	const existing = await db
		.prepare(
			"SELECT id FROM telegram_retained WHERE chat_id = ? AND mailbox_id = ? AND message_local_id = ?",
		)
		.bind(input.chatId, input.mailboxId, input.messageLocalId)
		.first<{ id: string }>();
	if (existing) return;
	await db
		.prepare(
			`INSERT INTO telegram_retained
       (id, chat_id, mailbox_id, mailbox_address, message_local_id, thread_id, from_addr, retained_at, digest_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			retainedId(),
			input.chatId,
			input.mailboxId,
			input.mailboxAddress,
			input.messageLocalId,
			input.threadId,
			input.fromAddr,
			nowIso(),
		)
		.run();
}

export async function getRetainedItem(db: D1Database, id: string): Promise<RetainedRow | null> {
	return db.prepare("SELECT * FROM telegram_retained WHERE id = ?").bind(id).first<RetainedRow>();
}

async function pendingRetained(db: D1Database, chatId: string): Promise<RetainedRow[]> {
	const result = await db
		.prepare(
			`SELECT * FROM telegram_retained WHERE chat_id = ? AND digest_at IS NULL
       ORDER BY retained_at ASC LIMIT 200`,
		)
		.bind(chatId)
		.all<RetainedRow>();
	return result.results ?? [];
}

/**
 * Rows whose digest is old enough that nobody is still tapping its buttons.
 *
 * Retained-but-never-digested rows are deliberately never swept by age: they are
 * mail the operator has not been told about, and dropping them silently is the
 * one outcome this whole mechanism exists to avoid.
 */
export async function deleteStaleDigestItems(
	db: D1Database,
	olderThanMs = 7 * 86_400_000,
): Promise<number> {
	const result = await db
		.prepare("DELETE FROM telegram_retained WHERE digest_at IS NOT NULL AND digest_at < ?")
		.bind(new Date(Date.now() - olderThanMs).toISOString())
		.run();
	return result.meta.changes ?? 0;
}

/** More buttons than this and the summary stops being one glance. */
const DIGEST_BUTTON_LIMIT = 12;
const DIGEST_BUTTONS_PER_ROW = 4;

export type DigestOutcome =
	| { status: "sent"; count: number }
	| {
			status: "skipped";
			reason: "bridge_disabled" | "no_chat" | "quiet_hours" | "nothing_pending";
	  };

/**
 * Empties the night into one message.
 *
 * One message, not one per email, and that is the point rather than a nicety:
 * Telegram accepts roughly one message per second per chat, so releasing six
 * hours of retained mail card by card would either be throttled into the
 * afternoon or answered with 429s. A summary with numbered buttons spends one
 * message and still leaves every item one tap from a real, operable card.
 *
 * Called from the notification path (the first email after the window closes
 * flushes what the window held) and from the hourly cron, so a quiet morning with
 * no new mail still gets its digest.
 */
export async function flushTelegramDigest(env: Env, at = new Date()): Promise<DigestOutcome> {
	const config = readTelegramConfig(env);
	if (!config) return { status: "skipped", reason: "bridge_disabled" };
	const chatId = await resolveTelegramChatId(env);
	if (!chatId) return { status: "skipped", reason: "no_chat" };
	if (await isQuietNow(env.INDEX_DB, at)) return { status: "skipped", reason: "quiet_hours" };

	const pending = await pendingRetained(env.INDEX_DB, chatId);
	if (pending.length === 0) return { status: "skipped", reason: "nothing_pending" };

	await sendDigest(env, config, chatId, pending);
	// Marked only after Telegram accepted the summary: a failure here throws to the
	// caller, and the rows stay pending so the next pass tries again rather than
	// swallowing a night of mail.
	await env.INDEX_DB.prepare(
		`UPDATE telegram_retained SET digest_at = ? WHERE chat_id = ? AND digest_at IS NULL`,
	)
		.bind(nowIso(), chatId)
		.run();
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "telegram.digest_sent",
		severity: "info",
		subject: chatId,
		payload_json: JSON.stringify({ count: pending.length }),
	}).catch(() => undefined);
	return { status: "sent", count: pending.length };
}

/** Callback verb for "open the card for item N of the digest". */
export const DIGEST_CALLBACK_VERB = "g";

async function sendDigest(
	env: Env,
	config: TelegramConfig,
	chatId: string,
	rows: RetainedRow[],
): Promise<void> {
	// Subjects are re-read rather than retained, so the summary and the card it
	// expands into can never disagree about the same email.
	const subjects = new Map<string, string | null>();
	const byMailbox = new Map<string, string[]>();
	for (const row of rows) {
		byMailbox.set(row.mailbox_id, [...(byMailbox.get(row.mailbox_id) ?? []), row.message_local_id]);
	}
	for (const [mailboxId, ids] of byMailbox) {
		for (const indexed of await listMailIndexRows(env.INDEX_DB, mailboxId, ids)) {
			subjects.set(`${mailboxId}/${indexed.message_local_id}`, indexed.subject);
		}
	}

	const shown = rows.slice(0, DIGEST_BUTTON_LIMIT);
	const text = renderNightDigest({
		total: rows.length,
		items: shown.map((row) => ({
			fromAddr: row.from_addr,
			subject: subjects.get(`${row.mailbox_id}/${row.message_local_id}`) ?? null,
		})),
	});

	const buttons: TelegramInlineButton[][] = [];
	shown.forEach((row, index) => {
		const target = Math.floor(index / DIGEST_BUTTONS_PER_ROW);
		buttons[target] ??= [];
		buttons[target]?.push({
			text: String(index + 1),
			callback_data: `v1:${DIGEST_CALLBACK_VERB}:${row.id}`,
		});
	});

	await sendMessage(config, {
		chatId,
		text,
		replyMarkup: buttons.length > 0 ? inlineKeyboard(buttons) : undefined,
	});
}
