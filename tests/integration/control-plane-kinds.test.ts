import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleAuthRequest } from "#/api/better-auth";
import { insertMailbox } from "#/db/d1";
import { addSuppression } from "#/do/mailbox-suppressions";
import {
	approveIntent,
	getIntentStatus,
	getIntentView,
	registerControlPlaneKind,
	requestControlPlaneChange,
} from "#/lib/approvals";
import { renderApprovalPage } from "#/components/approval-page";
import { mailboxStub } from "#/lib/mailbox-stub";
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
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import { applyMigrations } from "../helpers/migrations";

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";

beforeAll(async () => {
	await applyMigrations(
		db,
		migrationInitial,
		migrationMessageIndex,
		migrationOwnerColumn,
		migrationTelegram,
		migrationOutbound,
		migrationKeys,
		migrationRequests,
		migrationEvents,
		migrationRuntimeConfig,
		migrationOwnerRegistry,
		migrationResolved,
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
		.prepare("INSERT INTO runtime_config (key, value, updated_at) VALUES ('deployment.origin', ?, ?)")
		.bind(ORIGIN, new Date().toISOString())
		.run();
});

function authEnv(): Env {
	return { ...env, BETTER_AUTH_SECRET: TEST_SECRET } as Env;
}

class Jar {
	private readonly cookies = new Map<string, string>();
	absorb(response: Response): void {
		for (const cookie of response.headers.getSetCookie()) {
			const pair = cookie.split(";")[0] ?? "";
			const eq = pair.indexOf("=");
			if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
		}
	}
	header(): string {
		return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
	}
}

async function pair(email: string): Promise<Jar> {
	const code = crypto.randomUUID().replaceAll("-", "").slice(0, 24);
	const now = new Date().toISOString();
	await db
		.prepare(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
		)
		.bind(code, now, new Date(Date.now() + 60 * 60 * 1000).toISOString())
		.run();
	const jar = new Jar();
	const response = await handleAuthRequest(
		new Request(`${ORIGIN}/api/auth/pairing`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: ORIGIN },
			body: JSON.stringify({ email, code }),
		}),
		authEnv(),
	);
	jar.absorb(response);
	expect(response.status, await response.clone().text()).toBe(200);
	return jar;
}

async function registerOwner(email: string): Promise<{ userId: string; jar: Jar }> {
	const jar = await pair(email);
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(email)
		.first<{ id: string }>();
	return { userId: user?.id ?? "", jar };
}


type Owner = Awaited<ReturnType<typeof registerOwner>>;
const EMAIL = "kinds-owner@example.com";
let owner: Owner;
let auth: { userId: string; email: string; owners: string[] };

beforeAll(async () => {
	owner = await registerOwner(EMAIL);
	auth = { userId: owner.userId, email: EMAIL, owners: [EMAIL] };
});

async function request(kind: string, payload: unknown) {
	return requestControlPlaneChange(env, auth, kind, payload);
}
async function approve(intent: { id: string; payloadHash: string }) {
	return approveIntent(env, {
		id: intent.id,
		payloadHash: intent.payloadHash,
		channel: "web",
		approver: owner.userId,
	});
}
async function applied(kind: string, payload: unknown) {
	const intent = await request(kind, payload);
	const result = await approve(intent);
	expect(result.status, JSON.stringify(result)).toBe("executed");
	return { intent, result };
}
async function view(intent: { id: string }) {
	return getIntentView(env, intent.id, { userId: owner.userId });
}
async function newMailbox(id: string, address: string) {
	await insertMailbox(db, {
		mailbox_id: id,
		primary_address: address,
		display_name: null,
		status: "active",
		owner_email: EMAIL,
	});
}
async function snapshotId(subject: string): Promise<string> {
	const row = await db
		.prepare(
			"SELECT id FROM ops_events WHERE event_type = 'admin.before_snapshot' AND subject = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.bind(subject)
		.first<{ id: string }>();
	return row!.id;
}
const domainRow = (name: string) =>
	db.prepare("SELECT * FROM domains WHERE domain = ?").bind(name).first<{ id: string; status: string }>();

describe("domains", () => {
	it("changes nothing before approval, then registers", async () => {
		const intent = await request("domain_add", { domain: "kinds-a.example", zoneId: "zone1" });
		expect(await domainRow("kinds-a.example")).toBeNull();
		await approve(intent);
		expect((await domainRow("kinds-a.example"))?.status).toBe("active");
	});
	it("refuses invalid payloads and non-owners at creation", async () => {
		await expect(request("domain_add", { domain: "x", zoneId: "z" })).rejects.toMatchObject({
			code: "validation_error",
		});
		await expect(request("domain_add", { domain: "ok.example", zoneId: "z", extra: 1 })).rejects.toBeTruthy();
		await expect(
			requestControlPlaneChange(env, { ...auth, email: "stranger@example.com" }, "domain_add", {
				domain: "ok.example",
				zoneId: "z",
			}),
		).rejects.toBeTruthy();
	});
	it("warns on disabling a domain with active mailboxes, and restores round-trip once", async () => {
		await applied("domain_add", { domain: "kinds-b.example", zoneId: "zone2" });
		await newMailbox("mbx_kinds_b", "hi@kinds-b.example");
		const intent = await request("domain_disable", { domain: "kinds-b.example" });
		const rendered = await view(intent);
		expect(rendered.warnings.some((w) => w.code === "domain_has_active_mailboxes")).toBe(true);
		await approve(intent);
		const disabled = await domainRow("kinds-b.example");
		expect(disabled?.status).toBe("disabled");
		const snap = await snapshotId(disabled!.id);
		await applied("restore", { opsEventId: snap });
		expect((await domainRow("kinds-b.example"))?.status).toBe("active");
		await expect(request("restore", { opsEventId: snap })).rejects.toMatchObject({
			code: "snapshot_consumed",
		});
	});
	it("domain_update snapshots when disabling", async () => {
		await applied("domain_add", { domain: "kinds-c.example", zoneId: "zone3" });
		await applied("domain_update", { domain: "kinds-c.example", body: { status: "disabled" } });
		expect((await domainRow("kinds-c.example"))?.status).toBe("disabled");
	});
});

describe("routing", () => {
	it("adds and removes aliases, restoring the removed one", async () => {
		await applied("domain_add", { domain: "kinds-r.example", zoneId: "zoneR" });
		await newMailbox("mbx_kinds_r", "main@kinds-r.example");
		const payload = { aliasAddress: "sales@kinds-r.example", mailboxId: "mbx_kinds_r" };
		const intent = await request("alias_add", payload);
		expect(await db.prepare("SELECT 1 FROM aliases WHERE alias_address = ?").bind(payload.aliasAddress).first()).toBeNull();
		await approve(intent);
		await expect(request("alias_add", payload)).rejects.toMatchObject({ code: "alias_exists" });
		await applied("alias_remove", { aliasAddress: payload.aliasAddress });
		expect(await db.prepare("SELECT 1 FROM aliases WHERE alias_address = ?").bind(payload.aliasAddress).first()).toBeNull();
		await applied("restore", { opsEventId: await snapshotId(payload.aliasAddress) });
		expect(await db.prepare("SELECT 1 FROM aliases WHERE alias_address = ?").bind(payload.aliasAddress).first()).not.toBeNull();
	});
	it("refuses aliases to another owner's mailbox", async () => {
		await insertMailbox(db, {
			mailbox_id: "mbx_kinds_foreign",
			primary_address: "x@kinds-r.example",
			display_name: null,
			status: "active",
			owner_email: "someone-else@example.com",
		});
		await expect(
			request("alias_add", { aliasAddress: "f@kinds-r.example", mailboxId: "mbx_kinds_foreign" }),
		).rejects.toMatchObject({ code: "forbidden" });
	});
	it("renders a red warning for external forwards and round-trips rule removal", async () => {
		const domain = (await domainRow("kinds-r.example"))!;
		const intent = await request("routing_rule_upsert", {
			domainId: domain.id,
			pattern: "fwd@kinds-r.example",
			priority: 5,
			action: "forward",
			forwardTo: ["ext@elsewhere.test", "own@kinds-r.example"],
		});
		const rendered = await view(intent);
		expect(rendered.warnings.map((w) => w.message)).toContain(
			"Reenvío a una dirección externa: ext@elsewhere.test",
		);
		expect(rendered.warnings).toHaveLength(1);
		expect(await db.prepare("SELECT 1 FROM routing_rules WHERE pattern = 'fwd@kinds-r.example'").first()).toBeNull();
		await approve(intent);
		const rule = await db
			.prepare("SELECT id FROM routing_rules WHERE pattern = 'fwd@kinds-r.example'")
			.first<{ id: string }>();
		expect(rule).not.toBeNull();
		await applied("routing_rule_upsert", { ruleId: rule!.id, priority: 9 });
		await applied("routing_rule_remove", { ruleId: rule!.id });
		expect(await db.prepare("SELECT 1 FROM routing_rules WHERE id = ?").bind(rule!.id).first()).toBeNull();
		await applied("restore", { opsEventId: await snapshotId(rule!.id) });
		expect(
			await db.prepare("SELECT priority FROM routing_rules WHERE id = ?").bind(rule!.id).first(),
		).toEqual({ priority: 9 });
	});
	it("refuses invalid rule payloads", async () => {
		await expect(request("routing_rule_upsert", { pattern: "x" })).rejects.toMatchObject({
			code: "validation_error",
		});
	});
});

describe("templates", () => {
	it("upserts with a diff summary, archives, and refuses non-owners", async () => {
		await newMailbox("mbx_kinds_t", "t@kinds-t.example");
		const base = { mailboxId: "mbx_kinds_t", templateId: "welcome" };
		const tpl = (subject: string, body_text?: string) => ({ ...base, body: { subject, body_text } });
		await applied("template_upsert", tpl("Hola", "uno"));
		const next = await request("template_upsert", tpl("Hola 2", "uno dos"));
		const rendered = await view(next);
		const text = JSON.stringify(rendered.fields);
		expect(text).toContain("Hola → Hola 2");
		expect(text).toContain("- uno");
		expect(text).toContain("+ uno dos");
		await approve(next);
		await applied("template_archive", { mailboxId: "mbx_kinds_t", templateId: "welcome" });
		await expect(
			request("template_archive", { mailboxId: "mbx_kinds_foreign", templateId: "welcome" }),
		).rejects.toMatchObject({ code: "forbidden" });
		await expect(
			request("template_upsert", tpl("bad\nsubject")),
		).rejects.toMatchObject({ code: "validation_error" });
	});
});

describe("approval page fidelity", () => {
	it("template approval shows body, escaped HTML, links and external-link warnings", async () => {
		await newMailbox("mbx_kinds_f", "f@kinds-f.example");
		await applied("domain_add", { domain: "kinds-f.example", zoneId: "zf" });
		const base = { mailboxId: "mbx_kinds_f", templateId: "promo" };
		await applied("template_upsert", { ...base, body: { subject: "Hi", body_text: "old line\nkeep" } });
		const intent = await request("template_upsert", {
			...base,
			body: {
				subject: "Hi 2",
				body_text: "Pay now at https://evil.example/pay.\nkeep",
				body_html: '<p onclick="x()">Go <a href="https://kinds-f.example/ok">ok</a> <a href="https://phish.example/x?a=1&b=2">pay</a></p><script>alert(1)</script>',
			},
		});
		const v = await view(intent);
		const html = renderApprovalPage({ ...v, fields: v.fields, warnings: v.warnings });
		expect(html).toContain("Pay now at https://evil.example/pay.");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>");
		expect(html).toContain("evil.example — https://evil.example/pay");
		expect(html).toContain("phish.example — https://phish.example/x?a=1&amp;b=2");
		expect(html).toContain("kinds-f.example — https://kinds-f.example/ok");
		expect(html).toContain("<pre");
		expect(html).toContain("- old line");
		expect(html).toContain("+ Pay now at");
		const warnings = v.warnings.map((w) => w.message).join("|");
		expect(warnings).toContain("evil.example");
		expect(warnings).toContain("phish.example");
		expect(warnings).not.toContain("dominio que no es uno de tus dominios de envío: kinds-f.example");
	});
	it("api key and domain provision pages show every approved field", async () => {
		await newMailbox("mbx_kinds_g", "g@kinds-g.example");
		const intent = await request("api_key_create", {
			mailboxId: "mbx_kinds_g",
			body: {
				environment: "live",
				sender: "g@kinds-g.example",
				senderName: "Gee Co",
				scopes: ["transactional:send", "transactional:templates:use"],
				templateAllowlist: ["welcome", "reset"],
				recipientPolicy: "*@*",
			},
		});
		const v = await view(intent);
		const page = renderApprovalPage(v);
		for (const expected of ["Gee Co", "*@*", "welcome, reset", "transactional:send"])
			expect(page).toContain(expected);
		expect(v.warnings.map((w) => w.code)).toContain("permissive_recipient_policy");
		const prov = await request("domain_provision", {
			domain: "kinds-g.example",
			body: {
				dmarc: { policy: "quarantine", alignment: "strict", rua: "reports@collector.example" },
				mailbox: { address: "g@kinds-g.example", displayName: "Gee", ownerEmail: EMAIL },
			},
		});
		const pv = await view(prov);
		const ppage = renderApprovalPage(pv);
		for (const expected of ["strict", "reports@collector.example", "Gee", EMAIL])
			expect(ppage).toContain(expected);
		expect(pv.warnings.map((w) => w.code)).toContain("dmarc_external_rua");
		expect(pv.fields.some((f) => f.label.startsWith("campo:"))).toBe(false);
	});
	it("safety net appends payload keys a kind did not render", async () => {
		registerControlPlaneKind("synthetic_hidden", {
			covers: ["shown"],
			validate: (value) => value as Record<string, unknown>,
			render: async () => ({
				title: "Sintético",
				fields: [{ label: "Visto", value: "x" }],
				warnings: [],
			}),
			execute: async () => ({}),
		});
		const intent = await request("synthetic_hidden", {
			shown: 1,
			hidden: "secret-target@evil.example",
			nested: { deep: [1, 2], other: true },
		});
		const v = await view(intent);
		const rows = Object.fromEntries(v.fields.map((f) => [f.label, f.value]));
		expect(rows["campo: hidden"]).toBe("secret-target@evil.example");
		expect(rows["campo: nested.deep"]).toBe("[1,2]");
		expect(rows["campo: nested.other"]).toBe("true");
		expect(rows["campo: shown"]).toBeUndefined();
		expect(renderApprovalPage(v)).toContain("campo: hidden");
	});
});

describe("api keys", () => {
	it("reveals the secret once, only in the approve response", async () => {
		await newMailbox("mbx_kinds_k", "k@kinds-k.example");
		const intent = await request("api_key_create", {
			mailboxId: "mbx_kinds_k",
			body: {
				environment: "test",
				sender: "k@kinds-k.example",
				scopes: ["transactional:status"],
			},
		});
		const result = await approve(intent);
		expect(result.status).toBe("executed");
		const secret = result.reveal?.[0]?.value ?? "";
		expect(secret).toMatch(/^rck_test_/);
		expect(JSON.stringify(result.result)).not.toContain(secret);
		expect(JSON.stringify(await getIntentStatus(env, intent.id))).not.toContain(secret);
		const stored = await db.prepare("SELECT * FROM approvals WHERE token = ?").bind(intent.id).first();
		expect(JSON.stringify(stored)).not.toContain(secret);
		const events = await db.prepare("SELECT * FROM ops_events").all();
		expect(JSON.stringify(events.results)).not.toContain(secret);
		const again = await approve(intent);
		expect(again.reveal).toBeUndefined();
		expect(JSON.stringify(again)).not.toContain(secret);
	});
	it("rotates, changes scopes and revokes", async () => {
		const list = async () =>
			(
				(await (await mailboxStub(env, "mbx_kinds_k").fetch("https://mailbox-do/transactional/api-keys")).json()) as {
					keys: Array<{ keyId: string; status: string; scopes: string[] }>;
				}
			).keys;
		const first = (await list()).find((k) => k.status === "active")!;
		const rotated = await applied("api_key_rotate", { mailboxId: "mbx_kinds_k", keyId: first.keyId });
		expect(rotated.result.reveal?.[0]?.value).toMatch(/^rck_test_/);
		const second = (await list()).find((k) => k.status === "active")!;
		expect(second.keyId).not.toBe(first.keyId);
		const scoped = await applied("api_key_scopes", {
			mailboxId: "mbx_kinds_k",
			keyId: second.keyId,
			scopes: ["transactional:status"],
		});
		expect(scoped.result.reveal).toHaveLength(1);
		const third = (await list()).find((k) => k.status === "active")!;
		expect(third.keyId).not.toBe(second.keyId);
		const revoked = await applied("api_key_revoke", { mailboxId: "mbx_kinds_k", keyId: third.keyId });
		expect(revoked.result.reveal).toBeUndefined();
		expect((await list()).filter((k) => k.status === "active")).toHaveLength(0);
	});
	it("refuses invalid payloads and foreign mailboxes", async () => {
		await expect(
			request("api_key_create", { mailboxId: "mbx_kinds_k", body: { environment: "test" } }),
		).rejects.toBeTruthy();
		await expect(
			request("api_key_revoke", { mailboxId: "mbx_kinds_foreign", keyId: "k" }),
		).rejects.toMatchObject({ code: "forbidden" });
	});
});

describe("suppressions and reconcile", () => {
	it("removes a suppression only after approval, with a warning", async () => {
		await newMailbox("mbx_kinds_s", "s@kinds-s.example");
		await runInDurableObject(mailboxStub(env, "mbx_kinds_s"), async (_i, state) => {
			addSuppression(state.storage.sql, "bounced@example.net", "manual", null, null);
		});
		const intent = await request("suppression_remove", {
			mailboxId: "mbx_kinds_s",
			body: { email: "bounced@example.net" },
		});
		const rendered = await view(intent);
		expect(rendered.warnings[0]?.message).toContain("rebotó o se quejó");
		const count = async () =>
			(
				(await (await mailboxStub(env, "mbx_kinds_s").fetch("https://mailbox-do/transactional/suppressions")).json()) as {
					suppressions: unknown[];
				}
			).suppressions.length;
		expect(await count()).toBe(1);
		await approve(intent);
		expect(await count()).toBe(0);
		await expect(
			request("suppression_remove", { mailboxId: "mbx_kinds_s", body: { email: "bounced@example.net" } }),
		).rejects.toMatchObject({ code: "suppression_not_found" });
		await expect(
			request("suppression_remove", { mailboxId: "mbx_kinds_s", body: { email: "not-an-email" } }),
		).rejects.toBeTruthy();
	});
	it("reconcile lists stale requests and never sends", async () => {
		const old = new Date(Date.now() - 2 * 3600_000).toISOString();
		await db
			.prepare(
				"INSERT INTO transactional_request_log (request_id, key_id, mailbox_id, status, to_addr, template_id, sender, provider_message_id, error_code, created_at, updated_at) VALUES ('r1','k1','mbx_kinds_s','pending','a@b.test','t','s@kinds-s.example',NULL,NULL,?,?)",
			)
			.bind(old, old)
			.run();
		const intent = await request("transactional_reconcile", { mailboxId: "mbx_kinds_s" });
		const rendered = await view(intent);
		expect(JSON.stringify(rendered.fields)).toContain('"1"');
		expect(rendered.warnings[0]?.message).toContain("No se reenvía");
		const before = await db.prepare("SELECT COUNT(*) AS n FROM outbound_sends").first<{ n: number }>();
		await approve(intent);
		expect((await getIntentStatus(env, intent.id)).status).toBe("executed");
		expect((await db.prepare("SELECT COUNT(*) AS n FROM outbound_sends").first<{ n: number }>())?.n).toBe(
			before?.n,
		);
		await expect(
			request("transactional_reconcile", { mailboxId: "mbx_kinds_foreign" }),
		).rejects.toMatchObject({ code: "forbidden" });
	});
	it("restore refuses another owner's snapshot", async () => {
		await newMailbox("mbx_kinds_x", "x@kinds-x.example");
		await applied("mailbox_disable", { mailboxId: "mbx_kinds_x" });
		const snap = await snapshotId("mbx_kinds_x");
		await db.prepare("UPDATE mailboxes SET owner_email = 'someone-else@example.com' WHERE mailbox_id = 'mbx_kinds_x'").run();
		await expect(request("restore", { opsEventId: snap })).rejects.toMatchObject({ code: "forbidden" });
		await db.prepare("UPDATE mailboxes SET owner_email = ? WHERE mailbox_id = 'mbx_kinds_x'").bind(EMAIL).run();
		await applied("restore", { opsEventId: snap });
		expect((await db.prepare("SELECT status FROM mailboxes WHERE mailbox_id = 'mbx_kinds_x'").first())).toEqual({ status: "active" });
	});
});
