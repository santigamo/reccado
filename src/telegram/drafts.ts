/**
 * The draft behind a preview, and how a correction reaches it.
 *
 * Before this, fixing a typo meant discarding the preview, scrolling back to the
 * original card and quoting it again — so the two gestures a phone actually
 * suggests (reply to the preview; edit what you just typed) both dead-ended.
 * Replying failed with "No sé a qué correo responde esto", because resolveLink
 * only reads telegram_links and a preview is not a card; editing did nothing at
 * all, because edited_message was not in allowed_updates.
 *
 * See migrations/d1/0014_telegram_experience.sql for why this is its own table
 * and not two more columns on telegram_actions.
 */

import { sha256Hex } from "../lib/crypto";
import {
	plainTextToHtml,
	type QuotedParent,
	quoteHtmlForReply,
	quoteTextForReply,
} from "../lib/email-headers";
import type { TelegramEntity } from "./api";
import { entitiesToHtml } from "./format";
import { fetchMailboxMessage } from "./messages";

const nowIso = () => new Date().toISOString();

/** How long a preview stays editable. Matches the Send button's own TTL. */
export const DRAFT_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deterministic action token derived from the Telegram message that produced the
 * draft. Telegram retries updates it thinks failed; a random token would mint a
 * second button (and a second send attempt key) for the same reply.
 *
 * It lives here rather than in webhook.ts because the edit path has to rebuild
 * the very same Send button when it restates a preview, and two derivations of
 * one token is one derivation too many.
 */
export async function actionToken(chatId: string, messageId: number): Promise<string> {
	const digest = await sha256Hex(new TextEncoder().encode(`tg:${chatId}:${messageId}`));
	return digest.slice(0, 24);
}

export type TelegramDraftRow = {
	chat_id: string;
	preview_message_id: number;
	source_message_id: number;
	mailbox_id: string;
	draft_id: string;
	telegram_user_id: string;
	version: number;
	created_at: string;
	expires_at: string;
};

/**
 * Records which draft a preview is showing.
 *
 * Written after the preview is sent, because its message id is the key and only
 * Telegram can supply it. INSERT OR REPLACE so a redelivered update — which
 * produces the same draft through the same idempotency key — overwrites its own
 * row instead of colliding with it.
 */
export async function rememberDraftPreview(
	db: D1Database,
	row: Omit<TelegramDraftRow, "created_at" | "version"> & { version?: number },
): Promise<void> {
	await db
		.prepare(
			`INSERT OR REPLACE INTO telegram_drafts
       (chat_id, preview_message_id, source_message_id, mailbox_id, draft_id,
        telegram_user_id, version, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			row.chat_id,
			row.preview_message_id,
			row.source_message_id,
			row.mailbox_id,
			row.draft_id,
			row.telegram_user_id,
			row.version ?? 1,
			nowIso(),
			row.expires_at,
		)
		.run();
}

function unexpired(row: TelegramDraftRow | null): TelegramDraftRow | null {
	return row && Date.parse(row.expires_at) > Date.now() ? row : null;
}

/** The draft a quoted preview is about. */
export async function getDraftByPreview(
	db: D1Database,
	chatId: string,
	previewMessageId: number,
): Promise<TelegramDraftRow | null> {
	return unexpired(
		await db
			.prepare("SELECT * FROM telegram_drafts WHERE chat_id = ? AND preview_message_id = ?")
			.bind(chatId, previewMessageId)
			.first<TelegramDraftRow>(),
	);
}

/**
 * The draft an edited message produced.
 *
 * Newest first because a preview can be re-sent (a redelivered update, a second
 * attempt after a failed edit) and the row the operator is looking at is the last
 * one written.
 */
export async function getDraftBySource(
	db: D1Database,
	chatId: string,
	sourceMessageId: number,
): Promise<TelegramDraftRow | null> {
	return unexpired(
		await db
			.prepare(
				`SELECT * FROM telegram_drafts WHERE chat_id = ? AND source_message_id = ?
         ORDER BY created_at DESC LIMIT 1`,
			)
			.bind(chatId, sourceMessageId)
			.first<TelegramDraftRow>(),
	);
}

async function bumpDraftVersion(db: D1Database, row: TelegramDraftRow): Promise<number> {
	const next = row.version + 1;
	await db
		.prepare("UPDATE telegram_drafts SET version = ? WHERE chat_id = ? AND preview_message_id = ?")
		.bind(next, row.chat_id, row.preview_message_id)
		.run();
	return next;
}

/** Drops the mapping for a draft that can no longer be edited. */
export async function forgetDraftPreview(db: D1Database, row: TelegramDraftRow): Promise<void> {
	await db
		.prepare("DELETE FROM telegram_drafts WHERE chat_id = ? AND preview_message_id = ?")
		.bind(row.chat_id, row.preview_message_id)
		.run();
}

export async function deleteExpiredDraftPreviews(db: D1Database): Promise<number> {
	const result = await db
		.prepare("DELETE FROM telegram_drafts WHERE expires_at < ?")
		.bind(nowIso())
		.run();
	return result.meta.changes ?? 0;
}

/** Exactly the draft statuses a correction may still land on. */
const EDITABLE_STATUSES = new Set(["draft", "pending_confirmation"]);

export type DraftEditOutcome =
	| { status: "updated"; version: number; to: string[]; subject: string }
	/** Already sent or cancelled: the text on the wire is not ours to rewrite. */
	| { status: "closed"; draftStatus: string }
	| { status: "unknown_draft" }
	| { status: "no_parent" };

type StoredDraft = {
	id: string;
	status: string;
	to_json: string;
	subject: string;
	parent_message_id: string | null;
	thread_id: string | null;
};

/**
 * Applies a correction to the draft a preview is showing.
 *
 * The status check is the load-bearing part. `updateDraft` in the Durable Object
 * rewrites a row whatever state it is in, so without this an edit arriving after
 * the Send button was pressed would silently rewrite the record of what was
 * actually mailed — a ledger that disagrees with the recipient's inbox. The
 * mapping row is dropped in that case, so the second correction is refused by
 * lookup rather than by luck.
 *
 * Nothing is re-armed: a draft already in pending_confirmation stays there, and
 * its Send token is derived from the source message rather than stored per
 * version, so the button under the preview keeps pointing at the same draft.
 */
export async function applyDraftEdit(
	env: Env,
	row: TelegramDraftRow,
	input: { text: string; entities: TelegramEntity[] | undefined },
): Promise<DraftEditOutcome> {
	const stub = env.MAILBOX_DO.getByName(row.mailbox_id);
	const response = await stub.fetch(`https://mailbox-do/drafts/${row.draft_id}`);
	if (!response.ok) {
		return { status: "unknown_draft" };
	}
	const draft = ((await response.json()) as { draft?: StoredDraft | null }).draft;
	if (!draft?.id) {
		return { status: "unknown_draft" };
	}
	if (!EDITABLE_STATUSES.has(draft.status)) {
		await forgetDraftPreview(env.INDEX_DB, row);
		return { status: "closed", draftStatus: draft.status };
	}

	// Re-quoted from the parent rather than patched into the old body: the stored
	// body_text is the operator's words *plus* the quotation, and splicing a new
	// sentence into that string would eventually corrupt the quote it is glued to.
	const parent = draft.parent_message_id
		? await fetchMailboxMessage(env, row.mailbox_id, draft.parent_message_id)
		: null;
	if (!parent) {
		return { status: "no_parent" };
	}
	const quoted: QuotedParent = {
		fromAddr: parent.from_addr,
		date: parent.date_header ?? parent.received_at,
		bodyText: parent.body_text,
	};

	const patch = await stub.fetch(`https://mailbox-do/drafts/${row.draft_id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			bodyText: quoteTextForReply(input.text, quoted),
			bodyHtml: quoteHtmlForReply(
				input.entities?.length
					? entitiesToHtml(input.text, input.entities)
					: plainTextToHtml(input.text),
				quoted,
			),
		}),
	});
	if (!patch.ok) {
		return { status: "unknown_draft" };
	}

	let to: string[] = [];
	try {
		const parsed = JSON.parse(draft.to_json) as unknown;
		to = Array.isArray(parsed)
			? parsed.filter((entry): entry is string => typeof entry === "string")
			: [];
	} catch {
		to = [];
	}
	return {
		status: "updated",
		version: await bumpDraftVersion(env.INDEX_DB, row),
		to,
		subject: draft.subject,
	};
}
