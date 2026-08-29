import {
	createOutboundSendIfMissing,
	getMailbox,
	getOutboundSendByIdempotency,
	insertOpsEvent,
	updateOutboundSendStatus,
	upsertMessageIndex,
} from "../db/d1";
import { enqueueTelegramCardRefresh } from "../telegram/cards";
import { AppError } from "./errors";
import { outboundSendIdempotencyKey } from "./idempotency";

/**
 * The one path that turns a confirmed draft into sent mail.
 *
 * Every surface that can send — the web UI, and the Telegram bridge — goes through
 * here, so the D1 outbound_sends ledger, the message index and the idempotency
 * rules are identical no matter who pressed the button. Adding a second sender
 * that talks to the Durable Object directly would mean a send that the ops views
 * cannot see.
 */

export type ConfirmDraftSendResult = {
	status: number;
	body: Record<string, unknown>;
};

type DoSendResult = {
	sent?: boolean;
	status?: string;
	messageLocalId?: string;
	threadId?: string;
	duplicate?: boolean;
	providerMessageId?: string | null;
	rfcMessageId?: string | null;
	subject?: string | null;
	fromAddr?: string;
	toJson?: string;
	snippet?: string | null;
	receivedAt?: string;
	rawR2Key?: string;
	rawSha256?: string;
	reason?: string;
	error?: string;
};

export async function confirmDraftSend(
	env: Env,
	input: {
		mailboxId: string;
		draftId: string;
		attemptKey: string;
		approvalMode?: "human_confirmed" | "telegram_confirmed" | "preauthorized_transactional";
	},
): Promise<ConfirmDraftSendResult> {
	const { mailboxId, draftId, attemptKey, approvalMode } = input;
	const mailbox = await getMailbox(env.INDEX_DB, mailboxId);
	if (!mailbox) {
		throw new AppError("Mailbox not found", "mailbox_not_found", 404);
	}
	const stub = env.MAILBOX_DO.getByName(mailboxId);

	const idempotencyKey = outboundSendIdempotencyKey(draftId, attemptKey);
	const existingSend = await getOutboundSendByIdempotency(env.INDEX_DB, idempotencyKey);
	if (existingSend?.status === "sent") {
		return {
			status: 200,
			body: {
				id: draftId,
				status: "sent",
				sent: false,
				duplicate: true,
				providerMessageId: existingSend.provider_message_id,
			},
		};
	}

	// Atomic D1 gate: INSERT OR IGNORE on the unique idempotency_key.
	// Only the first caller to INSERT gets true and may proceed to the DO.
	const created = await createOutboundSendIfMissing(env.INDEX_DB, {
		id: crypto.randomUUID(),
		mailbox_id: mailboxId,
		draft_id: draftId,
		idempotency_key: idempotencyKey,
		status: "sending",
		approval_mode: approvalMode ?? "human_confirmed",
	});

	if (!created) {
		// Another caller already holds this idempotency key. Re-fetch to see current status.
		const existingRow = await getOutboundSendByIdempotency(env.INDEX_DB, idempotencyKey);
		if (existingRow) {
			if (existingRow.status === "sent") {
				return {
					status: 200,
					body: {
						id: draftId,
						status: "sent",
						sent: false,
						duplicate: true,
						providerMessageId: existingRow.provider_message_id,
					},
				};
			}
			if (existingRow.status === "sending") {
				// Another caller has the sending gate. Don't call the DO or overwrite D1.
				return {
					status: 200,
					body: {
						id: draftId,
						status: "sending",
						sent: false,
						duplicate: true,
						reason: "already_sending",
					},
				};
			}
			// For "failed"/"unknown" rows, the caller may retry — fall through to the DO.
		}
	}

	// Record the approval provenance event for the D1 ops view.
	await insertOpsEvent(env.INDEX_DB, {
		id: crypto.randomUUID(),
		event_type: "send.confirmed",
		severity: "info",
		subject: mailboxId,
		payload_json: JSON.stringify({
			draftId,
			idempotencyKey,
			approvalMode: approvalMode ?? "human_confirmed",
		}),
	}).catch(() => {
		// Ops event failures must not block sending.
	});

	let response: Response;
	try {
		response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/confirm-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// The mailbox's own address travels with the request: the DO has no D1
			// access, and it decides From/Reply-To from this value.
			body: JSON.stringify({
				idempotencyKey,
				mailboxAddress: mailbox.primary_address,
			}),
		});
	} catch (error) {
		await updateOutboundSendStatus(env.INDEX_DB, {
			idempotencyKey,
			status: "failed",
			errorCode: error instanceof Error ? error.message.slice(0, 120) : "send_failed",
		});
		throw error;
	}

	if (!response.ok) {
		await updateOutboundSendStatus(env.INDEX_DB, {
			idempotencyKey,
			status: "failed",
			errorCode: `http_${response.status}`,
		});
		let body: Record<string, unknown>;
		try {
			body = (await response.json()) as Record<string, unknown>;
		} catch {
			body = { error: `send_failed_http_${response.status}` };
		}
		return { status: response.status, body };
	}

	const result = (await response.json()) as DoSendResult;

	if (result.sent && result.messageLocalId) {
		await updateOutboundSendStatus(env.INDEX_DB, {
			idempotencyKey,
			status: "sent",
			providerMessageId: result.providerMessageId ?? idempotencyKey,
			errorCode: null,
		});
		await upsertMessageIndex(env.INDEX_DB, {
			mailbox_id: mailboxId,
			message_local_id: result.messageLocalId,
			thread_id: result.threadId ?? result.messageLocalId,
			// Indexing the sent Message-ID is what lets a cross-mailbox lookup find
			// the outbound half of a conversation.
			rfc_message_id: result.rfcMessageId ?? null,
			subject: result.subject ?? null,
			from_addr: result.fromAddr ?? mailbox.primary_address,
			to_json: result.toJson ?? "[]",
			snippet: result.snippet ?? null,
			received_at: result.receivedAt ?? new Date().toISOString(),
			has_attachments: 0,
			labels_json: "[]",
			state: "sent",
			raw_r2_key: result.rawR2Key ?? `sent/${draftId}`, // gitleaks:allow (field name trips generic-api-key; no secret here)
			raw_sha256: result.rawSha256 ?? idempotencyKey,
			updated_at: new Date().toISOString(),
		});
		// The card that announced this conversation in Telegram still offers to
		// answer it. Whichever surface just did — this function is the only one that
		// can send — is the one fact that card is missing. Best effort and never
		// throwing: a chat bridge must not be able to fail a send that already left.
		if (result.threadId) {
			await enqueueTelegramCardRefresh(env, {
				mailboxId,
				messageLocalId: null,
				threadId: result.threadId,
				status: "replied",
			});
		}
	} else if (result.error === "ambiguous") {
		// Ambiguous provider outcome — the provider may have accepted the message.
		// Record D1 status as "unknown" (not "failed") so ops can reconcile
		// manually. No automatic re-delivery. Skip the message index to avoid
		// showing a phantom message row.
		await updateOutboundSendStatus(env.INDEX_DB, {
			idempotencyKey,
			status: "unknown",
			errorCode: result.reason ?? "ambiguous",
		});
		await insertOpsEvent(env.INDEX_DB, {
			id: crypto.randomUUID(),
			event_type: "send.ambiguous",
			severity: "warning",
			subject: mailboxId,
			payload_json: JSON.stringify({
				draftId,
				idempotencyKey,
				approvalMode: approvalMode ?? "human_confirmed",
				reason: result.reason ?? null,
			}),
		});
	} else if (result.duplicate) {
		await updateOutboundSendStatus(env.INDEX_DB, {
			idempotencyKey,
			status: result.status === "sending" ? "sending" : "sent",
			providerMessageId:
				result.status === "sending" ? null : (result.providerMessageId ?? idempotencyKey),
			errorCode: null,
		});
	} else {
		await updateOutboundSendStatus(env.INDEX_DB, {
			idempotencyKey,
			status: "failed",
			errorCode: result.reason ?? "not_sent",
		});
	}

	return { status: response.status, body: result as Record<string, unknown> };
}
