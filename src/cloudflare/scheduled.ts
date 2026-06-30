import { listMailboxes } from "../db/d1";
import { backupManifestR2Key } from "../lib/r2-keys";
import { insertOpsEvent } from "../db/d1";

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

	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "cron.backup_sweep",
		severity: "info",
		subject: "scheduled",
		payload_json: JSON.stringify({
			cron: controller.cron,
			scheduledTime: new Date(controller.scheduledTime).toISOString(),
			mailboxCount: mailboxes.length,
		}),
	});

	console.log("scheduled.tick", {
		cron: controller.cron,
		scheduledTime: new Date(controller.scheduledTime).toISOString(),
		mailboxCount: mailboxes.length,
	});
}
