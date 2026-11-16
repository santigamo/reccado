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
import { applyMigrations } from "../helpers/migrations";

/**
 * DMARC aggregate reports end to end: classified at ingest (stored, read on
 * arrival), kept out of every web list, count and search, reachable in the
 * reports view, untouched for MCP (which talks to the DO without a filter), and
 * backfilled on a mailbox that predates schema v11.
 */

type TestEnv = Env & { INDEX_DB: D1Database; MAIL_OBJECTS: R2Bucket };
const testEnv = env as unknown as TestEnv;
type Row = Record<string, unknown>;

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

const GOOGLE_SUBJECT =
	"Report domain: send.transcribo.es Submitter: google.com Report-ID: 5799709528446682960";

function reportMime(input: {
	from: string;
	subject: string;
	messageId: string;
	filename: string;
	contentType: string;
	inReplyTo?: string;
}): string {
	return [
		`From: ${input.from}`,
		"To: test@example.com",
		`Subject: ${input.subject}`,
		`Message-ID: <${input.messageId}>`,
		...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
		"Date: Mon, 16 Nov 2026 03:00:00 +0000",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="rpt"',
		"",
		"--rpt",
		"Content-Type: text/plain; charset=utf-8",
		"",
		"This is an aggregate report from the submitter.",
		"--rpt",
		`Content-Type: ${input.contentType}; name="${input.filename}"`,
		`Content-Disposition: attachment; filename="${input.filename}"`,
		"Content-Transfer-Encoding: base64",
		"",
		// A real (empty) zip/gzip header is not needed: nothing unpacks it.
		"UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==",
		"--rpt--",
		"",
	].join("\r\n");
}

function plainMime(input: {
	from: string;
	subject: string;
	messageId: string;
	inReplyTo?: string;
	body?: string;
}): string {
	return [
		`From: ${input.from}`,
		"To: test@example.com",
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

const googleReport = (messageId = "5799709528446682960@google.com") =>
	reportMime({
		from: "noreply-dmarc-support@google.com",
		subject: GOOGLE_SUBJECT,
		messageId,
		filename: "google.com!send.transcribo.es!1763164800!1763251199.zip",
		contentType: "application/zip",
	});

async function ingest(
	mailboxId: string,
	raw: string,
	messageId: string | null,
): Promise<{ status: string; messageLocalId: string; threadId?: string }> {
	const rawBytes = new TextEncoder().encode(raw);
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

async function doGet<T>(mailboxId: string, path: string): Promise<T> {
	const response = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(`https://mailbox-do${path}`);
	expect(response.status).toBe(200);
	return (await response.json()) as T;
}

const counts = (mailboxId: string) =>
	doGet<{ counts: MailboxCounts }>(mailboxId, "/counts").then((r) => r.counts);
const threadIds = async (mailboxId: string, query: string) =>
	(await doGet<{ threads: Row[] }>(mailboxId, `/threads${query}`)).threads.map((t) => t.id);
const searchIds = async (mailboxId: string, query: string) =>
	(
		await doGet<{ results: Array<{ message_id: string }> }>(mailboxId, `/search${query}`)
	).results.map((r) => r.message_id);

async function messageRows(mailboxId: string): Promise<Row[]> {
	return runInDurableObject(
		testEnv.MAILBOX_DO.getByName(mailboxId),
		async (_i, state) =>
			state.storage.sql
				.exec(
					"SELECT id, thread_id, subject, automated_kind, is_read, parse_status, state FROM messages",
				)
				.toArray() as Row[],
	);
}

describe("DMARC reports at ingest", () => {
	it("are stored with their attachment, arrive read, and are marked automated", async () => {
		const mailboxId = "mbx-dmarc-ingest";
		const result = await ingest(mailboxId, googleReport(), "5799709528446682960@google.com");
		expect(result.status).toBe("inserted");
		const [row] = await messageRows(mailboxId);
		expect(row).toMatchObject({
			automated_kind: "dmarc_report",
			is_read: 1,
			parse_status: "parsed",
			state: "inbox",
		});
		const detail = await doGet<{ messages: Array<Row & { attachments: Row[] }> }>(
			mailboxId,
			`/threads/${result.threadId}`,
		);
		expect(detail.messages[0]?.attachments[0]).toMatchObject({
			filename: "google.com!send.transcribo.es!1763164800!1763251199.zip",
			content_type: "application/zip",
		});
	});

	it("Yahoo (gz) and Microsoft (x-gzip) reports are classified too", async () => {
		const mailboxId = "mbx-dmarc-providers";
		await ingest(
			mailboxId,
			reportMime({
				from: "dmarchelp@yahooinc.com",
				subject:
					"Report Domain: imsanti.dev Submitter: Yahoo Inc. Report-ID: <1763251200.774421@dmarc.yahoo.com>",
				messageId: "1763251200.774421@dmarc.yahoo.com",
				filename: "yahoo.com!imsanti.dev!1763164800!1763251199.xml.gz",
				contentType: "application/gzip",
			}),
			"1763251200.774421@dmarc.yahoo.com",
		);
		await ingest(
			mailboxId,
			reportMime({
				from: "dmarcreport@microsoft.com",
				subject:
					"Report Domain: transcribo.es Submitter: enterprise.protection.outlook.com Report-ID: 4f7c3b1e8a2d",
				messageId: "4f7c3b1e8a2d@protection.outlook.com",
				filename: "enterprise.protection.outlook.com!transcribo.es!1763164800!1763251200.xml.gz",
				contentType: "application/x-gzip",
			}),
			"4f7c3b1e8a2d@protection.outlook.com",
		);
		const rows = await messageRows(mailboxId);
		expect(rows).toHaveLength(2);
		expect(rows.every((r) => r.automated_kind === "dmarc_report" && r.is_read === 1)).toBe(true);
	});

	it("a redelivery is a duplicate: one row, unchanged counts", async () => {
		const mailboxId = "mbx-dmarc-redelivery";
		const raw = googleReport();
		await ingest(mailboxId, raw, "5799709528446682960@google.com");
		const again = await ingest(mailboxId, raw, "5799709528446682960@google.com");
		expect(again.status).toBe("duplicate");
		expect(await messageRows(mailboxId)).toHaveLength(1);
		const c = await counts(mailboxId);
		expect(c.reports).toEqual({ threads: 1, unread: 0, messages: 1 });
		expect(c.inbox).toEqual({ threads: 0, unread: 0, messages: 0 });
	});

	it("leaves people's mail alone: talk about DMARC, a reply quoting a report, a parse failure", async () => {
		const mailboxId = "mbx-dmarc-negatives";
		const report = await ingest(mailboxId, googleReport(), "5799709528446682960@google.com");
		await ingest(
			mailboxId,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: "Our DMARC report looks wrong",
				messageId: "ana-dmarc@example.com",
				body: "Report domain: send.transcribo.es Submitter: google.com Report-ID: 1",
			}),
			"ana-dmarc@example.com",
		);
		await ingest(
			mailboxId,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: GOOGLE_SUBJECT,
				messageId: "ana-reply@example.com",
				inReplyTo: "5799709528446682960@google.com",
				body: "Look at this one.",
			}),
			"ana-reply@example.com",
		);
		// Nested past postal-mime's depth limit: parsing throws, the row is kept.
		let body = "Final part.\n";
		for (let i = 300; i >= 1; i--) {
			body = `Content-Type: multipart/mixed; boundary="l${i}"\n\n--l${i}\n${body}\n--l${i}--\n`;
		}
		await ingest(
			mailboxId,
			`From: noreply-dmarc-support@google.com\nTo: test@example.com\nSubject: ${GOOGLE_SUBJECT}\nMessage-ID: <broken-report@google.com>\n${body}`,
			"broken-report@google.com",
		);
		const rows = await messageRows(mailboxId);
		const classified = rows.filter((r) => r.automated_kind !== null);
		expect(classified.map((r) => r.id)).toEqual([report.messageLocalId]);
		const failed = rows.find((r) => r.parse_status === "failed");
		expect(failed).toMatchObject({ automated_kind: null, is_read: 0 });
		expect(rows.filter((r) => r.automated_kind === null).every((r) => r.is_read === 0)).toBe(true);
	});
});

describe("what the web sees, and what MCP still sees", () => {
	it("lists, counts and search exclude reports; the reports view and the unfiltered DO include them", async () => {
		const mailboxId = "mbx-dmarc-views";
		const report = await ingest(mailboxId, googleReport(), "5799709528446682960@google.com");
		const human = await ingest(
			mailboxId,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: "Lunch",
				messageId: "lunch@example.com",
				body: "About send.transcribo.es",
			}),
			"lunch@example.com",
		);

		for (const query of ["?reports=exclude", "?state=inbox&reports=exclude"]) {
			expect(await threadIds(mailboxId, query)).toEqual([human.threadId]);
		}
		expect(await threadIds(mailboxId, "?reports=only")).toEqual([report.threadId]);
		// No filter: what MCP gets, unchanged.
		expect(new Set(await threadIds(mailboxId, "?state=inbox"))).toEqual(
			new Set([human.threadId, report.threadId]),
		);

		const c = await counts(mailboxId);
		expect(c.inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.all).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.reports).toEqual({ threads: 1, unread: 0, messages: 1 });

		expect(await searchIds(mailboxId, "?q=transcribo&reports=exclude")).toEqual([
			human.messageLocalId,
		]);
		expect(await searchIds(mailboxId, "?q=transcribo&reports=only")).toEqual([
			report.messageLocalId,
		]);
		expect(new Set(await searchIds(mailboxId, "?q=transcribo"))).toEqual(
			new Set([human.messageLocalId, report.messageLocalId]),
		);
		expect(
			new Set(await searchIds(mailboxId, "?q=transcribo&sensitive=1&reports=exclude")),
		).toEqual(new Set([human.messageLocalId]));
	});

	it("a report inside a person's conversation does not hide the conversation", async () => {
		const mailboxId = "mbx-dmarc-mixed";
		const human = await ingest(
			mailboxId,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: "Setup",
				messageId: "setup@example.com",
			}),
			"setup@example.com",
		);
		const report = await ingest(mailboxId, googleReport(), "5799709528446682960@google.com");
		// Weld the report onto Ana's conversation (as a subject collision could).
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(mailboxId), async (_i, state) => {
			state.storage.sql.exec(
				"UPDATE messages SET thread_id = ? WHERE id = ?",
				human.threadId,
				report.messageLocalId,
			);
		});

		const { threads } = await doGet<{ threads: Row[] }>(mailboxId, "/threads?reports=exclude");
		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({
			id: human.threadId,
			message_count: 1,
			unread_count: 1,
			latest_from: "ana@example.com",
		});
		expect(await threadIds(mailboxId, "?reports=only")).toEqual([human.threadId]);
		const c = await counts(mailboxId);
		expect(c.inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.reports).toEqual({ threads: 1, unread: 0, messages: 1 });
	});

	it("the web counts are answered from the partial index", async () => {
		const plan = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName("mbx-dmarc-plan"),
			async (_i, state) => {
				folderCounts(state.storage.sql);
				const explain = (query: string) =>
					state.storage.sql
						.exec(`EXPLAIN QUERY PLAN ${query}`)
						.toArray()
						.map((row) => String((row as { detail: string }).detail))
						.join("\n");
				return {
					people: explain(
						"SELECT state, COUNT(DISTINCT thread_id), COUNT(*) FROM messages WHERE automated_kind IS NULL GROUP BY state",
					),
					reports: explain(
						"SELECT COUNT(DISTINCT thread_id), COUNT(*) FROM messages WHERE automated_kind IS NOT NULL",
					),
				};
			},
		);
		expect(plan.people).toContain("COVERING INDEX idx_messages_web_counts");
		expect(plan.reports).toContain("COVERING INDEX idx_messages_reports");
	});
});

describe("schema v11 on a mailbox that predates it", () => {
	it("adds the column and indexes, and backfills the reports already stored", async () => {
		const name = "mbx-dmarc-v11-migrate";
		const report = await ingest(name, googleReport(), "5799709528446682960@google.com");
		const human = await ingest(
			name,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: "Our DMARC report looks wrong",
				messageId: "ana@example.com",
			}),
			"ana@example.com",
		);
		const reply = await ingest(
			name,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: GOOGLE_SUBJECT,
				messageId: "ana-reply@example.com",
				inReplyTo: "5799709528446682960@google.com",
			}),
			"ana-reply@example.com",
		);
		await runInDurableObject(testEnv.MAILBOX_DO.getByName(name), async (_i, state) => {
			const sql = state.storage.sql;
			// Put the pre-v11 shape back: every message unread, no column, no indexes.
			sql.exec("UPDATE messages SET is_read = 0");
			sql.exec("DROP INDEX IF EXISTS idx_messages_web_counts");
			sql.exec("DROP INDEX IF EXISTS idx_messages_reports");
			sql.exec("ALTER TABLE messages DROP COLUMN automated_kind");
			sql.exec("DELETE FROM schema_migrations WHERE version >= 11");
		});
		await abortAllDurableObjects();

		const after = await runInDurableObject(
			testEnv.MAILBOX_DO.getByName(name),
			async (_i, state) => ({
				indexes: state.storage.sql
					.exec(
						"SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_messages_web_counts', 'idx_messages_reports')",
					)
					.toArray().length,
				version: state.storage.sql
					.exec<{ v: number }>("SELECT MAX(version) AS v FROM schema_migrations")
					.toArray()[0]?.v,
			}),
		);
		expect(after).toEqual({ indexes: 2, version: 15 });

		const byId = new Map((await messageRows(name)).map((r) => [r.id, r]));
		expect(byId.get(report.messageLocalId)).toMatchObject({
			automated_kind: "dmarc_report",
			is_read: 1,
		});
		expect(byId.get(human.messageLocalId)).toMatchObject({ automated_kind: null, is_read: 0 });
		expect(byId.get(reply.messageLocalId)).toMatchObject({ automated_kind: null, is_read: 0 });
		const c = await counts(name);
		expect(c.reports.messages).toBe(1);
		expect(c.inbox.unread).toBe(2);
	});
});

describe("GET /api/mailboxes/:id/threads|search|counts (web)", () => {
	const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
	const OWNER = "owner@example.com";
	const ORIGIN = "https://inbox.example.dev";
	const authEnv = () =>
		({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, OWNER_BOOTSTRAP_EMAILS: OWNER }) as Env;

	async function run(request: Request): Promise<Response> {
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, authEnv(), ctx);
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

	it("hides reports by default and lists them with reports=only", async () => {
		const mailboxId = "mbx_dmarc_web";
		const now = new Date().toISOString();
		await testEnv.INDEX_DB.prepare(
			"INSERT OR IGNORE INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, NULL, 'active', ?, ?, ?)",
		)
			.bind(mailboxId, `${mailboxId}@example.com`, OWNER, now, now)
			.run();
		const report = await ingest(mailboxId, googleReport(), "5799709528446682960@google.com");
		const human = await ingest(
			mailboxId,
			plainMime({
				from: "Ana <ana@example.com>",
				subject: "transcribo plan",
				messageId: "p@example.com",
			}),
			"p@example.com",
		);
		const cookie = await sessionCookieFor(OWNER);
		const get = async <T>(path: string): Promise<T> => {
			const response = await run(
				new Request(`${ORIGIN}/api/mailboxes/${mailboxId}${path}`, { headers: { cookie } }),
			);
			expect(response.status, await response.clone().text()).toBe(200);
			return (await response.json()) as T;
		};

		const inbox = await get<{ threads: Row[] }>("/threads?state=inbox");
		expect(inbox.threads.map((t) => t.id)).toEqual([human.threadId]);
		const all = await get<{ threads: Row[] }>("/threads");
		expect(all.threads.map((t) => t.id)).toEqual([human.threadId]);
		const reports = await get<{ threads: Row[] }>("/threads?reports=only");
		expect(reports.threads.map((t) => t.id)).toEqual([report.threadId]);

		const search = await get<{ results: Array<{ message_id: string }> }>("/search?q=transcribo");
		expect(search.results.map((r) => r.message_id)).toEqual([human.messageLocalId]);
		const reportSearch = await get<{ results: Array<{ message_id: string }> }>(
			"/search?q=transcribo&reports=only",
		);
		expect(reportSearch.results.map((r) => r.message_id)).toEqual([report.messageLocalId]);

		const { counts: c } = await get<{ counts: MailboxCounts }>("/counts");
		expect(c.inbox).toEqual({ threads: 1, unread: 1, messages: 1 });
		expect(c.reports).toEqual({ threads: 1, unread: 0, messages: 1 });

		// Unknown values are refused rather than silently showing everything.
		const bad = await run(
			new Request(`${ORIGIN}/api/mailboxes/${mailboxId}/threads?reports=all`, {
				headers: { cookie },
			}),
		);
		expect(bad.status).toBe(400);
	});
});
