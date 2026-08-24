import { describe, it, expect } from "vitest";
import {
	classifyEmailEvent,
	emailSendingEventSchema,
	normalizeEmailSendingEvent,
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
