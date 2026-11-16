import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { insertMailbox } from "#/db/d1";
import { createIntent, denyIntent, requestControlPlaneChange } from "#/lib/approvals";
import { listApprovals } from "#/lib/approvals-list";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationOwnerColumn from "../../migrations/d1/0003_mailbox_owner.sql?raw";
import migrationTelegram from "../../migrations/d1/0004_telegram.sql?raw";
import migrationOutbound from "../../migrations/d1/0005_outbound_status_approval.sql?raw";
import migrationRuntimeConfig from "../../migrations/d1/0009_runtime_config.sql?raw";
import migrationOwnerRegistry from "../../migrations/d1/0012_owner_registry.sql?raw";
import migrationBetterAuth from "../../migrations/d1/0016_better_auth.sql?raw";
import migrationBetterAuthMcp from "../../migrations/d1/0017_better_auth_mcp.sql?raw";
import migrationBetterAuthMcpFkFix from "../../migrations/d1/0018_better_auth_mcp_fk_fix.sql?raw";
import migrationTwoFactor from "../../migrations/d1/0019_two_factor.sql?raw";
import migrationAuthUpgrade from "../../migrations/d1/0021_better_auth_1_7_20.sql?raw";
import migrationApprovals from "../../migrations/d1/0022_approvals.sql?raw";
import migrationAudit from "../../migrations/d1/0025_outbound_audit.sql?raw";
import migrationApprovalMeta from "../../migrations/d1/0026_approval_metadata.sql?raw";
import migrationIntentPayload from "../../migrations/d1/0027_intent_payload.sql?raw";
import migrationPendingUnique from "../../migrations/d1/0028_approval_pending_unique.sql?raw";
import worker from "../../src/server";
import { applyMigrations } from "../helpers/migrations";

/**
 * GET /api/approvals: the inbox's approvals queue. Owner web session only;
 * read-only; shows nothing the single-item view does not.
 */

const db = env.INDEX_DB;
const ORIGIN = "https://example.com";
const TEST_SECRET = "test-secret-0123456789-0123456789-0123";
const OWNER = "queue-owner@example.com";

const authEnv = () =>
	({ ...env, BETTER_AUTH_SECRET: TEST_SECRET, OWNER_BOOTSTRAP_EMAILS: OWNER }) as Env;

async function run(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, authEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

function cookiesOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0])
		.join("; ");
}

async function postJson(path: string, body: unknown, cookie?: string): Promise<Response> {
	return run(
		new Request(`${ORIGIN}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: ORIGIN,
				...(cookie ? { cookie } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
}

let ownerCookie = "";
let ownerId = "";

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
		migrationBetterAuthMcpFkFix,
		migrationTwoFactor,
		migrationAuthUpgrade,
		migrationApprovals,
		migrationAudit,
		migrationApprovalMeta,
		migrationIntentPayload,
		migrationPendingUnique,
	);
	const code = "QUEUEPAIRING0001";
	await db
		.prepare(
			"INSERT INTO owner_pairing_codes (code, created_at, expires_at, issued_by) VALUES (?, ?, ?, 'manual')",
		)
		.bind(code, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
		.run();
	const paired = await postJson("/api/auth/pairing", { email: OWNER, code });
	expect(paired.status, await paired.clone().text()).toBe(200);
	ownerCookie = cookiesOf(paired);
	const user = await db
		.prepare('SELECT id FROM "user" WHERE email = ?')
		.bind(OWNER)
		.first<{ id: string }>();
	ownerId = user?.id ?? "";
	expect(ownerId).not.toBe("");
});

async function agentDraft(mailboxId: string, draft: Record<string, unknown>) {
	const stub = env.MAILBOX_DO.getByName(mailboxId);
	const created = await stub.fetch("https://mailbox-do/drafts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...draft, origin: "mcp" }),
	});
	const { id } = (await created.json()) as { id: string };
	const armed = await stub.fetch(`https://mailbox-do/drafts/${id}/request-send`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mailboxAddress: `${mailboxId}@imsanti.dev`, displayName: "Owner" }),
	});
	const { payload_hash } = (await armed.json()) as { payload_hash: string };
	return { draftId: id, payloadHash: payload_hash };
}

async function mailbox(): Promise<string> {
	const mailboxId = `mbx_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
	await insertMailbox(db, {
		mailbox_id: mailboxId,
		primary_address: `${mailboxId}@imsanti.dev`,
		display_name: "Owner",
		status: "active",
		owner_email: OWNER,
	});
	return mailboxId;
}

async function sendIntent(
	mailboxId: string,
	draft: Record<string, unknown>,
	tokenSub: string | null,
) {
	const { draftId, payloadHash } = await agentDraft(mailboxId, draft);
	const intent = await createIntent(env, {
		kind: "send",
		origin: "mcp",
		mailboxId,
		draftId,
		payloadHash,
		oauthClientId: "client-claude",
		tokenSub,
		tokenJti: "jti",
	});
	return { ...intent, draftId };
}

describe("GET /api/approvals", () => {
	it("refuses a request with no session", async () => {
		const response = await run(new Request(`${ORIGIN}/api/approvals`));
		expect(response.status).toBe(401);
	});

	it("refuses an MCP OAuth access token: the queue is reachable only with the owner web session", async () => {
		const register = await postJson(
			"/api/auth/oauth2/register",
			{
				redirect_uris: ["https://client.example/cb"],
				token_endpoint_auth_method: "client_secret_basic",
				client_name: "queue-test",
			},
			ownerCookie,
		);
		expect(register.status, await register.clone().text()).toBe(201);
		const client = (await register.json()) as { client_id: string; client_secret: string };

		const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const authorize = new URL(`${ORIGIN}/api/auth/oauth2/authorize`);
		authorize.searchParams.set("response_type", "code");
		authorize.searchParams.set("client_id", client.client_id);
		authorize.searchParams.set("redirect_uri", "https://client.example/cb");
		authorize.searchParams.set("scope", "mail:read mail:send config:read");
		authorize.searchParams.set("code_challenge", challenge);
		authorize.searchParams.set("code_challenge_method", "S256");
		authorize.searchParams.set("resource", `${ORIGIN}/mcp`);
		const redirected = await run(
			new Request(authorize, { headers: { cookie: ownerCookie }, redirect: "manual" }),
		);
		expect(redirected.status).toBe(302);
		const oauthQuery = (redirected.headers.get("location") ?? "").split("?")[1] ?? "";
		const consent = await postJson(
			"/api/auth/oauth2/consent",
			{ accept: true, oauth_query: oauthQuery },
			ownerCookie,
		);
		expect(consent.status).toBe(200);
		const consentBody = (await consent.json()) as { redirect_uri?: string; url?: string };
		const code = new URL(consentBody.redirect_uri ?? consentBody.url ?? "").searchParams.get(
			"code",
		);
		const token = await run(
			new Request(`${ORIGIN}/api/auth/oauth2/token`, {
				method: "POST",
				headers: {
					authorization: `Basic ${btoa(`${client.client_id}:${client.client_secret}`)}`,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code: code ?? "",
					redirect_uri: "https://client.example/cb",
					code_verifier: verifier,
				}),
			}),
		);
		expect(token.status).toBe(200);
		const { access_token } = (await token.json()) as { access_token: string };
		expect(access_token).toBeTruthy();

		const response = await run(
			new Request(`${ORIGIN}/api/approvals`, {
				headers: { authorization: `Bearer ${access_token}` },
			}),
		);
		expect(response.status).toBe(401);
		expect(await response.text()).not.toContain('pending":[');
	});

	it("lists pending (oldest first, all kinds, not expired) and decided, with the frozen send", async () => {
		const box = await mailbox();
		const reply = await sendIntent(
			box,
			{
				to: ["rico@lumenlabs.io"],
				subject: "Re: Quick UX review",
				bodyText: "Hi Rico,\n\nHappy to take a look.",
				threadId: "thread-rico",
			},
			ownerId,
		);
		const fresh = await sendIntent(
			box,
			{ to: ["helena@brandt.de"], subject: "Invoice overdue", bodyText: "Hi Helena" },
			null,
		);
		const key = await requestControlPlaneChange(
			env,
			{ userId: ownerId, email: OWNER, owners: [OWNER] },
			"api_key_create",
			{
				mailboxId: box,
				body: {
					environment: "live",
					sender: `${box}@imsanti.dev`,
					scopes: ["transactional:status"],
				},
			},
		);
		const expired = await sendIntent(
			box,
			{ to: ["old@example.net"], subject: "Old", bodyText: "x" },
			ownerId,
		);
		await db
			.prepare("UPDATE approvals SET expires_at = ? WHERE token = ?")
			.bind(new Date(Date.now() - 1000).toISOString(), expired.id)
			.run();
		const foreign = await sendIntent(
			box,
			{ to: ["x@example.net"], subject: "Another owner's", bodyText: "x" },
			"someone-else",
		);
		const denied = await sendIntent(
			box,
			{ to: ["marta@acme.io"], subject: "Denied", bodyText: "no" },
			ownerId,
		);
		await denyIntent(env, denied.id);
		// Telegram rows share the table but are not agent requests.
		await db
			.prepare(
				"INSERT INTO approvals (token, kind, mailbox_id, draft_id, created_at, expires_at, origin) VALUES ('tg-row', 'confirm_send', ?, 'd', ?, ?, 'telegram')",
			)
			.bind(box, new Date().toISOString(), new Date(Date.now() + 600_000).toISOString())
			.run();
		// Make the order deterministic: reply oldest, then fresh, then the key.
		const base = Date.now() - 120_000;
		for (const [i, id] of [reply.id, fresh.id, key.id].entries()) {
			await db
				.prepare("UPDATE approvals SET created_at = ? WHERE token = ?")
				.bind(new Date(base + i * 1000).toISOString(), id)
				.run();
		}

		const response = await run(
			new Request(`${ORIGIN}/api/approvals`, { headers: { cookie: ownerCookie } }),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const body = (await response.json()) as Awaited<ReturnType<typeof listApprovals>>;
		const ids = body.pending.map((item) => item.id);
		expect(ids).toEqual([reply.id, fresh.id, key.id]);
		expect(ids).not.toContain(expired.id);
		expect(ids).not.toContain(foreign.id);
		expect(ids).not.toContain("tg-row");

		const [first, second, third] = body.pending;
		expect(first).toMatchObject({
			kind: "send",
			status: "pending",
			decidedAt: null,
			revealsSecret: false,
			approveUrl: `/approve/${encodeURIComponent(reply.id)}`,
			payloadHash: reply.payloadHash,
			send: {
				mailboxId: box,
				draftId: reply.draftId,
				threadId: "thread-rico",
				to: ["rico@lumenlabs.io"],
				subject: "Re: Quick UX review",
				text: "Hi Rico,\n\nHappy to take a look.",
				snippet: "Hi Rico, Happy to take a look.",
			},
		});
		expect(
			first?.warnings.some(
				(w) => w.code === "external_recipient" && w.address === "rico@lumenlabs.io",
			),
		).toBe(true);
		expect(second?.send?.threadId).toBeNull();
		expect(third).toMatchObject({
			kind: "api_key_create",
			status: "pending",
			revealsSecret: true,
			send: null,
		});
		expect(third?.fields.length).toBeGreaterThan(0);
		expect(third?.payloadHash).toMatch(/^[a-f0-9]{64}$/);

		expect(body.decided.map((item) => item.id)).toEqual([denied.id]);
		expect(body.decided[0]).toMatchObject({
			status: "denied",
			payloadHash: null,
			fields: [],
			send: { subject: "Denied", text: null },
		});
		expect(body.decided[0]?.decidedAt).toBeTruthy();
		// Nothing the agent could use to approve, and no OAuth internals.
		expect(JSON.stringify(body)).not.toContain("client-claude");
		expect(JSON.stringify(body)).not.toContain('"jti"');
	});

	it("reads each pending send's frozen snapshot once, and carries its HTML body", async () => {
		const box = await mailbox();
		const intent = await sendIntent(
			box,
			{
				to: ["a@example.net"],
				subject: "Rich",
				bodyText: "Hello in bold",
				bodyHtml: "<p>Hello <strong>in bold</strong></p>",
			},
			ownerId,
		);
		const plain = await sendIntent(
			box,
			{ to: ["b@example.net"], subject: "Plain", bodyText: "Hello" },
			ownerId,
		);
		// Every mailbox DO request the listing makes, by path.
		const paths: string[] = [];
		const counting = {
			...authEnv(),
			MAILBOX_DO: {
				getByName: (name: string) => {
					const stub = env.MAILBOX_DO.getByName(name);
					return {
						fetch: (input: RequestInfo | URL, init?: RequestInit) => {
							paths.push(new URL(typeof input === "string" ? input : String(input)).pathname);
							return stub.fetch(input, init);
						},
					};
				},
			},
		} as unknown as Env;
		const list = await listApprovals(counting, ownerId);
		const rich = list.pending.find((item) => item.id === intent.id);
		expect(rich?.send).toMatchObject({
			text: "Hello in bold",
			html: "<p>Hello <strong>in bold</strong></p>",
		});
		expect(list.pending.find((item) => item.id === plain.id)?.send?.html).toBeNull();
		for (const item of [intent, plain]) {
			const reads = paths.filter((p) => p === `/drafts/${item.draftId}/send-intent`);
			expect(reads).toHaveLength(1);
		}
	});

	it("names the requesting OAuth client when it is registered", async () => {
		const box = await mailbox();
		const intent = await sendIntent(
			box,
			{ to: ["a@example.net"], subject: "Named", bodyText: "x" },
			ownerId,
		);
		await db
			.prepare(
				`INSERT INTO "oauthClient" ("id", "clientId", "name", "redirectUris") VALUES ('oc1', 'client-claude', 'Claude', '[]')`,
			)
			.run();
		const list = await listApprovals(authEnv(), ownerId);
		expect(list.pending.find((item) => item.id === intent.id)?.requestedBy).toBe("Claude");
	});
});
