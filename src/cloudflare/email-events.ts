import { z } from "zod";

/**
 * Cloudflare Email Service Event Subscription official nested format.
 *
 * The queue delivers the JSON as-is; the outer envelope carries
 * { type, source, payload, metadata }.
 */
const cfEmailEventType = z.enum([
	"cf.email.sending.message.delivered",
	"cf.email.sending.message.deferred",
	"cf.email.sending.message.bounced",
	"cf.email.sending.message.rejected",
	"cf.email.sending.message.complained",
	"cf.email.sending.message.failed",
]);

const cfNestedEventSchema = z.object({
	type: cfEmailEventType,
	source: z.object({
		zoneId: z.string().optional(),
		domain: z.string().optional(),
	}),
	payload: z.object({
		eventId: z.string().min(1),
		messageId: z.string().min(1),
		sender: z.string().email(),
		recipient: z.string().email(),
		terminal: z.boolean().optional(),
		delivery: z
			.object({
				status: z.string().optional(),
				code: z.string().optional(),
			})
			.optional(),
		bounce: z
			.object({
				type: z.enum(["hard", "soft"]).optional(),
				category: z.string().optional(),
			})
			.optional(),
		rejection: z
			.object({
				reason: z.string().optional(),
				category: z.string().optional(),
			})
			.optional(),
		complaint: z
			.object({
				type: z.string().optional(),
			})
			.optional(),
		failure: z
			.object({
				reason: z.string().optional(),
				category: z.string().optional(),
			})
			.optional(),
	}),
	metadata: z.object({
		accountId: z.string().optional(),
		eventSubscriptionId: z.string().optional(),
		eventSchemaVersion: z.union([z.string(), z.number()]).optional(),
		eventTimestamp: z.string().min(1),
	}),
});

/**
 * Internal flat event schema.
 *
 * Only safe fields are parsed — never subject, reason, smtp_response, body, auth,
 * or variables. The event_id is used for idempotency.
 *
 * Cloudflare event types:
 *   cf.email.sending.message.delivered
 *   cf.email.sending.message.deferred
 *   cf.email.sending.message.bounced
 *   cf.email.sending.message.rejected
 *   cf.email.sending.message.complained
 *   cf.email.sending.message.failed
 */
export const emailSendingEventSchema = z.object({
	event_id: z.string().min(1),
	event_type: cfEmailEventType,
	provider_message_id: z.string().min(1),
	to: z.string().email(),
	from: z.string().email(),
	timestamp: z.string().min(1),
	// Optional fields are parsed but only the category is relevant — never log reason/smtp_response.
	bounce_type: z.enum(["hard", "soft"]).optional(),
	error_category: z.string().optional(),
	rejection_reason: z.string().optional(),
});

export type EmailSendingEvent = z.infer<typeof emailSendingEventSchema>;

/**
 * Attempts to parse the input as the official Cloudflare nested format, or falls
 * back to the flat format for backward compatibility with test fixtures.
 *
 * Returns null if neither format is valid.
 */
export function normalizeEmailSendingEvent(input: unknown): EmailSendingEvent | null {
	// Try flat format first (backward compat)
	const flat = emailSendingEventSchema.safeParse(input);
	if (flat.success) {
		return flat.data;
	}

	// Try nested official format
	const nested = cfNestedEventSchema.safeParse(input);
	if (!nested.success) {
		return null;
	}

	const { type, payload, metadata } = nested.data;

	// Derive bounce_type from payload.bounce.type
	let bounceType: "hard" | "soft" | undefined;
	if (type === "cf.email.sending.message.bounced" && payload.bounce?.type) {
		bounceType = payload.bounce.type;
	}

	return {
		event_id: payload.eventId,
		event_type: type,
		provider_message_id: payload.messageId,
		to: payload.recipient,
		from: payload.sender,
		timestamp: metadata.eventTimestamp,
		bounce_type: bounceType,
		error_category:
			payload.bounce?.category ??
			payload.rejection?.category ??
			payload.failure?.category ??
			undefined,
		rejection_reason: payload.rejection?.reason ?? undefined,
	};
}

/**
 * Classifies the event for suppression and delivery state.
 * Only hard bounces and complaints create suppressions.
 * Rejected with reason "suppressed" is informational — Cloudflare already suppressed.
 */
export type EventClassification = {
	terminal: boolean;
	suppress: boolean;
	suppressReason: "hard_bounce" | "complaint" | null;
	deliveryStatus:
		| "delivered"
		| "deferred"
		| "bounced"
		| "rejected"
		| "complained"
		| "failed"
		| "unknown";
};

export function classifyEmailEvent(event: EmailSendingEvent): EventClassification {
	switch (event.event_type) {
		case "cf.email.sending.message.delivered":
			return {
				terminal: true,
				suppress: false,
				suppressReason: null,
				deliveryStatus: "delivered",
			};
		case "cf.email.sending.message.deferred":
			return {
				terminal: false,
				suppress: false,
				suppressReason: null,
				deliveryStatus: "deferred",
			};
		case "cf.email.sending.message.bounced":
			// Only hard bounces suppress
			if (event.bounce_type === "hard") {
				return {
					terminal: true,
					suppress: true,
					suppressReason: "hard_bounce",
					deliveryStatus: "bounced",
				};
			}
			// A bounced event is terminal even for a soft bounce: Cloudflare emits it
			// after temporary delivery retries are exhausted. It does not suppress.
			return {
				terminal: true,
				suppress: false,
				suppressReason: null,
				deliveryStatus: "bounced",
			};
		case "cf.email.sending.message.rejected":
			// Rejected means the provider rejected before delivery attempt.
			// For reason "suppressed", Cloudflare already suppressed the recipient upstream.
			// We do NOT suppress arbitrarily rejected recipients — only hard bounces and complaints.
			return {
				terminal: true,
				suppress: false,
				suppressReason: null,
				deliveryStatus: "rejected",
			};
		case "cf.email.sending.message.complained":
			return {
				terminal: true,
				suppress: true,
				suppressReason: "complaint",
				deliveryStatus: "complained",
			};
		case "cf.email.sending.message.failed":
			return {
				terminal: true,
				suppress: false,
				suppressReason: null,
				deliveryStatus: "failed",
			};
	}
}

/**
 * Safe event metadata for logging/ops events.
 * Never includes: subject, reason, smtp_response, body, auth, variables.
 */
export function safeEventMetadata(event: EmailSendingEvent): Record<string, unknown> {
	return {
		event_id: event.event_id,
		event_type: event.event_type,
		provider_message_id: event.provider_message_id,
		to: event.to,
		from: event.from,
		timestamp: event.timestamp,
		bounce_type: event.bounce_type,
	};
}
