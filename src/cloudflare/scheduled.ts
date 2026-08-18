import {
	deleteExpiredTelegramActions,
	insertOpsEvent,
	listMailboxes,
	listStaleSendingOutboundSends,
	updateOutboundSendStatus,
} from "../db/d1";
import { backupManifestR2Key } from "../lib/r2-keys";

// Outbound sends stuck at status="sending" for longer than this are assumed to be
// an interrupted saga (worker crash / DO call that never returned) rather than a
// send still genuinely in flight, and get reconciled by reconcileStaleOutboundSends.
const STALE_SENDING_THRESHOLD_MS = 10 * 60 * 1000;
const STALE_SENDING_SWEEP_LIMIT = 50;

async function reconcileStaleOutboundSends(db: D1Database, scheduledTime: number): Promise<number> {
	const threshold = new Date(scheduledTime - STALE_SENDING_THRESHOLD_MS).toISOString();
	const staleSends = await listStaleSendingOutboundSends(db, threshold, STALE_SENDING_SWEEP_LIMIT);

	for (const send of staleSends) {
		// We can't be certain whether the underlying provider send actually went out,
		// so we don't claim "sent" or "failed". The outcome is potentially ambiguous
		// (the provider may have accepted the message before the worker crashed), so
		// we use "unknown" — the same status that confirmDraftSend writes when the DO
		// returns an ambiguous provider error. This flags the row for human review
		// without auto-retrying or falsely marking it as a definitive failure.
		await updateOutboundSendStatus(db, {
			idempotencyKey: send.idempotency_key,
			status: "unknown",
			errorCode: "stale_sending_timeout_needs_review",
		});
		await insertOpsEvent(db, {
			id: crypto.randomUUID(),
			event_type: "outbound_send.stale_reconciled",
			severity: "warning",
			subject: send.mailbox_id,
			payload_json: JSON.stringify({
				outboundSendId: send.id,
				draftId: send.draft_id,
				idempotencyKey: send.idempotency_key,
				previousStatus: "sending",
				stuckSinceUpdatedAt: send.updated_at,
			}),
		});
	}

	return staleSends.length;
}

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
	const date = new Date(controller.scheduledTime).toISOString().slice(0, 10);
	const mailboxes = await listMailboxes(env.INDEX_DB);

	for (const mailbox of mailboxes) {
		const stub = env.MAILBOX_DO.getByName(mailbox.mailbox_id);
		const exportResponse = await stub.fetch("https://mailbox-do/export-index");
		if (!exportResponse.ok) continue;
		const exported = await exportResponse.text();
		const key = backupManifestR2Key({ date, mailboxId: mailbox.mailbox_id });
		await env.MAIL_OBJECTS.put(key, exported, {
			httpMetadata: { contentType: "application/json" },
		});
	}

	const reconciledSendCount = await reconcileStaleOutboundSends(
		env.INDEX_DB,
		controller.scheduledTime,
	);

	// Expired Telegram confirm buttons: harmless but unbounded if never swept.
	const expiredTelegramActions = await deleteExpiredTelegramActions(env.INDEX_DB);

	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "cron.backup_sweep",
		severity: "info",
		subject: "scheduled",
		payload_json: JSON.stringify({
			cron: controller.cron,
			scheduledTime: new Date(controller.scheduledTime).toISOString(),
			mailboxCount: mailboxes.length,
			reconciledSendCount,
			expiredTelegramActions,
		}),
	});

	console.log("scheduled.tick", {
		cron: controller.cron,
		scheduledTime: new Date(controller.scheduledTime).toISOString(),
		mailboxCount: mailboxes.length,
		reconciledSendCount,
		expiredTelegramActions,
	});
}
