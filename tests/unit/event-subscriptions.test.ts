import { describe, expect, it } from "vitest";
import {
	EMAIL_SENDING_EVENT_TYPES,
	type EventSubscription,
	evaluateFeedbackSubscription,
	parseQueueListTable,
	parseSendingDomainsTable,
	parseSubscriptionListJson,
} from "../../scripts/lib/event-subscriptions";

const OUR_QUEUE = "d1f33ca4e7c34a6a87cf177e910cd06d";

function subscription(overrides: Partial<EventSubscription> = {}): EventSubscription {
	return {
		id: "sub-1",
		name: "Email Sending",
		enabled: true,
		source: { type: "email.sending", domain: "send.example.com", zone_id: "zone-1" },
		destination: { type: "queues.queue", queue_id: OUR_QUEUE },
		events: [...EMAIL_SENDING_EVENT_TYPES],
		...overrides,
	};
}

describe("evaluateFeedbackSubscription", () => {
	it("is live when all six event types reach our queue", () => {
		expect(
			evaluateFeedbackSubscription({
				sendingDomain: "send.example.com",
				expectedQueueId: OUR_QUEUE,
				subscriptions: [subscription()],
			}),
		).toEqual({ state: "live", subscriptionIds: ["sub-1"] });
	});

	// The defect as it actually shipped: a second sending domain was provisioned
	// and nothing bound it to the queue, so it produced no events for anything.
	it("is absent when no subscription names the domain", () => {
		expect(
			evaluateFeedbackSubscription({
				sendingDomain: "notify.example.com",
				expectedQueueId: OUR_QUEUE,
				subscriptions: [subscription()],
			}),
		).toEqual({ state: "absent" });
	});

	// Existence alone is a false pass: this configuration satisfies any "does a
	// subscription exist" check while every bounce and complaint stays invisible,
	// which means the suppression mirror silently stops being maintained.
	it("is partial when the subscription omits bounce and complaint events", () => {
		const verdict = evaluateFeedbackSubscription({
			sendingDomain: "send.example.com",
			expectedQueueId: OUR_QUEUE,
			subscriptions: [subscription({ events: ["message.delivered"] })],
		});
		expect(verdict.state).toBe("partial_events");
		expect(verdict).toMatchObject({
			missingEvents: [
				"message.deferred",
				"message.bounced",
				"message.rejected",
				"message.complained",
				"message.failed",
			],
		});
	});

	// One wrong dropdown in the dashboard sends a domain's events to the other
	// environment's queue, where this worker never sees them.
	it("is wrong_queue when the destination is another queue", () => {
		const verdict = evaluateFeedbackSubscription({
			sendingDomain: "send.example.com",
			expectedQueueId: OUR_QUEUE,
			subscriptions: [
				subscription({ destination: { type: "queues.queue", queue_id: "some-other-queue" } }),
			],
		});
		expect(verdict.state).toBe("wrong_queue");
		expect(verdict).toMatchObject({ queueIds: ["some-other-queue"] });
	});

	it("is disabled when the only subscription is switched off", () => {
		expect(
			evaluateFeedbackSubscription({
				sendingDomain: "send.example.com",
				expectedQueueId: OUR_QUEUE,
				subscriptions: [subscription({ enabled: false })],
			}),
		).toEqual({ state: "disabled", subscriptionIds: ["sub-1"] });
	});

	// Two subscriptions splitting the six event types is a legitimate setup, and
	// calling it broken would be a false alarm the operator learns to skip past.
	it("unions the event types across several usable subscriptions", () => {
		expect(
			evaluateFeedbackSubscription({
				sendingDomain: "send.example.com",
				expectedQueueId: OUR_QUEUE,
				subscriptions: [
					subscription({
						id: "sub-a",
						events: ["message.delivered", "message.deferred", "message.failed"],
					}),
					subscription({
						id: "sub-b",
						events: ["message.bounced", "message.rejected", "message.complained"],
					}),
				],
			}),
		).toEqual({ state: "live", subscriptionIds: ["sub-a", "sub-b"] });
	});

	// A domain typed with different case in the config must not read as a
	// different, unsubscribed domain — that would be a fabricated failure.
	it("matches the domain case-insensitively", () => {
		expect(
			evaluateFeedbackSubscription({
				sendingDomain: "SEND.Example.com",
				expectedQueueId: OUR_QUEUE,
				subscriptions: [
					subscription({ source: { type: "email.sending", domain: "send.example.com" } }),
				],
			}).state,
		).toBe("live");
	});

	it("ignores subscriptions from other event sources on the same queue", () => {
		expect(
			evaluateFeedbackSubscription({
				sendingDomain: "send.example.com",
				expectedQueueId: OUR_QUEUE,
				subscriptions: [subscription({ source: { type: "r2", domain: "send.example.com" } })],
			}),
		).toEqual({ state: "absent" });
	});
});

describe("parseSubscriptionListJson", () => {
	it("reads the shape wrangler actually prints", () => {
		const raw = `⛅️ wrangler 4.127.1\n[{"id":"abc","name":"Email Sending","enabled":true,"source":{"name":"Email Service","type":"email.sending","zone_id":"z1","domain":"send.example.com"},"destination":{"type":"queues.queue","queue_id":"q1"},"events":["message.delivered"]}]`;
		expect(parseSubscriptionListJson(raw)).toEqual([
			{
				id: "abc",
				name: "Email Sending",
				enabled: true,
				source: { type: "email.sending", zone_id: "z1", domain: "send.example.com" },
				destination: { type: "queues.queue", queue_id: "q1" },
				events: ["message.delivered"],
			},
		]);
	});

	// An older wrangler rejects --json outright. Returning null rather than
	// throwing is what lets the caller report "unresolved, here is the fix"
	// instead of crashing on a CLI surface it does not control.
	it("returns null for output that is not a JSON array", () => {
		expect(parseSubscriptionListJson("✘ [ERROR] Unknown argument: json")).toBeNull();
		expect(parseSubscriptionListJson('{"not":"an array"}')).toBeNull();
	});
});

describe("parseSendingDomainsTable", () => {
	it("reads zone, name and enabled out of the box-drawn table", () => {
		const raw = [
			"┌─────────────┬───────────────────┬─────────┬──────┐",
			"│ zone        │ name              │ enabled │ tag  │",
			"├─────────────┼───────────────────┼─────────┼──────┤",
			"│ example.com │ send.example.com  │ yes     │ t1   │",
			"├─────────────┼───────────────────┼─────────┼──────┤",
			"│ other.test  │ mail.other.test   │ no      │ t2   │",
			"└─────────────┴───────────────────┴─────────┴──────┘",
		].join("\n");
		expect(parseSendingDomainsTable(raw)).toEqual([
			{ zone: "example.com", name: "send.example.com", enabled: true },
			{ zone: "other.test", name: "mail.other.test", enabled: false },
		]);
	});
});

describe("parseQueueListTable", () => {
	// The id column is the point: a subscription's destination is a queue id, so
	// without this mapping "subscribed" cannot be told from "subscribed to the
	// other environment".
	it("keeps the queue id alongside the name", () => {
		const raw = [
			"│ id │ name │ created_on │ modified_on │ producers │ consumers │",
			"│ q1 │ inbox-mcp-email-events-dev │ x │ y │ 1 │ 1 │",
			"│ q2 │ inbox-mcp-email-events-dlq-dev │ x │ y │ 0 │ 1 │",
		].join("\n");
		expect(parseQueueListTable(raw)).toEqual([
			{ id: "q1", name: "inbox-mcp-email-events-dev", consumers: 1 },
			{ id: "q2", name: "inbox-mcp-email-events-dlq-dev", consumers: 1 },
		]);
	});
});
