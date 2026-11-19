import type { Hono } from "hono";
import { requireAuth } from "./auth";
import type { ApiBindings } from "./hono";

/**
 * Owner-only approval API. Mounted inside the /api/* perimeter, and every
 * handler re-reads the session with the cookie cache off: approving a send is
 * the same class of action as confirm-send.
 *
 * POSTs require an Origin that matches this request. A missing Origin is
 * rejected here even though the global check allows it, so a cross-site form
 * cannot approve by omitting the header.
 */
export function registerApprovalRoutes(api: Hono<ApiBindings>): void {
	// The inbox queue: pending (oldest first) and decided in the last 24 h. Read-only,
	// owner session only; it exposes nothing the single-item view below does not.
	api.get("/api/approvals", async (c) => {
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { listApprovals } = await import("../lib/approvals-list");
		return json(await listApprovals(c.env, auth.userId), 200);
	});

	api.get("/api/approvals/:id", async (c) => {
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { getIntentView } = await import("../lib/approvals");
		const view = await getIntentView(c.env, c.req.param("id"), { userId: auth.userId });
		return json(view, 200);
	});

	// A send request's HTML part, rendered for review the way a received message
	// is: through prepareEmailHtml (remote content held back), under the strict
	// email-frame CSP, framable by this origin only. Every link's target is
	// written next to it. `?hash=` binds the preview to the payload the page will
	// approve; anything stale, swapped or not a send is a 404.
	api.get("/api/approvals/:id/html", async (c) => {
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { approvalPreviewHtml } = await import("../lib/approvals");
		const hash = c.req.query("hash") ?? null;
		if (hash !== null && !/^[a-f0-9]{64}$/.test(hash)) return json({ error: "invalid_hash" }, 400);
		const html = await approvalPreviewHtml(c.env, c.req.param("id"), auth.userId, hash);
		if (html === null) return json({ error: "html_not_found" }, 404);
		const { LINK_TARGETS_STYLE, prepareEmailHtml } = await import("../lib/email-html");
		const { framedEmailResponse } = await import("./mailbox-routes");
		let prepared: string;
		try {
			prepared = await prepareEmailHtml(html, new Map(), false);
		} catch {
			return json({ error: "html_unrenderable" }, 422);
		}
		return framedEmailResponse(prepared, false, LINK_TARGETS_STYLE);
	});

	api.get("/api/approvals/:id/status", async (c) => {
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { getIntentStatus } = await import("../lib/approvals");
		return json(await getIntentStatus(c.env, c.req.param("id")), 200);
	});

	api.post("/api/approvals/:id/approve", async (c) => {
		const origin = sameOrigin(c.req.raw);
		if (origin instanceof Response) return origin;
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const payloadHash = await readPayloadHash(c.req.raw);
		if (payloadHash instanceof Response) return payloadHash;
		const { approveIntent } = await import("../lib/approvals");
		const result = await approveIntent(c.env, {
			id: c.req.param("id"),
			payloadHash,
			channel: "web",
			approver: auth.userId,
		});
		await syncTelegramNotice(c.env, c.req.param("id"));
		const status = result.error ? statusFor(result.error) : 200;
		return json(result, status);
	});

	api.post("/api/approvals/:id/deny", async (c) => {
		const origin = sameOrigin(c.req.raw);
		if (origin instanceof Response) return origin;
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { denyIntent } = await import("../lib/approvals");
		const result = await denyIntent(c.env, c.req.param("id"));
		await syncTelegramNotice(c.env, c.req.param("id"));
		return json(result, 200);
	});
}

/**
 * Queues the edit that makes the Telegram notice say Aprobado / Denegado. After
 * the decision, never instead of it, and it never fails the request: the notice
 * is a mirror of the decision, not part of it (telegram/approval-notices.ts).
 */
async function syncTelegramNotice(env: Env, id: string): Promise<void> {
	const { enqueueApprovalNoticeSync } = await import("../telegram/approval-notices");
	await enqueueApprovalNoticeSync(env, { approvalId: id });
}

function json(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function owner(
	request: Request,
	env: Env,
): Promise<Awaited<ReturnType<typeof requireAuth>> | Response> {
	try {
		return await requireAuth(request, env, { disableCookieCache: true });
	} catch (error) {
		if (error instanceof Response) return error;
		throw error;
	}
}

/** Present and equal to this request's origin. Missing is a refusal, not a pass. */
function sameOrigin(request: Request): string | Response {
	const origin = request.headers.get("Origin");
	const expected = new URL(request.url).origin;
	if (!origin || origin !== expected) {
		return json({ error: "origin_mismatch" }, 403);
	}
	return origin;
}

function statusFor(error: string): number {
	if (error === "expired") return 410;
	if (error === "forbidden") return 403;
	return 409;
}

/** The hash the owner saw on the page; the service compares it with the stored one. */
async function readPayloadHash(request: Request): Promise<string | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "invalid_body" }, 400);
	}
	const hash = (body as { payloadHash?: unknown } | null)?.payloadHash;
	if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
		return json({ error: "invalid_body" }, 400);
	}
	return hash;
}
