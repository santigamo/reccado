import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { InboundEmailQueueMessage } from "#/cloudflare/types";
import { sha256Hex } from "#/lib/crypto";
import { inboundIdempotencyKey } from "#/lib/idempotency";
import { rawEmailR2Key } from "#/lib/r2-keys";
import worker from "#/server";
import attachmentSmallEml from "../../fixtures/mime/attachment-small.eml?raw";
import multipartHtmlOnlyContentEml from "../../fixtures/mime/multipart-html-only-content.eml?raw";
import migrationInitial from "../../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../../migrations/d1/0002_message_index.sql?raw";
import migrationMailboxOwner from "../../migrations/d1/0003_mailbox_owner.sql?raw";

type TestEnv = Env & {
	INDEX_DB: D1Database;
	MAIL_OBJECTS: R2Bucket;
	MAILBOX_DO: DurableObjectNamespace;
};

const testEnv = env as unknown as TestEnv;

// The vitest-pool-workers D1 binding starts schema-less: it does not auto-apply
// migrations/d1/*.sql. D1Database#exec() only accepts one statement per line, so
// the multi-line CREATE TABLE statements in the migration files are split and run
// individually via prepare().run() instead.
async function applyMigration(sql: string): Promise<void> {
	const statements = sql
		.split(";")
		.map((statement) => statement.trim())
		.filter(Boolean);
	for (const statement of statements) {
		await testEnv.INDEX_DB.prepare(statement).run();
	}
}

beforeAll(async () => {
	await applyMigration(migrationInitial as string);
	await applyMigration(migrationMessageIndex as string);
	await applyMigration(migrationMailboxOwner as string);
});

async function fetchWorker(request: Request, workerEnv: Env = env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, workerEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("malformed/invalid request bodies", () => {
	it("returns 400 validation_error (not 500) when a JSON body fails zod validation", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/mailboxes", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("validation_error");
	});

	// A body that isn't syntactically valid JSON makes c.req.json() throw a SyntaxError
	// before zod runs; onError maps that to a 400 invalid_json rather than a generic 500.
	it("returns 400 invalid_json for a syntactically invalid JSON body", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/mailboxes", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{not valid json",
			}),
		);
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("invalid_json");
	});
});

describe("phase0 debug routes fail closed", () => {
	// Force the "unconfigured" state explicitly rather than relying on the ambient env:
	// vitest-pool-workers loads `.dev.vars`, which locally defines PHASE0_DEBUG_TOKEN, so
	// asserting on the global env is non-hermetic (passes in CI, fails after `pnpm dev`).
	const envWithoutDebugToken: Env = { ...env, PHASE0_DEBUG_TOKEN: undefined };

	it("returns 404 for the mailbox debug route when PHASE0_DEBUG_TOKEN is not configured", async () => {
		expect(envWithoutDebugToken.PHASE0_DEBUG_TOKEN).toBeUndefined();
		const response = await fetchWorker(
			new Request("http://localhost/api/debug/phase0/mailboxes/mbx_anything"),
			envWithoutDebugToken,
		);
		expect(response.status).toBe(404);
	});

	it("returns 404 even when a token header is supplied, since none is configured to match", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/debug/phase0/mailboxes/mbx_anything", {
				headers: { "x-phase0-debug-token": "guessed-token" },
			}),
			envWithoutDebugToken,
		);
		expect(response.status).toBe(404);
	});

	it("returns 404 for the r2/head debug route when no token is configured", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/debug/phase0/r2/head?key=anything"),
			envWithoutDebugToken,
		);
		expect(response.status).toBe(404);
	});
});

describe("global security headers", () => {
	it("sets nosniff/frame-deny/no-referrer headers on a normal API response", async () => {
		const response = await fetchWorker(new Request("http://localhost/api/health"));
		expect(response.status).toBe(200);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	});
});

describe("CSRF Origin check on state-changing /api/ requests", () => {
	it("rejects a POST whose Origin does not match the request host with 403 origin_mismatch", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/mailboxes", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "https://evil.example.com" },
				body: JSON.stringify({ primaryAddress: "csrf-blocked@example.com" }),
			}),
		);
		expect(response.status).toBe(403);
		const body = (await response.json()) as { error: string };
		expect(body.error).toBe("origin_mismatch");
	});

	it("allows a POST whose Origin matches the request host", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/mailboxes", {
				method: "POST",
				headers: { "content-type": "application/json", origin: "http://localhost" },
				body: JSON.stringify({ primaryAddress: "csrf-same-origin@example.com" }),
			}),
		);
		expect(response.status).toBe(201);
	});

	it("does not block a POST that has no Origin header at all", async () => {
		const response = await fetchWorker(
			new Request("http://localhost/api/mailboxes", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ primaryAddress: "csrf-no-origin@example.com" }),
			}),
		);
		// Not blocked by the Origin check: the request reaches the handler and
		// completes normally (201 created), rather than failing with 403.
		expect(response.status).toBe(201);
	});
});

describe("attachment download route", () => {
	it("serves attachments with Content-Disposition: attachment, nosniff, and a sandboxed CSP", async () => {
		const mailboxId = "mbx_security_attachment";

		// Seed the mailbox in the D1 control plane (mailboxStub() requires the row
		// to exist) and ingest a real message+attachment directly through the DO,
		// mirroring how the queue consumer would in production.
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				mailboxId,
				"attachment-route@example.com",
				null,
				"active",
				"dev@local",
				new Date().toISOString(),
				new Date().toISOString(),
			)
			.run();

		const rawBytes = new TextEncoder().encode(attachmentSmallEml as string);
		const rawSha256 = await sha256Hex(rawBytes);
		const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
		await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);

		const messageId = "attachment-small-fixture-security@example.com";
		const queueMessage: InboundEmailQueueMessage = {
			schemaVersion: 1,
			eventType: "email.received.v1",
			traceId: crypto.randomUUID(),
			enqueuedAt: new Date().toISOString(),
			receivedAt: new Date().toISOString(),
			mailboxId,
			domain: "example.com",
			recipient: "test@example.com",
			sender: "sender@example.com",
			rawR2Key,
			rawSha256,
			rawSize: rawBytes.byteLength,
			messageId,
			headers: { subject: "Attachment small", date: null, inReplyTo: null, references: [] },
			routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
			idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
		};
		const ingestResponse = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			"https://mailbox-do/ingest",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(queueMessage),
			},
		);
		const ingestResult = (await ingestResponse.json()) as { messageLocalId: string };

		// Fetch the message metadata straight from the DO (not through
		// GET /api/mailboxes/:id/messages/:id) to find the attachment id. See the
		// "DO-proxied routes" describe block below: that route currently 500s
		// through the full HTTP path, which is a separate, already-documented bug.
		// The attachment *download* route under test here builds its own fresh
		// Response and is unaffected.
		const doMessageResponse = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			`https://mailbox-do/messages/${ingestResult.messageLocalId}`,
		);
		const messagePayload = (await doMessageResponse.json()) as {
			message: { attachments: Array<{ id: string; filename: string }> };
		};
		const attachmentId = messagePayload.message.attachments[0]?.id;
		expect(attachmentId).toBeTruthy();

		const attachmentResponse = await fetchWorker(
			new Request(
				`http://localhost/api/mailboxes/${mailboxId}/messages/${ingestResult.messageLocalId}/attachments/${attachmentId}`,
			),
		);
		expect(attachmentResponse.status).toBe(200);
		expect(attachmentResponse.headers.get("content-disposition")).toBe(
			'attachment; filename="note.txt"',
		);
		expect(attachmentResponse.headers.get("x-content-type-options")).toBe("nosniff");
		const csp = attachmentResponse.headers.get("content-security-policy");
		expect(csp).toContain("sandbox");
		expect(csp).toContain("default-src 'none'");
		const text = await attachmentResponse.text();
		expect(text).toContain("Hello attachment content.");
	});

	it("returns 404 attachment_not_found for an unknown attachment id on a real message", async () => {
		const mailboxId = "mbx_security_attachment_missing";
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				mailboxId,
				"attachment-missing@example.com",
				null,
				"active",
				"dev@local",
				new Date().toISOString(),
				new Date().toISOString(),
			)
			.run();

		const rawBytes = new TextEncoder().encode(attachmentSmallEml as string);
		const rawSha256 = await sha256Hex(rawBytes);
		const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
		await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
		const messageId = "attachment-small-fixture-missing@example.com";
		const queueMessage: InboundEmailQueueMessage = {
			schemaVersion: 1,
			eventType: "email.received.v1",
			traceId: crypto.randomUUID(),
			enqueuedAt: new Date().toISOString(),
			receivedAt: new Date().toISOString(),
			mailboxId,
			domain: "example.com",
			recipient: "test@example.com",
			sender: "sender@example.com",
			rawR2Key,
			rawSha256,
			rawSize: rawBytes.byteLength,
			messageId,
			headers: { subject: "Attachment small", date: null, inReplyTo: null, references: [] },
			routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
			idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
		};
		const ingestResponse = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			"https://mailbox-do/ingest",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(queueMessage),
			},
		);
		const ingestResult = (await ingestResponse.json()) as { messageLocalId: string };

		const response = await fetchWorker(
			new Request(
				`http://localhost/api/mailboxes/${mailboxId}/messages/${ingestResult.messageLocalId}/attachments/does-not-exist`,
			),
		);
		expect(response.status).toBe(404);
	});
});

describe("HTML body route", () => {
	it("serves the sandboxed email HTML with a strict CSP and a base target, exposing the code", async () => {
		const mailboxId = "mbx_security_html_body";
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				mailboxId,
				"html-body-route@example.com",
				null,
				"active",
				"dev@local",
				new Date().toISOString(),
				new Date().toISOString(),
			)
			.run();

		const rawBytes = new TextEncoder().encode(multipartHtmlOnlyContentEml as string);
		const rawSha256 = await sha256Hex(rawBytes);
		const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
		await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
		const messageId = "multipart-html-only-content-fixture@example.com";
		const queueMessage: InboundEmailQueueMessage = {
			schemaVersion: 1,
			eventType: "email.received.v1",
			traceId: crypto.randomUUID(),
			enqueuedAt: new Date().toISOString(),
			receivedAt: new Date().toISOString(),
			mailboxId,
			domain: "example.com",
			recipient: "hello@imsanti.dev",
			sender: "noreply@labsmobile.com",
			rawR2Key,
			rawSha256,
			rawSize: rawBytes.byteLength,
			messageId,
			headers: {
				subject: "[LabsMobile] Accede a tu cuenta",
				date: null,
				inReplyTo: null,
				references: [],
			},
			routing: { ruleId: null, action: "store", matchedAlias: "hello@imsanti.dev" },
			idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
		};
		const ingestResponse = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			"https://mailbox-do/ingest",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(queueMessage),
			},
		);
		const ingestResult = (await ingestResponse.json()) as { messageLocalId: string };

		const response = await fetchWorker(
			new Request(
				`http://localhost/api/mailboxes/${mailboxId}/messages/${ingestResult.messageLocalId}/html`,
			),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");

		const csp = response.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).not.toContain("script-src"); // no script source is allowed at all
		// Must NOT set the CSP `sandbox` directive: that would force an opaque origin and
		// break the client's same-origin iframe height measurement (isolation comes from
		// the iframe `sandbox` attribute + `default-src 'none'` instead).
		expect(csp).not.toContain("sandbox");

		const html = await response.text();
		expect(html).toContain('<base target="_blank"'); // links open in a new tab
		expect(html).toContain("653865"); // the 2FA code the plain-text part omitted
	});
});

describe("DO-proxied routes vs. the global security-header middleware", () => {
	// Real bug, not a spec'd security control: src/api/hono.ts installs
	// `api.use("*", async (c, next) => { await next(); c.res.headers.set(...) })`
	// to stamp security headers on every response. Several mailbox routes (e.g.
	// GET /messages/:messageId, GET /threads, GET /search, POST .../actions,
	// the /drafts routes) return the Durable Object stub's `fetch()` Response
	// Responses proxied straight from the Durable Object have immutable headers; the
	// security-header middleware rebuilds the response so it can attach the baseline
	// headers without throwing, and the route returns its real payload.
	it("GET /messages/:messageId returns the message payload with security headers", async () => {
		const mailboxId = "mbx_security_do_proxy_bug";
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				mailboxId,
				"do-proxy-bug@example.com",
				null,
				"active",
				"dev@local",
				new Date().toISOString(),
				new Date().toISOString(),
			)
			.run();

		const rawBytes = new TextEncoder().encode(attachmentSmallEml as string);
		const rawSha256 = await sha256Hex(rawBytes);
		const rawR2Key = rawEmailR2Key({ mailboxId, receivedAt: new Date(), rawSha256 });
		await testEnv.MAIL_OBJECTS.put(rawR2Key, rawBytes);
		const messageId = "attachment-small-fixture-do-proxy-bug@example.com";
		const queueMessage: InboundEmailQueueMessage = {
			schemaVersion: 1,
			eventType: "email.received.v1",
			traceId: crypto.randomUUID(),
			enqueuedAt: new Date().toISOString(),
			receivedAt: new Date().toISOString(),
			mailboxId,
			domain: "example.com",
			recipient: "test@example.com",
			sender: "sender@example.com",
			rawR2Key,
			rawSha256,
			rawSize: rawBytes.byteLength,
			messageId,
			headers: { subject: "Attachment small", date: null, inReplyTo: null, references: [] },
			routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
			idempotencyKey: inboundIdempotencyKey({ mailboxId, messageId, rawSha256 }),
		};
		const ingestResponse = await testEnv.MAILBOX_DO.getByName(mailboxId).fetch(
			"https://mailbox-do/ingest",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(queueMessage),
			},
		);
		const ingestResult = (await ingestResponse.json()) as { messageLocalId: string };

		const response = await fetchWorker(
			new Request(
				`http://localhost/api/mailboxes/${mailboxId}/messages/${ingestResult.messageLocalId}`,
			),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		const body = (await response.json()) as { message?: unknown };
		expect(body.message).toBeTruthy();
	});

	it("GET /threads returns the proxied DO response with security headers", async () => {
		const mailboxId = "mbx_security_do_proxy_bug_threads";
		await testEnv.INDEX_DB.prepare(
			"INSERT INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(
				mailboxId,
				"do-proxy-bug-threads@example.com",
				null,
				"active",
				"dev@local",
				new Date().toISOString(),
				new Date().toISOString(),
			)
			.run();

		const response = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/threads`),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("maps a Durable Object handler error to 404 (not 500) for a missing draft", async () => {
		const mailboxId = "mbx_security_do_error_mapping";
		const response = await fetchWorker(
			new Request(`http://localhost/api/mailboxes/${mailboxId}/drafts/nonexistent-draft`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ subject: "x" }),
			}),
		);
		expect(response.status).toBe(404);
	});
});

describe("setup status diagnostic", () => {
	it("reports control-plane completeness and flips canReceive once an active alias exists", async () => {
		const now = new Date().toISOString();
		await testEnv.INDEX_DB.prepare(
			"INSERT OR IGNORE INTO domains (id, domain, zone_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
			.bind("dom_setup_status", "setup-status.example", "zone", now, now)
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT OR IGNORE INTO mailboxes (mailbox_id, primary_address, display_name, status, owner_email, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)",
		)
			.bind("mbx_setup_status", "inbox@setup-status.example", "Setup Status", "dev@local", now, now)
			.run();
		await testEnv.INDEX_DB.prepare(
			"INSERT OR IGNORE INTO aliases (alias_address, mailbox_id, domain_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
		)
			.bind("inbox@setup-status.example", "mbx_setup_status", "dom_setup_status", now, now)
			.run();

		const response = await fetchWorker(new Request("http://localhost/api/setup/status"));
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			controlPlane: { mailboxes: number; aliases: number; domains: number; canReceive: boolean };
		};
		expect(body.ok).toBe(true);
		expect(body.controlPlane.mailboxes).toBeGreaterThanOrEqual(1);
		expect(body.controlPlane.aliases).toBeGreaterThanOrEqual(1);
		expect(body.controlPlane.domains).toBeGreaterThanOrEqual(1);
		expect(body.controlPlane.canReceive).toBe(true);
	});
});
