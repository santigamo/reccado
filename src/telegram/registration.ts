/**
 * Keeps the Telegram webhook pointed at this deployment, without anyone running a
 * setup script.
 *
 * The old flow was three manual steps -- invent a secret, store it as a worker
 * secret, run `pnpm setup:telegram --apply` -- and skipping any one of them left a
 * bridge that looked configured and delivered nothing. Every input those steps
 * needed is knowable at runtime: the secret is derived from the bot token, and the
 * URL is the origin the worker is already being served on. So the cron reconciles
 * it hourly, the same way it reconciles stale sends: compare what Telegram believes
 * against what is true, and fix the difference.
 *
 * Comparing the URL alone was not enough. A webhook registered with a *stale
 * secret* points at exactly the right URL, so the cron reported ok forever while
 * every update was answered 401 -- the silent death this whole file exists to
 * prevent. But our own record is not enough either: it cannot see a third party
 * re-registering the bot elsewhere, nor Access blocking the route at the edge.
 * So reconciliation combines what we recorded with what Telegram observes, and
 * where they disagree the observation wins.
 */

import {
	getRuntimeConfig,
	getTelegramWebhookRegistration,
	RUNTIME_CONFIG_KEYS,
	setTelegramWebhookObservation,
	setTelegramWebhookRegistration,
	type TelegramWebhookObservation,
	type TelegramWebhookRegistration,
} from "../db/runtime-config";
import { insertOpsEvent } from "../db/d1";
import {
	deriveWebhookSecret,
	deriveWebhookSecretFingerprint,
	getWebhookInfo,
	readTelegramConfig,
	setWebhook,
	TELEGRAM_ALLOWED_UPDATES,
} from "./api";
import { reconcileTelegramCommands } from "./commands";
import { ensureOwnerPairingCode } from "./operators";

/** Why the cron decided the live registration was not the one we want. */
export type WebhookRegistrationCause =
	/** Telegram is delivering somewhere else entirely. */
	| "url_drift"
	/** No record of us ever registering -- includes every deployment that predates this record. */
	| "registration_unrecorded"
	/** The bot token changed, so the secret derived from it did too. */
	| "secret_rotated"
	/** Telegram is failing to deliver, and the failures are newer than our registration. */
	| "delivery_errors"
	/**
	 * The live subscription is missing an update kind this build acts on.
	 *
	 * Its own cause because nothing else can see it: allowed_updates is not part of
	 * the secret, so a deploy that starts handling a new kind of update leaves every
	 * existing deployment subscribed to the old list, pointed at the right URL, with
	 * the right secret, reporting ok forever while Telegram simply never sends the
	 * updates. Exactly the silent death this file exists to prevent, one field over.
	 */
	| "allowed_updates_drift";

export type WebhookReconciliation =
	| { status: "skipped"; reason: "bridge_disabled" | "origin_unknown" }
	| { status: "ok"; url: string }
	| {
			status: "registered";
			url: string;
			previousUrl: string;
			cause: WebhookRegistrationCause;
	  }
	| { status: "failed"; error: string };

export function telegramWebhookUrl(origin: string): string {
	return `${origin.replace(/\/$/, "")}/telegram/webhook`;
}

/**
 * Telegram stamps last_error_date with its own clock, we stamp registeredAt with
 * ours. A couple of minutes of tolerance keeps a registration from being judged
 * against an error that merely looks newer.
 */
const CLOCK_SKEW_MS = 120_000;

/**
 * True when delivery failures are newer than the registration they would condemn.
 *
 * Only the *date* is ever compared. The message is stored and displayed, never
 * branched on: "Wrong response from the webhook: 401 Unauthorized" is prose
 * Telegram owns and can reword, and a bridge whose self-healing depends on that
 * wording breaks the day it changes -- silently, which is the failure mode this
 * whole mechanism exists to remove.
 *
 * The comparison also survives either behaviour of setWebhook, documented or not:
 * if Telegram clears the error, there is nothing to compare; if it keeps it, the
 * stale date falls behind the new registeredAt and the state returns to normal on
 * its own. Only errors that keep happening keep the date moving forward.
 */
export function hasDeliveryErrorSinceRegistration(
	registration: TelegramWebhookRegistration,
	lastErrorAt: string | null,
): boolean {
	if (!lastErrorAt) return false;
	const errorMs = Date.parse(lastErrorAt);
	if (!Number.isFinite(errorMs)) return false;
	return errorMs > Date.parse(registration.registeredAt) + CLOCK_SKEW_MS;
}

/**
 * True when the live subscription cannot deliver something this build handles.
 *
 * An absent list is Telegram's default, which is a superset of everything we ask
 * for -- so absence is agreement, not drift, and treating it as drift would
 * re-register on every single pass.
 */
export function hasAllowedUpdatesDrift(observed: string[] | undefined): boolean {
	if (!observed) return false;
	const live = new Set(observed);
	return TELEGRAM_ALLOWED_UPDATES.some((update) => !live.has(update));
}

/** Null means the live registration is the one we want; leave it alone. */
function registrationCause(input: {
	observedUrl: string;
	wantedUrl: string;
	registration: TelegramWebhookRegistration | null;
	fingerprint: string;
	lastErrorAt: string | null;
	allowedUpdates: string[] | undefined;
}): WebhookRegistrationCause | null {
	if (input.observedUrl !== input.wantedUrl) return "url_drift";
	if (hasAllowedUpdatesDrift(input.allowedUpdates)) return "allowed_updates_drift";
	// No record at all is the blind spot itself: every deployment registered before
	// this record existed lands here once, and heals.
	if (!input.registration) return "registration_unrecorded";
	if (input.registration.fingerprint !== input.fingerprint) return "secret_rotated";
	if (hasDeliveryErrorSinceRegistration(input.registration, input.lastErrorAt)) {
		return "delivery_errors";
	}
	return null;
}

/**
 * Never throws: this runs inside the cron sweep alongside backups and send
 * reconciliation, and a Telegram outage must not abort the rest of it.
 */
export async function reconcileTelegramWebhook(env: Env): Promise<WebhookReconciliation> {
	const config = readTelegramConfig(env);
	if (!config) {
		return { status: "skipped", reason: "bridge_disabled" };
	}

	// Before the origin check, and before anything that can bail out: a deployment
	// with no operator is a deployment whose only way to get one is a /start the
	// webhook has to be alive to receive, and the code that /start carries has to
	// exist by the time the operator goes looking for it.
	await ensureOwnerPairingCode(env);

	// Reconciled from inside this function rather than beside it in the cron, and
	// deliberately before the origin check: the "/" menu is state living in
	// Telegram exactly like the webhook is, it does not depend on knowing our own
	// hostname, and the cron's entry point is not ours to add a second call to.
	// Best effort — a menu that failed to update must not stop the webhook that
	// carries the mail from being repaired.
	const commands = await reconcileTelegramCommands(env);
	if (commands.status === "registered" || commands.status === "failed") {
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type:
				commands.status === "registered"
					? "telegram.commands_registered"
					: "telegram.commands_registration_failed",
			severity: commands.status === "registered" ? "info" : "warning",
			subject: "telegram",
			payload_json: JSON.stringify(commands),
		}).catch(() => undefined);
	}

	const origin = await getRuntimeConfig(env.INDEX_DB, RUNTIME_CONFIG_KEYS.deploymentOrigin);
	if (!origin) {
		// Nobody has loaded the authenticated UI yet, so the worker genuinely does
		// not know its own public hostname. Registering against a guess would be
		// worse than waiting.
		return { status: "skipped", reason: "origin_unknown" };
	}

	const url = telegramWebhookUrl(origin);
	try {
		const info = await getWebhookInfo(config);
		const lastErrorAt =
			typeof info.last_error_date === "number" && Number.isFinite(info.last_error_date)
				? new Date(info.last_error_date * 1000).toISOString()
				: null;
		const observation: TelegramWebhookObservation = {
			url: info.url,
			lastErrorAt,
			lastErrorMessage: info.last_error_message ?? null,
			pendingUpdateCount: info.pending_update_count ?? 0,
			observedAt: new Date().toISOString(),
		};
		// Written on every pass, healthy ones included: /api/health answers from this
		// row precisely so it never has to wait on api.telegram.org.
		await setTelegramWebhookObservation(env.INDEX_DB, observation);

		const [registration, fingerprint] = await Promise.all([
			getTelegramWebhookRegistration(env.INDEX_DB),
			deriveWebhookSecretFingerprint(config.botToken),
		]);
		const cause = registrationCause({
			observedUrl: info.url,
			wantedUrl: url,
			registration,
			fingerprint,
			lastErrorAt,
			allowedUpdates: info.allowed_updates,
		});
		if (!cause) {
			return { status: "ok", url };
		}

		// Order matters: register first, record second. Recording first and then
		// failing the setWebhook would write a claim that was never true, and the
		// next pass would trust it -- recreating the blind spot with our own hands.
		// Failing the other way round is harmless: setWebhook is idempotent, so a D1
		// write that dies here just means the next pass re-registers.
		await setWebhook(config, { url, secret: await deriveWebhookSecret(config.botToken) });
		await setTelegramWebhookRegistration(env.INDEX_DB, {
			fingerprint,
			registeredAt: new Date().toISOString(),
			url,
		});
		return { status: "registered", url, previousUrl: info.url, cause };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}
