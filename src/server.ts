import { createApiApp } from "./api/hono";
import { deriveDevTestMailboxId } from "./db/seed-dev";
import type { InboundEmailQueueMessage } from "./cloudflare/types";

export { MailboxDurableObject } from "./do/mailbox-do";

const api = createApiApp();

function phase0DebugAuthorized(request: Request, env: Env): boolean {
	const token = env.PHASE0_DEBUG_TOKEN;
	if (!token) {
		return true;
	}
	return request.headers.get("x-phase0-debug-token") === token;
}

api.get("/api/debug/phase0/mailboxes/:mailboxId/schema", async (c) => {
	if (!phase0DebugAuthorized(c.req.raw, c.env)) {
		return c.notFound();
	}
	const mailboxId = c.req.param("mailboxId");
	const stub = c.env.MAILBOX_DO.getByName(mailboxId);
	return stub.fetch("https://mailbox-do/debug/schema");
});

api.get("/api/debug/phase0/schema/:mailboxId", async (c) => {
	if (!phase0DebugAuthorized(c.req.raw, c.env)) {
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
	if (!phase0DebugAuthorized(c.req.raw, c.env)) {
		return c.notFound();
	}
	const mailboxId = c.req.param("mailboxId");
	const stub = c.env.MAILBOX_DO.getByName(mailboxId);
	return stub.fetch("https://mailbox-do/debug");
});


api.get("/api/debug/phase0/r2/head", async (c) => {
	if (!phase0DebugAuthorized(c.req.raw, c.env)) {
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
	if (!phase0DebugAuthorized(c.req.raw, c.env)) {
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
			if (!phase0DebugAuthorized(request, env)) {
				return new Response("Not found", { status: 404 });
			}
			const { handleLocalEmailSimulation } = await import("./cloudflare/local-email");
			return handleLocalEmailSimulation(request, env, ctx);
		}
		if (url.pathname.startsWith("/api/")) {
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
