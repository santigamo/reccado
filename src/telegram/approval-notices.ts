/**
 * Approval notices that stay true.
 *
 * A notice used to be fire-and-forget: sent once to General, with the URL twice
 * and no expiry, and left saying "pending" after the owner had approved, denied
 * or ignored it. Here a notice is an object with a life:
 *
 * - it is delivered by the notify queue (the same retrying, 429-aware path a
 *   card uses), not inline in the MCP request that created the approval;
 * - it lands in the topic of the mailbox the request is about, General otherwise;
 * - it carries a short summary, the expiry time and the URL once, as its button;
 * - its message id is remembered (telegram_approval_notices, migration 0031), and
 *   every later sync redraws it in place as Aprobado / Denegado / Caducado.
 *
 * One idempotent operation does all of it -- "make the notice show the approval's
 * current state" -- so the triggers can be blunt: the creation, the web decision,
 * a delayed queue message timed for the expiry, and the hourly sweep as backstop.
 *
 * Still link-only. There is no approve or deny button and never will be: the
 * owner approves on /approve/:id with the owner web session (AGENTS.md, "Hard
 * invariant"). Nothing here reads or changes an approval's decision.
 */

import type { TelegramApprovalNoticeQueueMessage } from "../cloudflare/types";
import { getApproval } from "../db/d1";
import { getRuntimeConfig, RUNTIME_CONFIG_KEYS } from "../db/runtime-config";
import { getTelegramTopicMapping } from "../db/telegram-topics";
import { buildApprovalUrl, getIntentCard, type IntentStatusName } from "../lib/approvals";
import {
	editMessageText,
	isMissingTopicError,
	isNotModifiedError,
	readTelegramConfig,
	sendMessage,
	TelegramApiError,
} from "./api";
import { resolveTelegramChatId } from "./binding";
import {
	type DecidedNoticeState,
	intentCardKeyboard,
	renderDecidedNotice,
	renderIntentCardText,
} from "./intent-cards";
import { formatMinutes, formatOffset, readQuietHours } from "./noise";

export type NoticeState = "pending" | DecidedNoticeState;

type NoticeRow = {
	approval_id: string;
	chat_id: string;
	message_id: number;
	topic_id: number | null;
	state: NoticeState;
};

/** What the notice should show for an approval in this state. */
export function noticeStateFor(status: IntentStatusName): NoticeState {
	switch (status) {
		case "pending":
			return "pending";
		case "denied":
			return "denied";
		case "expired":
			return "expired";
		case "stale":
			return "stale";
		default:
			// approved, sent, executed, failed: the owner said yes. What happened after
			// is on the page; the notice only has to stop asking.
			return "approved";
	}
}

/**
 * "14:32 (UTC+02:00)", in the operator's clock.
 *
 * The only clock the bridge knows the operator lives in is the one he stated his
 * quiet hours in, so that offset is reused; without one, UTC is said out loud
 * rather than passed off as local time.
 */
export function formatExpiry(iso: string | null, utcOffsetMinutes: number): string | null {
	if (!iso) return null;
	const at = Date.parse(iso);
	if (!Number.isFinite(at)) return null;
	const local = new Date(at + utcOffsetMinutes * 60_000);
	const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
	const zone = utcOffsetMinutes === 0 ? "UTC" : `UTC${formatOffset(utcOffsetMinutes)}`;
	return `${formatMinutes(minutes)} (${zone})`;
}

/** The mailbox a request is about: the send's own mailbox, or the one a control-plane payload names. */
async function mailboxOfApproval(db: D1Database, approvalId: string): Promise<string | null> {
	const row = await db
		.prepare("SELECT mailbox_id, payload_json FROM approvals WHERE token = ?")
		.bind(approvalId)
		.first<{ mailbox_id: string | null; payload_json: string | null }>()
		.catch(() => null);
	if (!row) return null;
	if (row.mailbox_id) return row.mailbox_id;
	try {
		const payload = JSON.parse(row.payload_json ?? "null") as { mailboxId?: unknown } | null;
		return typeof payload?.mailboxId === "string" && payload.mailboxId ? payload.mailboxId : null;
	} catch {
		return null;
	}
}

async function getNotice(db: D1Database, approvalId: string): Promise<NoticeRow | null> {
	return db
		.prepare(
			"SELECT approval_id, chat_id, message_id, topic_id, state FROM telegram_approval_notices WHERE approval_id = ?",
		)
		.bind(approvalId)
		.first<NoticeRow>();
}

async function setNoticeState(db: D1Database, approvalId: string, state: NoticeState) {
	await db
		.prepare("UPDATE telegram_approval_notices SET state = ?, updated_at = ? WHERE approval_id = ?")
		.bind(state, new Date().toISOString(), approvalId)
		.run();
}

export type ApprovalNoticeOutcome =
	| { status: "sent" | "edited" | "unchanged" }
	| {
			status: "skipped";
			reason: "bridge_disabled" | "no_chat" | "no_origin" | "already_decided";
	  };

/**
 * Makes the approval's notice show the approval's current state.
 *
 * - no notice yet, approval pending -> send one (mailbox topic, else General);
 * - no notice yet, approval already decided -> nothing: announcing a request
 *   nobody can act on any more would be noise;
 * - a notice whose drawn state differs -> edit it in place;
 * - same state -> nothing, which is what makes redeliveries harmless.
 *
 * Throws on transport failures so the queue can redeliver; permanent skips are
 * returned, like a card's.
 */
export async function syncApprovalNotice(
	env: Env,
	input: { approvalId: string; compact?: boolean },
): Promise<ApprovalNoticeOutcome> {
	const config = readTelegramConfig(env);
	if (!config) return { status: "skipped", reason: "bridge_disabled" };
	const chatId = await resolveTelegramChatId(env);
	if (!chatId) return { status: "skipped", reason: "no_chat" };

	const view = await getIntentCard(env, input.approvalId);
	const state = noticeStateFor(view.status);
	const notice = await getNotice(env.INDEX_DB, input.approvalId);

	if (!notice) {
		if (state !== "pending") return { status: "skipped", reason: "already_decided" };
		const origin = await getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.deploymentOrigin);
		const url = origin ? buildApprovalUrl(origin, input.approvalId) : null;
		if (!url) return { status: "skipped", reason: "no_origin" };
		const [hours, mailboxId] = await Promise.all([
			// Only the clock is wanted; a missing settings row means UTC, never no notice.
			readQuietHours(env.INDEX_DB).catch(() => ({ utcOffsetMinutes: 0 })),
			mailboxOfApproval(env.INDEX_DB, input.approvalId),
		]);
		const text = renderIntentCardText(view, {
			compact: input.compact,
			expires: formatExpiry(view.expiresAt, hours.utcOffsetMinutes),
		});
		// Only an existing topic: a request is not a reason to create one, and a
		// deleted topic sends the notice to General rather than failing it.
		let topicId = mailboxId
			? ((await getTelegramTopicMapping(env.INDEX_DB, chatId, mailboxId).catch(() => null))
					?.topic_id ?? null)
			: null;
		const send = () =>
			sendMessage(config, {
				chatId,
				text,
				messageThreadId: topicId,
				replyMarkup: intentCardKeyboard(url),
			});
		let sent: Awaited<ReturnType<typeof sendMessage>>;
		try {
			sent = await send();
		} catch (error) {
			if (topicId === null || !isMissingTopicError(error)) throw error;
			topicId = null;
			sent = await send();
		}
		const now = new Date().toISOString();
		await env.INDEX_DB.prepare(
			`INSERT INTO telegram_approval_notices (approval_id, chat_id, message_id, topic_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(approval_id) DO UPDATE SET chat_id = excluded.chat_id, message_id = excluded.message_id,
         topic_id = excluded.topic_id, state = 'pending', updated_at = excluded.updated_at`,
		)
			.bind(input.approvalId, chatId, sent.message_id, topicId, now, now)
			.run();
		return { status: "sent" };
	}

	if (notice.state === state || state === "pending") return { status: "unchanged" };
	try {
		await editMessageText(config, {
			chatId: notice.chat_id,
			messageId: notice.message_id,
			text: renderDecidedNotice(view, state),
		});
	} catch (error) {
		// "Not modified" means it already says so; any other 400 means the message
		// is gone or no longer editable (Telegram refuses edits after 48 h), and both
		// are permanent -- record the state so the sweep stops trying.
		const permanent =
			isNotModifiedError(error) || (error instanceof TelegramApiError && error.statusCode === 400);
		if (!permanent) throw error;
	}
	await setNoticeState(env.INDEX_DB, input.approvalId, state);
	return { status: "edited" };
}

/** Queue delays are capped by Cloudflare Queues at 12 hours. */
const MAX_DELAY_SECONDS = 43_200;

/**
 * Queues a sync, best effort. Never throws: an approval must not fail because the
 * chat bridge is off or the queue hiccupped -- the hourly sweep is the backstop.
 */
export async function enqueueApprovalNoticeSync(
	env: Env,
	input: { approvalId: string; compact?: boolean; delaySeconds?: number },
): Promise<void> {
	if (!readTelegramConfig(env)) return;
	try {
		const delay = Math.max(0, Math.min(MAX_DELAY_SECONDS, Math.ceil(input.delaySeconds ?? 0)));
		await env.NOTIFY_QUEUE.send(
			{
				schemaVersion: 1,
				eventType: "telegram.approval_notice.v1",
				notice: { approvalId: input.approvalId, compact: input.compact ?? false },
			} satisfies TelegramApprovalNoticeQueueMessage,
			delay > 0 ? { delaySeconds: delay } : undefined,
		);
	} catch (error) {
		console.error("telegram.approval_notice_enqueue_failed", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Announces a new approval request, and books the edit that will mark it expired.
 *
 * Expiry is handled by a delayed queue message timed a few seconds past
 * `expires_at` (approvals last 10 minutes): no polling, and a redelivery is a
 * no-op. If that message is lost, the hourly sweep below catches the notice.
 */
export async function announceApproval(
	env: Env,
	input: { approvalId: string; compact: boolean },
): Promise<void> {
	if (!readTelegramConfig(env)) return;
	await enqueueApprovalNoticeSync(env, input);
	const row = await getApproval(env.INDEX_DB, input.approvalId).catch(() => null);
	const expiresAt = row ? Date.parse(row.expires_at) : Number.NaN;
	if (Number.isFinite(expiresAt)) {
		await enqueueApprovalNoticeSync(env, {
			approvalId: input.approvalId,
			delaySeconds: (expiresAt - Date.now()) / 1000 + 5,
		});
	}
}

/** Notices per sweep; a backlog larger than this drains over the next hours. */
const SWEEP_LIMIT = 20;

/**
 * The hourly backstop: every notice still drawn as pending is synced, which
 * edits the ones whose approval was decided or ran out while the queue message
 * that should have said so was lost. Never throws.
 */
export async function reconcileApprovalNotices(env: Env): Promise<number> {
	if (!readTelegramConfig(env)) return 0;
	const pending = await env.INDEX_DB.prepare(
		"SELECT approval_id FROM telegram_approval_notices WHERE state = 'pending' ORDER BY created_at ASC LIMIT ?",
	)
		.bind(SWEEP_LIMIT)
		.all<{ approval_id: string }>()
		.catch(() => null);
	let edited = 0;
	for (const row of pending?.results ?? []) {
		try {
			const outcome = await syncApprovalNotice(env, { approvalId: row.approval_id });
			if (outcome.status === "edited") edited += 1;
		} catch (error) {
			console.warn("telegram.approval_notice_sweep_failed", {
				approvalId: row.approval_id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return edited;
}
