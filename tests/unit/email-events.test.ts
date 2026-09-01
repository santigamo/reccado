import { describe, it, expect } from "vitest";
import {
	classifyEmailEvent,
	emailSendingEventSchema,
	normalizeEmailSendingEvent,
	safeEventMetadata,
	type EmailSendingEvent,
} from "#/cloudflare/email-events";

const makeEvent = (overrides: Partial<EmailSendingEvent>): EmailSendingEvent => ({
	event_id: "evt_001",
	event_type: "cf.email.sending.message.delivered",
	provider_message_id: "pm_001",
	to: "user@example.com",
	from: "sender@myapp.com",
	timestamp: "2026-01-15T10:00:00Z",
	...overrides,
});

// Official Cloudflare nested format fixture
function makeNestedEvent(
	type: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type,
		source: { zoneId: "zone_001", domain: "example.com" },
		payload: {
			eventId: "evt_001",
			messageId: "pm_001",
			sender: "sender@myapp.com",
			recipient: "user@example.com",
			terminal: true,
			...overrides,
		},
		metadata: {
			accountId: "acct_001",
			eventSubscriptionId: "sub_001",
			eventSchemaVersion: "1.0",
			eventTimestamp: "2026-01-15T10:00:00Z",
		},
	};
}

describe("emailSendingEventSchema", () => {
	it("accepts valid delivered event", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.delivered" });
		expect(emailSendingEventSchema.safeParse(event).success).toBe(true);
	});

	it("accepts valid bounced event with bounce_type", () => {
		const event = makeEvent({
			event_type: "cf.email.sending.message.bounced",
			bounce_type: "hard",
		});
		expect(emailSendingEventSchema.safeParse(event).success).toBe(true);
	});

	it("accepts valid complained event", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.complained" });
		expect(emailSendingEventSchema.safeParse(event).success).toBe(true);
	});

	it("rejects unknown event_type", () => {
		const event = makeEvent({
			event_type: "cf.email.sending.message.unknown",
		} as unknown as EmailSendingEvent);
		expect(emailSendingEventSchema.safeParse(event).success).toBe(false);
	});

	it("rejects missing event_id", () => {
		const event = makeEvent({ event_id: "" });
		expect(emailSendingEventSchema.safeParse(event).success).toBe(false);
	});

	it("rejects invalid email in to field", () => {
		const event = makeEvent({ to: "not-an-email" });
		expect(emailSendingEventSchema.safeParse(event).success).toBe(false);
	});

	it("rejects invalid bounce_type value", () => {
		const event = makeEvent({
			event_type: "cf.email.sending.message.bounced",
			bounce_type: "unknown" as "hard",
		});
		expect(emailSendingEventSchema.safeParse(event).success).toBe(false);
	});
});

describe("normalizeEmailSendingEvent", () => {
	it("accepts flat format (backward compat)", () => {
		const flat = makeEvent({ event_type: "cf.email.sending.message.delivered" });
		const result = normalizeEmailSendingEvent(flat);
		expect(result).not.toBeNull();
		expect(result!.event_id).toBe("evt_001");
		expect(result!.event_type).toBe("cf.email.sending.message.delivered");
	});

	it("accepts official nested format", () => {
		const nested = makeNestedEvent("cf.email.sending.message.delivered");
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.event_id).toBe("evt_001");
		expect(result!.event_type).toBe("cf.email.sending.message.delivered");
		expect(result!.provider_message_id).toBe("pm_001");
		expect(result!.to).toBe("user@example.com");
		expect(result!.from).toBe("sender@myapp.com");
		expect(result!.timestamp).toBe("2026-01-15T10:00:00Z");
	});

	it("derives bounce_type from payload.bounce.type in nested format", () => {
		const nested = makeNestedEvent("cf.email.sending.message.bounced", {
			bounce: { type: "hard", category: "rejected" },
		});
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.bounce_type).toBe("hard");
		expect(result!.error_category).toBe("rejected");
	});

	it("derives soft bounce_type from payload.bounce.type", () => {
		const nested = makeNestedEvent("cf.email.sending.message.bounced", {
			bounce: { type: "soft" },
		});
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.bounce_type).toBe("soft");
	});

	it("handles nested bounced event without bounce.type", () => {
		const nested = makeNestedEvent("cf.email.sending.message.bounced");
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.bounce_type).toBeUndefined();
	});

	it("handles rejection reason in nested format", () => {
		const nested = makeNestedEvent("cf.email.sending.message.rejected", {
			rejection: { reason: "suppressed", category: "policy" },
		});
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.rejection_reason).toBe("suppressed");
		expect(result!.error_category).toBe("policy");
	});

	it("returns null for invalid input", () => {
		expect(normalizeEmailSendingEvent(null)).toBeNull();
		expect(normalizeEmailSendingEvent("not an object")).toBeNull();
		expect(normalizeEmailSendingEvent({})).toBeNull();
	});

	it("returns null for nested format missing required fields", () => {
		const bad = { type: "cf.email.sending.message.delivered", source: {}, metadata: {} };
		expect(normalizeEmailSendingEvent(bad)).toBeNull();
	});

	it("handles complained event in nested format", () => {
		const nested = makeNestedEvent("cf.email.sending.message.complained");
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.event_type).toBe("cf.email.sending.message.complained");
	});

	it("handles failed event in nested format", () => {
		const nested = makeNestedEvent("cf.email.sending.message.failed", {
			failure: { reason: "timeout", category: "network" },
		});
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.event_type).toBe("cf.email.sending.message.failed");
		expect(result!.error_category).toBe("network");
	});

	it("handles deferred event in nested format", () => {
		const nested = makeNestedEvent("cf.email.sending.message.deferred");
		const result = normalizeEmailSendingEvent(nested);
		expect(result).not.toBeNull();
		expect(result!.event_type).toBe("cf.email.sending.message.deferred");
	});
});

describe("what a Cloudflare event can and cannot be correlated on", () => {
	// A verbatim payload from Cloudflare's own docs
	// (developers.cloudflare.com/email-service/platform/event-subscriptions), kept
	// literal because the whole correlation design rests on what is in it.
	const officialDelivered = {
		type: "cf.email.sending.message.delivered",
		source: {
			type: "email.sending",
			zoneId: "023e105f4ecef8ad9ca31a8372d0c353",
			domain: "example.com",
		},
		payload: {
			eventId: "0190d0c4-7e9a-7b3c-9f12-1a2b3c4d5e6f",
			messageId: "0101018f7d0c4d9a-msg-deadbeef",
			sender: "noreply@example.com",
			recipient: "user@example.net",
			subject: "Welcome",
			terminal: true,
			delivery: {
				status: "delivered",
				provider: "gmail",
				deliveryTimeMs: 1234,
				smtpStatusCode: "250",
				smtpEnhancedStatusCode: "2.0.0",
				smtpResponse: "250 2.0.0 OK 1714820445 a1b2c3 - gsmtp",
			},
		},
		metadata: {
			accountId: "f9f79265f388666de8122cfb508d7776",
			eventSubscriptionId: "1830c4bb612e43c3af7f4cada31fbf3f",
			eventSchemaVersion: 1,
			eventTimestamp: "2026-06-01T02:48:57.132Z",
		},
	};

	it("carries a Cloudflare-internal message id, not an RFC5322 Message-ID", () => {
		const result = normalizeEmailSendingEvent(officialDelivered);
		expect(result).not.toBeNull();
		expect(result!.provider_message_id).toBe("0101018f7d0c4d9a-msg-deadbeef");
		// The distinction is load-bearing: Cloudflare reserves the Message-ID header
		// and rejects a sender-supplied one, so we cannot mint an id of our own and
		// recognise it here. Any angle-bracketed addr-spec would mean that changed.
		expect(result!.provider_message_id).not.toMatch(/^<.*@.*>$/);
	});

	it("exposes only sender, recipient and timestamp as correlatable fields", () => {
		const result = normalizeEmailSendingEvent(officialDelivered);
		expect(result!.from).toBe("noreply@example.com");
		expect(result!.to).toBe("user@example.net");
		expect(result!.timestamp).toBe("2026-06-01T02:48:57.132Z");
		// There is no header passthrough and no sender-chosen correlation id in the
		// payload, so a stamped X- header would be invisible to us. Envelope
		// correlation exists because this list is all there is.
		expect(Object.keys(result!).sort()).toEqual(
			[
				"bounce_type",
				"error_category",
				"event_id",
				"event_type",
				"from",
				"provider_message_id",
				"rejection_reason",
				"timestamp",
				"to",
			].sort(),
		);
	});

	it("drops the subject rather than carrying it into anything persisted", () => {
		const result = normalizeEmailSendingEvent(officialDelivered);
		expect(result).not.toBeNull();
		// The interpolated subject routinely contains the template variables — "Your
		// code is 123456" — so it is neither normalized nor logged, and it is not
		// used as a correlation key for the same reason.
		expect(JSON.stringify(result)).not.toContain("Welcome");
		expect(JSON.stringify(safeEventMetadata(result!))).not.toContain("Welcome");
	});

	it("never carries the provider's own error prose", () => {
		const bounced = normalizeEmailSendingEvent({
			...officialDelivered,
			type: "cf.email.sending.message.bounced",
			payload: {
				...officialDelivered.payload,
				delivery: { status: "bounced", smtpResponse: "550 5.1.1 User unknown" },
				bounce: { type: "hard", category: "permanent_failure", reason: "550 5.1.1 User unknown" },
			},
		});
		expect(bounced).not.toBeNull();
		expect(bounced!.bounce_type).toBe("hard");
		expect(bounced!.error_category).toBe("permanent_failure");
		expect(JSON.stringify(bounced)).not.toContain("User unknown");
	});
});

describe("classifyEmailEvent", () => {
	it("delivered: terminal, no suppression", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.delivered" });
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(false);
		expect(result.suppressReason).toBeNull();
		expect(result.deliveryStatus).toBe("delivered");
	});

	it("deferred: not terminal, no suppression", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.deferred" });
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(false);
		expect(result.suppress).toBe(false);
		expect(result.deliveryStatus).toBe("deferred");
	});

	it("hard bounce: terminal, suppresses", () => {
		const event = makeEvent({
			event_type: "cf.email.sending.message.bounced",
			bounce_type: "hard",
		});
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(true);
		expect(result.suppressReason).toBe("hard_bounce");
		expect(result.deliveryStatus).toBe("bounced");
	});

	it("soft bounce: terminal, no suppression", () => {
		const event = makeEvent({
			event_type: "cf.email.sending.message.bounced",
			bounce_type: "soft",
		});
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(false);
		expect(result.suppressReason).toBeNull();
		expect(result.deliveryStatus).toBe("bounced");
	});

	it("bounce without bounce_type: terminal, no suppression", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.bounced" });
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(false);
		expect(result.suppressReason).toBeNull();
	});

	it("complaint: terminal, suppresses", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.complained" });
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(true);
		expect(result.suppressReason).toBe("complaint");
		expect(result.deliveryStatus).toBe("complained");
	});

	it("rejected: terminal, no suppression", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.rejected" });
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(false);
		expect(result.suppressReason).toBeNull();
		expect(result.deliveryStatus).toBe("rejected");
	});

	it("failed: terminal, no suppression", () => {
		const event = makeEvent({ event_type: "cf.email.sending.message.failed" });
		const result = classifyEmailEvent(event);
		expect(result.terminal).toBe(true);
		expect(result.suppress).toBe(false);
		expect(result.suppressReason).toBeNull();
		expect(result.deliveryStatus).toBe("failed");
	});
});
