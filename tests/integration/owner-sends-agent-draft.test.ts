import {
	createExecutionContext,
	runInDurableObject,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { insertMailbox } from "#/db/d1";
import {
	approveIntent,
	getIntentStatus,
	getIntentView,
	getOrCreatePendingIntent,
	signOwnerWebSendProof,
} from "#/lib/approvals";
import { storeDraftUpload } from "#/lib/draft-attachment-upload";
import { confirmDraftSend } from "#/lib/outbound-send";
import { McpMailboxFacade } from "../../src/mcp/mailbox-facade";
import worker from "../../src/server";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import { applyMigrations } from "../helpers/migrations";

/**
 * The owner sends an agent-written draft directly from the web (the agent can
 * never send; an agent-initiated send needs the hash-bound approval; the owner
 * may send an agent draft with the owner web session, bound to the content they
 * were shown; never from Telegram), and an owner edit takes the draft over.
 */

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const TEST_SECRET = "owner-send-secret-0123456789-0123456789";
// The mailbox DO verifies proofs with its own env, the isolate env: the route
// that signs them has to see the same secret, so the shared object carries it.
const shared = env as Env;
let savedSecret: string | undefined;

beforeAll(async () => {
	await applyMigrations(
		db,
		migrationInitial,
		migrationMessageIndex,
		migrationOwnerColumn,
		migrationTelegram,
		migrationOutbound,
		migrationRuntimeConfig,
		migrationOwnerRegistry,
		migrationBetterAuth,
		migrationBetterAuthMcp,
		migrationTwoFactor,
		migrationAuthUpgrade,
		migrationApprovals,
		migrationAudit,
		migrationApprovalMeta,
		migrationIntentPayload,
		migrationPendingUnique,
	);
	await db
		.prepare(
			"INSERT OR REPLACE INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', ?, ?)",
		)
		.bind(ORIGIN, new Date().toISOString())
		.run();
	savedSecret = shared.BETTER_AUTH_SECRET;
	shared.BETTER_AUTH_SECRET = TEST_SECRET;
});

afterAll(() => {
	shared.BETTER_AUTH_SECRET = savedSecret;
});

function rand(n = 12): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, n);
}

async function ownerSession(email: string): Promise<{ userId: string; cookie: string }> {
	const code = rand(24);
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
		)
		.bind(code, now, new Date(Date.now() + 60 * 60 * 1000).toISOString())
		.run();
	const response = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/pairing`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ email, code }),
		}),
		shared,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	const cookie = response.headers
		.getSetCookie()
		.map((c) => c.split(";")[0])
		.join("; ");
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return { userId: user?.id ?? "", cookie };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** An owner with a web session, a mailbox, and a draft the agent saved over MCP. */
async function setup(label: string) {
	const email = `${label}-${rand(6)}@example.com`;
	const owner = await ownerSession(email);
	const mailboxId = `mbx_${rand(16)}`;
	const address = `${mailboxId}@imsanti.dev`;
	await insertMailbox(db, {
		mailbox_id: mailboxId,
		primary_address: address,
		display_name: "Owner",
		status: "active",
		owner_email: email,
	});
	const facade = new McpMailboxFacade(shared, {
		userId: owner.userId,
		email,
		scopes: new Set(["mail:read", "mail:draft"]),
	});
	const idempotencyKey = crypto.randomUUID();
	const { draft_id: draftId } = await facade.createDraft(mailboxId, {
		to: ["stranger@example.net"],
		subject: "Propuesta",
		bodyMarkdown: "Hola **Ana**, te paso la propuesta.",
		idempotencyKey,
	});
	const stub = shared.MAILBOX_DO.getByName(mailboxId);
	return { email, owner, mailboxId, address, facade, draftId, stub, idempotencyKey };
}

async function api(
	s: Setup,
	path: string,
	init: { method?: string; body?: unknown; origin?: boolean } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		cookie: s.owner.cookie,
	};
	if (init.origin !== false) headers.origin = ORIGIN;
	const ctx = createExecutionContext();
	const response = await worker.fetch(
		new Request(`${ORIGIN}/api/mailboxes/${s.mailboxId}${path}`, {
			method: init.method ?? "GET",
			headers,
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		}),
		shared,
		ctx,
	);
	await waitOnExecutionContext(ctx);
	return response;
}

/** What the composer loads: the draft as served to the browser. */
async function loadDraft(s: Setup) {
	const response = await api(s, `/drafts/${s.draftId}`);
	expect(response.status).toBe(200);
	return (
		(await response.json()) as {
			draft: { origin: string; status: string; body_text: string; content_fingerprint: string };
		}
	).draft;
}

/** The composer's Send: request-send, then confirm-send (with the fingerprint, if any). */
async function webSend(
	s: Setup,
	idempotencyKey: string,
	opts: { fingerprint?: string; origin?: boolean } = {},
) {
	const armed = await api(s, `/drafts/${s.draftId}/request-send`, { method: "POST" });
	expect(armed.status).toBe(200);
	const response = await api(s, `/drafts/${s.draftId}/confirm-send`, {
		method: "POST",
		origin: opts.origin,
		body: {
			idempotencyKey,
			...(opts.fingerprint ? { draftFingerprint: opts.fingerprint } : {}),
		},
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function messageCount(s: Setup): Promise<number> {
	return runInDurableObject(
		s.stub,
		async (_instance, state) =>
			state.storage.sql.exec("SELECT id FROM messages WHERE direction = 'outbound'").toArray()
				.length,
	);
}

async function originOf(s: Setup): Promise<string> {
	return runInDurableObject(
		s.stub,
		async (_instance, state) =>
			state.storage.sql
				.exec<{ origin: string }>("SELECT origin FROM outbound_drafts WHERE id = ?", s.draftId)
				.toArray()[0]?.origin ?? "",
	);
}

/** An approval request as the MCP `send` tool would create it. */
async function pendingApproval(s: Setup) {
	const armed = await s.stub.fetch(`https://mailbox-do/drafts/${s.draftId}/request-send`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mailboxAddress: s.address, displayName: "Owner", requester: "mcp" }),
	});
	const { payload_hash: payloadHash } = (await armed.json()) as { payload_hash: string };
	expect(payloadHash).toMatch(/^[a-f0-9]{64}$/);
	const { intent } = await getOrCreatePendingIntent(shared, {
		kind: "send",
		origin: "mcp",
		mailboxId: s.mailboxId,
		draftId: s.draftId,
		payloadHash,
		tokenSub: s.owner.userId,
	});
	expect((await getIntentStatus(shared, intent.id)).status).toBe("pending");
	return { id: intent.id, payloadHash };
}

describe("owner sends an agent draft directly from the web", () => {
	it("sends an untouched agent draft exactly once, recorded as an owner direct send", async () => {
		const s = await setup("direct");
		const shown = await loadDraft(s);
		expect(shown.origin).toBe("mcp");
		expect(shown.content_fingerprint).toMatch(/^[a-f0-9]{64}$/);

		const first = await webSend(s, "attempt-1", { fingerprint: shown.content_fingerprint });
		expect(first.status, JSON.stringify(first.body)).toBe(200);
		expect(first.body).toMatchObject({ sent: true, ownerSentAgentDraft: true });
		expect(await messageCount(s)).toBe(1);

		// The same click replayed (same idempotency key) sends nothing more.
		const replay = await api(s, `/drafts/${s.draftId}/confirm-send`, {
			method: "POST",
			body: { idempotencyKey: "attempt-1", draftFingerprint: shown.content_fingerprint },
		});
		expect(await replay.json()).toMatchObject({ sent: false, duplicate: true });
		// A second click with a new key finds the draft already sent.
		const again = await api(s, `/drafts/${s.draftId}/confirm-send`, {
			method: "POST",
			body: { idempotencyKey: "attempt-2", draftFingerprint: shown.content_fingerprint },
		});
		expect((await again.json()) as { sent?: boolean }).toMatchObject({ sent: false });
		expect(await messageCount(s)).toBe(1);

		const sends = await db
			.prepare("SELECT status FROM outbound_sends WHERE draft_id = ? AND status = 'sent'")
			.bind(s.draftId)
			.all();
		expect(sends.results).toHaveLength(1);
		const event = await db
			.prepare(
				"SELECT payload_json FROM ops_events WHERE event_type = 'send.owner_direct_agent_draft' AND payload_json LIKE ?",
			)
			.bind(`%${s.draftId}%`)
			.first<{ payload_json: string }>();
		expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({
			draftId: s.draftId,
			channel: "owner_web",
			actor: s.email,
			contentFingerprint: shown.content_fingerprint,
		});
	});

	it("refuses with draft_changed when the agent edited the draft after the owner opened it", async () => {
		const s = await setup("changed");
		const shown = await loadDraft(s);
		await s.facade.updateDraft(s.mailboxId, s.draftId, {
			to: ["stranger@example.net", "attacker@evil.example"],
			subject: "Propuesta",
			bodyText: "changed by the agent",
		});
		const result = await webSend(s, "changed-1", { fingerprint: shown.content_fingerprint });
		expect(result.status).toBe(409);
		expect(result.body).toMatchObject({ sent: false, error: "draft_changed" });
		expect(await messageCount(s)).toBe(0);

		// Reloaded, the owner sees the new content (and its fingerprint) and can send that.
		const reloaded = await loadDraft(s);
		expect(reloaded.body_text).toBe("changed by the agent");
		expect(reloaded.content_fingerprint).not.toBe(shown.content_fingerprint);
		const resent = await webSend(s, "changed-2", { fingerprint: reloaded.content_fingerprint });
		expect(resent.body).toMatchObject({ sent: true });
		expect(await messageCount(s)).toBe(1);
	});

	it("refuses an agent draft without a fingerprint, or a fingerprint without our Origin", async () => {
		const s = await setup("missing");
		const shown = await loadDraft(s);
		const bare = await webSend(s, "bare-1");
		expect(bare.status).toBe(409);
		expect(bare.body).toMatchObject({ sent: false, error: "approval_required" });
		const noOrigin = await webSend(s, "bare-2", {
			fingerprint: shown.content_fingerprint,
			origin: false,
		});
		expect(noOrigin.status).toBe(403);
		expect(noOrigin.body).toMatchObject({ error: "origin_mismatch" });
		const wrong = await webSend(s, "bare-3", { fingerprint: "0".repeat(64) });
		expect(wrong.body).toMatchObject({ sent: false, error: "draft_changed" });
		expect(await messageCount(s)).toBe(0);
	});

	it("refuses a forged owner proof at the mailbox DO and from Telegram", async () => {
		const s = await setup("forged");
		const shown = await loadDraft(s);
		await s.stub.fetch(`https://mailbox-do/drafts/${s.draftId}/request-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mailboxAddress: s.address }),
		});
		// Whoever reaches the DO without the worker's secret cannot mint the proof.
		const forged = await signOwnerWebSendProof("not-the-secret-0123456789-0123456789", {
			mailboxId: s.mailboxId,
			draftId: s.draftId,
			idempotencyKey: "forged",
			fingerprint: shown.content_fingerprint,
			exp: Date.now() + 30_000,
		});
		const direct = await s.stub.fetch(`https://mailbox-do/drafts/${s.draftId}/confirm-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ idempotencyKey: "forged", ownerProof: forged }),
		});
		expect(await direct.json()).toMatchObject({ sent: false, error: "approval_required" });
		// A valid proof for a different idempotency key does not transfer either.
		const other = await signOwnerWebSendProof(TEST_SECRET, {
			mailboxId: s.mailboxId,
			draftId: s.draftId,
			idempotencyKey: "signed-for-another",
			fingerprint: shown.content_fingerprint,
			exp: Date.now() + 30_000,
		});
		const swapped = await s.stub.fetch(`https://mailbox-do/drafts/${s.draftId}/confirm-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ idempotencyKey: "used-here", ownerProof: other }),
		});
		expect(await swapped.json()).toMatchObject({ sent: false, error: "approval_required" });

		const telegram = await confirmDraftSend(shared, {
			mailboxId: s.mailboxId,
			draftId: s.draftId,
			attemptKey: "telegram-attempt",
			approvalMode: "telegram_confirmed",
		});
		expect(telegram.body).toMatchObject({ sent: false, error: "approval_required" });
		expect(await messageCount(s)).toBe(0);
	});

	it("invalidates a pending approval when the owner sends directly", async () => {
		const s = await setup("supersede-send");
		const approval = await pendingApproval(s);
		const shown = await loadDraft(s);
		const sent = await webSend(s, "direct-1", { fingerprint: shown.content_fingerprint });
		expect(sent.body).toMatchObject({ sent: true });
		expect((await getIntentStatus(shared, approval.id)).status).toBe("stale");
		const late = await approveIntent(shared, {
			id: approval.id,
			payloadHash: approval.payloadHash,
			channel: "web",
			approver: s.owner.userId,
		});
		expect(late.status).not.toBe("sent");
		expect(await messageCount(s)).toBe(1);
		expect(
			await db
				.prepare("SELECT event_type FROM ops_events WHERE id = ?")
				.bind(`approval.superseded:${approval.id}`)
				.first(),
		).toMatchObject({ event_type: "approval.superseded" });
	});
});

describe("owner takeover of an agent draft", () => {
	it("makes the draft the owner's: the agent can no longer edit, cancel, re-claim or send it", async () => {
		const s = await setup("takeover");
		const saved = await api(s, `/drafts/${s.draftId}`, {
			method: "PATCH",
			body: { bodyText: "rewritten by the owner", bodyHtml: "<p>rewritten by the owner</p>" },
		});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({ takenOver: true });
		expect(await originOf(s)).toBe("web");

		await expect(
			s.facade.updateDraft(s.mailboxId, s.draftId, {
				to: ["stranger@example.net"],
				subject: "Propuesta",
				bodyText: "agent tries again",
			}),
		).rejects.toThrow("draft_not_agent_owned");
		await expect(s.facade.cancelDraft(s.mailboxId, s.draftId)).rejects.toThrow(
			"draft_not_agent_owned",
		);
		// Replaying the creating idempotency key does not hand it back to the agent.
		await expect(
			s.facade.createDraft(s.mailboxId, {
				to: ["stranger@example.net"],
				subject: "Propuesta",
				bodyText: "replay",
				idempotencyKey: s.idempotencyKey,
			}),
		).rejects.toThrow("draft_not_agent_owned");
		// The DO enforces it too, not only the facade's read before the write.
		const raced = await s.stub.fetch(`https://mailbox-do/drafts/${s.draftId}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ bodyText: "slipped past", origin: "mcp", allowedStatuses: ["draft"] }),
		});
		expect(raced.status).toBe(409);
		expect(await raced.json()).toMatchObject({ error: "draft_not_agent_owned" });
		const askToSend = await s.stub.fetch(`https://mailbox-do/drafts/${s.draftId}/request-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mailboxAddress: s.address, requester: "mcp" }),
		});
		expect(await askToSend.json()).toMatchObject({ error: "draft_not_agent_owned" });
		expect(await originOf(s)).toBe("web");
		const current = await loadDraft(s);
		expect(current.body_text).toBe("rewritten by the owner");

		// Now an ordinary owner draft: sent from the web without a fingerprint.
		const sent = await webSend(s, "owner-1");
		expect(sent.body).toMatchObject({ sent: true });
		expect(sent.body.ownerSentAgentDraft).toBeUndefined();
		expect(await messageCount(s)).toBe(1);
	});

	it("supersedes a pending approval even when the owner saved the text unchanged", async () => {
		const s = await setup("supersede-edit");
		const approval = await pendingApproval(s);
		const before = await loadDraft(s);
		const saved = await api(s, `/drafts/${s.draftId}`, {
			method: "PATCH",
			body: { subject: "Propuesta" },
		});
		expect(await saved.json()).toMatchObject({ takenOver: true });
		expect((await getIntentStatus(shared, approval.id)).status).toBe("stale");
		const late = await approveIntent(shared, {
			id: approval.id,
			payloadHash: approval.payloadHash,
			channel: "web",
			approver: s.owner.userId,
		});
		expect(late.status).toBe("stale");
		expect(await messageCount(s)).toBe(0);
		// Attachments now work like on any owner draft.
		const upload = await worker.fetch(
			new Request(
				`${ORIGIN}/api/mailboxes/${s.mailboxId}/drafts/${s.draftId}/attachments?filename=a.txt`,
				{
					method: "POST",
					headers: { "content-type": "text/plain", cookie: s.owner.cookie, origin: ORIGIN },
					body: "hello",
				},
			),
			shared,
			createExecutionContext(),
		);
		expect(upload.status, await upload.clone().text()).toBe(201);
		const after = await loadDraft(s);
		expect(after.content_fingerprint).not.toBe(before.content_fingerprint);
	});

	it("still refuses files on a draft that is the agent's", async () => {
		const s = await setup("agent-files");
		const upload = await worker.fetch(
			new Request(
				`${ORIGIN}/api/mailboxes/${s.mailboxId}/drafts/${s.draftId}/attachments?filename=a.txt`,
				{
					method: "POST",
					headers: { "content-type": "text/plain", cookie: s.owner.cookie, origin: ORIGIN },
					body: "hello",
				},
			),
			shared,
			createExecutionContext(),
		);
		expect(upload.status).toBe(409);
		expect(await upload.json()).toMatchObject({ error: "agent_draft_attachments" });
	});
});

describe("agent attaches files to its own draft over MCP", () => {
	const pdf = new TextEncoder().encode("%PDF-1.4 propuesta");

	it("uploads a file that rides in the approved payload, is listed on the approval page and goes out", async () => {
		const s = await setup("mcp-file");
		const added = await s.facade.addDraftFile(s.mailboxId, s.draftId, {
			filename: "propuesta.pdf",
			contentType: "application/pdf",
			bytes: pdf,
		});
		expect(added.added).toHaveLength(1);
		expect(added.attachments).toEqual([
			expect.objectContaining({
				filename: "propuesta.pdf",
				content_type: "application/pdf",
				size: pdf.byteLength,
				source: "upload",
			}),
		]);

		const approval = await pendingApproval(s);
		// The approval page lists the file by name, type and size, next to its hash.
		const view = await getIntentView(shared, approval.id, { userId: s.owner.userId });
		const files = view.fields.find((f) => f.label === "Adjuntos")?.value ?? "";
		expect(files).toContain("propuesta.pdf · application/pdf");
		expect(files).toContain(`sha256 ${added.added[0]!.sha256}`);

		// Frozen once it waits for approval: no more files from the agent.
		await expect(
			s.facade.addDraftFile(s.mailboxId, s.draftId, { filename: "b.txt", bytes: pdf }),
		).rejects.toThrow("draft_not_editable");
		await expect(
			s.facade.removeDraftAttachment(s.mailboxId, s.draftId, added.added[0]!.attachment_id),
		).rejects.toThrow("draft_not_editable");

		const approved = await approveIntent(shared, {
			id: approval.id,
			payloadHash: approval.payloadHash,
			channel: "web",
			approver: s.owner.userId,
		});
		expect(approved.status, JSON.stringify(approved)).toBe("sent");
		expect(await messageCount(s)).toBe(1);
		const sentFiles = await runInDurableObject(s.stub, async (_instance, state) =>
			state.storage.sql
				.exec<{ filename: string }>(
					"SELECT a.filename FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.direction = 'outbound'",
				)
				.toArray(),
		);
		expect(sentFiles.map((f) => f.filename)).toEqual(["propuesta.pdf"]);
	});

	it("removes a file it added, and never touches a draft the owner took over", async () => {
		const s = await setup("mcp-remove");
		const added = await s.facade.addDraftFile(s.mailboxId, s.draftId, {
			filename: "a.txt",
			contentType: "text/plain",
			bytes: pdf,
		});
		const removed = await s.facade.removeDraftAttachment(
			s.mailboxId,
			s.draftId,
			added.added[0]!.attachment_id,
		);
		expect(removed.attachments).toEqual([]);

		const saved = await api(s, `/drafts/${s.draftId}`, {
			method: "PATCH",
			body: { subject: "Propuesta" },
		});
		expect(await saved.json()).toMatchObject({ takenOver: true });
		await expect(
			s.facade.addDraftFile(s.mailboxId, s.draftId, { filename: "a.txt", bytes: pdf }),
		).rejects.toThrow("draft_not_agent_owned");
		// The DO refuses it too, atomically with the write, whatever the facade read.
		const raced = await s.stub.fetch(
			`https://mailbox-do/drafts/${s.draftId}/attachments/from-message`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ messageId: "x", requester: "mcp" }),
			},
		);
		expect(raced.status).toBe(409);
		expect(await raced.json()).toMatchObject({ error: "draft_not_agent_owned" });
		// An upload the DO refuses leaves no object behind in R2.
		const before = (await shared.MAIL_OBJECTS.list()).objects.length;
		const refused = await storeDraftUpload(shared, s.stub, {
			mailboxId: s.mailboxId,
			draftId: s.draftId,
			filename: "late.txt",
			contentType: "text/plain",
			bytes: pdf,
			requester: "mcp",
		});
		expect(refused.status).toBe(409);
		expect((await shared.MAIL_OBJECTS.list()).objects.length).toBe(before);
	});

	it("attaches a message's files only with the read scope that would download them", async () => {
		// Source: the sent copy of an earlier draft that carried a file.
		const source = await setup("mcp-forward-src");
		await source.facade.addDraftFile(source.mailboxId, source.draftId, {
			filename: "contrato.pdf",
			contentType: "application/pdf",
			bytes: pdf,
		});
		const shown = await loadDraft(source);
		const sent = await webSend(source, "src-1", { fingerprint: shown.content_fingerprint });
		expect(sent.body).toMatchObject({ sent: true });
		const messageId = String(sent.body.messageId ?? sent.body.message_id ?? "");
		const sourceMessage = await runInDurableObject(
			source.stub,
			async (_instance, state) =>
				state.storage.sql
					.exec<{ id: string }>("SELECT id FROM messages WHERE direction = 'outbound' LIMIT 1")
					.toArray()[0],
		);
		const sourceId = messageId || sourceMessage!.id;

		// A second agent draft in the same mailbox.
		const { draft_id: draftId } = await source.facade.createDraft(source.mailboxId, {
			to: ["stranger@example.net"],
			subject: "Reenvío",
			bodyText: "Te reenvío el contrato.",
			idempotencyKey: crypto.randomUUID(),
		});
		// A sent copy is never classified: not shown harmless, so the plain read
		// scope may not take its files (the same rule as downloading them).
		await expect(
			source.facade.addDraftAttachmentsFromMessage(source.mailboxId, draftId, sourceId),
		).rejects.toThrow(/insufficient_scope/);
		const sensitive = new McpMailboxFacade(shared, {
			userId: source.owner.userId,
			email: source.email,
			scopes: new Set(["mail:read", "mail:read:sensitive", "mail:draft"]),
		});
		await expect(
			sensitive.addDraftAttachmentsFromMessage(source.mailboxId, draftId, sourceId, ["nope"]),
		).rejects.toThrow("not_found");
		const forwarded = await sensitive.addDraftAttachmentsFromMessage(
			source.mailboxId,
			draftId,
			sourceId,
		);
		expect(forwarded.added.map((a) => [a.filename, a.source])).toEqual([
			["contrato.pdf", "message"],
		]);
		// Same file twice is not added twice.
		const again = await sensitive.addDraftAttachmentsFromMessage(
			source.mailboxId,
			draftId,
			sourceId,
		);
		expect(again.added).toEqual([]);
		expect(again.attachments).toHaveLength(1);

		// Once classified as ordinary mail (what ingest does for inbound messages),
		// the plain read scope is enough.
		await runInDurableObject(source.stub, async (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE messages SET sensitive_classified = 1, sensitive_kind = NULL WHERE id = ?",
				sourceId,
			);
		});
		const { draft_id: third } = await source.facade.createDraft(source.mailboxId, {
			to: ["stranger@example.net"],
			subject: "Otra vez",
			bodyText: "Adjunto.",
			idempotencyKey: crypto.randomUUID(),
		});
		const plain = await source.facade.addDraftAttachmentsFromMessage(
			source.mailboxId,
			third,
			sourceId,
		);
		expect(plain.added.map((a) => a.filename)).toEqual(["contrato.pdf"]);
	});
});
