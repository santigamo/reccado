import type { EmailSendingEvent, EventClassification } from "../cloudflare/email-events";

type SqlStorage = DurableObjectState["storage"]["sql"];

/**
 * Checks if a recipient is suppressed in the local mailbox DO mirror.
 * Normalizes to lowercase before lookup.
 */
export function isRecipientSuppressed(
	sql: SqlStorage,
	recipient: string,
): { suppressed: boolean; reason: string | null } {
	const normalized = recipient.trim().toLowerCase();
	const row = sql
		.exec<{ reason: string; expires_at: string | null }>(
			"SELECT reason, expires_at FROM recipient_suppressions WHERE email = ?",
			normalized,
		)
		.toArray()[0];
	if (!row) return { suppressed: false, reason: null };
	// Check expiry
	if (row.expires_at && new Date(row.expires_at) <= new Date()) {
		return { suppressed: false, reason: null };
	}
	return { suppressed: true, reason: row.reason };
}

/**
 * Adds a suppression entry atomically. Idempotent on email.
 */
export function addSuppression(
	sql: SqlStorage,
	email: string,
	reason: "hard_bounce" | "complaint" | "manual" | "provider_rejected",
	sourceEventId: string | null,
	expiresAt: string | null,
): void {
	const now = new Date().toISOString();
	sql.exec(
		`INSERT OR IGNORE INTO recipient_suppressions
     (email, reason, source_event_id, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
		email.trim().toLowerCase(),
		reason,
		sourceEventId,
		now,
		now,
		expiresAt,
	);
}

/**
 * Removes a suppression entry. Only 'manual' suppressions may be removed
 * through the admin endpoint. Hard bounces and complaints from the provider
 * require explicit safe-policy override.
 * Returns true if a row was removed.
 */
export function removeSuppression(
	sql: SqlStorage,
	email: string,
	allowProviderRemoval: boolean,
): boolean {
	const normalized = email.trim().toLowerCase();
	if (!allowProviderRemoval) {
		// Only remove manual suppressions
		const result = sql.exec(
			"DELETE FROM recipient_suppressions WHERE email = ? AND reason = 'manual'",
			normalized,
		);
		return result.rowsWritten > 0;
	}
	// Explicit safe-policy override: remove any suppression
	const result = sql.exec("DELETE FROM recipient_suppressions WHERE email = ?", normalized);
	return result.rowsWritten > 0;
}

/**
 * Lists all current suppressions (non-expired).
 */
export function listSuppressions(
	sql: SqlStorage,
): Array<{ email: string; reason: string; created_at: string; expires_at: string | null }> {
	return sql
		.exec(
			`SELECT email, reason, created_at, expires_at
       FROM recipient_suppressions
       WHERE expires_at IS NULL OR expires_at > ?
       ORDER BY created_at DESC`,
			new Date().toISOString(),
		)
		.toArray() as Array<{
		email: string;
		reason: string;
		created_at: string;
		expires_at: string | null;
	}>;
}

/**
 * Records a delivery event idempotently by event_id.
 */
export function recordDeliveryEvent(
	sql: SqlStorage,
	event: {
		eventId: string;
		requestId: string | null;
		providerMessageId: string;
		recipient: string;
		eventType: string;
		terminal: boolean;
	},
): boolean {
	const now = new Date().toISOString();
	const result = sql.exec(
		`INSERT OR IGNORE INTO transactional_delivery_events
     (event_id, request_id, provider_message_id, recipient, event_type, terminal, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.eventId,
		event.requestId,
		event.providerMessageId,
		event.recipient.trim().toLowerCase(),
		event.eventType,
		event.terminal ? 1 : 0,
		now,
	);
	return result.rowsWritten > 0;
}

/**
 * Updates the delivery status on a transactional request row.
 * Only updates safe fields: provider_message_id, delivery_status, delivery_event_at.
 * Does NOT touch payload_hash, variables_json, client_idempotency_key.
 */
export function updateTransactionalRequestDeliveryStatus(
	sql: SqlStorage,
	requestId: string,
	deliveryStatus: string,
): boolean {
	const now = new Date().toISOString();
	const result = sql.exec(
		`UPDATE transactional_requests
	     SET delivery_status = ?,
	         delivery_event_at = ?,
	         updated_at = ?
	     WHERE request_id = ?`,
		deliveryStatus,
		now,
		now,
		requestId,
	);
	return result.rowsWritten > 0;
}

/**
 * Handles a classified Email Sending event: suppresses if needed, records delivery event.
 * Returns the request_id if one was resolved, or null.
 */
/**
 * How long a provider-originated suppression lasts.
 *
 * A hard bounce and a complaint look alike in the event stream and are not alike
 * at all. A hard bounce is a fact about a mailbox at a moment in time — the
 * address did not exist, or the server refused it — and mailboxes get recreated,
 * domains change hands, and typos get corrected. Ninety days is long enough that
 * a genuinely dead address is not retried into a reputation problem, and short
 * enough that an address which came back to life is reachable again without an
 * operator noticing and intervening.
 *
 * A complaint is not a fact about a mailbox, it is a statement of intent by a
 * person: they marked this mail as spam. Intent does not expire on a schedule, so
 * a complaint suppression is permanent and only an explicit, owner-authorized
 * removal lifts it.
 */
const HARD_BOUNCE_SUPPRESSION_DAYS = 90;

export function suppressionExpiryFor(
	reason: "hard_bounce" | "complaint" | "manual" | "provider_rejected",
	now: Date = new Date(),
): string | null {
	if (reason !== "hard_bounce") return null;
	return new Date(now.getTime() + HARD_BOUNCE_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function handleDeliveryEvent(
	sql: SqlStorage,
	event: EmailSendingEvent,
	classification: EventClassification,
	requestId: string | null,
): void {
	// Record the delivery event (idempotent by event_id)
	recordDeliveryEvent(sql, {
		eventId: event.event_id,
		requestId,
		providerMessageId: event.provider_message_id,
		recipient: event.to,
		eventType: event.event_type,
		terminal: classification.terminal,
	});

	// Suppress if hard bounce or complaint
	if (classification.suppress && classification.suppressReason) {
		addSuppression(
			sql,
			event.to,
			classification.suppressReason,
			event.event_id,
			suppressionExpiryFor(classification.suppressReason),
		);
	}

	// Update transactional request delivery status if we have a request_id
	if (requestId) {
		updateTransactionalRequestDeliveryStatus(sql, requestId, classification.deliveryStatus);
	}
}
