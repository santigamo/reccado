import { describe, expect, it } from "vitest";
import type { RebindResult } from "#/telegram/admin/rebind";
import type { TelegramOperatorStatus } from "#/telegram/admin/status";
import type { TopicMappingResult } from "#/telegram/admin/topics";
import {
	describeApiRefusal,
	formatDeliveryTest,
	formatRebind,
	formatTelegramStatus,
	formatTopicListing,
	formatTopicResult,
	parseChatFlag,
	parseTopicCommand,
	resolveMailboxRef,
} from "../../scripts/lib/telegram-operator-core";

describe("formatDeliveryTest", () => {
	it("prints PASS/FAIL per mailbox with the reason", () => {
		const text = formatDeliveryTest({
			chatId: "-100",
			isForum: true,
			ok: false,
			results: [
				{
					mailboxId: "mbx_1",
					address: "hello@imsanti.dev",
					topicId: 7,
					outcome: "delivered_to_topic",
					reason: null,
					messageId: 1,
					landedThreadId: 7,
				},
				{
					mailboxId: "mbx_2",
					address: "billing@imsanti.dev",
					topicId: 8,
					outcome: "fell_back_to_general",
					reason: "Addressed to topic 8, but Telegram filed it under General.",
					messageId: 2,
					landedThreadId: null,
				},
			],
		}).join("\n");
		expect(text).toMatch(/PASS {2}hello@imsanti\.dev\s+topic 7/);
		expect(text).toMatch(/FAIL {2}billing@imsanti\.dev\s+fell_back_to_general — Addressed/);
		expect(text).toContain("Some mailboxes");
	});
});

describe("parseTopicCommand", () => {
	it("reads a create, an adopt with a label, and --replace", () => {
		expect(parseTopicCommand("hello@imsanti.dev", { name: "imsanti" })).toEqual({
			mailboxRef: "hello@imsanti.dev",
			name: "imsanti",
			replace: false,
		});
		expect(parseTopicCommand("mbx_1", { adopt: "42", name: "facturas", replace: "true" })).toEqual({
			mailboxRef: "mbx_1",
			name: "facturas",
			adoptThreadId: 42,
			replace: true,
		});
	});

	it("refuses what the route would refuse, before any request", () => {
		expect(() => parseTopicCommand(undefined, { name: "x" })).toThrow(/needs a mailbox/);
		expect(() => parseTopicCommand("mbx_1", {})).toThrow(/--name .* or --adopt/);
		expect(() => parseTopicCommand("mbx_1", { name: "true" })).toThrow(/--name needs a value/);
		expect(() => parseTopicCommand("mbx_1", { adopt: "abc" })).toThrow(
			/positive message_thread_id/,
		);
		expect(() => parseTopicCommand("mbx_1", { adopt: "0" })).toThrow(/positive/);
		expect(() => parseTopicCommand("mbx_1", { name: "x".repeat(129) })).toThrow(/128/);
	});
});

describe("resolveMailboxRef", () => {
	const mailboxes = [
		{ mailbox_id: "mbx_1", primary_address: "hello@imsanti.dev" },
		{ mailbox_id: "mbx_2", primary_address: "billing@imsanti.dev" },
	];

	it("accepts an id or a primary address, case-insensitively", () => {
		expect(resolveMailboxRef("mbx_2", mailboxes)).toBe("mbx_2");
		expect(resolveMailboxRef("Hello@IMSANTI.dev", mailboxes)).toBe("mbx_1");
	});

	it("names what it could not find", () => {
		expect(() => resolveMailboxRef("nope@imsanti.dev", mailboxes)).toThrow(/primary address/);
		expect(() => resolveMailboxRef("mbx_9", mailboxes)).toThrow(/No mailbox with id mbx_9/);
	});
});

describe("formatTopicResult / formatTopicListing", () => {
	const mapping = {
		chatId: "-100",
		mailboxId: "mbx_1",
		topicId: 7,
		topicName: "imsanti",
		effectiveName: "imsanti",
		createdAt: "2026-09-27T00:00:00.000Z",
	};

	it("prints a dry-run create and how to apply it", () => {
		const result: TopicMappingResult = {
			outcome: "would_create",
			dryRun: true,
			chatId: "-100",
			mapping: null,
			replaced: { ...mapping, topicName: null, effectiveName: "Santi Gamo" },
			topicVerified: false,
			reason: 'Would create a topic named "imsanti".',
		};
		const text = formatTopicResult(result).join("\n");
		expect(text).toContain("Dry run — would create");
		expect(text).toContain('replaces: topic 7 "Santi Gamo"');
		expect(text).toContain("--apply");
	});

	it("does not ask to apply an `already`", () => {
		const text = formatTopicResult({
			outcome: "already",
			dryRun: true,
			chatId: "-100",
			mapping,
			replaced: null,
			topicVerified: false,
			reason: null,
		}).join("\n");
		expect(text).toContain("Already mapped");
		expect(text).toContain('mbx_1 -> topic 7 "imsanti"');
		expect(text).not.toContain("--apply");
	});

	it("marks the mappings in the bound chat", () => {
		const text = formatTopicListing({
			binding: { chatId: "-100", isForum: true },
			topics: [
				{ ...mapping, mailboxAddress: "hello@imsanti.dev", inBoundChat: true },
				{ ...mapping, chatId: "424242", topicId: 3, mailboxAddress: null, inBoundChat: false },
			],
		});
		expect(text[1]).toMatch(/^ {2}\* -100/);
		expect(text[2]).toMatch(/^ {4}424242/);
	});
});

describe("parseChatFlag", () => {
	it("accepts numeric ids and public usernames", () => {
		expect(parseChatFlag("-1004344536018")).toBe("-1004344536018");
		expect(parseChatFlag("424242")).toBe("424242");
		expect(parseChatFlag("@santihq")).toBe("@santihq");
	});

	it("rejects a missing or malformed chat", () => {
		expect(() => parseChatFlag(undefined)).toThrow(/--chat <id> is required/);
		expect(() => parseChatFlag("true")).toThrow(/--chat <id> is required/);
		expect(() => parseChatFlag("santi hq")).toThrow(/expected a numeric/);
	});
});

describe("formatRebind", () => {
	const result: RebindResult = {
		outcome: "would_rebind",
		dryRun: true,
		previous: { chatId: "424242", isForum: false },
		current: { chatId: "-100", isForum: true, type: "supergroup", title: "Santi HQ" },
		membership: {
			status: "administrator",
			canManageTopics: true,
			canSendMessages: true,
			eligible: true,
			reason: "ok",
		},
		topics: { mappedInNewChat: 0, keptForOtherChats: 2 },
		notes: [],
	};

	it("prints current -> new and how to apply", () => {
		const text = formatRebind(result).join("\n");
		expect(text).toContain("Dry run — would rebind");
		expect(text).toContain("current: 424242 (forum: no)");
		expect(text).toContain('new:     -100 (forum: yes) · supergroup "Santi HQ"');
		expect(text).toContain("2 kept for other chats");
		expect(text).toContain("--apply");
	});

	it("does not ask to apply what already happened", () => {
		const text = formatRebind({ ...result, outcome: "rebound", dryRun: false }).join("\n");
		expect(text).toContain("Rebound the Telegram bridge");
		expect(text).not.toContain("Re-run with --apply");
	});
});

function status(overrides: Partial<TelegramOperatorStatus> = {}): TelegramOperatorStatus {
	return {
		bridge: {
			mode: "on",
			ok: true,
			missing: [],
			reason: null,
			webhookUrl: "https://x/telegram/webhook",
			pendingUpdateCount: 0,
		},
		bot: { ok: true, id: 1, username: "reccado_bot", firstName: "Reccado" },
		binding: { chatId: "-100", isForum: true },
		chat: { ok: true, id: "-100", type: "supergroup", title: "Santi HQ", isForum: true },
		membership: {
			ok: true,
			status: "administrator",
			canManageTopics: true,
			canSendMessages: true,
			eligible: true,
			reason: "ok",
		},
		webhook: { registration: null, observation: null },
		mailboxes: [
			{
				mailboxId: "mbx_hello",
				address: "hello@imsanti.dev",
				displayName: "Santi",
				topic: {
					chatId: "-100",
					mailboxId: "mbx_hello",
					topicId: 7,
					topicName: "imsanti",
					effectiveName: "imsanti",
					createdAt: "2026-09-27T00:00:00.000Z",
				},
				topicVerified: false,
			},
			{
				mailboxId: "mbx_billing",
				address: "billing@imsanti.dev",
				displayName: null,
				topic: null,
				topicVerified: false,
			},
		],
		topicVerification: { verified: false, reason: "unverifiable" },
		...overrides,
	};
}

describe("formatTelegramStatus", () => {
	it("names the bot, the chat, the rights and each mailbox's topic", () => {
		const text = formatTelegramStatus(status()).join("\n");
		expect(text).toContain("@reccado_bot");
		expect(text).toContain('supergroup "Santi HQ"');
		expect(text).toContain("can_manage_topics: yes");
		expect(text).toContain('topic 7 "imsanti"');
		expect(text).toContain("no topic mapped");
		expect(text).toContain("topics unverified");
	});

	it("warns when the stored forum flag disagrees with Telegram", () => {
		const text = formatTelegramStatus(status({ binding: { chatId: "-100", isForum: false } })).join(
			"\n",
		);
		expect(text).toContain("WARNING: the stored forum flag");
		expect(text).toContain("pnpm operator telegram rebind --chat -100 --apply");
	});

	it("says so when the bridge is off", () => {
		const text = formatTelegramStatus(status({ bot: null, chat: null, membership: null })).join(
			"\n",
		);
		expect(text).toContain("TELEGRAM_BOT_TOKEN is not set");
	});
});

describe("describeApiRefusal", () => {
	it("prefers the route's own error and message", () => {
		expect(
			describeApiRefusal(409, JSON.stringify({ error: "no_chat_bound", message: "Send /start." })),
		).toBe("no_chat_bound (HTTP 409): Send /start.");
	});

	it("falls back to the raw body", () => {
		expect(describeApiRefusal(502, "Bad gateway")).toBe("HTTP 502: Bad gateway");
	});
});
