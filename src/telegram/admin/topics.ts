/**
 * GET / POST /api/telegram/topics: which forum topic each mailbox posts into.
 *
 * A mapping can be made two ways: by creating a topic under a name the operator
 * chose, or by adopting a thread that already exists (created by a person, or
 * by another bot -- the workaround this replaces). Either way the name is stored
 * with the mapping (migration 0020), so it no longer has to be the mailbox's
 * display_name, which is also the From name its replies go out with.
 */

import { getMailbox, insertOpsEvent, listMailboxes } from "../../db/d1";
import { RUNTIME_CONFIG_KEYS, setRuntimeConfig } from "../../db/runtime-config";
import {
	getTelegramTopicMapping,
	listTelegramTopics,
	type TelegramTopicRow,
	upsertTelegramTopic,
} from "../../db/telegram-topics";
import {
	createForumTopic,
	getChat,
	readTelegramConfig,
	TelegramApiError,
	type TelegramConfig,
} from "../api";
import { chatSupportsTopics } from "../binding";
import {
	type AdminResult,
	type BindingState,
	bridgeDisabled,
	describeTelegramError,
	isForumChat,
	mappingView,
	noChatBound,
	readBinding,
	refuse,
	TOPIC_UNVERIFIED_REASON,
	type TopicMappingView,
} from "./shared";

/** Telegram's own limit on a forum topic name. */
export const TELEGRAM_TOPIC_NAME_MAX = 128;

export type TopicMappingRequest = {
	mailboxId: string;
	name?: string;
	adoptThreadId?: number;
	replace?: boolean;
};

export type TopicMappingDecision =
	| { kind: "already"; existing: TelegramTopicRow }
	| { kind: "conflict"; existing: TelegramTopicRow }
	| { kind: "create"; name: string; replacing: TelegramTopicRow | null }
	| { kind: "adopt"; topicId: number; name: string | null; replacing: TelegramTopicRow | null };

/**
 * What a mapping request should do, given the mapping already in place.
 *
 * Idempotent on purpose, so `pnpm onboard` can re-run it: asking again for what
 * is already there (the same adopted thread, or a created topic under the same
 * stored name) is `already`, not a second topic. Anything else that collides
 * with an existing mapping is a conflict unless the caller said `replace` -- a
 * mapping decides where a mailbox's mail lands, and moving it must be
 * deliberate.
 */
export function decideTopicMapping(
	request: TopicMappingRequest,
	existing: TelegramTopicRow | null,
): TopicMappingDecision {
	const name = request.name?.trim() || null;
	if (existing) {
		const same =
			request.adoptThreadId !== undefined
				? existing.topic_id === request.adoptThreadId &&
					(name === null || name === existing.topic_name)
				: name !== null && name === existing.topic_name;
		if (same) return { kind: "already", existing };
		if (!request.replace) return { kind: "conflict", existing };
	}
	const replacing = existing ?? null;
	if (request.adoptThreadId !== undefined) {
		return { kind: "adopt", topicId: request.adoptThreadId, name, replacing };
	}
	// The route's schema guarantees one of the two; reaching here without a name is a bug.
	if (!name) throw new Error("decideTopicMapping: a name is required to create a topic");
	return { kind: "create", name, replacing };
}

export type TopicListing = {
	binding: BindingState;
	/** Every mapping in every chat; `inBoundChat` marks the ones in force. */
	topics: Array<TopicMappingView & { mailboxAddress: string | null; inBoundChat: boolean }>;
};

export async function listTelegramTopicMappings(env: Env): Promise<TopicListing> {
	const [binding, rows, mailboxes] = await Promise.all([
		readBinding(env),
		listTelegramTopics(env.INDEX_DB),
		listMailboxes(env.INDEX_DB),
	]);
	const byId = new Map(mailboxes.map((mailbox) => [mailbox.mailbox_id, mailbox]));
	return {
		binding,
		topics: rows.map((row) => {
			const mailbox = byId.get(row.mailbox_id) ?? null;
			return {
				...mappingView(row, mailbox),
				mailboxAddress: mailbox?.primary_address ?? null,
				inBoundChat: row.chat_id === binding.chatId,
			};
		}),
	};
}

export type TopicMappingResult = {
	outcome: "created" | "adopted" | "already" | "would_create" | "would_adopt";
	dryRun: boolean;
	chatId: string;
	/** The mapping in force afterwards. Null for a dry-run create: no topic id exists yet. */
	mapping: TopicMappingView | null;
	/** The mapping this request replaced (`replace: true`). Its topic is left in Telegram. */
	replaced: TopicMappingView | null;
	/** True only for a topic this request just created; see TOPIC_UNVERIFIED_REASON. */
	topicVerified: boolean;
	reason: string | null;
};

/**
 * Whether the bound chat is a forum, asked of Telegram when it answers.
 *
 * Live rather than the stored flag because the operator may have turned Topics
 * on since /start, and refusing a topic over a stale "0" would send him back to
 * raw D1. Outside dry runs the observation is remembered, exactly as /start
 * remembers it; a failed probe falls back to the stored flag.
 */
async function observeForum(
	env: Env,
	config: TelegramConfig,
	chatId: string,
	persist: boolean,
): Promise<boolean> {
	let isForum: boolean;
	try {
		isForum = isForumChat(await getChat(config, { chatId }));
	} catch {
		return chatSupportsTopics(env);
	}
	if (persist) {
		await setRuntimeConfig(
			env.INDEX_DB,
			RUNTIME_CONFIG_KEYS.telegramChatIsForum,
			isForum ? "1" : "0",
		);
	}
	return isForum;
}

export async function mapTelegramTopic(
	env: Env,
	input: TopicMappingRequest & { dryRun: boolean },
): Promise<AdminResult<TopicMappingResult>> {
	const config = readTelegramConfig(env);
	if (!config) return bridgeDisabled();
	const mailbox = await getMailbox(env.INDEX_DB, input.mailboxId);
	if (!mailbox || mailbox.status !== "active") {
		return refuse(404, "mailbox_not_found", `No active mailbox ${input.mailboxId}.`);
	}
	const binding = await readBinding(env);
	if (!binding.chatId) return noChatBound();
	const chatId = binding.chatId;
	if (!(await observeForum(env, config, chatId, !input.dryRun))) {
		return refuse(
			409,
			"chat_not_forum",
			`The bound chat ${chatId} is not a forum. Turn on Topics in the group's settings, then re-run (or move the bridge: pnpm operator telegram rebind --chat <id> --apply).`,
		);
	}

	const existing = await getTelegramTopicMapping(env.INDEX_DB, chatId, input.mailboxId);
	const decision = decideTopicMapping(input, existing);
	if (decision.kind === "conflict") {
		return refuse(
			409,
			"topic_mapping_exists",
			`Mailbox ${input.mailboxId} is already mapped to topic ${decision.existing.topic_id} in ${chatId}. Pass replace: true to move it.`,
			{ existing: mappingView(decision.existing, mailbox) },
		);
	}
	const base = { dryRun: input.dryRun, chatId };
	if (decision.kind === "already") {
		return {
			ok: true,
			status: 200,
			body: {
				...base,
				outcome: "already",
				mapping: mappingView(decision.existing, mailbox),
				replaced: null,
				topicVerified: false,
				reason: TOPIC_UNVERIFIED_REASON,
			},
		};
	}
	const replaced = decision.replacing ? mappingView(decision.replacing, mailbox) : null;

	if (input.dryRun) {
		return {
			ok: true,
			status: 200,
			body: {
				...base,
				outcome: decision.kind === "create" ? "would_create" : "would_adopt",
				mapping:
					decision.kind === "adopt"
						? mappingView(
								{
									chat_id: chatId,
									mailbox_id: input.mailboxId,
									topic_id: decision.topicId,
									topic_name: decision.name,
									created_at: new Date().toISOString(),
								},
								mailbox,
							)
						: null,
				replaced,
				topicVerified: false,
				reason:
					decision.kind === "create"
						? `Would create a topic named "${decision.name}".`
						: TOPIC_UNVERIFIED_REASON,
			},
		};
	}

	let topicId: number;
	if (decision.kind === "create") {
		try {
			topicId = (await createForumTopic(config, { chatId, name: decision.name })).message_thread_id;
		} catch (error) {
			const message = describeTelegramError(error, config.botToken);
			if (error instanceof TelegramApiError && error.statusCode < 500 && error.statusCode !== 429) {
				return refuse(
					409,
					"topic_create_refused",
					`Telegram refused to create the topic: ${message}. The bot needs can_manage_topics; or create the topic yourself and adopt its thread id.`,
				);
			}
			return refuse(502, "telegram_unavailable", `createForumTopic failed: ${message}`);
		}
	} else {
		topicId = decision.topicId;
	}
	const row = await upsertTelegramTopic(env.INDEX_DB, {
		chatId,
		mailboxId: input.mailboxId,
		topicId,
		topicName: decision.name,
	});
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "telegram.topic_mapped",
		severity: "info",
		subject: input.mailboxId,
		payload_json: JSON.stringify({
			chatId,
			topicId,
			mode: decision.kind,
			replacedTopicId: replaced?.topicId ?? null,
		}),
	}).catch(() => undefined);

	return {
		ok: true,
		status: 201,
		body: {
			...base,
			outcome: decision.kind === "create" ? "created" : "adopted",
			mapping: mappingView(row, mailbox),
			replaced,
			topicVerified: decision.kind === "create",
			reason: decision.kind === "create" ? null : TOPIC_UNVERIFIED_REASON,
		},
	};
}
