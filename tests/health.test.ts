import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import migrationInitial from "../migrations/d1/0001_initial.sql?raw";
import migrationMessageIndex from "../migrations/d1/0002_message_index.sql?raw";
import migrationTransactionalRequests from "../migrations/d1/0007_transactional_requests.sql?raw";
import migrationEmailEvents from "../migrations/d1/0008_email_events_suppressions.sql?raw";
import worker from "../src/server";
import { applyMigrations } from "./helpers/migrations";

type TestEnv = Env & { INDEX_DB: D1Database };

type HealthBody = {
	readiness: { ok: boolean; status: string };
	dependencies: {
		sendingFeedback: {
			ok: boolean;
			configured: boolean;
			mode: string;
			reason: string | null;
			darkDomains: string[];
			maturityHours: number | null;
		};
	};
};

const testEnv = env as unknown as TestEnv;

async function fetchHealth(url: string): Promise<Response> {
	const request = new Request(url);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

// D1 storage in this pool is NOT rolled back between individual `it()`s within a
// file (only across files) -- tables created by one test remain visible to later
// tests in this same describe block. So the "schema missing" case must run BEFORE
// the migrations are applied, and the "schema present" case (which applies the
// migrations) must run after it, permanently establishing the schema for the rest
// of this file's tests (the last test below only asserts on `auth`, which is
// unaffected by indexDb's state either way).
describe("health route", () => {
	// This is the regression test for the false-confidence bug: previously
	// `indexDb: { ok: true, configured: true }` was hardcoded and never queried D1,
	// so a missing migration (e.g. no "aliases" table) was invisible to /api/health
	// even while email ingest was 500ing with "D1_ERROR: no such table: aliases".
	it("reports indexDb.ok:false with a reason and degrades readiness when the D1 schema is missing", async () => {
		const response = await fetchHealth("http://localhost/api/health");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			readiness: { ok: boolean; status: string };
			dependencies: { indexDb: { ok: boolean; configured: boolean; reason: string | null } };
		};
		expect(body.dependencies.indexDb.ok).toBe(false);
		expect(body.dependencies.indexDb.configured).toBe(true);
		expect(body.dependencies.indexDb.reason).toBeTruthy();
		expect(body.dependencies.indexDb.reason).toContain("aliases");
		expect(body.readiness).toEqual({ ok: false, status: "degraded" });
	});

	it("reports indexDb.ok:true and overall readiness ready when the D1 schema is present", async () => {
		await applyMigrations(
			testEnv.INDEX_DB,
			migrationInitial as string,
			migrationMessageIndex as string,
		);

		const response = await fetchHealth("http://localhost/api/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			readiness: {
				ok: true,
				status: "ready",
			},
			dependencies: {
				auth: {
					ok: true,
					configured: false,
					mode: "local-dev-bypass",
					reason:
						"Cloudflare Access validation is disabled until ACCESS_JWT_AUDIENCE is configured.",
					missing: ["ACCESS_JWT_AUDIENCE", "ACCESS_TEAM_DOMAIN"],
				},
				indexDb: {
					ok: true,
					configured: true,
					reason: null,
				},
				cloudflareApi: {
					ok: true,
					configured: false,
					reason: "CLOUDFLARE_API_TOKEN is not set.",
				},
				telegram: {
					ok: true,
					configured: false,
					mode: "off",
					reason: "Telegram bridge is disabled until TELEGRAM_BOT_TOKEN is set.",
					missing: [],
					webhookUrl: null,
					pendingUpdateCount: null,
				},
				// The transactional projections are not part of this migration set, so
				// the send log cannot be read at all. "unknown" is the honest answer to
				// that, and it must not read as "all clear".
				sendingFeedback: {
					ok: true,
					configured: false,
					mode: "unknown",
					reason: null,
					darkDomains: [],
					maturityHours: null,
				},
			},
		});
	});

	it("reports degraded auth readiness on non-localhost when Access is not configured", async () => {
		const response = await fetchHealth("https://example.com/api/health");

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			readiness: { ok: boolean; status: string };
			dependencies: { auth: { ok: boolean; reason: string } };
		};
		expect(body.readiness).toEqual({ ok: false, status: "degraded" });
		expect(body.dependencies.auth.ok).toBe(false);
		expect(body.dependencies.auth.reason).toBe(
			"Cloudflare Access validation is not configured for non-localhost requests.",
		);
	});

	// The defect this guards: a sending domain with no Email Sending event
	// subscription produces no lifecycle events for anything, so every send from
	// it stays `delivery_status: null` and looks exactly like a send whose event
	// has not arrived yet. Nothing in the system could tell those apart, and three
	// features read the absence as evidence about the message.
	it("names a sending domain whose feedback channel has never answered", async () => {
		await applyMigrations(
			testEnv.INDEX_DB,
			migrationTransactionalRequests as string,
			migrationEmailEvents as string,
		);

		const before = (await (await fetchHealth("http://localhost/api/health")).json()) as HealthBody;
		expect(before.dependencies.sendingFeedback).toMatchObject({
			ok: true,
			configured: false,
			mode: "no_sends",
		});

		const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		await insertRequestLog({ requestId: "req-dark", sender: "bot@notify.example.com", at: old });
		await insertRequestLog({
			requestId: "req-live",
			sender: "bot@send.example.com",
			at: old,
			deliveryEventAt: old,
		});

		const after = (await (await fetchHealth("http://localhost/api/health")).json()) as HealthBody;
		const feedback = after.dependencies.sendingFeedback;
		expect(feedback.ok).toBe(false);
		expect(feedback.mode).toBe("dark");
		expect(feedback.darkDomains).toEqual(["notify.example.com"]);
		expect(feedback.reason).toContain("notify.example.com");
		// The domain that is answering must not be dragged down with it: this is a
		// per-domain fact, and a blanket "sending feedback is broken" would send the
		// operator looking in the wrong place.
		expect(feedback.darkDomains).not.toContain("send.example.com");
		// Readiness stays ready: sending still works, and a dark feedback channel is
		// not a reason to fail a liveness probe.
		expect(after.readiness.ok).toBe(true);
	});

	// Liveness is a claim about now. A domain nobody has sent from in a month has
	// no current evidence either way, and keeping it permanently red would both
	// mislead and turn a polled endpoint into an ever-growing table scan.
	it("ignores a domain whose sends are older than the lookback window", async () => {
		await insertRequestLog({
			requestId: "req-ancient",
			sender: "bot@retired.example.com",
			at: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
		});

		const body = (await (await fetchHealth("http://localhost/api/health")).json()) as HealthBody;
		expect(body.dependencies.sendingFeedback.darkDomains).not.toContain("retired.example.com");
		expect(body.dependencies.sendingFeedback.darkDomains).toEqual(["notify.example.com"]);
	});
});

async function insertRequestLog(row: {
	requestId: string;
	sender: string;
	at: string;
	deliveryEventAt?: string;
}): Promise<void> {
	await testEnv.INDEX_DB.prepare(
		`INSERT INTO transactional_request_log
       (request_id, key_id, mailbox_id, status, to_addr, template_id, sender,
        provider_message_id, error_code, delivery_status, delivery_event_at,
        created_at, updated_at)
     VALUES (?, 'key-1', 'mbx-1', 'sent', 'someone@example.org', NULL, ?, ?, NULL, ?, ?, ?, ?)`,
	)
		.bind(
			row.requestId,
			row.sender,
			`msg-${row.requestId}`,
			row.deliveryEventAt ? "delivered" : null,
			row.deliveryEventAt ?? null,
			row.at,
			row.at,
		)
		.run();
}
