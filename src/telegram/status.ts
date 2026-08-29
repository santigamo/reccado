/**
 * What the Telegram bridge believes about itself, as a value.
 *
 * The bridge sat dead in production for days: TELEGRAM_WEBHOOK_SECRET was never
 * set, readTelegramConfig threw on every inbound email, and the notifier caught
 * the throw and moved on so that Telegram could not break mail ingest. Not
 * failing the request was right. Failing *silently* was not -- the error went to
 * console.error, which nobody reads, and nothing else in the system knew.
 *
 * So the state is reified here and surfaced in /api/health and `pnpm doctor`,
 * exactly as getAccessConfigStatus already does for Access. Degrading to a named
 * mode is the standard; degrading to a mute broken one is the bug.
 *
 * Everything here is read from D1. Deliberately: /api/health is what a monitor
 * polls to decide whether this worker is alive, and making that answer depend on
 * a third party's latency and uptime would turn a Telegram outage into a
 * degraded Reccado. The cron already looks at Telegram hourly and writes down
 * what it saw; this reads the note.
 */

import {
	getRuntimeConfig,
	getTelegramWebhookObservation,
	getTelegramWebhookRegistration,
	RUNTIME_CONFIG_KEYS,
} from "../db/runtime-config";
import { readTelegramConfig } from "./api";
import { resolveTelegramOperators } from "./operators";
import { hasDeliveryErrorSinceRegistration, telegramWebhookUrl } from "./registration";

export type TelegramStatus = {
	/**
	 * off: no bot token, bridge intentionally disabled.
	 * failing: fully set up, but Telegram is failing to deliver updates that were
	 * sent after our last registration -- the mode that used to read as "on".
	 */
	mode: "off" | "partial" | "on" | "failing";
	ok: boolean;
	/** What is still needed before new mail reaches Telegram. */
	missing: string[];
	reason: string | null;
	/** Where updates should be delivered, once the origin is known. */
	webhookUrl: string | null;
	/**
	 * Updates Telegram is holding for us. Null until the cron has looked once.
	 * A number that climbs is the same failure the error message describes, seen
	 * from the other side -- and it keeps counting when the message is generic.
	 */
	pendingUpdateCount: number | null;
};

export async function getTelegramStatus(env: Env): Promise<TelegramStatus> {
	const config = readTelegramConfig(env);
	if (!config) {
		return {
			mode: "off",
			ok: true,
			missing: [],
			reason: "Telegram bridge is disabled until TELEGRAM_BOT_TOKEN is set.",
			webhookUrl: null,
			pendingUpdateCount: null,
		};
	}

	const [origin, adoptedChat, registration, observation, operators] = await Promise.all([
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.deploymentOrigin),
		getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.telegramChatId),
		getTelegramWebhookRegistration(env.INDEX_DB),
		getTelegramWebhookObservation(env.INDEX_DB),
		resolveTelegramOperators(env),
	]);

	const missing: string[] = [];
	// A token with nobody linked is exactly what "partial" was always for. It used
	// to arrive here as a thrown config error, which said the same thing in a
	// shape that cost the caller a try/catch and told the operator to edit a file.
	if (operators.size === 0) {
		missing.push("linked operator (send /start <pairing code> to the bot)");
	}
	if (!origin) {
		missing.push("deployment origin (load the authenticated UI once so the cron can register)");
	}
	if (!adoptedChat) {
		missing.push("adopted chat (send /start to the bot from a linked account)");
	}

	const webhookUrl = origin ? telegramWebhookUrl(origin) : null;
	const pendingUpdateCount = observation?.pendingUpdateCount ?? null;

	if (missing.length > 0) {
		return {
			mode: "partial",
			ok: false,
			missing,
			reason: `Telegram bridge is configured but not yet delivering: ${missing.join("; ")}.`,
			webhookUrl,
			pendingUpdateCount,
		};
	}

	// No registration or no observation yet means the cron has not completed a pass
	// on this deployment; that is a gap in knowledge, not a fault, and raising an
	// alarm for it would train the operator to ignore this field.
	if (
		registration &&
		observation &&
		hasDeliveryErrorSinceRegistration(registration, observation.lastErrorAt)
	) {
		const message = observation.lastErrorMessage ?? "no message reported";
		return {
			mode: "failing",
			ok: false,
			missing: [],
			reason:
				`Telegram is failing to deliver webhook updates since ${observation.lastErrorAt}: ` +
				`${message} (${pendingUpdateCount ?? 0} update(s) pending).`,
			webhookUrl,
			pendingUpdateCount,
		};
	}

	return {
		mode: "on",
		ok: true,
		missing: [],
		reason: null,
		webhookUrl,
		pendingUpdateCount,
	};
}
