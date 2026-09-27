/**
 * The pure half of `pnpm operator telegram ...` and `pnpm smoke:telegram`:
 * argument checks and the text printed for each /api/telegram/* answer.
 *
 * No node:* imports, so it runs in the Workers Vitest pool (same split as
 * ./operator-session-core.ts). The IO -- the session file and the HTTP calls --
 * lives in scripts/operator.ts and scripts/smoke-telegram.ts.
 *
 * The CLI never talks to Telegram itself: TELEGRAM_BOT_TOKEN is a write-only
 * worker secret, so every Telegram call happens inside the worker, behind the
 * owner session.
 */
import type { TelegramOperatorStatus } from "../../src/telegram/admin/status";

/**
 * A non-2xx answer from /api/telegram/* as one line: the route's own
 * `{ error, message }` when it sent one, else the status and a bounded body.
 */
export function describeApiRefusal(status: number, body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
		if (typeof parsed.error === "string") {
			return `${parsed.error} (HTTP ${status})${typeof parsed.message === "string" ? `: ${parsed.message}` : ""}`;
		}
	} catch {
		// Not JSON: fall through to the raw form.
	}
	return `HTTP ${status}: ${body.slice(0, 300)}`;
}

function yesNo(value: boolean | null | undefined): string {
	if (value === null || value === undefined) return "unknown";
	return value ? "yes" : "no";
}

export function formatTelegramStatus(status: TelegramOperatorStatus): string[] {
	const lines: string[] = [];
	lines.push(
		`bridge:    ${status.bridge.mode}${status.bridge.reason ? ` — ${status.bridge.reason}` : ""}`,
	);
	if (!status.bot) {
		lines.push("bot:       (bridge off: TELEGRAM_BOT_TOKEN is not set)");
	} else if (status.bot.ok) {
		lines.push(
			`bot:       @${status.bot.username ?? "?"} (id ${status.bot.id}, "${status.bot.firstName}")`,
		);
	} else {
		lines.push(`bot:       getMe failed: ${status.bot.error}`);
	}

	const { binding } = status;
	lines.push(
		`bound:     ${binding.chatId ?? "(no chat bound)"}${binding.chatId ? ` · stored forum flag: ${yesNo(binding.isForum)}` : ""}`,
	);
	if (status.chat) {
		if (status.chat.ok) {
			lines.push(
				`chat:      ${status.chat.type}${status.chat.title ? ` "${status.chat.title}"` : ""} · forum: ${yesNo(status.chat.isForum)}`,
			);
			if (binding.isForum !== null && binding.isForum !== status.chat.isForum) {
				lines.push(
					`  WARNING: the stored forum flag (${yesNo(binding.isForum)}) disagrees with Telegram (${yesNo(status.chat.isForum)}); cards follow the stored flag. Re-observe with: pnpm operator telegram rebind --chat ${binding.chatId} --apply`,
				);
			}
		} else {
			lines.push(`chat:      getChat failed: ${status.chat.error}`);
		}
	}
	if (status.membership) {
		if (status.membership.ok) {
			lines.push(
				`bot role:  ${status.membership.status} · can_manage_topics: ${yesNo(status.membership.canManageTopics)} · can post: ${yesNo(status.membership.canSendMessages)}`,
			);
			if (!status.membership.eligible || !status.membership.canManageTopics) {
				lines.push(`  ${status.membership.reason}`);
			}
		} else {
			lines.push(`bot role:  getChatMember failed: ${status.membership.error}`);
		}
	}

	const { registration, observation } = status.webhook;
	lines.push(
		`webhook:   ${registration ? `registered ${registration.registeredAt} -> ${registration.url}` : "not registered by this deployment yet"}`,
	);
	if (observation) {
		lines.push(
			`           observed ${observation.observedAt}: ${observation.pendingUpdateCount} pending${observation.lastErrorAt ? `, last error ${observation.lastErrorAt}: ${observation.lastErrorMessage ?? "?"}` : ", no delivery error"}`,
		);
	}

	lines.push("mailboxes:");
	if (status.mailboxes.length === 0) lines.push("  (no active mailboxes)");
	for (const mailbox of status.mailboxes) {
		const topic = mailbox.topic
			? `topic ${mailbox.topic.topicId} "${mailbox.topic.effectiveName}"${mailbox.topic.topicName ? "" : " (follows the mailbox name)"}`
			: binding.isForum
				? "no topic mapped (the next card creates one)"
				: "no topics (not a forum)";
		lines.push(`  ${mailbox.address.padEnd(32)} ${mailbox.mailboxId.padEnd(24)} ${topic}`);
	}
	lines.push(`  note: topics unverified — ${status.topicVerification.reason}`);
	return lines;
}
