/// <reference types="@cloudflare/workers-types" />

declare interface Env {
	MAILBOX_ID_SECRET?: string;
	ACCESS_JWT_AUDIENCE?: string;
	ACCESS_TEAM_DOMAIN?: string;
	PHASE0_DEBUG_TOKEN?: string;
	CLOUDFLARE_API_TOKEN?: string;
	/** Comma-separated allowlist of owner emails permitted to use the API. Unset = open single-operator mode. */
	ACCESS_ALLOWED_EMAILS?: string;
	/**
	 * Comma-separated domains verified for outbound sending in Cloudflare Email
	 * Sending. A mailbox whose domain is listed sends as itself; anything else
	 * falls back to MAIL_FROM_ADDRESS with Reply-To. See lib/sender-identity.ts.
	 */
	MAIL_SENDING_DOMAINS?: string;
	/** Telegram bot token from @BotFather. Unset = the Telegram bridge is off. */
	TELEGRAM_BOT_TOKEN?: string;
	/** Shared secret echoed by Telegram in X-Telegram-Bot-Api-Secret-Token. Required when the bridge is on. */
	TELEGRAM_WEBHOOK_SECRET?: string;
	/** Comma-separated Telegram user IDs allowed to drive the bot. Required when the bridge is on. */
	TELEGRAM_ALLOWED_USER_IDS?: string;
	/** Chat the bot notifies about new mail. Usually the operator's own user ID. */
	TELEGRAM_CHAT_ID?: string;
	/** "1" opts into one forum topic per email thread. Unset = plain messages + reply mapping. */
	TELEGRAM_TOPICS?: string;
}
