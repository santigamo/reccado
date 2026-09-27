import type { Hono } from "hono";
import { getTelegramOperatorStatus } from "../telegram/admin/status";
import type { ApiBindings } from "./hono";

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
	api.get("/api/telegram/status", async (c) => {
		return c.json(await getTelegramOperatorStatus(c.env));
	});
}
