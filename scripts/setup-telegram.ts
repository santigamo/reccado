#!/usr/bin/env tsx
/**
 * `pnpm setup:telegram` — points a Telegram bot at this worker's webhook.
 *
 * What it does, in order:
 *   1. calls getMe to prove the bot token works and print the bot's @username
 *   2. calls setWebhook with the URL and the shared secret token, restricting
 *      updates to message + callback_query
 *   3. calls getWebhookInfo and prints what Telegram now believes
 *
 * The secret token is what authenticates every incoming webhook request (it comes
 * back in X-Telegram-Bot-Api-Secret-Token), so the same value has to be set as the
 * TELEGRAM_WEBHOOK_SECRET worker secret. This script never writes secrets: it
 * reads them from the environment or .dev.vars and tells you what to set.
 *
 * SAFETY: dry-run by default. Pass `--apply` to actually register the webhook.
 *
 * Usage:
 *   pnpm setup:telegram --url https://reccado-dev.<subdomain>.workers.dev
 *   pnpm setup:telegram --url https://... --apply
 *   pnpm setup:telegram --delete --apply     # unregister the webhook
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Args = {
	url: string | null;
	apply: boolean;
	remove: boolean;
};

function parseArgs(): Args {
	const args = process.argv.slice(2);
	let url: string | null = null;
	let apply = false;
	let remove = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--url" && args[i + 1]) url = args[++i] as string;
		if (arg === "--apply") apply = true;
		if (arg === "--delete") remove = true;
	}
	return { url, apply, remove };
}

function readDevVars(): Record<string, string> {
	const devVarsPath = join(process.cwd(), ".dev.vars");
	if (!existsSync(devVarsPath)) return {};
	const vars: Record<string, string> = {};
	for (const line of readFileSync(devVarsPath, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		const value = trimmed
			.slice(eqIndex + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		vars[key] = value;
	}
	return vars;
}

async function callTelegram<T>(
	token: string,
	method: string,
	params: Record<string, unknown> = {},
): Promise<T> {
	const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(params),
	});
	const payload = (await response.json()) as {
		ok: boolean;
		result?: T;
		description?: string;
	};
	if (!payload.ok) {
		throw new Error(`${method} failed: ${payload.description ?? response.status}`);
	}
	return payload.result as T;
}

async function main(): Promise<void> {
	const args = parseArgs();
	const devVars = readDevVars();
	const token = process.env.TELEGRAM_BOT_TOKEN ?? devVars.TELEGRAM_BOT_TOKEN;
	const secret = process.env.TELEGRAM_WEBHOOK_SECRET ?? devVars.TELEGRAM_WEBHOOK_SECRET;

	if (!token) {
		console.error("TELEGRAM_BOT_TOKEN is not set (env or .dev.vars). Get one from @BotFather.");
		process.exit(1);
	}

	const me = await callTelegram<{ username: string; id: number }>(token, "getMe");
	console.log(`Bot: @${me.username} (id ${me.id})`);

	if (args.remove) {
		if (!args.apply) {
			console.log("\nDry run. Would call deleteWebhook. Re-run with --apply.");
			return;
		}
		await callTelegram(token, "deleteWebhook", { drop_pending_updates: false });
		console.log("Webhook deleted.");
		return;
	}

	if (!args.url) {
		console.error("--url is required (the worker's public origin, https, no trailing slash).");
		process.exit(1);
	}
	if (!secret) {
		console.error(
			"TELEGRAM_WEBHOOK_SECRET is not set (env or .dev.vars).\n" +
				"Generate one and set it in both places:\n" +
				"  openssl rand -hex 32\n" +
				"  wrangler secret put TELEGRAM_WEBHOOK_SECRET --env dev",
		);
		process.exit(1);
	}

	const webhookUrl = `${args.url.replace(/\/$/, "")}/telegram/webhook`;
	console.log(`Webhook URL: ${webhookUrl}`);

	if (!args.apply) {
		console.log("\nDry run. Would call setWebhook with the secret token. Re-run with --apply.");
		return;
	}

	await callTelegram(token, "setWebhook", {
		url: webhookUrl,
		secret_token: secret,
		allowed_updates: ["message", "callback_query"],
		drop_pending_updates: true,
	});

	const info = await callTelegram<{
		url: string;
		pending_update_count: number;
		last_error_message?: string;
	}>(token, "getWebhookInfo");
	console.log("\nRegistered:");
	console.log(`  url: ${info.url}`);
	console.log(`  pending updates: ${info.pending_update_count}`);
	if (info.last_error_message) {
		console.log(`  last error: ${info.last_error_message}`);
	}
	console.log(
		"\nNext: send /start to the bot to get your chat_id and user_id, then set\n" +
			"TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS.\n" +
			"If the worker is behind Cloudflare Access, add a Bypass policy for /telegram/webhook —\n" +
			"Telegram cannot present an Access JWT and every update will 302 to the login page.",
	);
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
