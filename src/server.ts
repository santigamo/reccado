import { createApiApp } from "./api/hono";
import type { InboundEmailQueueMessage } from "./cloudflare/types";
import { deriveDevTestMailboxId } from "./db/seed-dev";

export { MailboxDurableObject } from "./do/mailbox-do";

const api = createApiApp();

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	// Compare fixed-length digests instead of the raw strings so neither the early-exit
	// behavior of `===` nor the input length itself can leak timing information.
	const encoder = new TextEncoder();
	const [digestA, digestB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	const bytesA = new Uint8Array(digestA);
	const bytesB = new Uint8Array(digestB);
	let diff = 0;
	for (let i = 0; i < bytesA.length; i++) {
		diff |= bytesA[i]! ^ bytesB[i]!;
	}
	return diff === 0;
}

async function phase0DebugAuthorized(request: Request, env: Env): Promise<boolean> {
	const token = env.PHASE0_DEBUG_TOKEN;
	// Fail closed: debug endpoints are disabled entirely unless an operator explicitly
	// configures PHASE0_DEBUG_TOKEN. An unset/empty token must never authorize access.
	if (!token) {
		return false;
	}
	const provided = request.headers.get("x-phase0-debug-token");
	if (!provided) {
		return false;
	}
	return timingSafeEqual(provided, token);
}

api.get("/api/debug/phase0/mailboxes/:mailboxId/schema", async (c) => {
	if (!(await phase0DebugAuthorized(c.req.raw, c.env))) {
		return c.notFound();
	}
	const mailboxId = c.req.param("mailboxId");
	const stub = c.env.MAILBOX_DO.getByName(mailboxId);
	return stub.fetch("https://mailbox-do/debug/schema");
});

api.get("/api/debug/phase0/schema/:mailboxId", async (c) => {
	if (!(await phase0DebugAuthorized(c.req.raw, c.env))) {
		return c.notFound();
	}
	const mailboxId = c.req.param("mailboxId");
	if (c.req.query("dry") === "1") {
		return c.json({ ok: true, route: "schema", mailboxId });
	}
	const stub = c.env.MAILBOX_DO.getByName(mailboxId);
	return stub.fetch("https://mailbox-do/debug/schema");
});

api.get("/api/debug/phase0/mailboxes/:mailboxId", async (c) => {
	if (!(await phase0DebugAuthorized(c.req.raw, c.env))) {
		return c.notFound();
	}
	const mailboxId = c.req.param("mailboxId");
	const stub = c.env.MAILBOX_DO.getByName(mailboxId);
	return stub.fetch("https://mailbox-do/debug");
});

api.get("/api/debug/phase0/r2/head", async (c) => {
	if (!(await phase0DebugAuthorized(c.req.raw, c.env))) {
		return c.notFound();
	}
	const key = c.req.query("key");
	if (!key) {
		return c.json({ error: "key required" }, 400);
	}
	const object = await c.env.MAIL_OBJECTS.head(key);
	return c.json({
		exists: Boolean(object),
		key,
		size: object?.size ?? null,
		customMetadata: object?.customMetadata ?? null,
	});
});

api.get("/api/debug/phase0/test-mailbox-id", async (c) => {
	if (!(await phase0DebugAuthorized(c.req.raw, c.env))) {
		return c.notFound();
	}
	return c.json({ mailboxId: await deriveDevTestMailboxId() });
});

api.get("/api/mailboxes/:mailboxId/ws", async (c) => {
	const mailboxId = c.req.param("mailboxId");
	const upgrade = c.req.header("Upgrade");
	if (upgrade?.toLowerCase() !== "websocket") {
		return c.text("Expected WebSocket upgrade", 426);
	}

	const doUrl = new URL("https://mailbox-do/ws");
	doUrl.searchParams.set("mailboxId", mailboxId);

	const stub = c.env.MAILBOX_DO.getByName(mailboxId);
	return stub.fetch(
		new Request(doUrl.toString(), {
			headers: c.req.raw.headers,
		}),
	);
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/cdn-cgi/handler/email") {
			const { handleLocalEmailSimulation } = await import("./cloudflare/local-email");
			return handleLocalEmailSimulation(request, env, ctx);
		}
		if (url.pathname === "/api/debug/phase0/email") {
			if (!(await phase0DebugAuthorized(request, env))) {
				return new Response("Not found", { status: 404 });
			}
			const { handleLocalEmailSimulation } = await import("./cloudflare/local-email");
			return handleLocalEmailSimulation(request, env, ctx);
		}
		if (url.pathname.startsWith("/api/") || url.pathname === "/mcp") {
			return api.fetch(request, env, ctx);
		}
		const startHandler = (await import("@tanstack/react-start/server-entry")).default;
		return startHandler.fetch(request);
	},
	async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
		const { handleEmail } = await import("./cloudflare/email-handler");
		return handleEmail(message, env, ctx);
	},
	async queue(batch: MessageBatch<InboundEmailQueueMessage>, env: Env, ctx: ExecutionContext) {
		const { handleInboundQueue } = await import("./cloudflare/queue-consumer");
		return handleInboundQueue(batch, env, ctx);
	},
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
		const { handleScheduled } = await import("./cloudflare/scheduled");
		return handleScheduled(controller, env);
	},
} satisfies ExportedHandler<Env, InboundEmailQueueMessage>;
