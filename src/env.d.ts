/// <reference types="@cloudflare/workers-types" />

declare interface Env {
	ACCESS_JWT_AUDIENCE?: string;
	ACCESS_TEAM_DOMAIN?: string;
	PHASE0_DEBUG_TOKEN?: string;
	CLOUDFLARE_API_TOKEN?: string;
	/** Account id. Event subscriptions are account-scoped, so provisioning needs it. */
	CLOUDFLARE_ACCOUNT_ID?: string;
	/**
	 * Queue id (not name) that Email Sending feedback events are delivered to.
	 * Configured explicitly rather than looked up so the provisioning token never
	 * needs to read the account's queues. Unset = provisioning skips the feedback
	 * subscription step and says so.
	 */
	FEEDBACK_QUEUE_ID?: string;
	/**
	 * Emergency bootstrap for the owner registry (owner_identities in D1), not the
	 * record itself. Comma-separated owner emails, unioned with whatever the
	 * registry holds. Unset AND an empty registry = /api/* and /mcp deny.
	 */
	ACCESS_ALLOWED_EMAILS?: string;
	/**
	 * Comma-separated domains verified for outbound sending in Cloudflare Email
	 * Sending. A mailbox whose domain is listed sends as itself; anything else
	 * falls back to MAIL_FROM_ADDRESS with Reply-To. See lib/sender-identity.ts.
	 */
	MAIL_SENDING_DOMAINS?: string;
	/** Telegram bot token from @BotFather. Unset = the Telegram bridge is off. */
	TELEGRAM_BOT_TOKEN?: string;
	/**
	 * Emergency bootstrap for the Telegram half of the owner registry: comma-
	 * separated user IDs, unioned with the linked identities in D1. No longer
	 * required with the bot token -- an account is normally linked by sending
	 * `/start <pairing code>`, which is what keeps a personal user id out of this
	 * repository. Set it only to recover a deployment you cannot pair.
	 */
	TELEGRAM_ALLOWED_USER_IDS?: string;
	/**
	 * HMAC-SHA256 pepper for transactional API key hashing.
	 * Must be set when transactional API keys are used. Without it,
	 * API key operations fail closed.
	 */
	TRANSACTIONAL_API_KEY_PEPPER?: string;
}
