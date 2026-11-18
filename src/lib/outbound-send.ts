import {
	createOutboundSendIfMissing,
	getApproval,
	getMailbox,
	getOutboundSendByIdempotency,
	insertOpsEvent,
	updateOutboundSendAudit,
	updateOutboundSendStatus,
	upsertMessageIndex,
} from "../db/d1";
import { enqueueTelegramCardRefresh } from "../telegram/cards";
import {
	approvalProofSecret,
	type McpApprovalProof,
	type OwnerWebSendProof,
	signMcpApprovalProof,
	signOwnerWebSendProof,
	supersedePendingSendApprovals,
} from "./approvals";
import { AppError } from "./errors";
import { outboundSendIdempotencyKey } from "./idempotency";
import { mailboxStub } from "./mailbox-stub";

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
	hasAttachments?: boolean;
	reason?: string;
	error?: string;
	ownerSentAgentDraft?: boolean;
};

export async function confirmDraftSend(
	env: Env,
	input: {
		mailboxId: string;
		draftId: string;
		attemptKey: string;
		approvalMode?: "human_confirmed" | "telegram_confirmed" | "preauthorized_transactional";
		expectedPayloadHash?: string;
		/**
		 * Set only by the approval service after it has consumed the intent with a
		 * passkey. The web and Telegram callers leave this unset; an `mcp` draft
		 * then cannot send, except from the web with `ownerWebSend` below.
		 */
		approval?: {
			intentId: string;
			payloadHash: string;
			oauthClientId?: string | null;
			tokenSub?: string | null;
			tokenJti?: string | null;
		};
		/**
		 * Set only by the web confirm-send route, after it re-read the owner session
		 * (cookie cache off) and matched the Origin: the owner pressed Send on the
		 * content whose fingerprint the browser carries. It lets the owner send an
		 * agent-written draft directly; the DO still refuses unless that exact
		 * content is what goes out. Telegram and the approval service never set it.
		 */
		ownerWebSend?: { fingerprint: string; actor: string };
	},
): Promise<ConfirmDraftSendResult> {
	const { mailboxId, draftId, attemptKey, approvalMode } = input;
	let approvalProof: McpApprovalProof | null = null;
	let ownerProof: OwnerWebSendProof | null = null;
	if (input.ownerWebSend && input.approval) {
		return { status: 409, body: { id: draftId, sent: false, error: "approval_required" } };
	}
	if (input.approval) {
		if (!input.expectedPayloadHash || input.expectedPayloadHash !== input.approval.payloadHash) {
			return { status: 409, body: { id: draftId, sent: false, error: "approval_required" } };
		}
		const intent = await getApproval(env.INDEX_DB, input.approval.intentId);
		const secret = approvalProofSecret(env);
		if (
			!secret ||
			!intent ||
			intent.decision !== "approved" ||
			!intent.consumed_at ||
			intent.payload_hash !== input.approval.payloadHash ||
			intent.mailbox_id !== mailboxId ||
			intent.draft_id !== draftId
		) {
			return { status: 409, body: { id: draftId, sent: false, error: "approval_required" } };
		}
		approvalProof = await signMcpApprovalProof(secret, {
			intentId: input.approval.intentId,
			mailboxId,
			draftId,
			payloadHash: input.approval.payloadHash,
			exp: Date.now() + 60_000,
		});
	}
	const mailbox = await getMailbox(env.INDEX_DB, mailboxId);
	if (!mailbox) {
		throw new AppError("Mailbox not found", "mailbox_not_found", 404);
	}
	const stub = mailboxStub(env, mailboxId);

	const idempotencyKey = outboundSendIdempotencyKey(draftId, attemptKey);
	if (input.ownerWebSend) {
		const secret = approvalProofSecret(env);
		if (!secret || !/^[a-f0-9]{64}$/.test(input.ownerWebSend.fingerprint)) {
			return { status: 409, body: { id: draftId, sent: false, error: "approval_required" } };
		}
		ownerProof = await signOwnerWebSendProof(secret, {
			mailboxId,
			draftId,
			idempotencyKey,
			fingerprint: input.ownerWebSend.fingerprint,
			exp: Date.now() + 60_000,
		});
	}
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

	if (input.approval && approvalProof) {
		await updateOutboundSendAudit(env.INDEX_DB, {
			idempotencyKey,
			approvalChannel: "mcp_approval",
			intentId: input.approval.intentId,
			payloadHash: input.approval.payloadHash,
			oauthClientId: input.approval.oauthClientId,
			tokenSub: input.approval.tokenSub,
			tokenJti: input.approval.tokenJti,
		});
	}

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
			// Which gate let it through: the hash-bound approval, or the owner's own
			// web send bound to the content the browser showed.
			channel: input.approval ? "mcp_approval" : input.ownerWebSend ? "owner_web" : null,
		}),
	}).catch(() => {
		// Ops event failures must not block sending.
	});

	let response: Response;
	try {
		response = await stub.fetch(`https://mailbox-do/drafts/${draftId}/confirm-send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			// The mailbox's own address and display name travel with the request: the
			// DO has no D1 access, and it decides the whole From/Reply-To rendering
			// from these two values.
			body: JSON.stringify({
				idempotencyKey,
				mailboxAddress: mailbox.primary_address,
				displayName: mailbox.display_name,
				expectedPayloadHash: input.expectedPayloadHash,
				approvalProof,
				ownerProof,
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
			has_attachments: result.hasAttachments ? 1 : 0,
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
		if (result.ownerSentAgentDraft) {
			// The owner sent an agent's draft themselves, from the web, without an
			// approval: recorded apart from an approval send, with what bound it.
			await insertOpsEvent(env.INDEX_DB, {
				id: crypto.randomUUID(),
				event_type: "send.owner_direct_agent_draft",
				severity: "info",
				subject: mailboxId,
				payload_json: JSON.stringify({
					draftId,
					idempotencyKey,
					channel: "owner_web",
					actor: input.ownerWebSend?.actor ?? null,
					contentFingerprint: input.ownerWebSend?.fingerprint ?? null,
				}),
			}).catch(() => undefined);
		}
		// Sent outside an approval: whatever send request is still pending for this
		// draft can never be approved now. The DO would refuse it anyway (the draft
		// is sent); this makes the request read as superseded instead of pending.
		if (!input.approval) {
			await supersedePendingSendApprovals(env, {
				mailboxId,
				draftId,
				reason: "owner_direct_send",
			}).catch(() => undefined);
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
