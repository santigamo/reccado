import { expect, it } from "vitest";
import { intentNotificationKeyboard } from "#/telegram/notify";

it("links to the approval page without a callback approval button", () => {
	expect(intentNotificationKeyboard("https://example.com/approve/abc")).toEqual({
		inline_keyboard: [[{ text: "Revisar solicitud", url: "https://example.com/approve/abc" }]],
	});
});
