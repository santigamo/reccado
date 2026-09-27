import { describe, expect, it } from "vitest";
import { classifyTopicDelivery, renderDeliveryTestMessage } from "#/telegram/admin/delivery-test";
import { describeTelegramError, evaluateBotMembership, isForumChat } from "#/telegram/admin/shared";
import { decideTopicMapping } from "#/telegram/admin/topics";
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

describe("decideTopicMapping", () => {
	const row = (topicId: number, name: string | null) => ({
		chat_id: "-100",
		mailbox_id: "mbx_1",
		topic_id: topicId,
		topic_name: name,
		created_at: "2026-09-27T00:00:00.000Z",
	});

	it("creates or adopts when nothing is mapped", () => {
		expect(decideTopicMapping({ mailboxId: "mbx_1", name: " imsanti " }, null)).toEqual({
			kind: "create",
			name: "imsanti",
			replacing: null,
		});
		expect(decideTopicMapping({ mailboxId: "mbx_1", adoptThreadId: 9 }, null)).toEqual({
			kind: "adopt",
			topicId: 9,
			name: null,
			replacing: null,
		});
	});

	it("treats the same request again as already", () => {
		expect(
			decideTopicMapping({ mailboxId: "mbx_1", name: "imsanti" }, row(7, "imsanti")).kind,
		).toBe("already");
		expect(decideTopicMapping({ mailboxId: "mbx_1", adoptThreadId: 7 }, row(7, "x")).kind).toBe(
			"already",
		);
		expect(
			decideTopicMapping({ mailboxId: "mbx_1", adoptThreadId: 7, name: "x" }, row(7, "x")).kind,
		).toBe("already");
	});

	it("is a conflict for anything else unless replace is set", () => {
		// A NULL-named (auto-created) topic is not "the same" as a named request:
		// its real name in Telegram is unknown.
		expect(decideTopicMapping({ mailboxId: "mbx_1", name: "imsanti" }, row(7, null)).kind).toBe(
			"conflict",
		);
		expect(decideTopicMapping({ mailboxId: "mbx_1", adoptThreadId: 8 }, row(7, null)).kind).toBe(
			"conflict",
		);
		expect(
			decideTopicMapping({ mailboxId: "mbx_1", adoptThreadId: 7, name: "y" }, row(7, "x")).kind,
		).toBe("conflict");
		expect(
			decideTopicMapping({ mailboxId: "mbx_1", name: "imsanti", replace: true }, row(7, null)),
		).toEqual({ kind: "create", name: "imsanti", replacing: row(7, null) });
	});
});

describe("classifyTopicDelivery", () => {
	it("trusts only the thread id Telegram hands back", () => {
		expect(classifyTopicDelivery(7, true, { message_thread_id: 7 }).outcome).toBe(
			"delivered_to_topic",
		);
		expect(classifyTopicDelivery(7, true, {}).outcome).toBe("fell_back_to_general");
		expect(classifyTopicDelivery(null, true, {}).outcome).toBe("fell_back_to_general");
		expect(classifyTopicDelivery(7, true, { message_thread_id: 9 })).toMatchObject({
			outcome: "failed",
			reason: expect.stringContaining("thread 9"),
		});
		expect(classifyTopicDelivery(null, false, {}).outcome).toBe("delivered_to_chat");
	});
});

describe("renderDeliveryTestMessage", () => {
	it("is labelled as a test and escapes the address", () => {
		const text = renderDeliveryTestMessage({ address: "a<b>@x.dev", topicId: 7 });
		expect(text).toContain("prueba de entrega");
		expect(text).toContain("a&lt;b&gt;@x.dev");
		expect(text).toContain("<code>7</code>");
	});
});
