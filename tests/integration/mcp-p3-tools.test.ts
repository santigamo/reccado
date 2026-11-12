import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { beforeAll, describe, expect, it } from "vitest";
import { stripConfigSecrets } from "../../src/mcp/admin-reads";
import { readAuditedResource } from "../../src/mcp/resources";
import { registerTools } from "../../src/mcp/tools";
import type { McpAuthContext } from "../../src/mcp/scopes";
import { McpMailboxFacade } from "../../src/mcp/mailbox-facade";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const testEnv = env as unknown as Env;
const TOOL_NAMES = [
	"list_mailboxes",
	"list_threads",
	"search_messages",
	"read_message",
	"read_thread",
	"save_draft",
	"cancel_draft",
	"update_messages",
	"get_health",
	"list_ops",
	"list_config",
	"send",
	"manage_mailbox",
	"manage_domain",
	"manage_routing",
	"manage_template",
	"manage_api_key",
	"remove_suppression",
	"restore",
	"reconcile_stale",
] as const;
const TOOL_SCOPES: Record<(typeof TOOL_NAMES)[number], string> = {
	send: "mail:send",
	manage_mailbox: "admin",
	manage_domain: "admin",
	manage_routing: "admin",
	manage_template: "admin",
	manage_api_key: "admin",
	remove_suppression: "admin",
	restore: "admin",
	reconcile_stale: "admin",
	list_mailboxes: "mail:read",
	list_threads: "mail:read",
	search_messages: "mail:read",
	read_message: "mail:read",
	read_thread: "mail:read",
	save_draft: "mail:draft",
	cancel_draft: "mail:draft",
	update_messages: "mail:draft",
	get_health: "admin",
	list_ops: "admin",
	list_config: "admin",
};

type ToolBody = {
	isError?: boolean;
	content: Array<{ type: string; text?: string; uri?: string; name?: string; mimeType?: string }>;
	structuredContent?: Record<string, unknown>;
};

function actor(email: string, scopes: string[]): McpAuthContext {
	return { userId: email, email, scopes: new Set(scopes), owners: [email], local: true };
}

const reader = actor("reader@local", ["mail:read", "mail:draft"]);
const drafter = actor("drafter@local", ["mail:read", "mail:draft"]);
const admin = actor("admin@local", ["mail:read", "mail:draft", "admin"]);
const sensitive = actor("reader@local", ["mail:read", "mail:draft", "mail:read:sensitive"]);

function serverFor(auth: McpAuthContext, toolEnv: Env = testEnv) {
	const server = new McpServer({ name: "reccado", version: "1.0.0" });
	registerTools(server, toolEnv, auth, "http://localhost");
	return server as unknown as {
		_registeredTools: Record<string, { handler: (args: Record<string, unknown>) => Promise<ToolBody> }>;
	};
}

async function callTool(
	auth: McpAuthContext,
	name: string,
	args: Record<string, unknown> = {},
	toolEnv: Env = testEnv,
) {
	const tool = serverFor(auth, toolEnv)._registeredTools[name];
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool.handler(args);
}

function textOf(result: ToolBody): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

beforeAll(async () =>
	applyMigrations(testEnv.INDEX_DB, migrationInitial, migrationIndex, migrationOwner),
);

async function mailbox(email: string, status = "active") {
	const id = `mbx_${crypto.randomUUID()}`;
	const now = new Date().toISOString();
	await testEnv.INDEX_DB.prepare(
		"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)",
	)
		.bind(id, `${id}@example.com`, status, email, now, now)
		.run();
	return id;
}

async function seedMessage(
	mailboxId: string,
	input: {
		body?: string | null;
		html?: string;
		subject?: string;
		from?: string;
		snippet?: string | null;
		receivedAt?: string;
		threadId?: string;
		state?: string;
		isRead?: number;
		unreadCount?: number;
		sensitiveKind?: string | null;
		sensitiveClassified?: number;
		attachment?: { id: string; bytes: string };
		fts?: boolean;
	} = {},
) {
	const stub = testEnv.MAILBOX_DO.getByName(mailboxId);
	const messageId = crypto.randomUUID();
	const threadId = input.threadId ?? crypto.randomUUID();
	const now = input.receivedAt ?? "2026-01-02T00:00:00.000Z";
	const body = input.body === undefined ? "Hello from the mailbox." : input.body;
	const rawKey = `test/${messageId}`;
	const htmlKey = input.html ? `test/${messageId}.html` : null;
	await testEnv.MAIL_OBJECTS.put(rawKey, body ?? input.html ?? "");
	if (htmlKey && input.html) await testEnv.MAIL_OBJECTS.put(htmlKey, input.html);
	const attachmentKey = input.attachment ? `test/${messageId}/${input.attachment.id}` : null;
	if (attachmentKey && input.attachment)
		await testEnv.MAIL_OBJECTS.put(attachmentKey, input.attachment.bytes);
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT OR IGNORE INTO threads (id, subject_norm, last_message_at, message_count, unread_count, created_at, updated_at)
			 VALUES (?, 'norm', ?, 1, ?, ?, ?)`,
			threadId,
			now,
			input.unreadCount ?? (input.isRead ? 0 : 1),
			now,
			now,
		);
		state.storage.sql.exec(
			`INSERT INTO messages (
			   id, idempotency_key, thread_id, direction, state, from_addr, to_json, cc_json, bcc_json,
			   subject, snippet, received_at, raw_r2_key, raw_sha256, raw_size, body_text, body_html_r2_key,
			   sensitive_kind, sensitive_classified, parse_status, has_attachments, is_read, created_at, updated_at
			 ) VALUES (?, ?, ?, 'inbound', ?, ?, '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', ?, ?, ?, ?)`,
			messageId,
			messageId,
			threadId,
			input.state ?? "inbox",
			input.from ?? "security@example.com",
			input.subject ?? "Hello",
			input.snippet === undefined ? body : input.snippet,
			now,
			rawKey,
			messageId,
			(body ?? "").length,
			body,
			htmlKey,
			input.sensitiveKind ?? null,
			input.sensitiveClassified ?? 0,
			input.attachment ? 1 : 0,
			input.isRead ?? 0,
			now,
			now,
		);
		if (input.fts !== false) {
			state.storage.sql.exec(
				`INSERT INTO message_fts (message_id, subject, sender, recipients, snippet, body_text)
				 VALUES (?, ?, ?, '', ?, ?)`,
				messageId,
				input.subject ?? "Hello",
				input.from ?? "security@example.com",
				input.snippet === undefined ? (body ?? "") : (input.snippet ?? ""),
				body ?? input.html ?? "",
			);
		}
		if (input.attachment && attachmentKey) {
			state.storage.sql.exec(
				`INSERT INTO attachments (id, message_id, filename, content_type, disposition, size, sha256, r2_key, created_at)
				 VALUES (?, ?, 'note.txt', 'text/plain', 'attachment', ?, 'abc', ?, ?)`,
				input.attachment.id,
				messageId,
				input.attachment.bytes.length,
				attachmentKey,
				now,
			);
		}
	});
	return { messageId, threadId };
}

async function messageRow(mailboxId: string, messageId: string) {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/messages/${encodeURIComponent(messageId)}`,
	);
	const body = (await response.json()) as { message: { state: string; is_read: number } };
	return body.message;
}

describe("MCP P3 tools", () => {
	it("registers the catalogue in order for every token", () => {
		expect(Object.keys(serverFor(reader)._registeredTools)).toEqual([...TOOL_NAMES]);
		expect(Object.keys(serverFor(actor("empty@local", []))._registeredTools)).toEqual([
			...TOOL_NAMES,
		]);
	});

	it("denies each tool when its scope is absent", async () => {
		const empty = actor("empty-scope@local", []);
		for (const name of TOOL_NAMES) {
			const result = await callTool(empty, name, {});
			expect(result.isError, name).toBe(true);
			expect(textOf(result)).toBe(`insufficient_scope: ${TOOL_SCOPES[name]}`);
		}
		const readOnly = actor("readonly@local", ["mail:read"]);
		expect(textOf(await callTool(readOnly, "save_draft", {}))).toBe("insufficient_scope: mail:draft");
		expect(textOf(await callTool(readOnly, "get_health", {}))).toBe("insufficient_scope: admin");
		const draftOnly = actor("draftonly@local", ["mail:draft"]);
		expect(textOf(await callTool(draftOnly, "read_message", {}))).toBe("insufficient_scope: mail:read");
	});

	it("lists only the caller's mailboxes and audits the scope", async () => {
		const id = await mailbox(reader.email);
		const foreign = await mailbox("someone-else@local");
		const result = await callTool(reader, "list_mailboxes");
		expect(result.isError).toBeFalsy();
		const ids = (
			result.structuredContent as { mailboxes: Array<{ mailbox_id: string }> }
		).mailboxes.map((row) => row.mailbox_id);
		expect(ids).toContain(id);
		expect(ids).not.toContain(foreign);
		const other = await callTool(actor("someone-else@local", ["mail:read"]), "list_mailboxes");
		expect(
			(other.structuredContent as { mailboxes: Array<{ mailbox_id: string }> }).mailboxes.map(
				(row) => row.mailbox_id,
			),
		).not.toContain(id);
		const audit = await testEnv.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'mcp.tool_call' AND subject = ? ORDER BY created_at DESC LIMIT 1",
		)
			.bind(reader.email)
			.first<{ payload_json: string }>();
		expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
			tool: "list_mailboxes",
			scope: "mail:read",
			denied: false,
		});
	});

	it("filters threads and refuses other owners", async () => {
		const id = await mailbox(reader.email);
		const inbox = await seedMessage(id, {
			subject: "Inbox note",
			receivedAt: "2026-03-02T00:00:00.000Z",
			state: "inbox",
			isRead: 0,
			unreadCount: 1,
			fts: false,
		});
		await seedMessage(id, {
			subject: "Filed note",
			receivedAt: "2026-03-01T00:00:00.000Z",
			state: "archive",
			isRead: 1,
			unreadCount: 0,
			fts: false,
		});
		const all = await callTool(reader, "list_threads", { mailboxId: id, limit: 10 });
		expect(textOf(all)).toContain("untrusted");
		const subjects = (
			all.structuredContent as { threads: Array<{ latest_subject: string }> }
		).threads.map((row) => row.latest_subject);
		expect(subjects).toEqual(expect.arrayContaining(["Inbox note", "Filed note"]));
		const unread = await callTool(reader, "list_threads", {
			mailboxId: id,
			limit: 10,
			unread: true,
		});
		expect(
			(unread.structuredContent as { threads: Array<{ id: string }> }).threads.map((row) => row.id),
		).toEqual([inbox.threadId]);
		const archived = await callTool(reader, "list_threads", {
			mailboxId: id,
			limit: 10,
			state: "archive",
		});
		expect(
			(archived.structuredContent as { threads: Array<{ latest_subject: string }> }).threads.map(
				(row) => row.latest_subject,
			),
		).toEqual(["Filed note"]);
		expect(textOf(await callTool(reader, "list_threads", { mailboxId: "mbx_missing", limit: 5 }))).toContain(
			"not_found",
		);
		expect(
			textOf(
				await callTool(actor("someone-else@local", ["mail:read"]), "list_threads", {
					mailboxId: id,
					limit: 5,
				}),
			),
		).toContain("not_found");
	});

	it("searches one mailbox or every owned mailbox, with subjects hydrated", async () => {
		const token = `zephyr${crypto.randomUUID().slice(0, 8)}`;
		const ownedA = await mailbox(reader.email);
		const ownedB = await mailbox(reader.email);
		const foreign = await mailbox("someone-else@local");
		const disabled = await mailbox(reader.email, "disabled");
		await seedMessage(ownedA, { subject: "Zephyr subject", body: `${token} alpha`, snippet: `${token} alpha` });
		await seedMessage(ownedB, { subject: "Other box", body: `${token} beta`, snippet: `${token} beta`, receivedAt: "2026-04-02T00:00:00.000Z" });
		await seedMessage(foreign, { body: `${token} foreign`, snippet: `${token} foreign` });
		await seedMessage(disabled, { body: `${token} disabled`, snippet: `${token} disabled` });
		const one = await callTool(reader, "search_messages", { mailboxId: ownedA, q: token, limit: 10 });
		const oneRows = (one.structuredContent as { results: Array<{ subject: string; mailbox_id: string }> })
			.results;
		expect(oneRows).toEqual([
			expect.objectContaining({ subject: "Zephyr subject", mailbox_id: ownedA }),
		]);
		const all = await callTool(reader, "search_messages", { q: token, limit: 10 });
		const ids = (all.structuredContent as { results: Array<{ mailbox_id: string }> }).results.map(
			(row) => row.mailbox_id,
		);
		expect(ids).toEqual([ownedB, ownedA]);
		expect(ids).not.toContain(foreign);
		expect(ids).not.toContain(disabled);
		expect(
			textOf(await callTool(reader, "search_messages", { mailboxId: foreign, q: token, limit: 5 })),
		).toContain("not_found");
		expect(
			textOf(await callTool(reader, "search_messages", { mailboxId: "mbx_missing", q: token, limit: 5 })),
		).toContain("not_found");
	});

	it("redacts OTP and reset mail unless mail:read:sensitive is granted", async () => {
		const id = await mailbox(reader.email);
		for (const body of [
			"Your code is 123456",
			"Tu código es 123456",
			"Reset your password https://example.com/reset?token=secret",
		]) {
			const seeded = await seedMessage(id, { body, snippet: body, fts: false });
			const hidden = await callTool(reader, "read_message", {
				mailboxId: id,
				messageId: seeded.messageId,
			});
			const message = (hidden.structuredContent as { message: { body_text: string; redacted: boolean; sensitive_kind: string } }).message;
			expect(message.redacted).toBe(true);
			expect(message.sensitive_kind).toBeTruthy();
			expect(message.body_text).not.toContain("123456");
			expect(message.body_text).not.toContain("token=secret");
			expect(textOf(hidden)).toContain("untrusted");
			const shown = await callTool(sensitive, "read_message", {
				mailboxId: id,
				messageId: seeded.messageId,
			});
			expect(
				(shown.structuredContent as { message: { body_text: string; redacted: boolean } }).message,
			).toMatchObject({ body_text: body, redacted: false });
		}
	});

	it("classifies legacy HTML-only mail and honors a stored sensitive kind", async () => {
		const id = await mailbox(reader.email);
		const htmlOnly = await seedMessage(id, {
			body: null,
			html: "<p>Your code is 654321</p>",
			subject: "Hello",
			snippet: null,
			fts: false,
		});
		const fromHtml = (
			await callTool(reader, "read_message", { mailboxId: id, messageId: htmlOnly.messageId })
		).structuredContent as { message: { sensitive_kind: string; redacted: boolean; body_text: string } };
		expect(fromHtml.message).toMatchObject({ sensitive_kind: "otp", redacted: true });
		expect(fromHtml.message.body_text).not.toContain("654321");
		const stored = await seedMessage(id, {
			body: "use 999888 please",
			from: "friend@example.com",
			subject: "Hello",
			sensitiveKind: "password_reset",
			sensitiveClassified: 1,
			fts: false,
		});
		const masked = (
			await callTool(reader, "read_message", { mailboxId: id, messageId: stored.messageId })
		).structuredContent as { message: { body_text: string; redacted: boolean; sensitive_kind: string } };
		expect(masked.message.sensitive_kind).toBe("password_reset");
		expect(masked.message.redacted).toBe(true);
		expect(masked.message.body_text).not.toContain("999888");
		const clear = (
			await callTool(sensitive, "read_message", { mailboxId: id, messageId: stored.messageId })
		).structuredContent as { message: { body_text: string; redacted: boolean } };
		expect(clear.message).toMatchObject({ body_text: "use 999888 please", redacted: false });
	});

	it("reads a thread oldest-first and links raw MIME plus attachments as resources", async () => {
		const id = await mailbox(reader.email);
		const threadId = crypto.randomUUID();
		const older = await seedMessage(id, {
			threadId,
			body: "older plain note",
			receivedAt: "2026-05-01T00:00:00.000Z",
			fts: false,
		});
		const attachmentId = crypto.randomUUID();
		const newer = await seedMessage(id, {
			threadId,
			body: "Your code is 123456",
			snippet: "Your code is 123456",
			receivedAt: "2026-05-02T00:00:00.000Z",
			attachment: { id: attachmentId, bytes: "file-bytes" },
			fts: false,
		});
		const result = await callTool(reader, "read_thread", { mailboxId: id, threadId });
		const messages = (
			result.structuredContent as {
				messages: Array<{ message_id: string; body_text: string; redacted: boolean; resource_links: Array<{ uri: string }> }>;
			}
		).messages;
		expect(messages.map((row) => row.message_id)).toEqual([older.messageId, newer.messageId]);
		expect(messages[0]?.body_text).toBe("older plain note");
		expect(messages[1]?.redacted).toBe(true);
		expect(messages[1]?.body_text).not.toContain("123456");
		expect(messages[1]?.resource_links.map((link) => link.uri)).toEqual([
			`reccado://mailboxes/${encodeURIComponent(id)}/messages/${encodeURIComponent(newer.messageId)}/raw`,
			`reccado://mailboxes/${encodeURIComponent(id)}/messages/${encodeURIComponent(newer.messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
		]);
		expect(result.content.some((part) => part.type === "resource_link")).toBe(true);
		const raw = await readAuditedResource(testEnv, sensitive, id, newer.messageId);
		expect(new TextDecoder().decode(Uint8Array.from(atob(raw.blob), (char) => char.charCodeAt(0)))).toBe(
			"Your code is 123456",
		);
		const file = await readAuditedResource(testEnv, sensitive, id, newer.messageId, attachmentId);
		expect(new TextDecoder().decode(Uint8Array.from(atob(file.blob), (char) => char.charCodeAt(0)))).toBe(
			"file-bytes",
		);
		await expect(readAuditedResource(testEnv, reader, id, newer.messageId)).rejects.toThrow(
			"insufficient_scope: mail:read:sensitive",
		);
		await expect(
			readAuditedResource(testEnv, actor("someone-else@local", ["mail:read", "mail:read:sensitive"]), id, newer.messageId),
		).rejects.toThrow("not_found");
		await expect(readAuditedResource(testEnv, sensitive, id, newer.messageId, "missing-file")).rejects.toThrow(
			"not_found",
		);
		const audit = await testEnv.INDEX_DB.prepare(
			"SELECT payload_json FROM ops_events WHERE event_type = 'mcp.resource_read' AND subject = ? ORDER BY created_at DESC LIMIT 1",
		)
			.bind(sensitive.email)
			.first<{ payload_json: string }>();
		expect(JSON.parse(audit?.payload_json ?? "{}").scope).toBe("mail:read");
		expect(
			textOf(await callTool(reader, "read_thread", { mailboxId: id, threadId: "missing-thread" })),
		).toContain("not_found");
		expect(
			textOf(await callTool(reader, "read_message", { mailboxId: id, messageId: "missing-message" })),
		).toContain("not_found");
	});

	it("refuses oversized raw resources", async () => {
		const id = await mailbox(reader.email);
		const seeded = await seedMessage(id, { body: "small", fts: false, sensitiveClassified: 1 });
		const bigKey = `test/big-${seeded.messageId}`;
		await testEnv.MAIL_OBJECTS.put(bigKey, new Uint8Array(5 * 1024 * 1024 + 1));
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(id), async (_instance, state) => {
			state.storage.sql.exec("UPDATE messages SET raw_r2_key = ? WHERE id = ?", bigKey, seeded.messageId);
		});
		await expect(readAuditedResource(testEnv, reader, id, seeded.messageId)).rejects.toThrow(/too_large/);
	});

	it("saves, updates, threads and cancels drafts without sending", async () => {
		const id = await mailbox(drafter.email);
		const parent = await seedMessage(id, { body: "original", fts: false });
		const key = crypto.randomUUID();
		const created = await callTool(drafter, "save_draft", {
			mailboxId: id,
			to: ["person@example.com"],
			subject: "Hello",
			bodyText: "Body",
			idempotencyKey: key,
		});
		const draftId = (created.structuredContent as { draft: { draft_id: string; duplicate: boolean } }).draft
			.draft_id;
		expect(created.structuredContent).toMatchObject({ draft: { status: "draft", duplicate: false } });
		const again = await callTool(drafter, "save_draft", {
			mailboxId: id,
			to: ["person@example.com"],
			subject: "Hello",
			bodyText: "Body",
			idempotencyKey: key,
		});
		expect(again.structuredContent).toMatchObject({ draft: { draft_id: draftId, duplicate: true } });
		const updated = await callTool(drafter, "save_draft", {
			mailboxId: id,
			draftId,
			to: ["person@example.com"],
			subject: "Updated",
			bodyText: "Body",
		});
		expect(updated.isError).toBeFalsy();
		const reply = await callTool(drafter, "save_draft", {
			mailboxId: id,
			to: ["person@example.com"],
			subject: "Re: Hello",
			bodyText: "Reply",
			threadId: parent.threadId,
			inReplyToMessageId: parent.messageId,
			idempotencyKey: crypto.randomUUID(),
		});
		const replyId = (reply.structuredContent as { draft: { draft_id: string } }).draft.draft_id;
		const stored = (await (
			await testEnv.MAILBOX_DO.getByName(id).fetch(`https://mailbox-do/drafts/${replyId}`)
		).json()) as { draft: { status: string; origin: string; thread_id: string; parent_message_id: string; subject: string } };
		expect(stored.draft).toMatchObject({
			status: "draft",
			origin: "mcp",
			thread_id: parent.threadId,
			parent_message_id: parent.messageId,
		});
		const edited = (await (
			await testEnv.MAILBOX_DO.getByName(id).fetch(`https://mailbox-do/drafts/${draftId}`)
		).json()) as { draft: { subject: string; origin: string; status: string } };
		expect(edited.draft).toMatchObject({ subject: "Updated", origin: "mcp", status: "draft" });
		expect(
			textOf(
				await callTool(drafter, "save_draft", {
					mailboxId: id,
					to: ["person@example.com"],
					subject: "Nope",
					bodyText: "Body",
					threadId: "other-thread",
					inReplyToMessageId: parent.messageId,
					idempotencyKey: crypto.randomUUID(),
				}),
			),
		).toContain("validation_error");
		expect(
			textOf(
				await callTool(drafter, "save_draft", {
					mailboxId: id,
					to: [`${id}@example.com`],
					subject: "Nope",
					bodyText: "Body",
					idempotencyKey: crypto.randomUUID(),
				}),
			),
		).toContain("validation_error");
		expect(
			textOf(
				await callTool(drafter, "save_draft", {
					mailboxId: id,
					to: ["person@example.com"],
					subject: "Nope",
					bodyText: "Body",
				}),
			),
		).toContain("validation_error");
		expect(
			textOf(
				await callTool(drafter, "save_draft", {
					mailboxId: "mbx_missing",
					to: ["person@example.com"],
					subject: "Nope",
					bodyText: "Body",
					idempotencyKey: crypto.randomUUID(),
				}),
			),
		).toContain("not_found");
		expect(
			textOf(
				await callTool(actor("someone-else@local", ["mail:draft"]), "save_draft", {
					mailboxId: id,
					to: ["person@example.com"],
					subject: "Nope",
					bodyText: "Body",
					idempotencyKey: crypto.randomUUID(),
				}),
			),
		).toContain("not_found");
		const cancelled = await callTool(drafter, "cancel_draft", { mailboxId: id, draftId });
		expect(cancelled.structuredContent).toMatchObject({ draft_id: draftId, status: "cancelled" });
		expect(textOf(await callTool(drafter, "cancel_draft", { mailboxId: id, draftId: "missing" }))).toContain(
			"not_found",
		);
		expect(
			textOf(
				await callTool(actor("someone-else@local", ["mail:draft"]), "cancel_draft", {
					mailboxId: id,
					draftId: replyId,
				}),
			),
		).toContain("not_found");
		const facade = new McpMailboxFacade(testEnv, drafter);
		const editable = await facade.createDraft(id, {
			to: ["person@example.com"],
			subject: "before",
			bodyText: "body",
			idempotencyKey: crypto.randomUUID(),
		});
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(id), async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE outbound_drafts SET status = 'sent' WHERE id = ?",
				editable.draft_id,
			);
		});
		await expect(
			facade.updateDraft(id, editable.draft_id, {
				to: ["person@example.com"],
				subject: "after",
				bodyText: "body",
			}),
		).rejects.toThrow("draft_not_editable");
		await expect(facade.updateMessages(id, [parent.messageId], "delete")).rejects.toThrow(
			"validation_error",
		);
	});

	it("applies recoverable message actions and stops before a missing id", async () => {
		const id = await mailbox(drafter.email);
		const first = await seedMessage(id, { body: "one", isRead: 0, fts: false });
		const second = await seedMessage(id, { body: "two", isRead: 0, fts: false });
		expect(
			textOf(
				await callTool(drafter, "update_messages", {
					mailboxId: id,
					messageIds: [first.messageId, "missing"],
					action: "mark_read",
				}),
			),
		).toContain("not_found");
		expect((await messageRow(id, first.messageId)).is_read).toBe(0);
		const marked = await callTool(drafter, "update_messages", {
			mailboxId: id,
			messageIds: [first.messageId, second.messageId],
			action: "mark_read",
		});
		expect(marked.structuredContent).toMatchObject({
			action: "mark_read",
			message_ids: [first.messageId, second.messageId],
		});
		expect((await messageRow(id, first.messageId)).is_read).toBe(1);
		await callTool(drafter, "update_messages", {
			mailboxId: id,
			messageIds: [first.messageId],
			action: "archive",
		});
		expect((await messageRow(id, first.messageId)).state).toBe("archive");
		await callTool(drafter, "update_messages", {
			mailboxId: id,
			messageIds: [first.messageId],
			action: "trash",
		});
		expect((await messageRow(id, first.messageId)).state).toBe("trash");
		await callTool(drafter, "update_messages", {
			mailboxId: id,
			messageIds: [first.messageId],
			action: "restore_inbox",
		});
		expect((await messageRow(id, first.messageId)).state).toBe("inbox");
		await callTool(drafter, "update_messages", {
			mailboxId: id,
			messageIds: [first.messageId],
			action: "mark_unread",
		});
		expect((await messageRow(id, first.messageId)).is_read).toBe(0);
		expect(
			textOf(
				await callTool(actor("someone-else@local", ["mail:draft"]), "update_messages", {
					mailboxId: id,
					messageIds: [first.messageId],
					action: "archive",
				}),
			),
		).toContain("not_found");
		expect(
			textOf(
				await callTool(drafter, "update_messages", {
					mailboxId: "mbx_missing",
					messageIds: [first.messageId],
					action: "archive",
				}),
			),
		).toContain("not_found");
	});

	it("enqueues the same Telegram card refresh the HTTP actions route does", async () => {
		const id = await mailbox(drafter.email);
		const message = await seedMessage(id, { body: "archive me", fts: false });
		const queued: unknown[] = [];
		const toolEnv = {
			...testEnv,
			TELEGRAM_BOT_TOKEN: "123:fake-token",
			NOTIFY_QUEUE: {
				send: async (body: unknown) => {
					queued.push(body);
				},
			},
		} as unknown as Env;

		const result = await callTool(
			drafter,
			"update_messages",
			{ mailboxId: id, messageIds: [message.messageId], action: "archive" },
			toolEnv,
		);

		expect(result.isError, textOf(result)).toBeFalsy();
		expect(queued).toEqual([
			{
				schemaVersion: 1,
				eventType: "telegram.card_refresh.v1",
				refresh: {
					mailboxId: id,
					messageLocalId: message.messageId,
					threadId: null,
					status: "archived",
				},
			},
		]);
	});

	it("still succeeds when the Telegram card refresh cannot be enqueued", async () => {
		const id = await mailbox(drafter.email);
		const message = await seedMessage(id, { body: "archive me", fts: false });
		const toolEnv = {
			...testEnv,
			TELEGRAM_BOT_TOKEN: "123:fake-token",
			NOTIFY_QUEUE: {
				send: async () => {
					throw new Error("queue down");
				},
			},
		} as unknown as Env;

		const result = await callTool(
			drafter,
			"update_messages",
			{ mailboxId: id, messageIds: [message.messageId], action: "archive" },
			toolEnv,
		);

		expect(result.isError, textOf(result)).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			action: "archive",
			message_ids: [message.messageId],
		});
		expect((await messageRow(id, message.messageId)).state).toBe("archive");
	});

	it("reads health, ops and config without secrets", async () => {
		expect(JSON.stringify(stripConfigSecrets({ keys: [{ key_hash: "SECRET", displaySuffix: "abcd12" }] }))).not.toContain(
			"SECRET",
		);
		const health = await callTool(admin, "get_health");
		expect(health.isError, textOf(health)).toBeFalsy();
		expect(
			(health.structuredContent as { dependencies: { sendingFeedback: { mode: string } } }).dependencies
				.sendingFeedback.mode,
		).toEqual(expect.any(String));
		const owned = await mailbox(admin.email);
		const now = new Date().toISOString();
		const hash = `deadbeef-key-hash-${crypto.randomUUID()}`;
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(owned), async (_instance, state) => {
			state.storage.sql.exec(
				`INSERT INTO api_keys (
				   key_id, hash_version, key_hash, display_suffix, environment, mailbox_id, sender,
				   scopes_json, status, created_at, updated_at
				 ) VALUES ('key-1', 1, ?, 'abcd12', 'test', ?, 'bot@example.com', '[]', 'active', ?, ?)`,
				hash,
				owned,
				now,
				now,
			);
			state.storage.sql.exec(
				`INSERT INTO recipient_suppressions (email, reason, created_at, updated_at)
				 VALUES ('blocked@example.com', 'manual', ?, ?)`,
				now,
				now,
			);
		});
		const domainId = crypto.randomUUID();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO domains (id, domain, zone_id, status, created_at, updated_at) VALUES (?, ?, 'zone', 'active', ?, ?)",
		)
			.bind(domainId, `${domainId}.example`, now, now)
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
			.bind(`alias-${domainId}@example.com`, owned, domainId, now, now)
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO routing_rules (id, domain_id, pattern, priority, action, mailbox_id, forward_to_json, enabled, created_at, updated_at) VALUES (?, ?, '*@example.com', 1, 'store', ?, '[]', 1, ?, ?)",
		)
			.bind(crypto.randomUUID(), domainId, owned, now, now)
			.run();
		const config = await callTool(admin, "list_config");
		expect(config.isError, textOf(config)).toBeFalsy();
		const configJson = JSON.stringify(config.structuredContent);
		expect(configJson).not.toContain(hash);
		expect(configJson).toContain("abcd12");
		expect(configJson).toContain(`${domainId}.example`);
		expect(configJson).toContain(`alias-${domainId}@example.com`);
		expect(configJson).toContain("*@example.com");
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at) VALUES (?, 'p3.test.event', 'info', ?, ?, ?)",
		)
			.bind("evt-old", owned, JSON.stringify({ mailbox_id: owned }), "2026-06-01T00:00:00.000Z")
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at) VALUES (?, 'p3.test.event', 'info', ?, ?, ?)",
		)
			.bind("evt-new", owned, JSON.stringify({ mailbox_id: owned }), "2026-06-02T00:00:00.000Z")
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO ingest_events (idempotency_key, mailbox_id, raw_r2_key, status, created_at, updated_at) VALUES (?, ?, 'r2/failed', 'failed', ?, ?)",
		)
			.bind(`fail-${owned}`, owned, now, now)
			.run();
		const events = await callTool(admin, "list_ops", {
			kind: "events",
			eventType: "p3.test.event",
			mailboxId: owned,
			limit: 1,
			offset: 0,
		});
		expect(events.structuredContent).toMatchObject({ events: [{ id: "evt-new" }] });
		const dlq = await callTool(admin, "list_ops", { kind: "dlq", mailboxId: owned, limit: 10, offset: 0 });
		expect(JSON.stringify(dlq.structuredContent)).toContain(`fail-${owned}`);
		const suppressed = await callTool(admin, "list_ops", {
			kind: "suppressions",
			mailboxId: owned,
			limit: 10,
			offset: 0,
		});
		expect(JSON.stringify(suppressed.structuredContent)).toContain("blocked@example.com");
		expect(
			textOf(
				await callTool(admin, "list_ops", {
					kind: "suppressions",
					mailboxId: "mbx_foreign",
					limit: 5,
					offset: 0,
				}),
			),
		).toContain("not_found");
	});
});
