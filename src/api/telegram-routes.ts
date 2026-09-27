import type { Hono } from "hono";
import { sendTelegramDeliveryTest } from "../telegram/admin/delivery-test";
import { rebindTelegramChat } from "../telegram/admin/rebind";
import type { AdminResult } from "../telegram/admin/shared";
import { getTelegramOperatorStatus } from "../telegram/admin/status";
import { listTelegramTopicMappings, mapTelegramTopic } from "../telegram/admin/topics";
import { assertMailboxAccess } from "./auth";
import type { ApiBindings } from "./hono";
import { telegramDeliveryTestSchema, telegramRebindSchema, telegramTopicSchema } from "./schemas";

/**
 * Operator control of the Telegram bridge, under /api/telegram/*.
 *
 * Registered inside the /api/* perimeter, so every route here already sits
 * behind requireAuth (a Better Auth session whose email is in the owner
 * registry) and every POST behind the Origin CSRF check -- the same gates as
 * /api/admin/*. There is no per-mailbox ACL to add: the bridge is one chat for
 * the whole deployment, and assertMailboxAccess only re-checks the owner
 * registry today (see src/api/auth.ts).
 *
 * The routes use the worker's own TELEGRAM_BOT_TOKEN, which is the reason they
 * exist: the secret is write-only, so the terminal cannot call Telegram as the
 * bot. No response ever contains the token.
 */
export function registerTelegramRoutes(api: Hono<ApiBindings>): void {
	const answer = <T>(result: AdminResult<T>) =>
		Response.json(result.body, { status: result.status });

	api.get("/api/telegram/status", async (c) => {
		return c.json(await getTelegramOperatorStatus(c.env));
	});

	api.post("/api/telegram/rebind", async (c) => {
		const body = telegramRebindSchema.parse(await c.req.json());
		return answer(
			await rebindTelegramChat(c.env, { chatId: body.chatId, dryRun: body.dryRun ?? false }),
		);
	});

	api.get("/api/telegram/topics", async (c) => {
		return c.json(await listTelegramTopicMappings(c.env));
	});

	api.post("/api/telegram/topics", async (c) => {
		const body = telegramTopicSchema.parse(await c.req.json());
		assertMailboxAccess(c.get("auth")!, body.mailboxId, c.env);
		return answer(await mapTelegramTopic(c.env, { ...body, dryRun: body.dryRun ?? false }));
	});

	// Posts real (labelled) messages, so it is a POST behind the CSRF check even
	// though it changes no state of ours beyond an ops_event.
	api.post("/api/telegram/test", async (c) => {
		// The body is optional: no body means every active mailbox.
		const text = await c.req.text();
		const body = telegramDeliveryTestSchema.parse(text.trim() ? JSON.parse(text) : {});
		if (body.mailboxId) assertMailboxAccess(c.get("auth")!, body.mailboxId, c.env);
		return answer(await sendTelegramDeliveryTest(c.env, { mailboxId: body.mailboxId }));
	});
}
