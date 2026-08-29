/**
 * Config the worker writes for itself, in D1 rather than in the deploy manifest.
 *
 * The rule that decides what belongs here: if the system can observe the value,
 * asking a human to transcribe it into wrangler.jsonc and redeploy is a bug, not
 * configuration. Trust declarations (who may drive the bot) and external
 * credentials (the bot token) stay outside -- a system that decides on its own
 * whom to trust is a vulnerability, not a convenience.
 */

const nowIso = () => new Date().toISOString();

export const RUNTIME_CONFIG_KEYS = {
	/** Chat that receives new-mail cards, adopted on first /start. */
	telegramChatId: "telegram.chat_id",
	/**
	 * "1" when the adopted chat is a forum supergroup, so new-mail cards go into
	 * one topic per mailbox instead of a flat message stream.
	 *
	 * Observed with getChat when the operator sends /start, not declared: whether a
	 * chat has topics is a fact about that chat, and asking a human to transcribe
	 * it into a var is how the answer silently drifts from reality. Cached here
	 * because the notifier must not spend a Bot API call per email to re-ask on a
	 * path Telegram rate-limits.
	 */
	telegramChatIsForum: "telegram.chat_is_forum",
	/**
	 * What *we* last registered with Telegram: URL, when, and the fingerprint of
	 * the secret used. One JSON value rather than three keys so the three facts
	 * can never be half-updated -- a fingerprint that belongs to a different
	 * registration than its timestamp would make the comparison lie.
	 */
	telegramWebhookRegistration: "telegram.webhook_registration",
	/** What *Telegram* last told us about that webhook. See the observation type. */
	telegramWebhookObservation: "telegram.webhook_observation",
	/** Public origin this deployment is served on, observed from real traffic. */
	deploymentOrigin: "deployment.origin",
} as const;

export type RuntimeConfigKey = (typeof RUNTIME_CONFIG_KEYS)[keyof typeof RUNTIME_CONFIG_KEYS];

/** The registration this deployment performed, as evidence against drift. */
export type TelegramWebhookRegistration = {
	/** Names the secret in force without being usable as one. */
	fingerprint: string;
	/** ISO instant of the setWebhook call that succeeded. */
	registeredAt: string;
	url: string;
};

/**
 * Telegram's own account of the webhook, refreshed on every cron pass -- including
 * the passes where nothing is wrong, because "the last look was clean" is itself
 * the fact /api/health needs in order to answer without calling Telegram.
 */
export type TelegramWebhookObservation = {
	url: string;
	/** ISO instant of Telegram's last failed delivery, null when it reported none. */
	lastErrorAt: string | null;
	lastErrorMessage: string | null;
	pendingUpdateCount: number;
	observedAt: string;
};

/**
 * Reads a JSON-valued key, treating anything unparseable as absent.
 *
 * These values are only ever written by this worker, so corruption means a bug or
 * a hand-edited row -- and in both cases the caller's "no record yet" branch
 * (re-register, report nothing observed) is the correct recovery. Throwing from
 * inside a cron sweep or a health check to punish a malformed row would not be.
 */
async function getJsonRuntimeConfig<T>(
	db: D1Database,
	key: RuntimeConfigKey,
	parse: (value: unknown) => T | null,
): Promise<T | null> {
	const raw = await getRuntimeConfig(db, key);
	if (!raw) return null;
	try {
		return parse(JSON.parse(raw));
	} catch {
		return null;
	}
}

const isIsoInstant = (value: unknown): value is string =>
	typeof value === "string" && Number.isFinite(Date.parse(value));

export async function getTelegramWebhookRegistration(
	db: D1Database,
): Promise<TelegramWebhookRegistration | null> {
	return getJsonRuntimeConfig(db, RUNTIME_CONFIG_KEYS.telegramWebhookRegistration, (value) => {
		if (typeof value !== "object" || value === null) return null;
		const record = value as Record<string, unknown>;
		// registeredAt must be comparable: an unparseable date would silently defeat
		// the "errors newer than the registration" check it exists to feed.
		if (typeof record.fingerprint !== "string" || !record.fingerprint) return null;
		if (!isIsoInstant(record.registeredAt)) return null;
		if (typeof record.url !== "string") return null;
		return {
			fingerprint: record.fingerprint,
			registeredAt: record.registeredAt,
			url: record.url,
		};
	});
}

export async function setTelegramWebhookRegistration(
	db: D1Database,
	registration: TelegramWebhookRegistration,
): Promise<void> {
	await setRuntimeConfig(
		db,
		RUNTIME_CONFIG_KEYS.telegramWebhookRegistration,
		JSON.stringify(registration),
	);
}

export async function getTelegramWebhookObservation(
	db: D1Database,
): Promise<TelegramWebhookObservation | null> {
	return getJsonRuntimeConfig(db, RUNTIME_CONFIG_KEYS.telegramWebhookObservation, (value) => {
		if (typeof value !== "object" || value === null) return null;
		const record = value as Record<string, unknown>;
		if (typeof record.url !== "string") return null;
		if (!isIsoInstant(record.observedAt)) return null;
		return {
			url: record.url,
			lastErrorAt: isIsoInstant(record.lastErrorAt) ? record.lastErrorAt : null,
			lastErrorMessage:
				typeof record.lastErrorMessage === "string" ? record.lastErrorMessage : null,
			pendingUpdateCount:
				typeof record.pendingUpdateCount === "number" && Number.isFinite(record.pendingUpdateCount)
					? record.pendingUpdateCount
					: 0,
			observedAt: record.observedAt,
		};
	});
}

export async function setTelegramWebhookObservation(
	db: D1Database,
	observation: TelegramWebhookObservation,
): Promise<void> {
	await setRuntimeConfig(
		db,
		RUNTIME_CONFIG_KEYS.telegramWebhookObservation,
		JSON.stringify(observation),
	);
}

export async function getRuntimeConfig(
	db: D1Database,
	key: RuntimeConfigKey,
): Promise<string | null> {
	const row = await db
		.prepare(`SELECT value FROM runtime_config WHERE key = ?`)
		.bind(key)
		.first<{ value: string }>();
	return row?.value ?? null;
}

export async function setRuntimeConfig(
	db: D1Database,
	key: RuntimeConfigKey,
	value: string,
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		)
		.bind(key, value, nowIso())
		.run();
}

/**
 * First write wins, and the winner is returned.
 *
 * Adoption must not be a last-write-wins race: an allowlisted operator who sends
 * /start from a group they were added to would otherwise silently move every
 * future new-mail card out of the chat they actually watch. The caller compares
 * the returned value against what it tried to claim to tell the two cases apart.
 */
export async function adoptRuntimeConfig(
	db: D1Database,
	key: RuntimeConfigKey,
	value: string,
): Promise<string> {
	await db
		.prepare(
			`INSERT INTO runtime_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO NOTHING`,
		)
		.bind(key, value, nowIso())
		.run();
	// Re-read rather than trusting the insert: on conflict the row that survives
	// is the one another request wrote, which is exactly what the caller needs.
	return (await getRuntimeConfig(db, key)) ?? value;
}

/**
 * Remembers the public origin this worker is served on, so the cron can keep the
 * Telegram webhook registered without anyone configuring a URL.
 *
 * Recorded ONLY from a request that already cleared Cloudflare Access on a public
 * https origin. `request.url` is built from the Host header, which any client can
 * forge -- and this value decides where Telegram is told to deliver updates, so an
 * unauthenticated request that could write here would be able to redirect the
 * operator's mail notifications to a host of its choosing. Gating on Access means
 * only the operator's own authenticated browser, on the real hostname, can set it.
 */
export async function recordDeploymentOrigin(db: D1Database, requestUrl: string): Promise<void> {
	let url: URL;
	try {
		url = new URL(requestUrl);
	} catch {
		return;
	}
	if (url.protocol !== "https:") return;
	if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return;
	// Skip the write when nothing changed: this runs on every authenticated API
	// request, and D1 writes are not free.
	if ((await getRuntimeConfig(db, RUNTIME_CONFIG_KEYS.deploymentOrigin)) === url.origin) return;
	await setRuntimeConfig(db, RUNTIME_CONFIG_KEYS.deploymentOrigin, url.origin);
}
