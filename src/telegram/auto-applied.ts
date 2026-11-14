import { getApproval } from "../db/d1";
import { applyControlPlaneNow, ownerForUser, type ControlPlaneRequest } from "../lib/control-plane-intents";
import { controlPlaneKind } from "../lib/control-plane-registry";
import { answerCallbackQuery, editMessageText, inlineKeyboard, readTelegramConfig, sendMessage, type TelegramCallbackQuery, type TelegramConfig } from "./api";
import { resolveTelegramChatId } from "./binding";
import { telegramEscape } from "./format";

/** Callback data: `undo:<intent id>` (43-char token, well inside Telegram's 64 bytes). */
export const UNDO_CALLBACK_PREFIX = "undo:";

type SnapshotRef = { itemIndex: number; snapshotId: string };

/** The server-rendered notice body. Everything shown is derived from the validated payload, never from the client. */
export function renderAutoAppliedNotice(input: {
	kind: string;
	clientId: string;
	applied: NonNullable<ControlPlaneRequest["applied"]>;
}): string {
	const { applied } = input;
	const lines = [`<b>Cambio aplicado automáticamente</b>`, `Cliente: <code>${telegramEscape(input.clientId)}</code>`];
	for (const [i, item] of applied.items.entries()) {
		const mark = item.status === "executed" ? "✅" : item.status === "failed" ? "❌" : "⏭";
		const detail = item.status === "failed" ? ` (${telegramEscape(item.errorCode ?? "error")})` : "";
		lines.push(`${mark} ${telegramEscape(applied.summaries[i] ?? input.kind)} — <code>${telegramEscape(applied.targets[i] ?? "")}</code>${detail}`);
	}
	if (applied.variableLinks.length)
		lines.push(`⚠️ Enlaces variables permitidos por la política: <code>${applied.variableLinks.map(telegramEscape).join(", ")}</code> (el valor lo pone el servidor del producto al enviar).`);
	return lines.join("\n");
}

/**
 * Best-effort notice to the owner's bound chat after a delegated client's change was applied.
 * The "↩️ Deshacer" button is offered only when the change left a snapshot `restore` can reapply.
 */
export async function notifyAutoApplied(
	env: Env,
	input: { intentId: string; kind: string; applied: NonNullable<ControlPlaneRequest["applied"]> },
): Promise<void> {
	const config = readTelegramConfig(env);
	const chatId = await resolveTelegramChatId(env);
	if (!config || !chatId) return;
	const undoable = input.applied.snapshotIds.some((ids) => ids.length > 0);
	await sendMessage(config, {
		chatId,
		text: renderAutoAppliedNotice({ kind: input.kind, clientId: input.applied.policy.clientId, applied: input.applied }),
		...(undoable ? { replyMarkup: inlineKeyboard([[{ text: "↩️ Deshacer", callback_data: `${UNDO_CALLBACK_PREFIX}${input.intentId}` }]]) } : {}),
	});
}

async function snapshotRefs(env: Env, intentId: string): Promise<SnapshotRef[]> {
	const rows = await env.INDEX_DB.prepare(
		"SELECT id, payload_json FROM ops_events WHERE event_type = 'admin.auto_applied' AND id LIKE ? ORDER BY id",
	)
		.bind(`auto_applied:${intentId}:%`)
		.all<{ id: string; payload_json: string }>();
	const refs: SnapshotRef[] = [];
	for (const row of rows.results ?? []) {
		const index = Number(row.id.split(":").pop());
		const ids = (JSON.parse(row.payload_json) as { snapshot_ids?: unknown }).snapshot_ids;
		for (const id of Array.isArray(ids) ? ids : []) if (typeof id === "string") refs.push({ itemIndex: index, snapshotId: id });
	}
	return refs;
}

/** Restores every snapshot an auto-applied intent wrote. Returns how many were restored. */
export async function undoAutoApplied(env: Env, intentId: string): Promise<number> {
	const row = await getApproval(env.INDEX_DB, intentId);
	if (!row || row.origin !== "mcp" || !row.token_sub) throw new Error("not_found");
	const via = await env.INDEX_DB.prepare("SELECT approved_via FROM approvals WHERE token = ?").bind(intentId).first<{ approved_via: string | null }>();
	if (via?.approved_via !== "auto") throw new Error("not_found");
	const refs = await snapshotRefs(env, intentId);
	if (!refs.length) throw new Error("nothing_to_undo");
	const owner = await ownerForUser(env, row.token_sub);
	const restore = controlPlaneKind("restore");
	if (!restore) throw new Error("invalid_intent_kind");
	let restored = 0;
	// Newest change first, so stacked edits of one template unwind in order.
	for (const ref of refs.reverse()) {
		const applied = await applyControlPlaneNow(env, owner, {
			kind: "restore",
			validated: [restore.validate({ opsEventId: ref.snapshotId })],
			isBatch: false,
			principal: { tokenSub: row.token_sub },
			via: "undo",
		});
		if (applied.items[0]?.status === "executed") restored += 1;
		else if (applied.items[0]?.errorCode === "snapshot_consumed") continue;
		else throw new Error(applied.items[0]?.errorCode ?? "undo_failed");
	}
	return restored;
}

/** Handles the "↩️ Deshacer" press. The caller has already checked the operator allowlist. */
export async function handleUndoCallback(env: Env, config: TelegramConfig, query: TelegramCallbackQuery): Promise<void> {
	const intentId = (query.data ?? "").slice(UNDO_CALLBACK_PREFIX.length);
	let text: string;
	try {
		const restored = await undoAutoApplied(env, intentId);
		text = restored ? "Deshecho" : "Ya estaba deshecho";
	} catch (error) {
		const code = error instanceof Error ? error.message : "";
		text = code === "nothing_to_undo" || code === "not_found" ? "No se puede deshacer" : "No se pudo deshacer";
	}
	await answerCallbackQuery(config, { callbackQueryId: query.id, text });
	if (query.message && text !== "No se pudo deshacer")
		await editMessageText(config, {
			chatId: String(query.message.chat.id),
			messageId: query.message.message_id,
			text: `${telegramEscape("↩️")} ${telegramEscape(text)}`,
		}).catch(() => undefined);
}
