import type { EmailSendingEvent, EventClassification } from "../cloudflare/email-events";
import { readSendMarker, sentMarkerValue, transactionalSendMarkerKey } from "./mailbox-send-utils";

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
 * How far back from a delivery event we will look for the request it belongs to
 * when the provider id is unrecognised.
 *
 * A `delivered` event lands within seconds; a `bounced` event only after the
 * provider has exhausted its own retry schedule, which runs to about three days
 * at the large receivers. Seven days covers that with margin. It is a ceiling on
 * how stale a claim may be, not a promise that anything within it matches — the
 * uniqueness rule below is what actually decides.
 */
const ENVELOPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Clock skew allowance. `created_at` is our wall clock and `eventTimestamp` is
 * Cloudflare's, so a message can appear to have been created marginally after the
 * event that reports on it.
 */
const ENVELOPE_SKEW_MS = 5 * 60 * 1000;

/**
 * The `created_at` range a delivery event may claim a request from.
 *
 * Exported because the queue consumer narrows the same set in D1 to find which
 * mailbox to route to. Both sides must agree on the bounds or the consumer could
 * offer the DO a candidate the DO will not accept.
 */
export function envelopeCorrelationWindow(
	timestamp: string,
): { notBefore: string; notAfter: string } | null {
	const eventAt = Date.parse(timestamp);
	if (Number.isNaN(eventAt)) return null;
	return {
		notBefore: new Date(eventAt - ENVELOPE_WINDOW_MS).toISOString(),
		notAfter: new Date(eventAt + ENVELOPE_SKEW_MS).toISOString(),
	};
}

export type EnvelopeCorrelation =
	| { outcome: "matched"; requestId: string }
	| { outcome: "no_candidate" }
	| { outcome: "ambiguous"; candidates: number };

/**
 * Finds the transactional request a delivery event belongs to when its
 * `provider_message_id` matches nothing.
 *
 * Cloudflare mints the message id itself and will not let a sender set one — the
 * `Message-ID` header is on its reserved list — and no sender-chosen value
 * survives into the event payload. So when a send throws ambiguously we never
 * learn the id of a message that may well have gone out, and its delivery events
 * arrive unattributable. Sender, recipient and timestamp are all that is left.
 *
 * That would be a weak basis for a guess in general, and is a much stronger one
 * here: an event matching no id at all can only belong to a send we never got an
 * id for, and the only such sends are the ones sitting at `unknown`. Every send
 * that returned normally recorded its id and resolves on the primary path without
 * ever reaching this function. So the candidate set is not "mail to this
 * recipient", it is "sends whose outcome we admit we do not know" — and if more
 * than one of those fits, this refuses rather than picking.
 */
export function correlateEventToUnknownRequest(
	sql: SqlStorage,
	event: { to: string; from: string; timestamp: string },
): EnvelopeCorrelation {
	const window = envelopeCorrelationWindow(event.timestamp);
	if (!window) return { outcome: "no_candidate" };

	// `provider_message_id IS NULL` is the load-bearing clause: a row that already
	// has an id is reachable by the primary path and is never up for adoption.
	const candidates = sql
		.exec<{ request_id: string }>(
			`SELECT request_id
	       FROM transactional_requests
	       WHERE status = 'unknown'
	         AND provider_message_id IS NULL
	         AND created_at >= ?
	         AND created_at <= ?
	         AND lower(sender) = ?
	         AND lower(to_addr) = ?
	       LIMIT 2`,
			window.notBefore,
			window.notAfter,
			event.from.trim().toLowerCase(),
			event.to.trim().toLowerCase(),
		)
		.toArray();

	if (candidates.length === 0) return { outcome: "no_candidate" };
	if (candidates.length > 1) return { outcome: "ambiguous", candidates: candidates.length };
	return { outcome: "matched", requestId: candidates[0]!.request_id };
}

/**
 * What an observed terminal event proves about whether the message left.
 *
 * A bounce or a complaint is not a failure to send — both require that the
 * message was transmitted, and a complaint requires that a person read it. They
 * resolve an ambiguous send to `sent`; the `delivery_status` column carries the
 * bad news separately. A rejection or a pipeline failure is the opposite: the
 * provider never handed it on, so nothing was delivered.
 *
 * Returns null for anything that proves nothing either way.
 */
function statusProvenBy(classification: EventClassification): "sent" | "failed" | null {
	if (!classification.terminal) return null;
	switch (classification.deliveryStatus) {
		case "delivered":
		case "bounced":
		case "complained":
			return "sent";
		case "rejected":
		case "failed":
			return "failed";
		default:
			return null;
	}
}

/**
 * Resolves an ambiguous send from an observed delivery event.
 *
 * This is emphatically not a retry, and the distinction is the whole safety
 * argument: nothing here sends anything. It reads an event describing what
 * already happened to a message that had left without our knowing, and writes
 * down the answer. `resolved_via` records that the answer was inferred, so an
 * operator can always tell it apart from a provider acknowledgement.
 *
 * Returns the status it settled on, or null if the row was not ambiguous.
 */
function resolveAmbiguousRequest(
	sql: SqlStorage,
	requestId: string,
	event: EmailSendingEvent,
	classification: EventClassification,
): "sent" | "failed" | null {
	const row = sql
		.exec<{ status: string; provider_message_id: string | null }>(
			"SELECT status, provider_message_id FROM transactional_requests WHERE request_id = ?",
			requestId,
		)
		.toArray()[0];
	if (row?.status !== "unknown") return null;

	// The first event of any kind, terminal or not, hands us the provider id we
	// never got. Claiming it means every later event for this message — the
	// bounce after the deferral — takes the primary path instead of coming back
	// through correlation.
	if (!row.provider_message_id) {
		sql.exec(
			"UPDATE transactional_requests SET provider_message_id = ?, updated_at = ? WHERE request_id = ?",
			event.provider_message_id,
			new Date().toISOString(),
			requestId,
		);
	}

	const proven = statusProvenBy(classification);
	if (!proven) return null;

	const now = new Date().toISOString();
	sql.exec(
		`UPDATE transactional_requests
	     SET status = ?,
	         resolved_via = 'envelope_correlation',
	         error_code = ?,
	         variables_json = NULL,
	         updated_at = ?
	     WHERE request_id = ? AND status = 'unknown'`,
		proven,
		proven === "failed" ? "permanent_failure" : null,
		now,
		requestId,
	);

	// Keep the at-most-once marker in step with the row. A send that re-entered
	// while the row said `unknown` would consult the marker, and a marker still
	// reading `unknown` after the row says `sent` is the kind of disagreement that
	// eventually sends a second copy.
	const markerKey = transactionalSendMarkerKey(requestId);
	const existingMarker = sql
		.exec<{ value: string }>("SELECT value FROM mailbox_meta WHERE key = ?", markerKey)
		.toArray()[0];
	if (existingMarker && readSendMarker(existingMarker.value).status === "unknown") {
		sql.exec(
			"UPDATE mailbox_meta SET value = ?, updated_at = ? WHERE key = ?",
			proven === "sent"
				? sentMarkerValue(event.provider_message_id)
				: JSON.stringify({ status: "failed", error: "permanent_failure" }),
			now,
			markerKey,
		);
	}

	return proven;
}

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
): { resolvedStatus: "sent" | "failed" | null } {
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

	if (!requestId) return { resolvedStatus: null };

	// Order matters: settle the request's own status first, then stamp the
	// delivery status, so the second write's `updated_at` is the one that stands.
	const resolvedStatus = resolveAmbiguousRequest(sql, requestId, event, classification);
	updateTransactionalRequestDeliveryStatus(sql, requestId, classification.deliveryStatus);
	return { resolvedStatus };
}
