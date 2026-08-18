import { describe, expect, it } from "vitest";
import facadeSource from "../../src/mcp/mailbox-facade.ts?raw";
import toolsSource from "../../src/mcp/tools.ts?raw";

describe("MCP mailbox facade security", () => {
	const FORBIDDEN_PATHS = [
		"/request-send",
		"/confirm-send",
		"/actions",
		"/raw",
		"/attachments/",
		"/export-index",
		"/debug",
		"/debug/schema",
		"/alarm",
		"/ingest",
		"/cancel",
	];

	it.each(FORBIDDEN_PATHS)("facade source does not contain forbidden path '%s'", (path) => {
		expect(facadeSource).not.toContain(path);
	});

	it("facade only uses safe DO paths: /threads, /search, /messages, /drafts", () => {
		expect(facadeSource).toContain("https://mailbox-do/threads");
		expect(facadeSource).toContain("https://mailbox-do/search");
		expect(facadeSource).toContain("https://mailbox-do/messages/");
		expect(facadeSource).toContain("https://mailbox-do/drafts");
	});

	it("facade does not expose a generic DO fetch/proxy method", () => {
		expect(facadeSource).not.toContain("proxyFetch");
		expect(facadeSource).not.toContain("genericFetch");
		expect(facadeSource).not.toContain("rawFetch");
	});

	it("facade createDraft uses POST (not request-send or confirm-send)", () => {
		const draftSection = facadeSource.substring(
			facadeSource.indexOf("async createDraft"),
			facadeSource.indexOf("async createDraft") + 1000,
		);
		expect(draftSection).toContain("POST");
		expect(draftSection).not.toContain("request-send");
		expect(draftSection).not.toContain("confirm-send");
	});
});

describe("MCP tool registration safety", () => {
	const REGISTERED_TOOLS = [
		"list_mailboxes",
		"list_threads",
		"search_messages",
		"read_message",
		"draft_reply",
	];

	it.each(REGISTERED_TOOLS)("has the expected tool '%s'", (tool) => {
		expect(toolsSource).toContain(`"${tool}"`);
	});

	it("does not register a send/send_email tool", () => {
		expect(toolsSource).not.toContain('"send"');
		expect(toolsSource).not.toContain("send_email");
		expect(toolsSource).not.toContain("confirm_send");
	});

	it("does not import confirmDraftSend or any send path", () => {
		expect(toolsSource).not.toContain("confirmDraftSend");
		expect(toolsSource).not.toContain("outbound-send");
		expect(toolsSource).not.toContain("outboundSend");
	});
});
