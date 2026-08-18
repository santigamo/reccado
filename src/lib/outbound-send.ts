import {
	createOutboundSendIfMissing,
	getMailbox,
	getOutboundSendByIdempotency,
	updateOutboundSendStatus,
	upsertMessageIndex,
} from "../db/d1";
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
};

export async function confirmDraftSend(
	env: Env,
	input: { mailboxId: string; draftId: string; attemptKey: string },
): Promise<ConfirmDraftSendResult> {
	const { mailboxId, draftId, attemptKey } = input;
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

	await createOutboundSendIfMissing(env.INDEX_DB, {
		id: crypto.randomUUID(),
		mailbox_id: mailboxId,
		draft_id: draftId,
		idempotency_key: idempotencyKey,
		status: "sending",
	});

	let response: Response;
	try {
		response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/confirm-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// The mailbox's own address travels with the request: the DO has no D1
			// access, and it decides From/Reply-To from this value.
			body: JSON.stringify({
				idempotencyKey: attemptKey,
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
