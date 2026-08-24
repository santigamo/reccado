import type { TransactionalApiKeyRecord } from "../lib/transactional-keys";
import { verifyApiKey, parseApiKey } from "../lib/transactional-keys";
import {
	type TransactionalSendContext,
	transactionalRequestSchema,
	interpolateTemplate,
	validateTemplateVariables,
	checkRecipientPolicy,
	transactionalPayloadHash,
	type TransactionalSendResult,
	type TransactionalResponseStatus,
} from "../lib/transactional-send";
import { isAmbiguousProviderError } from "../lib/outbound-classification";
import { AmbiguousSendError } from "../lib/errors";
import {
	extractProviderMessageId,
	readSendMarker,
	sentMarkerValue,
	rowToApiKeyRecord,
} from "./mailbox-send-utils";

const IDEMPOTENCY_KEY_PREFIX = "txn:v1:";

/**
 * Gets an API key record from DO sqlite by keyId.
 */
export function getApiKeyRecord(
	sql: DurableObjectState["storage"]["sql"],
	keyId: string,
): TransactionalApiKeyRecord | null {
	const row = sql.exec("SELECT * FROM api_keys WHERE key_id = ?", keyId).toArray()[0] as
		| Record<string, unknown>
		| undefined;
	if (!row) return null;
	const record = rowToApiKeyRecord(row);
	return record as TransactionalApiKeyRecord;
}

/**
 * Authenticates and authorizes a transactional API key from the Authorization header,
 * then executes the send if all gates pass.
 *
 * This is the canonical auth path — authorization is always DO-authoritative,
 * never D1-dependent. Scopes, status, expiry, mailbox binding, template allowlist,
 * recipient policy, quotas, and idempotency are all checked in the DO.
 *
 * The request record is inserted BEFORE the provider call (status 'pending') so
 * the idempotency key is reserved atomically. After the provider call the record
 * transitions to 'sent', 'unknown', or 'failed'. Raw provider error messages are
 * NEVER stored — only a stable error_category string.
 */
export async function handleTransactionalSend(
	ctx: TransactionalSendContext,
	pepper: string,
	request: {
		mailboxId: string;
		authHeader: string | null;
		idempotencyKeyHeader: string | null;
		body: unknown;
	},
): Promise<TransactionalSendResult> {
	// 1-2. Parse Authorization header
	if (!request.authHeader?.startsWith("Bearer ")) {
		return { status: "rejected", requestId: "", keyId: "", error: "missing_authorization" };
	}
	const rawKey = request.authHeader.slice("Bearer ".length).trim();
	if (!rawKey) {
		return { status: "rejected", requestId: "", keyId: "", error: "missing_authorization" };
	}

	// 3. Parse the API key
	const parsed = parseApiKey(rawKey);
	if (!parsed) {
		return { status: "rejected", requestId: "", keyId: "", error: "invalid_api_key" };
	}
	const activeKeyId = parsed.keyId;

	// 4. Look up the key record in DO sqlite
	const record = getApiKeyRecord(ctx.sql, activeKeyId);
	if (!record) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "invalid_api_key" };
	}

	// 5. Verify key belongs to this mailbox
	if (record.mailboxId !== request.mailboxId) {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: "key_does_not_belong_to_mailbox",
		};
	}

	// 6. Verify the key hash (cryptographic auth)
	const verified = await verifyApiKey(pepper, rawKey, record);
	if (!verified) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "invalid_api_key" };
	}

	// 7. Check required scope
	if (!record.scopes.includes("transactional:send")) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "insufficient_scope" };
	}

	// 8. Check scope for template use (template key is implied by the send action)
	if (!record.scopes.includes("transactional:templates:use")) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "insufficient_scope" };
	}

	// 9. Reject test environment keys in the production send path.
	if (record.environment === "test") {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: "test_key_not_allowed_in_production_send",
		};
	}

	// 10. Check expiry
	if (record.expiresAt && new Date(record.expiresAt) <= new Date()) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "key_expired" };
	}

	// 11. Check status
	if (record.status === "revoked") {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "key_revoked" };
	}

	// 12. Parse idempotency key (required)
	const clientIdempotencyKey = request.idempotencyKeyHeader?.trim();
	if (!clientIdempotencyKey || clientIdempotencyKey.length < 1) {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: "idempotency_key_required",
		};
	}
	if (clientIdempotencyKey.length > 255) {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: "idempotency_key_too_long",
		};
	}

	// 13. Validate request body
	const parsedBody = transactionalRequestSchema.safeParse(request.body);
	if (!parsedBody.success) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "invalid_request_body" };
	}
	const { template: templateId, to, variables } = parsedBody.data;

	// 14. Check template allowlist
	//     Null/empty = no template allowed (explicit allowlist required for creation).
	if (!record.templateAllowlist || record.templateAllowlist.length === 0) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "template_not_allowed" };
	}
	if (!record.templateAllowlist.includes(templateId)) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "template_not_allowed" };
	}

	// 15. Check template exists
	const template = getTemplate(ctx.sql, request.mailboxId, templateId);
	if (!template) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "template_not_found" };
	}

	// 16. Validate template variables
	const varValidation = validateTemplateVariables(template, variables);
	if (!varValidation.ok) {
		const reasons: string[] = [];
		if (varValidation.missing.length > 0) reasons.push("missing_variables");
		if (varValidation.unknown.length > 0) reasons.push("unknown_variables");
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: reasons.join(",") };
	}

	// 17. Interpolate template — may fail (e.g. CR/LF in subject)
	const interpolated = interpolateTemplate(template, variables);
	if (!interpolated) {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: "template_interpolation_failed",
		};
	}

	// 18. Check recipient policy
	const policyCheck = checkRecipientPolicy(to, record.recipientPolicy);
	if (!policyCheck.allowed) {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: policyCheck.reason ?? "recipient_not_allowed",
		};
	}

	// 18a. Check local suppression list before sending
	const { isRecipientSuppressed } = await import("./mailbox-suppressions");
	const suppressionCheck = isRecipientSuppressed(ctx.sql, to);
	if (suppressionCheck.suppressed) {
		return {
			status: "rejected",
			requestId: "",
			keyId: activeKeyId,
			error: "recipient_suppressed",
		};
	}

	// 19. Compute payload hash for idempotency
	const payloadHash = await transactionalPayloadHash({
		keyId: parsed.keyId,
		clientIdempotencyKey,
		template: templateId,
		to,
		variables,
	});

	// 20. Idempotency check — atomic reservation
	const requestId = crypto.randomUUID();
	const now = new Date().toISOString();
	const fromAddress = record.sender;

	// Check for existing request
	const existingRequest = getTransactionalRequest(ctx.sql, parsed.keyId, clientIdempotencyKey);
	if (existingRequest) {
		if (existingRequest.payload_hash === payloadHash) {
			return {
				status: mapDbStatusToResponse(existingRequest.status),
				requestId: existingRequest.request_id,
				keyId: activeKeyId,
				providerMessageId: existingRequest.provider_message_id,
			};
		}
		return {
			status: "idempotency_conflict",
			requestId: existingRequest.request_id,
			keyId: activeKeyId,
			error: "idempotency_key_already_used_with_different_payload",
		};
	}

	// 21. Atomic: reserve idempotency + charge quota inside transactionSync
	let quotaAllowed = true;
	ctx.transactionSync(() => {
		// Double-check inside transaction (no concurrent DO call, but safety)
		const innerExisting = getTransactionalRequest(ctx.sql, parsed.keyId, clientIdempotencyKey);
		if (innerExisting) return; // will be caught by the post-check

		// Check and increment quotas atomically with the insert
		const quotaOk = checkAndIncrementQuota(ctx.sql, record, parsed.keyId);
		if (!quotaOk.allowed) {
			quotaAllowed = false;
			return;
		}

		// Insert BEFORE provider call with status 'pending'
		insertTransactionalRequest(ctx.sql, {
			request_id: requestId,
			key_id: parsed.keyId,
			client_idempotency_key: clientIdempotencyKey,
			payload_hash: payloadHash,
			status: "pending",
			to_addr: to,
			template_id: templateId,
			variables_json: JSON.stringify(variables),
			sender: fromAddress,
			provider_message_id: null,
			error_code: null,
			created_at: now,
			updated_at: now,
		});
	});

	if (!quotaAllowed) {
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "quota_exceeded" };
	}

	// Verify the insert happened (handles the case where double-check found existing)
	const insertedRequest = getTransactionalRequest(ctx.sql, parsed.keyId, clientIdempotencyKey);
	if (!insertedRequest) {
		// This can happen if the inner double-check found an existing request.
		// Re-check for existing and handle accordingly.
		const reExisting = getTransactionalRequest(ctx.sql, parsed.keyId, clientIdempotencyKey);
		if (reExisting) {
			if (reExisting.payload_hash === payloadHash) {
				return {
					status: mapDbStatusToResponse(reExisting.status),
					requestId: reExisting.request_id,
					keyId: activeKeyId,
					providerMessageId: reExisting.provider_message_id,
				};
			}
			return {
				status: "idempotency_conflict",
				requestId: reExisting.request_id,
				keyId: activeKeyId,
				error: "idempotency_key_already_used_with_different_payload",
			};
		}
		return { status: "rejected", requestId: "", keyId: activeKeyId, error: "internal_error" };
	}

	// 22. Execute the send
	const doSendResult = await doTransactionalSend(
		ctx,
		requestId,
		parsed.keyId,
		clientIdempotencyKey,
		{
			to,
			from: fromAddress,
			subject: interpolated.subject,
			bodyText: interpolated.body_text,
			bodyHtml: interpolated.body_html,
		},
	);

	// 23. Update the request record post-send — store ONLY stable error category, not raw PII
	const errorCategory = doSendResult.errorCategory ?? null;
	ctx.sql.exec(
		"UPDATE transactional_requests SET status = ?, provider_message_id = ?, error_code = ?, updated_at = ? WHERE request_id = ?",
		doSendResult.status,
		doSendResult.providerMessageId,
		errorCategory,
		new Date().toISOString(),
		requestId,
	);

	return {
		status: doSendResult.status,
		requestId,
		keyId: activeKeyId,
		providerMessageId: doSendResult.providerMessageId,
		error: doSendResult.errorCategory,
	};
}

type DoSendParams = {
	to: string;
	from: string;
	subject: string;
	bodyText: string | null;
	bodyHtml: string | null;
};

/**
 * Executes the actual provider send. Provider error messages are NEVER stored;
 * only a stable error category string is returned.
 */
async function doTransactionalSend(
	ctx: TransactionalSendContext,
	requestId: string,
	_keyId: string,
	_clientIdempotencyKey: string,
	params: DoSendParams,
): Promise<{
	status: TransactionalResponseStatus;
	providerMessageId: string | null;
	errorCategory?: string;
}> {
	const idempotencyKey = `${IDEMPOTENCY_KEY_PREFIX}${requestId}`;

	// Check for existing sent marker (idempotency across DO retries)
	const sentMarker = ctx.sql
		.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = ?", idempotencyKey)
		.toArray()[0];
	if (sentMarker) {
		const marker = readSendMarker(sentMarker.value);
		if (marker.status === "sent") {
			return { status: "sent", providerMessageId: marker.providerMessageId };
		}
		if (marker.status === "unknown") {
			return { status: "unknown", providerMessageId: null, errorCategory: "ambiguous" };
		}
		if (marker.status === "failed") {
			return {
				status: "permanent_failure",
				providerMessageId: null,
				errorCategory: "permanent_failure",
			};
		}
	}

	// Reserve the send marker atomically
	try {
		ctx.sql.exec(
			"INSERT INTO mailbox_meta (key, value, updated_at) VALUES (?, 'sending', ?)",
			idempotencyKey,
			new Date().toISOString(),
		);
	} catch {
		// Concurrent caller already reserved — return duplicate
		return { status: "sent", providerMessageId: null };
	}

	// Execute the send through the shared EMAIL engine
	let providerMessageId: string | null = null;
	try {
		const providerResult = await ctx.email.send({
			from: params.from,
			to: [params.to],
			subject: params.subject,
			text: params.bodyText ?? undefined,
			html: params.bodyHtml ?? undefined,
		});
		providerMessageId = extractProviderMessageId(providerResult);
	} catch (error) {
		// Classify and store a REDACTED error category — never raw messages/PII
		if (error instanceof AmbiguousSendError || isAmbiguousProviderError(error)) {
			ctx.sql.exec(
				"UPDATE mailbox_meta SET value = ?, updated_at = ? WHERE key = ?",
				JSON.stringify({ status: "unknown", error: "ambiguous" }),
				new Date().toISOString(),
				idempotencyKey,
			);
			return { status: "unknown", providerMessageId: null, errorCategory: "ambiguous" };
		}
		ctx.sql.exec(
			"UPDATE mailbox_meta SET value = ?, updated_at = ? WHERE key = ?",
			JSON.stringify({ status: "failed", error: "permanent_failure" }),
			new Date().toISOString(),
			idempotencyKey,
		);
		return {
			status: "permanent_failure",
			providerMessageId: null,
			errorCategory: "permanent_failure",
		};
	}

	// Success
	ctx.sql.exec(
		"UPDATE mailbox_meta SET value = ?, updated_at = ? WHERE key = ?",
		sentMarkerValue(providerMessageId),
		new Date().toISOString(),
		idempotencyKey,
	);

	return { status: "sent", providerMessageId };
}

// --- Quota management ---

function checkAndIncrementQuota(
	sql: DurableObjectState["storage"]["sql"],
	record: TransactionalApiKeyRecord,
	keyId: string,
): { allowed: boolean; reason?: string } {
	const now = new Date();

	// Per-minute rate limit
	const minuteWindow = now.toISOString().slice(0, 16);
	const minuteCount = getUsageCount(sql, keyId, `rate:minute:${minuteWindow}`);
	if (minuteCount >= 60) {
		return { allowed: false, reason: "rate_limit_exceeded" };
	}

	// Daily quota
	if (record.quotaMax != null && record.quotaMax > 0) {
		const dayWindow = now.toISOString().slice(0, 10);
		const dayCount = getUsageCount(sql, keyId, `quota:daily:${dayWindow}`);
		if (dayCount >= record.quotaMax) {
			return { allowed: false, reason: "daily_quota_exceeded" };
		}
	}

	// Increment counters
	incrementUsage(sql, keyId, `rate:minute:${minuteWindow}`, now);
	if (record.quotaMax != null && record.quotaMax > 0) {
		const dayWindow = now.toISOString().slice(0, 10);
		incrementUsage(sql, keyId, `quota:daily:${dayWindow}`, now);
	}

	return { allowed: true };
}

function getUsageCount(
	sql: DurableObjectState["storage"]["sql"],
	keyId: string,
	windowKey: string,
): number {
	const row = sql
		.exec<{ value: number }>(
			"SELECT value FROM api_key_usage WHERE key_id = ? AND window_key = ?",
			keyId,
			windowKey,
		)
		.toArray()[0];
	return row ? Number(row.value) : 0;
}

function incrementUsage(
	sql: DurableObjectState["storage"]["sql"],
	keyId: string,
	windowKey: string,
	now: Date,
): void {
	sql.exec(
		`INSERT INTO api_key_usage (key_id, window_key, value, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(key_id, window_key) DO UPDATE SET value = value + 1, updated_at = ?`,
		keyId,
		windowKey,
		now.toISOString(),
		now.toISOString(),
	);
}

// --- Template CRUD ---

export function createTemplate(
	sql: DurableObjectState["storage"]["sql"],
	mailboxId: string,
	input: {
		id: string;
		subject: string;
		body_text?: string | null;
		body_html?: string | null;
	},
): void {
	const now = new Date().toISOString();
	sql.exec(
		`INSERT INTO templates (id, mailbox_id, subject, body_text, body_html, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
		input.id,
		mailboxId,
		input.subject,
		input.body_text ?? null,
		input.body_html ?? null,
		now,
		now,
	);
}

export function listTemplates(sql: DurableObjectState["storage"]["sql"], mailboxId: string) {
	return sql
		.exec(
			"SELECT * FROM templates WHERE mailbox_id = ? AND status = 'active' ORDER BY updated_at DESC",
			mailboxId,
		)
		.toArray();
}

export function getTemplate(
	sql: DurableObjectState["storage"]["sql"],
	mailboxId: string,
	templateId: string,
): { id: string; subject: string; body_text: string | null; body_html: string | null } | null {
	const row = sql
		.exec<{
			id: string;
			subject: string;
			body_text: string | null;
			body_html: string | null;
			status: string;
		}>(
			"SELECT id, subject, body_text, body_html, status FROM templates WHERE id = ? AND mailbox_id = ?",
			templateId,
			mailboxId,
		)
		.toArray()[0];
	if (row?.status !== "active") return null;
	return { id: row.id, subject: row.subject, body_text: row.body_text, body_html: row.body_html };
}

export function archiveTemplate(
	sql: DurableObjectState["storage"]["sql"],
	mailboxId: string,
	templateId: string,
): boolean {
	const now = new Date().toISOString();
	const result = sql.exec(
		"UPDATE templates SET status = 'archived', updated_at = ? WHERE id = ? AND mailbox_id = ?",
		now,
		templateId,
		mailboxId,
	);
	return result.rowsWritten > 0;
}

// --- Transactional request CRUD ---

function getTransactionalRequest(
	sql: DurableObjectState["storage"]["sql"],
	keyId: string,
	clientIdempotencyKey: string,
): {
	request_id: string;
	payload_hash: string;
	status: string;
	provider_message_id: string | null;
} | null {
	return (
		sql
			.exec<{
				request_id: string;
				payload_hash: string;
				status: string;
				provider_message_id: string | null;
			}>(
				"SELECT request_id, payload_hash, status, provider_message_id FROM transactional_requests WHERE key_id = ? AND client_idempotency_key = ?",
				keyId,
				clientIdempotencyKey,
			)
			.toArray()[0] ?? null
	);
}

function insertTransactionalRequest(
	sql: DurableObjectState["storage"]["sql"],
	row: {
		request_id: string;
		key_id: string;
		client_idempotency_key: string;
		payload_hash: string;
		status: string;
		to_addr: string;
		template_id: string | null;
		variables_json: string | null;
		sender: string;
		provider_message_id: string | null;
		error_code: string | null;
		created_at: string;
		updated_at: string;
	},
): void {
	sql.exec(
		`INSERT OR REPLACE INTO transactional_requests
     (request_id, key_id, client_idempotency_key, payload_hash, status,
      to_addr, template_id, variables_json, sender,
      provider_message_id, error_code, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		row.request_id,
		row.key_id,
		row.client_idempotency_key,
		row.payload_hash,
		row.status,
		row.to_addr,
		row.template_id,
		row.variables_json,
		row.sender,
		row.provider_message_id,
		row.error_code,
		row.created_at,
		row.updated_at,
	);
}

function mapDbStatusToResponse(dbStatus: string): TransactionalResponseStatus {
	switch (dbStatus) {
		case "sent":
			return "sent";
		case "duplicate":
			return "duplicate";
		case "failed":
			return "permanent_failure";
		case "unknown":
			return "unknown";
		case "rejected":
			return "rejected";
		case "pending":
			return "accepted";
		default:
			return "unknown";
	}
}

// --- Ops event logging (best-effort D1, never blocks response) ---

/**
 * Maps a transactional send result status/error to a stable ops event payload.
 * Never logs: raw Authorization, plaintext key, variables, body, idempotency key,
 * or raw provider error messages. Only safe metadata.
 */
export function transactionalOpsEventPayload(
	mailboxId: string,
	keyId: string,
	result: TransactionalSendResult,
): {
	event_type: string;
	severity: "info" | "warning" | "error";
	subject: string;
	payload_json: string;
} {
	const eventType =
		result.status === "rejected" || result.status === "idempotency_conflict"
			? "transactional.request_rejected"
			: result.status === "sent"
				? "transactional.request_sent"
				: result.status === "permanent_failure"
					? "transactional.request_failed"
					: result.status === "unknown"
						? "transactional.request_ambiguous"
						: "transactional.request_accepted";

	const severity: "info" | "warning" | "error" =
		result.status === "permanent_failure"
			? "error"
			: result.status === "unknown" || result.status === "idempotency_conflict"
				? "warning"
				: "info";

	return {
		event_type: eventType,
		severity,
		subject: mailboxId,
		payload_json: JSON.stringify({
			mailboxId,
			keyId,
			requestId: result.requestId || undefined,
			status: result.status,
			error: result.error || undefined,
			// Never include: rawKey, keyHash, variables, body, idempotencyKey, providerMessageId, raw provider errors
		}),
	};
}

/**
 * Fires a transactional ops event to D1 (best-effort, fire-and-forget).
 * Called from the DO route handler after handleTransactionalSend returns.
 */
export function fireTransactionalOpsEvent(
	mailboxId: string,
	keyId: string,
	result: TransactionalSendResult,
): {
	event_type: string;
	severity: "info" | "warning" | "error";
	subject: string;
	payload_json: string;
} {
	return transactionalOpsEventPayload(mailboxId, keyId, result);
}

/**
 * Maps a transactional request DO row to a D1 projection row.
 * Never includes: variables_json, payload_hash, client_idempotency_key.
 */
export function makeTransactionalRequestLogRow(
	mailboxId: string,
	row: {
		request_id: string;
		key_id: string;
		status: string;
		to_addr: string;
		template_id: string | null;
		sender: string;
		provider_message_id: string | null;
		error_code: string | null;
		delivery_status: string | null;
		delivery_event_at: string | null;
		created_at: string;
		updated_at: string;
	},
): {
	request_id: string;
	key_id: string;
	mailbox_id: string;
	status: string;
	to_addr: string;
	template_id: string | null;
	sender: string;
	provider_message_id: string | null;
	error_code: string | null;
	delivery_status: string | null;
	delivery_event_at: string | null;
	created_at: string;
	updated_at: string;
} {
	return {
		request_id: row.request_id,
		key_id: row.key_id,
		mailbox_id: mailboxId,
		status: row.status,
		to_addr: row.to_addr,
		template_id: row.template_id,
		sender: row.sender,
		provider_message_id: row.provider_message_id,
		error_code: row.error_code,
		delivery_status: row.delivery_status ?? null,
		delivery_event_at: row.delivery_event_at ?? null,
		created_at: row.created_at,
		updated_at: row.updated_at,
	};
}

/**
 * Reconcilies transactional requests that are stuck at "pending" or "sending"
 * (crashed/interrupted DO saga). Marks them "unknown" and returns the counts.
 * This is an explicit admin endpoint — never auto-retry.
 */
export function reconcileStaleTransactionalRequests(
	sql: DurableObjectState["storage"]["sql"],
	olderThanIso: string,
): { reconciled: number; stillSending: number } {
	const staleRequests = sql
		.exec<{ request_id: string; key_id: string; status: string; created_at: string }>(
			"SELECT request_id, key_id, status, created_at FROM transactional_requests WHERE status IN ('pending', 'sending') AND updated_at < ?",
			olderThanIso,
		)
		.toArray();

	for (const req of staleRequests) {
		sql.exec(
			"UPDATE transactional_requests SET status = 'unknown', error_code = 'stale_reconciled', updated_at = ? WHERE request_id = ?",
			new Date().toISOString(),
			req.request_id,
		);
	}

	return { reconciled: staleRequests.length, stillSending: 0 };
}

// --- Status lookup ---

export function getTransactionalRequestStatus(
	sql: DurableObjectState["storage"]["sql"],
	requestId: string,
	keyId: string,
): {
	status: string;
	providerMessageId: string | null;
	createdAt: string;
	errorCode: string | null;
	deliveryStatus: string | null;
	deliveryEventAt: string | null;
} | null {
	const row =
		sql
			.exec<{
				status: string;
				provider_message_id: string | null;
				created_at: string;
				error_code: string | null;
				delivery_status: string | null;
				delivery_event_at: string | null;
			}>(
				"SELECT status, provider_message_id, created_at, error_code, delivery_status, delivery_event_at FROM transactional_requests WHERE request_id = ? AND key_id = ?",
				requestId,
				keyId,
			)
			.toArray()[0] ?? null;
	if (!row) return null;
	return {
		status: row.status,
		providerMessageId: row.provider_message_id,
		createdAt: row.created_at,
		errorCode: row.error_code,
		deliveryStatus: row.delivery_status,
		deliveryEventAt: row.delivery_event_at,
	};
}
