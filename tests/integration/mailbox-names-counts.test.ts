import {
	abortAllDurableObjects,
	createExecutionContext,
	env,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { folderCounts, type MailboxCounts } from "#/do/mailbox-do";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import { McpMailboxFacade } from "#/mcp/mailbox-facade";
import worker from "#/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationBetterAuthMcpFkFix from "../../migrations/d1/0018_better_auth_mcp_fk_fix.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationPasskey from "../../migrations/d1/0024_passkey.sql?raw";
import { confirmSendDraft } from "../helpers/armed-confirm";
import { applyMigrations } from "../helpers/migrations";

/**
 * Display names end to end (ingest -> DO rows -> thread list / detail / search)
 * and the real folder counts behind GET /api/mailboxes/:id/counts.
 */

type TestEnv = Env & { INDEX_DB: D1Database; MAIL_OBJECTS: R2Bucket };
const testEnv = env as unknown as TestEnv;

beforeAll(async () => {
	await applyMigrations(
		testEnv.INDEX_DB,
		migrationInitial as string,
		migrationMessageIndex as string,
		migrationMailboxOwner as string,
		migrationRuntimeConfig as string,
		migrationOwnerRegistry as string,
		migrationBetterAuth as string,
		migrationBetterAuthMcp as string,
		migrationBetterAuthMcpFkFix as string,
		migrationTwoFactor as string,
		migrationAuthUpgrade as string,
		migrationPasskey as string,
	);
});

function mime(input: {
	from: string;
	to?: string;
	cc?: string;
	subject: string;
	messageId: string;
	inReplyTo?: string;
	body?: string;
}): string {
	return [
		`From: ${input.from}`,
		`To: ${input.to ?? "Inbox Owner <test@example.com>"}`,
		...(input.cc ? [`Cc: ${input.cc}`] : []),
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
		"Date: Mon, 16 Nov 2026 10:00:00 +0000",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		input.body ?? "Hello there.",
		"",
	].join("\r\n");
}

async function ingest(
	mailboxId: string,
	raw: string | Uint8Array,
	messageId: string | null,
): Promise<{ status: string; messageLocalId: string; threadId?: string }> {
	const rawBytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
	const rawSha256 = await sha256Hex(rawBytes);
	const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
	await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
	const message: InboundEmailQueueMessage = {
		schemaVersion: 1,
		eventType: "email.received.v1",
		traceId: crypto.randomUUID(),
		enqueuedAt: new Date().toISOString(),
		receivedAt: new Date().toISOString(),
		mailboxId,
		domain: "example.com",
		recipient: "test@example.com",
		sender: "envelope@example.com",
		rawR2Key,
		rawSha256,
		rawSize: rawBytes.byteLength,
		messageId,
		headers: { subject: null, date: null, inReplyTo: null, references: [] },
		routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
		idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
	};
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		"https://mailbox-do/ingest",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		},
	);
	expect(response.status).toBe(200);
	return (await response.json()) as { status: string; messageLocalId: string; threadId?: string };
}

type Row = Record<string, unknown>;

async function doGet<T>(mailboxId: string, path: string): Promise<T> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(`https://mailbox-do${path}`);
	expect(response.status).toBe(200);
	return (await response.json()) as T;
}

async function act(mailboxId: string, messageId: string, action: string): Promise<void> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
		`https://mailbox-do/messages/${messageId}/actions`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action }),
		},
	);
	expect(response.status).toBe(200);
}

const counts = (mailboxId: string) =>
	doGet<{ counts: MailboxCounts }>(mailboxId, "/counts").then((r) => r.counts);

describe("display names at ingest", () => {
	it("stores the From and recipient names and exposes them on every read path", async () => {
		const mailboxId = "mbx-names-basic";
		const result = await ingest(
			mailboxId,
			mime({
				from: '"Noor Haddad" <noor@haddad.dev>',
				to: "Inbox Owner <test@example.com>, ana@example.com",
				cc: '"Bo Lindqvist" <bo@example.se>',
				subject: "Quarterly numbers",
				messageId: "names-basic@haddad.dev",
				body: "Numbers attached.",
			}),
			"names-basic@haddad.dev",
		);
		expect(result.status).toBe("inserted");

		const { message } = await doGet<{ message: Row }>(
			mailboxId,
			`/messages/${result.messageLocalId}`,
		);
		expect(message.from_addr).toBe("noor@haddad.dev");
		expect(message.from_name).toBe("Noor Haddad");
		expect(JSON.parse(String(message.recipient_names_json))).toEqual({
			"test@example.com": "Inbox Owner",
			"bo@example.se": "Bo Lindqvist",
		});

		const { threads } = await doGet<{ threads: Row[] }>(mailboxId, "/threads?state=inbox");
		expect(threads[0]?.latest_from).toBe("noor@haddad.dev");
		expect(threads[0]?.latest_from_name).toBe("Noor Haddad");

		const detail = await doGet<{ messages: Row[] }>(mailboxId, `/threads/${result.threadId}`);
		expect(detail.messages[0]?.from_name).toBe("Noor Haddad");

		// The name is searchable, not only the address.
		const search = await doGet<{ results: Array<{ message_id: string }> }>(
			mailboxId,
			`/search?q=${encodeURIComponent("Noor Haddad")}&limit=5`,
		);
		expect(search.results.map((r) => r.message_id)).toContain(result.messageLocalId);
	});

	it("a redelivery is a duplicate and leaves the stored name alone", async () => {
		const mailboxId = "mbx-names-redelivery";
		const raw = mime({
			from: "Noor Haddad <noor@haddad.dev>",
			subject: "Once",
			messageId: "names-redelivery@haddad.dev",
		});
		const first = await ingest(mailboxId, raw, "names-redelivery@haddad.dev");
		const second = await ingest(mailboxId, raw, "names-redelivery@haddad.dev");
		expect(first.status).toBe("inserted");
		expect(second.status).toBe("duplicate");
		expect(second.messageLocalId).toBe(first.messageLocalId);

		const rows = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			async (_i, state) =>
				state.storage.sql.exec("SELECT id, from_name FROM messages").toArray() as Row[],
		);
		expect(rows).toEqual([{ id: first.messageLocalId, from_name: "Noor Haddad" }]);
		expect((await counts(mailboxId)).inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
	});

	it("sanitises hostile names before storing them", async () => {
		const mailboxId = "mbx-names-hostile";
		const spoof = await ingest(
			mailboxId,
			mime({
				from: '"ceo@corp.com" <attacker@evil.io>',
				subject: "Wire transfer",
				messageId: "spoof@evil.io",
			}),
			"spoof@evil.io",
		);
		const bidi = await ingest(
			mailboxId,
			// RFC 2047 so the control characters survive the header parser.
			mime({
				from: `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("\u202ENoor\u200B Haddad\u0007")))}?= <noor@haddad.dev>`,
				subject: "Bidi",
				messageId: "bidi@haddad.dev",
			}),
			"bidi@haddad.dev",
		);
		const long = await ingest(
			mailboxId,
			mime({
				from: `"${"N".repeat(300)}" <long@example.com>`,
				subject: "Long",
				messageId: "long@example.com",
			}),
			"long@example.com",
		);
		const nameOf = async (id: string) =>
			(await doGet<{ message: Row }>(mailboxId, `/messages/${id}`)).message.from_name;

		expect(await nameOf(spoof.messageLocalId)).toBeNull();
		expect(await nameOf(bidi.messageLocalId)).toBe("Noor Haddad");
		expect(String(await nameOf(long.messageLocalId))).toHaveLength(80);
	});

	it("mail without a name, and a parse failure, store NULL and still list", async () => {
		const mailboxId = "mbx-names-none";
		const plain = await ingest(
			mailboxId,
			mime({
				from: "bare@example.com",
				to: "test@example.com",
				subject: "No name",
				messageId: "bare@example.com",
			}),
			"bare@example.com",
		);
		// Nested past postal-mime's depth limit: parsing throws, the row is kept.
		let body = "Final part.\n";
		for (let i = 300; i >= 1; i--) {
			body = `Content-Type: multipart/mixed; boundary="l${i}"\n\n--l${i}\n${body}\n--l${i}--\n`;
		}
		const broken = await ingest(
			mailboxId,
			`From: Named Sender <named@example.com>\nTo: test@example.com\nSubject: Broken\nMessage-ID: <broken@example.com>\n${body}`,
			"broken@example.com",
		);
		const rows = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			async (_i, state) =>
				state.storage.sql
					.exec("SELECT id, from_name, recipient_names_json, parse_status FROM messages")
					.toArray() as Row[],
		);
		const byId = new Map(rows.map((r) => [r.id, r]));
		expect(byId.get(plain.messageLocalId)).toMatchObject({
			from_name: null,
			recipient_names_json: null,
			parse_status: "parsed",
		});
		expect(byId.get(broken.messageLocalId)).toMatchObject({
			from_name: null,
			parse_status: "failed",
		});
		const { threads } = await doGet<{ threads: Row[] }>(mailboxId, "/threads?state=inbox");
		expect(threads).toHaveLength(2);
		expect(threads.every((t) => t.latest_from_name === null)).toBe(true);
	});
});

describe("MCP read tools carry the name next to the address", () => {
	it("list_threads, search_messages and read_message add the sanitised name", async () => {
		const mailboxId = `mbx_names_mcp_${crypto.randomUUID()}`;
		const now = new Date().toISOString();
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, 'active', 'dev@local', ?, ?)",
		)
			.bind(mailboxId, `${mailboxId}@example.com`, now, now)
			.run();
		const named = await ingest(
			mailboxId,
			mime({
				from: "Noor Haddad <noor@haddad.dev>",
				subject: "Agenda",
				messageId: "mcp@haddad.dev",
			}),
			"mcp@haddad.dev",
		);
		const facade = new McpMailboxFacade(testEnv, {
			userId: "dev-local",
			email: "dev@local",
			local: true,
			scopes: new Set(["mail:read"]),
		} as ConstructorParameters<typeof McpMailboxFacade>[1]);

		const [thread] = await facade.listThreads(mailboxId, 10);
		expect(thread).toMatchObject({
			latest_from: "noor@haddad.dev",
			latest_from_name: "Noor Haddad",
		});
		const [hit] = await facade.searchMessages(mailboxId, "Agenda", 5);
		expect(hit).toMatchObject({ from_addr: "noor@haddad.dev", from_name: "Noor Haddad" });
		const message = await facade.readMessage(mailboxId, named.messageLocalId);
		expect(message).toMatchObject({ from_addr: "noor@haddad.dev", from_name: "Noor Haddad" });
	});
});

describe("schema v10 on a mailbox that predates display names", () => {
	it("adds the columns and index, keeps old rows readable with a NULL name", async () => {
		const name = "mbx-names-v10-migrate";
		const stub = testEnv.MAILBOX_DO.getByName(name);
		const result = await ingest(
			name,
			mime({ from: "Old Sender <old@example.com>", subject: "Old", messageId: "old@example.com" }),
			"old@example.com",
		);
		await runInDurableObject(stub, async (_i, state) => {
			const sql = state.storage.sql;
			// Put the pre-v10 shape back: no name columns, no counts index.
			sql.exec("DROP INDEX IF EXISTS idx_messages_folder_counts");
			sql.exec("ALTER TABLE messages DROP COLUMN from_name");
			sql.exec("ALTER TABLE messages DROP COLUMN recipient_names_json");
			sql.exec("DELETE FROM schema_migrations WHERE version >= 10");
		});
		await abortAllDurableObjects();

		const fresh = testEnv.MAILBOX_DO.getByName(name);
		const after = await runInDurableObject(fresh, async (_i, state) => ({
			columns: (
				state.storage.sql.exec("PRAGMA table_info(messages)").toArray() as Array<{ name: string }>
			).map((c) => c.name),
			index: state.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_folder_counts'",
				)
				.toArray().length,
			version: state.storage.sql
				.exec<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations")
				.toArray()[0]?.v,
		}));
		expect(after.columns).toEqual(expect.arrayContaining(["from_name", "recipient_names_json"]));
		expect(after.index).toBe(1);
		expect(after.version).toBe(15);

		const { message } = await doGet<{ message: Row }>(name, `/messages/${result.messageLocalId}`);
		expect(message.from_name).toBeNull();
		expect(message.from_addr).toBe("old@example.com");
		const { threads } = await doGet<{ threads: Row[] }>(name, "/threads");
		expect(threads[0]?.latest_from_name).toBeNull();
	});
});

describe("folder counts", () => {
	it("start at zero", async () => {
		expect(await counts("mbx-counts-empty")).toEqual({
			inbox: { threads: 0, unread: 0, messages: 0 },
			sent: { threads: 0, unread: 0, messages: 0 },
			archive: { threads: 0, unread: 0, messages: 0 },
			trash: { threads: 0, unread: 0, messages: 0 },
			all: { threads: 0, unread: 0, messages: 0 },
			drafts: 0,
			reports: { threads: 0, unread: 0, messages: 0 },
		});
	});

	it("follow ingest, read, archive, trash, restore and send", async () => {
		const mailboxId = "mbx-counts-lifecycle";
		const a1 = await ingest(
			mailboxId,
			mime({ from: "Ana <ana@example.com>", subject: "Plan", messageId: "a1@example.com" }),
			"a1@example.com",
		);
		const a2 = await ingest(
			mailboxId,
			mime({
				from: "Ana <ana@example.com>",
				subject: "Re: Plan",
				messageId: "a2@example.com",
				inReplyTo: "a1@example.com",
			}),
			"a2@example.com",
		);
		const b1 = await ingest(
			mailboxId,
			mime({ from: "Bo <bo@example.se>", subject: "Lunch", messageId: "b1@example.se" }),
			"b1@example.se",
		);
		expect(a2.threadId).toBe(a1.threadId);

		// Ingest: two conversations, three messages, both unread.
		let c = await counts(mailboxId);
		expect(c.inbox).toEqual({ threads: 2, unread: 2, messages: 3 });
		expect(c.all).toEqual({ threads: 2, unread: 2, messages: 3 });

		// Read one of A's two messages: A still has an unread one.
		await act(mailboxId, a1.messageLocalId, "mark_read");
		expect((await counts(mailboxId)).inbox.unread).toBe(2);
		await act(mailboxId, a2.messageLocalId, "mark_read");
		expect((await counts(mailboxId)).inbox).toEqual({ threads: 2, unread: 1, messages: 3 });

		// Archive conversation A (folder moves are per message).
		await act(mailboxId, a1.messageLocalId, "archive");
		await act(mailboxId, a2.messageLocalId, "archive");
		c = await counts(mailboxId);
		expect(c.inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.archive).toEqual({ threads: 1, unread: 0, messages: 2 });

		// Trash B.
		await act(mailboxId, b1.messageLocalId, "trash");
		c = await counts(mailboxId);
		expect(c.inbox).toEqual({ threads: 0, unread: 0, messages: 0 });
		expect(c.trash).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.all).toEqual({ threads: 2, unread: 1, messages: 3 });

		// Restore B to the inbox.
		await act(mailboxId, b1.messageLocalId, "restore_inbox");
		c = await counts(mailboxId);
		expect(c.inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.trash).toEqual({ threads: 0, unread: 0, messages: 0 });

		// An open draft counts; sending it moves it into Sent and out of Drafts.
		const draftId = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			async (_i, state) => {
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				state.storage.sql.exec(
					`INSERT INTO outbound_drafts
           (id, thread_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at)
           VALUES (?, ?, '["bo@example.se"]', '[]', '[]', 'Re: Lunch', 'Sure.', NULL, 'draft', 'web', ?, ?)`,
					id,
					b1.threadId ?? null,
					now,
					now,
				);
				return id;
			},
		);
		expect((await counts(mailboxId)).drafts).toBe(1);
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (_i, state) => {
			await confirmSendDraft(
				{
					sql: state.storage.sql,
					transactionSync: (fn) => state.storage.transactionSync(fn),
					email: {
						send: async () => ({ messageId: "<sent@cloudflare.email>" }),
					} as unknown as Env["EMAIL"],
					fromAddress: "test@example.com",
					fromName: "Inbox Owner",
					replyToAddress: null,
				},
				draftId,
				`attempt-${draftId}`,
			);
		});
		c = await counts(mailboxId);
		expect(c.drafts).toBe(0);
		expect(c.sent).toEqual({ threads: 1, unread: 0, messages: 1 });
		// The reply joined B's conversation: still two conversations overall.
		expect(c.all).toEqual({ threads: 2, unread: 1, messages: 4 });

		// The sent copy carries the From name it went out with.
		const sentName = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(mailboxId),
			async (_i, state) =>
				state.storage.sql
					.exec<{ from_name: string | null }>(
						"SELECT from_name FROM messages WHERE direction = 'outbound'",
					)
					.toArray()[0]?.from_name,
		);
		expect(sentName).toBe("Inbox Owner");
	});

	it("are answered from the covering index", async () => {
		const plan = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName("mbx-counts-plan"),
			async (_i, state) => {
				folderCounts(state.storage.sql);
				return state.storage.sql
					.exec(
						"EXPLAIN QUERY PLAN SELECT state, COUNT(DISTINCT thread_id), COUNT(*) FROM messages GROUP BY state",
					)
					.toArray()
					.map((row) => String((row as { detail: string }).detail));
			},
		);
		expect(plan.join("\n")).toContain("COVERING INDEX idx_messages_folder_counts");
	});
});

describe("GET /api/mailboxes/:mailboxId/counts", () => {
	const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
	const OWNER = "owner@example.com";
	const STRANGER = "stranger@example.com";
	const ORIGIN = "https://inbox.example.dev";
	const authEnv = () =>
		({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, OWNER_BOOTSTRAP_EMAILS: OWNER }) as Env;

	async function run(request: Request, workerEnv: Env): Promise<Response> {
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, workerEnv, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	async function sessionCookieFor(email: string): Promise<string> {
		const { createAuth } = await import("#/api/better-auth");
		const auth = await createAuth(authEnv(), { request: new Request(`${ORIGIN}/`) });
		const ctx = await auth.$context;
		const existing = await testEnv.INDEX_DB.prepare(`SELECT id FROM "user" WHERE email = ?`)
			.bind(email)
			.first<{ id: string }>();
		const userId = existing
			? existing.id
			: (
					await ctx.internalAdapter.createUser(
						{ email, name: email.split("@")[0] ?? email, emailVerified: true },
						{ method: "admin" },
					)
				).id;
		const session = await ctx.internalAdapter.createSession(userId, false);
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(ctx.secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(session.token),
		);
		const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
		return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${base64}`)}`;
	}

	async function seedMailbox(mailboxId: string): Promise<void> {
		const now = new Date().toISOString();
		await testEnv.INDEX_DB.prepare(
			"INSERT OR IGNORE INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, 'active', ?, ?, ?)",
		)
			.bind(mailboxId, `${mailboxId}@example.com`, OWNER, now, now)
			.run();
	}

	it("returns the DO's counts to the owner", async () => {
		const mailboxId = "mbx_counts_route";
		await seedMailbox(mailboxId);
		await ingest(
			mailboxId,
			mime({ from: "Ana <ana@example.com>", subject: "Hi", messageId: "route@example.com" }),
			"route@example.com",
		);
		const cookie = await sessionCookieFor(OWNER);
		const response = await run(
			new Request(`${ORIGIN}/api/mailboxes/${mailboxId}/counts`, { headers: { cookie } }),
			authEnv(),
		);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const body = (await response.json()) as { mailbox_id: string; counts: MailboxCounts };
		expect(body.mailbox_id).toBe(mailboxId);
		expect(body.counts.inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(body.counts.drafts).toBe(0);
	});

	it("is owner-only: no session and a non-owner session are refused", async () => {
		const mailboxId = "mbx_counts_route_auth";
		await seedMailbox(mailboxId);
		const anonymous = await run(
			new Request(`${ORIGIN}/api/mailboxes/${mailboxId}/counts`),
			authEnv(),
		);
		expect([401, 403]).toContain(anonymous.status);
		const cookie = await sessionCookieFor(STRANGER);
		const stranger = await run(
			new Request(`${ORIGIN}/api/mailboxes/${mailboxId}/counts`, { headers: { cookie } }),
			authEnv(),
		);
		expect(stranger.status).toBe(403);
	});

	it("404s for a mailbox that does not exist", async () => {
		const cookie = await sessionCookieFor(OWNER);
		const response = await run(
			new Request(`${ORIGIN}/api/mailboxes/mbx_counts_missing/counts`, { headers: { cookie } }),
			authEnv(),
		);
		expect(response.status).toBe(404);
	});
});
