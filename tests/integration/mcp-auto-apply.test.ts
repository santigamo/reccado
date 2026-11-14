import { env } from "cloudflare:workers";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { insertMailbox } from "#/db/d1";
import { requestControlPlaneChange } from "#/lib/control-plane-intents";
import { upsertClientPolicy } from "#/lib/mcp-client-policy";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationKeys from "../../migrations/d1/0006_transactional_api_keys.sql?raw";
import migrationRequests from "../../migrations/d1/0007_transactional_requests.sql?raw";
import migrationEvents from "../../migrations/d1/0008_email_events_suppressions.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationResolved from "../../migrations/d1/0015_transactional_resolved_via.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationPasskey from "../../migrations/d1/0024_passkey.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import migrationPolicies from "../../migrations/d1/0029_mcp_client_policies.sql?raw";
import { makeIntentCodec } from "../../src/mcp/intent-flow";
import { registerTools } from "../../src/mcp/tools";
import * as autoApplied from "../../src/telegram/auto-applied";
import { applyMigrations } from "../helpers/migrations";

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const SECRET = "test-secret-0123456789-0123456789-0123";
const EMAIL = "delegate-owner@example.com";
const CLIENT = "delegated-client-1";
const MBX = "mbx_auto_a";
const MBX_OTHER = "mbx_auto_b";

let userId = "";
beforeAll(async () => {
	await applyMigrations(
		db, migrationInitial, migrationMessageIndex, migrationOwnerColumn, migrationTelegram, migrationOutbound, migrationKeys,
		migrationRequests, migrationEvents, migrationResolved, migrationRuntimeConfig, migrationOwnerRegistry, migrationBetterAuth,
		migrationBetterAuthMcp, migrationTwoFactor, migrationAuthUpgrade, migrationApprovals, migrationPasskey, migrationAudit,
		migrationApprovalMeta, migrationIntentPayload, migrationPendingUnique, migrationPolicies,
	);
	const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
	const now = new Date().toISOString();
	await db.prepare("INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')")
		.bind(code, now, new Date(Date.now() + 3_600_000).toISOString()).run();
	const response = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/pairing`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ email: EMAIL, code }) }),
		{ ...env, BETTER_AUTH_SECRET: SECRET } as Env,
	);
	expect(response.status, await response.clone().text()).toBe(200);
	userId = (await db.prepare('SELECT id FROM "user" WHERE email = ?').bind(EMAIL).first<{ id: string }>())!.id;
	for (const id of [MBX, MBX_OTHER])
		await insertMailbox(db, { mailbox_id: id, primary_address: `${id}@auto.example`, display_name: null, status: "active", owner_email: EMAIL });
});

afterEach(async () => {
	// Pending intents count against the per-subject cap; every test starts from none.
	await db.prepare("DELETE FROM approvals WHERE decision IS NULL").run();
});

const DELEGATED = ["admin", "mail:draft"];
const principal = (scopes: string[] = DELEGATED, client = CLIENT) => ({ oauthClientId: client, tokenSub: userId, tokenJti: "j", scopes: new Set(scopes) });
const auth = () => ({ userId, email: EMAIL, owners: [EMAIL] });
const tpl = (templateId: string, html: string, subject = "Hola", mailboxId = MBX) => ({ mailboxId, templateId, body: { subject, body_html: html, body_text: "texto" } });
const setPolicy = (over: Partial<Parameters<typeof upsertClientPolicy>[2]> = {}, client = CLIENT) =>
	upsertClientPolicy(db, EMAIL, { clientId: client, mailboxIds: [MBX], autoKinds: ["template_upsert", "template_archive", "restore"], linkDomains: ["transcribo.app"], ...over });
const approvalRow = (id: string) => db.prepare("SELECT * FROM approvals WHERE token = ?").bind(id).first<Record<string, unknown>>();
const pendingCount = async () => (await db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE decision IS NULL AND consumed_at IS NULL").first<{ n: number }>())!.n;
const autoEvents = async (client = CLIENT) => (await db.prepare("SELECT payload_json FROM ops_events WHERE event_type = 'admin.auto_applied' AND subject = ?").bind(client).all<{ payload_json: string }>()).results.map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
const templateSubject = async (mailboxId: string, templateId: string) => {
	const { listTemplates } = await import("#/lib/admin/templates");
	const result = await listTemplates(env, auth(), { mailboxId });
	return ((result.value as { templates: Array<{ id: string; subject: string }> }).templates).find((t) => t.id === templateId)?.subject;
};

describe("delegated auto-apply", () => {
	it("applies a template upsert without approval, snapshots, audits, and notifies", async () => {
		await setPolicy();
		await requestControlPlaneChange(env, auth(), "template_upsert", tpl("welcome", '<a href="https://transcribo.app/x">x</a>'), principal());
		const before = await pendingCount();
		const result = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("welcome", '<a href="https://app.transcribo.app/y">y</a>', "Hola 2"), principal());
		expect(result.applied?.items).toEqual([expect.objectContaining({ status: "executed" })]);
		expect(await pendingCount()).toBe(before);
		expect(await approvalRow(result.id)).toMatchObject({ approved_via: "auto", decision: "approved", oauth_client_id: CLIENT });
		expect(await templateSubject(MBX, "welcome")).toBe("Hola 2");
		const events = await autoEvents();
		expect(events.at(-1)).toMatchObject({ client_id: CLIENT, kind: "template_upsert", mailbox: MBX, intent_id: result.id });
		expect((events.at(-1)!.snapshot_ids as string[]).length).toBe(1);
		const snap = await db.prepare("SELECT 1 AS x FROM ops_events WHERE id = ? AND event_type = 'admin.before_snapshot'").bind((events.at(-1)!.snapshot_ids as string[])[0]).first();
		expect(snap).not.toBeNull();
	});

	it("returns status applied from the tool and queues the Telegram notice", async () => {
		await setPolicy();
		const notify = vi.spyOn(autoApplied, "notifyAutoApplied").mockResolvedValue(undefined);
		try {
			const codec = await makeIntentCodec(SECRET, userId);
			const server = new McpServer({ name: "t", version: "1" }, { requestState: { verify: codec.verify } });
			registerTools(server, env as Env, { ...auth(), scopes: new Set(DELEGATED), oauthClientId: CLIENT, tokenSub: userId, tokenJti: "j" } as never, ORIGIN, { era: "legacy", codec });
			const handler = (server as unknown as { _registeredTools: Record<string, { handler: (a: object, c: ServerContext) => Promise<{ structuredContent: Record<string, unknown> }> }> })._registeredTools.manage_template!.handler;
			const ctx = { mcpReq: { requestState: () => undefined } } as unknown as ServerContext;
			const out = (await handler({ action: "upsert", ...tpl("tool-tpl", "<p>hola</p>") }, ctx)).structuredContent;
			expect(out).toMatchObject({ status: "applied", intentId: expect.any(String), result: { items: [{ status: "executed" }] } });
			expect(JSON.stringify(out)).not.toMatch(/secret|plaintext/i);
			expect(notify).toHaveBeenCalledTimes(1);
			expect(notify.mock.calls[0]![1]).toMatchObject({ kind: "template_upsert", intentId: out.intentId });
			const pending = (await handler({ action: "upsert", ...tpl("tool-tpl", '<a href="https://evil.example">x</a>') }, ctx)).structuredContent;
			expect(pending).toMatchObject({ status: "pending", approvalUrl: expect.stringContaining("/approve/"), autoApplyRefused: expect.stringMatching(/evil\.example/) });
		} finally {
			notify.mockRestore();
		}
	});

	it("keeps the approval flow for a token that can read mail, and for clients without a policy", async () => {
		await setPolicy();
		for (const scopes of [["admin", "mail:read"], ["admin", "mail:read:sensitive"], ["mail:draft"]]) {
			const r = await requestControlPlaneChange(env, auth(), "template_upsert", tpl(`mr-${scopes.length}-${scopes[1] === "mail:read" ? "a" : scopes[1] === "mail:read:sensitive" ? "b" : "c"}`, "<p>x</p>"), principal(scopes));
			expect(r.applied).toBeUndefined();
			expect(r.autoApplyRefused).toBeUndefined();
			expect(await approvalRow(r.id)).toMatchObject({ decision: null, approved_via: null });
		}
		const none = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("no-policy", "<p>x</p>"), principal(DELEGATED, "client-without-policy"));
		expect(none.applied).toBeUndefined();
		expect(await templateSubject(MBX, "no-policy")).toBeUndefined();
	});

	it("falls back to pending with a reason for a kind or mailbox outside the policy", async () => {
		await setPolicy({ autoKinds: ["template_upsert"] });
		const kind = await requestControlPlaneChange(env, auth(), "template_archive", { mailboxId: MBX, templateId: "welcome" }, principal());
		expect(kind).toMatchObject({ autoApplyRefused: expect.stringMatching(/template_archive.*not in/) });
		const mailbox = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("other-mbx", "<p>x</p>", "S", MBX_OTHER), principal());
		expect(mailbox).toMatchObject({ autoApplyRefused: expect.stringContaining(MBX_OTHER) });
		expect(await templateSubject(MBX_OTHER, "other-mbx")).toBeUndefined();
		expect(await approvalRow(mailbox.id)).toMatchObject({ decision: null, auto_refused: expect.stringContaining(MBX_OTHER) });
	});

	it("never auto-applies kinds above the ceiling, even for a delegated client with a policy", async () => {
		await setPolicy();
		const r = await requestControlPlaneChange(env, auth(), "mailbox_disable", { mailboxId: MBX }, principal());
		expect(r.applied).toBeUndefined();
		expect(r.autoApplyRefused).toMatch(/never auto-applied/);
		expect((await db.prepare("SELECT status FROM mailboxes WHERE mailbox_id = ?").bind(MBX).first<{ status: string }>())!.status).toBe("active");
	});

	it("refuses external links, javascript: and variable links without the opt-in", async () => {
		await setPolicy();
		for (const html of ['<a href="https://evil.example/x">x</a>', '<a href="javascript:alert(1)">x</a>', '<a href="{{url}}">x</a>']) {
			const r = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("links", html), principal());
			expect(r.applied, html).toBeUndefined();
			expect(r.autoApplyRefused, html).toBeTruthy();
		}
	});

	it("allows href=\"{{url}}\" with the opt-in and says so in the notice", async () => {
		await setPolicy({ allowVariableLinks: true });
		const r = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("variable", '<a href="{{url}}">Abrir</a>'), principal());
		expect(r.applied?.variableLinks).toEqual(["{{url}}"]);
		const notice = autoApplied.renderAutoAppliedNotice({ kind: "template_upsert", clientId: CLIENT, applied: r.applied! });
		expect(notice).toContain("Enlaces variables");
		expect(notice).toContain("url");
		expect(notice).toContain(`${MBX}/variable`);
	});

	it("enforces the hourly limit and falls back to pending", async () => {
		const client = "limited-client";
		await setPolicy({ maxAutoPerHour: 2 }, client);
		const p = principal(DELEGATED, client);
		for (const n of [1, 2]) expect((await requestControlPlaneChange(env, auth(), "template_upsert", tpl(`lim-${n}`, "<p>x</p>"), p)).applied).toBeDefined();
		const third = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("lim-3", "<p>x</p>"), p);
		expect(third.applied).toBeUndefined();
		expect(third.autoApplyRefused).toMatch(/hourly/);
		expect(await templateSubject(MBX, "lim-3")).toBeUndefined();
		// A batch counts each item.
		const client2 = "limited-client-2";
		await setPolicy({ maxAutoPerHour: 2 }, client2);
		const batch = await requestControlPlaneChange(env, auth(), "template_upsert", [1, 2, 3].map((n) => tpl(`lb-${n}`, "<p>x</p>")), principal(DELEGATED, client2));
		expect(batch.autoApplyRefused).toMatch(/hourly/);
	});

	it("sends a whole batch to approval when one item is not eligible", async () => {
		await setPolicy();
		const r = await requestControlPlaneChange(env, auth(), "template_upsert", [tpl("batch-ok", "<p>x</p>"), tpl("batch-bad", "<p>x</p>", "S", MBX_OTHER)], principal());
		expect(r.applied).toBeUndefined();
		expect(r.autoApplyRefused).toContain(MBX_OTHER);
		expect(await templateSubject(MBX, "batch-ok")).toBeUndefined();
		const ok = await requestControlPlaneChange(env, auth(), "template_upsert", [tpl("batch-1", "<p>x</p>"), tpl("batch-2", "<p>x</p>")], principal());
		expect(ok.applied?.items.map((i) => i.status)).toEqual(["executed", "executed"]);
	});

	it("restore is auto only for template snapshots on allowed mailboxes", async () => {
		await setPolicy();
		await requestControlPlaneChange(env, auth(), "template_upsert", tpl("rs", "<p>one</p>", "Uno"), principal());
		const second = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("rs", "<p>two</p>", "Dos"), principal());
		const snap = second.applied!.snapshotIds[0]![0]!;
		const restored = await requestControlPlaneChange(env, auth(), "restore", { opsEventId: snap }, principal());
		expect(restored.applied?.items[0]).toMatchObject({ status: "executed" });
		expect(await templateSubject(MBX, "rs")).toBe("Uno");
		// A mailbox snapshot is not something this policy could have produced.
		const mailboxSnap = crypto.randomUUID();
		await db.prepare("INSERT INTO ops_events (id, event_type, severity, subject, payload_json, created_at) VALUES (?, 'admin.before_snapshot', 'info', ?, ?, ?)")
			.bind(mailboxSnap, MBX, JSON.stringify({ entity: "mailbox", by: EMAIL, mailbox_id: MBX }), new Date().toISOString()).run();
		const refused = await requestControlPlaneChange(env, auth(), "restore", { opsEventId: mailboxSnap }, principal());
		expect(refused.autoApplyRefused).toMatch(/snapshot/);
	});

	it("undo restores the before-snapshot, once", async () => {
		await setPolicy();
		await requestControlPlaneChange(env, auth(), "template_upsert", tpl("undoable", "<p>a</p>", "Antes"), principal());
		const change = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("undoable", "<p>b</p>", "Despues"), principal());
		expect(await templateSubject(MBX, "undoable")).toBe("Despues");
		expect(await autoApplied.undoAutoApplied(env, change.id)).toBe(1);
		expect(await templateSubject(MBX, "undoable")).toBe("Antes");
		expect(await autoApplied.undoAutoApplied(env, change.id)).toBe(0);
		// A human-approved or unknown intent cannot be undone through this path.
		const pending = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("undoable", "<p>c</p>", "Pend"), principal(["admin", "mail:read"]));
		await expect(autoApplied.undoAutoApplied(env, pending.id)).rejects.toThrow("not_found");
	});

	it("a policy for another owner never applies", async () => {
		await setPolicy({}, "foreign-client");
		await db.prepare("UPDATE mcp_client_policies SET owner_email = 'someone@else.test' WHERE client_id = 'foreign-client'").run();
		const r = await requestControlPlaneChange(env, auth(), "template_upsert", tpl("foreign", "<p>x</p>"), principal(DELEGATED, "foreign-client"));
		expect(r.applied).toBeUndefined();
		expect(r.autoApplyRefused).toMatch(/another owner/);
	});
});
