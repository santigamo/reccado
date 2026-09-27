import { describe, expect, it } from "vitest";
import { describeTelegramError, evaluateBotMembership, isForumChat } from "#/telegram/admin/shared";
import { TelegramApiError } from "#/telegram/api";

describe("describeTelegramError", () => {
	it("formats a Bot API refusal without the token", () => {
		const error = new TelegramApiError("getChat", 400, "Bad Request: chat not found");
		expect(describeTelegramError(error, "1:tok")).toBe(
			"getChat: Bad Request: chat not found (400)",
		);
	});

	it("redacts the token from a transport error that echoes the URL", () => {
		const error = new Error("fetch failed: https://api.telegram.org/bot1:secret-token/getMe");
		const text = describeTelegramError(error, "1:secret-token");
		expect(text).not.toContain("1:secret-token");
		expect(text).toContain("/bot[redacted]/getMe");
	});
});

describe("isForumChat", () => {
	it("needs both a supergroup and is_forum", () => {
		expect(isForumChat({ type: "supergroup", is_forum: true })).toBe(true);
		expect(isForumChat({ type: "supergroup" })).toBe(false);
		expect(isForumChat({ type: "private", is_forum: true })).toBe(false);
	});
});

describe("evaluateBotMembership", () => {
	it("accepts an administrator and reports can_manage_topics", () => {
		expect(
			evaluateBotMembership({ status: "administrator", can_manage_topics: true }, {}),
		).toMatchObject({ eligible: true, canManageTopics: true, canSendMessages: true });
		const noTopics = evaluateBotMembership({ status: "administrator" }, {});
		expect(noTopics).toMatchObject({ eligible: true, canManageTopics: false });
		expect(noTopics.reason).toMatch(/can_manage_topics/);
	});

	it("accepts a member only while members may send messages", () => {
		expect(evaluateBotMembership({ status: "member" }, {})).toMatchObject({
			eligible: true,
			canManageTopics: false,
		});
		expect(
			evaluateBotMembership({ status: "member" }, { permissions: { can_send_messages: false } }),
		).toMatchObject({ eligible: false, canSendMessages: false });
	});

	it("accepts a restricted bot only when the restriction still allows sending", () => {
		expect(
			evaluateBotMembership({ status: "restricted", is_member: true, can_send_messages: true }, {}),
		).toMatchObject({ eligible: true });
		expect(
			evaluateBotMembership(
				{ status: "restricted", is_member: true, can_send_messages: false },
				{},
			),
		).toMatchObject({ eligible: false });
	});

	it("refuses a bot that left or was removed", () => {
		expect(evaluateBotMembership({ status: "left" }, {}).eligible).toBe(false);
		expect(evaluateBotMembership({ status: "kicked" }, {}).eligible).toBe(false);
	});
});
