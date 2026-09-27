import { describe, expect, it } from "vitest";
import type { RebindResult } from "#/telegram/admin/rebind";
import type { TelegramOperatorStatus } from "#/telegram/admin/status";
import {
	describeApiRefusal,
	formatRebind,
	formatTelegramStatus,
	parseChatFlag,
} from "../../scripts/lib/telegram-operator-core";

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
