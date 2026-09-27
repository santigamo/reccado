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
import type { DeliveryTestResult } from "../../src/telegram/admin/delivery-test";
import type { RebindResult } from "../../src/telegram/admin/rebind";
import type { TelegramOperatorStatus } from "../../src/telegram/admin/status";
import type { TopicListing, TopicMappingResult } from "../../src/telegram/admin/topics";
import { OperatorInputError } from "./operator-session-core";

/** Telegram's own limit on a forum topic name (the route enforces it too). */
const TOPIC_NAME_MAX = 128;

export type TopicCommand = {
	/** A mailbox id or its primary address, as typed. */
	mailboxRef: string;
	name?: string;
	adoptThreadId?: number;
	replace: boolean;
};

/**
 * `telegram topic <mailboxId|address> (--name "..." | --adopt <threadId>) [--replace]`.
 * --adopt may carry a --name too: the label stored for that thread (and reused
 * if the topic is ever recreated).
 */
export function parseTopicCommand(
	mailboxRef: string | undefined,
	flags: Record<string, string>,
): TopicCommand {
	if (!mailboxRef) {
		throw new OperatorInputError(
			'telegram topic needs a mailbox: pnpm operator telegram topic <mailboxId|address> (--name "..." | --adopt <threadId>).',
		);
	}
	const name = flags.name === undefined || flags.name === "true" ? undefined : flags.name.trim();
	if (flags.name !== undefined && !name) {
		throw new OperatorInputError('--name needs a value, e.g. --name "imsanti".');
	}
	if (name && name.length > TOPIC_NAME_MAX) {
		throw new OperatorInputError(
			`--name is ${name.length} characters; Telegram allows ${TOPIC_NAME_MAX}.`,
		);
	}
	let adoptThreadId: number | undefined;
	if (flags.adopt !== undefined) {
		adoptThreadId = Number(flags.adopt);
		if (!Number.isInteger(adoptThreadId) || adoptThreadId <= 0) {
			throw new OperatorInputError(
				`--adopt ${flags.adopt}: expected the topic's positive message_thread_id.`,
			);
		}
	}
	if (name === undefined && adoptThreadId === undefined) {
		throw new OperatorInputError(
			'Give --name "..." to create a topic, or --adopt <threadId> to map an existing one.',
		);
	}
	return {
		mailboxRef,
		...(name !== undefined ? { name } : {}),
		...(adoptThreadId !== undefined ? { adoptThreadId } : {}),
		replace: flags.replace === "true",
	};
}

/** One line per mailbox, `PASS`/`FAIL` first, so a scroll-back reads at a glance. */
export function formatDeliveryTest(result: DeliveryTestResult): string[] {
	const lines = [
		`Delivery test in ${result.chatId} (${result.isForum ? "forum: one topic per mailbox" : "no topics: flat chat"})`,
	];
	if (result.results.length === 0) lines.push("  (no active mailboxes to test)");
	for (const entry of result.results) {
		const pass = entry.outcome === "delivered_to_topic" || entry.outcome === "delivered_to_chat";
		const where =
			entry.outcome === "delivered_to_topic"
				? `topic ${entry.topicId}`
				: entry.outcome === "delivered_to_chat"
					? "the chat"
					: entry.outcome;
		lines.push(
			`  ${pass ? "PASS" : "FAIL"}  ${entry.address.padEnd(32)} ${where}${entry.reason ? ` — ${entry.reason}` : ""}`,
		);
	}
	lines.push(
		"",
		result.ok
			? "All test messages landed where real cards would."
			: "Some mailboxes would not get their cards where expected (see FAIL lines).",
		"Test messages create no reply link: answering one in Telegram sends no email.",
	);
	return lines;
}

/** A mailbox id, or a primary address resolved against GET /api/mailboxes. */
export function resolveMailboxRef(
	ref: string,
	mailboxes: ReadonlyArray<{ mailbox_id: string; primary_address: string; status?: string }>,
): string {
	const trimmed = ref.trim();
	if (!trimmed.includes("@")) {
		if (mailboxes.some((m) => m.mailbox_id === trimmed)) return trimmed;
		throw new OperatorInputError(`No mailbox with id ${trimmed}.`);
	}
	const match = mailboxes.find((m) => m.primary_address.toLowerCase() === trimmed.toLowerCase());
	if (!match) {
		throw new OperatorInputError(
			`No mailbox has the primary address ${trimmed} (aliases are not accepted here).`,
		);
	}
	return match.mailbox_id;
}

export function formatTopicResult(result: TopicMappingResult): string[] {
	const heading: Record<TopicMappingResult["outcome"], string> = {
		would_create: "Dry run — would create a forum topic and map it:",
		would_adopt: "Dry run — would map an existing forum topic:",
		created: "Created the forum topic and mapped it:",
		adopted: "Mapped the existing forum topic:",
		already: "Already mapped; nothing to do:",
	};
	const lines = [heading[result.outcome], `  chat:     ${result.chatId}`];
	if (result.mapping) {
		lines.push(
			`  mapping:  ${result.mapping.mailboxId} -> topic ${result.mapping.topicId} "${result.mapping.effectiveName}"${result.mapping.topicName ? "" : " (follows the mailbox name)"}`,
		);
	}
	if (result.replaced) {
		lines.push(
			`  replaces: topic ${result.replaced.topicId} "${result.replaced.effectiveName}" (left in Telegram, no longer used)`,
		);
	}
	if (result.reason) lines.push(`  note:     ${result.reason}`);
	if (result.dryRun && result.outcome !== "already") {
		lines.push("", "Re-run with --apply to perform it.");
	}
	return lines;
}

export function formatTopicListing(listing: TopicListing): string[] {
	const lines = [
		`bound chat: ${listing.binding.chatId ?? "(none)"} (forum: ${yesNo(listing.binding.isForum)})`,
	];
	if (listing.topics.length === 0) lines.push("  (no topic mappings)");
	for (const topic of listing.topics) {
		lines.push(
			`  ${topic.inBoundChat ? "*" : " "} ${topic.chatId.padEnd(16)} ${(topic.mailboxAddress ?? topic.mailboxId).padEnd(32)} topic ${String(topic.topicId).padEnd(6)} "${topic.effectiveName}"${topic.topicName ? "" : " (follows the mailbox name)"}`,
		);
	}
	lines.push("  (* = in the bound chat; others are kept for a rebind back)");
	return lines;
}

/**
 * `--chat` as typed: a numeric chat id or a public @username. The same rule
 * the route enforces, checked first so a typo fails before any request.
 */
export function parseChatFlag(value: string | undefined): string {
	const chat = value?.trim();
	if (!chat || chat === "true") {
		throw new OperatorInputError("--chat <id> is required (e.g. --chat -1001234567890).");
	}
	if (!/^(-?\d{1,20}|@[A-Za-z0-9_]{4,32})$/.test(chat)) {
		throw new OperatorInputError(
			`--chat ${chat}: expected a numeric Telegram chat id (e.g. -1001234567890) or a public @username.`,
		);
	}
	return chat;
}

function describeBinding(binding: { chatId: string | null; isForum: boolean | null }): string {
	if (!binding.chatId) return "(no chat bound)";
	return `${binding.chatId} (forum: ${yesNo(binding.isForum)})`;
}

export function formatRebind(result: RebindResult): string[] {
	const heading: Record<RebindResult["outcome"], string> = {
		would_rebind: "Dry run — would rebind the Telegram bridge:",
		would_be_unchanged: "Dry run — already bound to that chat; nothing would change:",
		rebound: "Rebound the Telegram bridge:",
		unchanged: "Already bound to that chat; nothing changed:",
	};
	const lines = [heading[result.outcome]];
	lines.push(`  current: ${describeBinding(result.previous)}`);
	lines.push(
		`  new:     ${describeBinding(result.current)} · ${result.current.type}${result.current.title ? ` "${result.current.title}"` : ""}`,
	);
	if (result.membership) {
		lines.push(
			`  bot:     ${result.membership.status} · can_manage_topics: ${yesNo(result.membership.canManageTopics)}`,
		);
	}
	lines.push(
		`  topics:  ${result.topics.mappedInNewChat} mapped in the new chat; ${result.topics.keptForOtherChats} kept for other chats`,
	);
	for (const note of result.notes) lines.push(`  note: ${note}`);
	if (result.dryRun && result.outcome === "would_rebind") {
		lines.push("", "Re-run with --apply to rebind.");
	}
	return lines;
}

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
