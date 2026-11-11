import { parseAdmin } from "./errors";
import type { AuthContext } from "../../api/auth";
import { assertAdminAccess } from "./access";
import { adminMailboxActionSchema } from "../../api/schemas";
import {
	deleteMessageIndexForMailbox,
	getMailbox,
	insertOpsEvent,
	listIngestFailures,
	listOpsEvents,
	upsertMessageIndex,
} from "../../db/d1";
import { AdminError } from "./errors";
import { mailboxStub } from "../mailbox-stub";
import { backupManifestR2Key } from "../r2-keys";
import { requireMailboxOwner } from "./access";

export async function opsEvents(env: Env, actor: AuthContext) {
	assertAdminAccess(env, actor, "");
	return { events: await listOpsEvents(env.INDEX_DB) };
}
export async function dlq(env: Env, actor: AuthContext) {
	assertAdminAccess(env, actor, "");
	return {
		note: "Cloudflare DLQ messages are inspected via dashboard or wrangler; ingest failures listed here.",
		ingestFailures: await listIngestFailures(env.INDEX_DB),
	};
}
export async function listOpsPage(
	env: Env,
	actor: AuthContext,
	input: {
		kind: "events" | "dlq";
		limit: number;
		offset: number;
		eventType?: string;
		mailboxId?: string;
	},
) {
	assertAdminAccess(env, actor, "");
	if (input.kind === "events") {
		const filters: string[] = [];
		const binds: Array<string | number> = [];
		if (input.eventType) {
			filters.push("event_type = ?");
			binds.push(input.eventType);
		}
		if (input.mailboxId) {
			filters.push("(subject = ? OR instr(payload_json, ?) > 0)");
			binds.push(input.mailboxId, `"mailbox_id":"${input.mailboxId}"`);
		}
		const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
		return {
			events:
				(
					await env.INDEX_DB.prepare(
						`SELECT * FROM ops_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
					)
						.bind(...binds, input.limit, input.offset)
						.all()
				).results ?? [],
		};
	}
	const mailboxFilter = input.mailboxId ? "AND mailbox_id = ?" : "";
	const statement = env.INDEX_DB.prepare(
		`SELECT * FROM ingest_events WHERE status = 'failed' ${mailboxFilter} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
	);
	const bound = input.mailboxId
		? statement.bind(input.mailboxId, input.limit, input.offset)
		: statement.bind(input.limit, input.offset);
	return {
		ingestFailures: (await bound.all()).results ?? [],
		note: "Cloudflare DLQ messages are inspected via dashboard or wrangler; ingest failures listed here.",
	};
}
export async function reconcile(env: Env, actor: AuthContext, input: { mailboxId: string }) {
	await requireMailboxOwner(env, actor, input.mailboxId);
	if (!(await getMailbox(env.INDEX_DB, input.mailboxId)))
		throw new AdminError("Mailbox not found", "mailbox_not_found", 404);
	const response = await mailboxStub(env, input.mailboxId).fetch(
		"https://mailbox-do/transactional/reconcile-stale",
		{ method: "POST" },
	);
	if (!response.ok) throw new AdminError("Reconcile failed", "reconcile_failed", 500, false);
	const result = (await response.json()) as {
		mailboxId: string;
		reconciled: number;
		stillSending: number;
	};
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "transactional.reconcile_stale",
		severity: "info",
		subject: input.mailboxId,
		payload_json: JSON.stringify({
			reconciled: result.reconciled,
			stillSending: result.stillSending,
		}),
	});
	return result;
}
export async function reindex(env: Env, actor: AuthContext, input: unknown) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(adminMailboxActionSchema, input);
	const response = await mailboxStub(env, body.mailboxId).fetch("https://mailbox-do/export-index");
	if (!response.ok) throw new AdminError("Export failed", "export_failed", 500, false);
	const exported = (await response.json()) as {
		messages: Array<{
			message_local_id: string;
			thread_id: string;
			rfc_message_id: string | null;
			subject: string | null;
			from_addr: string;
			to_json: string;
			snippet: string | null;
			received_at: string;
			has_attachments: number;
			state: string;
			raw_r2_key: string;
			raw_sha256: string;
		}>;
	};
	await deleteMessageIndexForMailbox(env.INDEX_DB, body.mailboxId);
	for (const row of exported.messages)
		await upsertMessageIndex(env.INDEX_DB, {
			mailbox_id: body.mailboxId,
			message_local_id: row.message_local_id,
			thread_id: row.thread_id,
			rfc_message_id: row.rfc_message_id,
			subject: row.subject,
			from_addr: row.from_addr,
			to_json: row.to_json,
			snippet: row.snippet,
			received_at: row.received_at,
			has_attachments: row.has_attachments,
			labels_json: "[]",
			state: row.state as "inbox" | "archive" | "trash" | "sent" | "draft",
			raw_r2_key: row.raw_r2_key,
			raw_sha256: row.raw_sha256,
			updated_at: new Date().toISOString(),
		});
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "admin.reindex",
		severity: "info",
		subject: body.mailboxId,
		payload_json: JSON.stringify({ count: exported.messages.length }),
	});
	return { ok: true, count: exported.messages.length };
}
export async function backup(env: Env, actor: AuthContext, input: unknown) {
	assertAdminAccess(env, actor, "");
	const body = parseAdmin(adminMailboxActionSchema, input);
	const date = new Date().toISOString().slice(0, 10);
	const response = await mailboxStub(env, body.mailboxId).fetch("https://mailbox-do/export-index");
	if (!response.ok) throw new AdminError("Export failed", "export_failed", 500, false);
	const exported = await response.json();
	const key = backupManifestR2Key({ date, mailboxId: body.mailboxId });
	await env.MAIL_OBJECTS.put(key, JSON.stringify(exported, null, 2), {
		httpMetadata: { contentType: "application/json" },
	});
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "backup.completed",
		severity: "info",
		subject: body.mailboxId,
		payload_json: JSON.stringify({ key }),
	});
	return { ok: true, key };
}
