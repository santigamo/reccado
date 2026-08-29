/**
 * Everything the bridge needs an hourly heartbeat for, behind one call.
 *
 * One function and not three because the cron's entry point
 * (src/cloudflare/scheduled.ts) is a file this work does not own: every future
 * bridge feature that needs a tick would otherwise be a change to somebody else's
 * sweep. Adding the single line below is the whole integration.
 *
 *     const telegramSweep = await sweepTelegramBridge(env);
 *
 * Never throws: it runs alongside backups and send reconciliation, and a Telegram
 * outage must not abort the rest of the pass.
 */

import { deleteExpiredDraftPreviews } from "./drafts";
import { deleteStaleDigestItems, type DigestOutcome, flushTelegramDigest } from "./noise";

export type TelegramSweep = {
	/** What the morning digest did, if anything was waiting for it. */
	digest: DigestOutcome | { status: "failed"; error: string };
	/** Preview→draft mappings whose 24 hours ran out. */
	expiredDraftPreviews: number;
	/** Digested rows old enough that nobody is still tapping their buttons. */
	expiredDigestItems: number;
};

export async function sweepTelegramBridge(env: Env): Promise<TelegramSweep> {
	// The flush comes first and is the only part that talks to Telegram: mail the
	// operator has not been told about is the one thing here that is worth a
	// failure, and the two deletes must still run when it fails.
	let digest: TelegramSweep["digest"];
	try {
		digest = await flushTelegramDigest(env);
	} catch (error) {
		digest = { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
	const [expiredDraftPreviews, expiredDigestItems] = await Promise.all([
		deleteExpiredDraftPreviews(env.INDEX_DB).catch(() => 0),
		deleteStaleDigestItems(env.INDEX_DB).catch(() => 0),
	]);
	return { digest, expiredDraftPreviews, expiredDigestItems };
}
