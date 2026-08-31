import { describe, expect, it } from "vitest";
import {
	classifyEmailEvent,
	emailSendingEventSchema,
	normalizeEmailSendingEvent,
	safeEventMetadata,
	type EmailSendingEvent,
} from "#/cloudflare/email-events";
import { suppressionExpiryFor } from "#/do/mailbox-suppressions";

// ---------------------------------------------------------------------------
// DO route / suppression integration tests
// ---------------------------------------------------------------------------
// These tests validate the complete normalize→classify→safeEventMetadata
// pipeline for the official Cloudflare nested format, simulating the same
// transformation that runs in the queue consumer and DO.
// ---------------------------------------------------------------------------

describe("DO delivery event pipeline (normalize → classify → safe)", () => {
	const makeEvent = (overrides: Partial<EmailSendingEvent> = {}): EmailSendingEvent => ({
		event_id: "evt_001",
		event_type: "cf.email.sending.message.delivered",
		provider_message_id: "pm_001",
		to: "user@example.com",
		from: "sender@myapp.com",
		timestamp: "2026-01-15T10:00:00Z",
		...overrides,
	});

	it("round-trips hard bounce through normalize→classify", () => {
		const nested = {
			type: "cf.email.sending.message.bounced" as const,
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_001",
				messageId: "pm_001",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: true,
				bounce: { type: "hard" as const, category: "rejected" },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		const normalized = normalizeEmailSendingEvent(nested);
		expect(normalized).not.toBeNull();
		expect(normalized!.bounce_type).toBe("hard");

		const classification = classifyEmailEvent(normalized!);
		expect(classification.suppress).toBe(true);
		expect(classification.suppressReason).toBe("hard_bounce");
		expect(classification.deliveryStatus).toBe("bounced");
		expect(classification.terminal).toBe(true);
	});

	it("round-trips soft bounce through normalize→classify", () => {
		const nested = {
			type: "cf.email.sending.message.bounced" as const,
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_002",
				messageId: "pm_002",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: false,
				bounce: { type: "soft" as const },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		const normalized = normalizeEmailSendingEvent(nested);
		expect(normalized).not.toBeNull();
		expect(normalized!.bounce_type).toBe("soft");

		const classification = classifyEmailEvent(normalized!);
		expect(classification.suppress).toBe(false);
		expect(classification.deliveryStatus).toBe("bounced");
		expect(classification.terminal).toBe(true);
	});

	it("round-trips delivered through normalize→classify", () => {
		const nested = {
			type: "cf.email.sending.message.delivered" as const,
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_003",
				messageId: "pm_003",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: true,
				delivery: { status: "ok" },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		const normalized = normalizeEmailSendingEvent(nested);
		expect(normalized).not.toBeNull();
		expect(normalized!.event_type).toBe("cf.email.sending.message.delivered");

		const classification = classifyEmailEvent(normalized!);
		expect(classification.suppress).toBe(false);
		expect(classification.deliveryStatus).toBe("delivered");
		expect(classification.terminal).toBe(true);
	});

	it("round-trips complaint through normalize→classify", () => {
		const nested = {
			type: "cf.email.sending.message.complained" as const,
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_004",
				messageId: "pm_004",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: true,
				complaint: { type: "abuse" },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		const normalized = normalizeEmailSendingEvent(nested);
		expect(normalized).not.toBeNull();

		const classification = classifyEmailEvent(normalized!);
		expect(classification.suppress).toBe(true);
		expect(classification.suppressReason).toBe("complaint");
		expect(classification.deliveryStatus).toBe("complained");
	});

	it("round-trips rejected through normalize→classify", () => {
		const nested = {
			type: "cf.email.sending.message.rejected" as const,
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_005",
				messageId: "pm_005",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: true,
				rejection: { reason: "suppressed", category: "policy" },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		const normalized = normalizeEmailSendingEvent(nested);
		expect(normalized).not.toBeNull();

		const classification = classifyEmailEvent(normalized!);
		expect(classification.suppress).toBe(false);
		expect(classification.deliveryStatus).toBe("rejected");
	});

	it("round-trips failed through normalize→classify", () => {
		const nested = {
			type: "cf.email.sending.message.failed" as const,
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_006",
				messageId: "pm_006",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: true,
				failure: { reason: "timeout", category: "network" },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		const normalized = normalizeEmailSendingEvent(nested);
		expect(normalized).not.toBeNull();

		const classification = classifyEmailEvent(normalized!);
		expect(classification.suppress).toBe(false);
		expect(classification.deliveryStatus).toBe("failed");
		expect(classification.terminal).toBe(true);
	});

	it("flat schema rejects nested format, normalize accepts it", () => {
		const nested = {
			type: "cf.email.sending.message.delivered",
			source: { zoneId: "zone_001", domain: "example.com" },
			payload: {
				eventId: "evt_001",
				messageId: "pm_001",
				sender: "sender@myapp.com",
				recipient: "user@example.com",
				terminal: true,
				delivery: { status: "ok" },
			},
			metadata: {
				accountId: "acct_001",
				eventSubscriptionId: "sub_001",
				eventSchemaVersion: "1.0",
				eventTimestamp: "2026-01-15T10:00:00Z",
			},
		};
		expect(emailSendingEventSchema.safeParse(nested).success).toBe(false);
		expect(normalizeEmailSendingEvent(nested)).not.toBeNull();
	});

	it("safeEventMetadata never includes subject/reason/smtp_response/body", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.delivered" });
		const meta = safeEventMetadata(event);
		expect(meta.event_id).toBe("evt_001");
		expect(meta).not.toHaveProperty("subject");
		expect(meta).not.toHaveProperty("reason");
		expect(meta).not.toHaveProperty("smtp_response");
		expect(meta).not.toHaveProperty("body");
		expect(meta).not.toHaveProperty("auth");
		expect(meta).not.toHaveProperty("variables");
	});

	it("safeEventMetadata for bounced event excludes sensitive fields", () => {
		const event = makeEvent({
			event_type: "cf.email.sending.message.bounced",
			bounce_type: "hard",
		});
		const meta = safeEventMetadata(event);
		expect(meta.event_type).toBe("cf.email.sending.message.bounced");
		expect(meta.bounce_type).toBe("hard");
		expect(meta).not.toHaveProperty("reason");
		expect(meta).not.toHaveProperty("smtp_response");
		expect(meta).not.toHaveProperty("subject");
	});
});

describe("suppressionExpiryFor", () => {
	const now = new Date("2026-01-15T10:00:00.000Z");

	it("expires a hard bounce after 90 days", () => {
		expect(suppressionExpiryFor("hard_bounce", now)).toBe("2026-04-15T10:00:00.000Z");
	});

	// A complaint is a statement of intent by a person, not a fact about a mailbox.
	// Intent does not lapse on a timer, so only an explicit owner-authorized removal
	// lifts it.
	it("never expires a complaint", () => {
		expect(suppressionExpiryFor("complaint", now)).toBeNull();
	});

	it("never expires a manual or provider-rejected suppression", () => {
		expect(suppressionExpiryFor("manual", now)).toBeNull();
		expect(suppressionExpiryFor("provider_rejected", now)).toBeNull();
	});

	it("returns an expiry in the future for a hard bounce", () => {
		const expiry = suppressionExpiryFor("hard_bounce");
		expect(expiry).not.toBeNull();
		expect(new Date(expiry as string).getTime()).toBeGreaterThan(Date.now());
	});
});
