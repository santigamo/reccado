import "../lib/reflect-polyfill";
import type { Hono } from "hono";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
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
	api.get("/api/approvals/:id", async (c) => {
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { getIntentView } = await import("../lib/approvals");
		const view = await getIntentView(c.env, c.req.param("id"), { userId: auth.userId });
		return json(view, 200);
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
		const assertion = await readAssertion(c.req.raw);
		if (assertion instanceof Response) return assertion;
		const { approveIntent } = await import("../lib/approvals");
		const result = await approveIntent(c.env, {
			id: c.req.param("id"),
			userId: auth.userId,
			origin,
			assertion,
		});
		const status = result.error ? statusFor(result.error) : 200;
		return json(result, status);
	});

	api.post("/api/approvals/:id/deny", async (c) => {
		const origin = sameOrigin(c.req.raw);
		if (origin instanceof Response) return origin;
		const auth = await owner(c.req.raw, c.env);
		if (auth instanceof Response) return auth;
		const { denyIntent } = await import("../lib/approvals");
		return json(await denyIntent(c.env, c.req.param("id")), 200);
	});
}

function json(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function owner(request: Request, env: Env): Promise<Awaited<ReturnType<typeof requireAuth>> | Response> {
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
	if (error === "invalid_assertion") return 401;
	return 409;
}

async function readAssertion(request: Request): Promise<AuthenticationResponseJSON | Response> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ error: "invalid_body" }, 400);
	}
	const assertion = (body as { assertion?: unknown } | null)?.assertion;
	if (!isAssertion(assertion)) return json({ error: "invalid_body" }, 400);
	return assertion;
}

function isAssertion(value: unknown): value is AuthenticationResponseJSON {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const response = record.response;
	return (
		typeof record.id === "string" &&
		typeof record.rawId === "string" &&
		record.type === "public-key" &&
		!!response &&
		typeof response === "object"
	);
}
