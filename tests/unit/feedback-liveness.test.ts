import { describe, expect, it } from "vitest";
import {
	classifyFeedbackLiveness,
	FEEDBACK_MATURITY_MS,
	feedbackMaturityCutoff,
	type SenderFeedbackObservation,
	summarizeSendingFeedback,
} from "#/lib/feedback-liveness";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function observation(overrides: Partial<SenderFeedbackObservation> = {}): SenderFeedbackObservation {
	return {
		domain: "send.example.com",
		dispatched: 0,
		observed: 0,
		lastEventAt: null,
		lastDispatchAt: null,
		silentMatureDispatches: 0,
		lastSilentMatureAt: null,
		...overrides,
	};
}

describe("classifyFeedbackLiveness", () => {
	it("says nothing about a domain that has never dispatched", () => {
		expect(classifyFeedbackLiveness(observation())).toBe("unobserved");
	});

	// The load-bearing distinction. Reading "no event" as "the channel is dead"
	// on a send made ten minutes ago would be the same error as reading it as
	// "the message was never sent" -- inferring from an absence before presence
	// was even possible.
	it("refuses to judge a domain whose only sends are younger than the maturity window", () => {
		expect(
			classifyFeedbackLiveness(
				observation({ dispatched: 2, observed: 0, lastDispatchAt: iso(2 * HOUR) }),
			),
		).toBe("unobserved");
	});

	it("calls a domain never_observed once a mature dispatch has gone unanswered", () => {
		expect(
			classifyFeedbackLiveness(
				observation({
					dispatched: 2,
					observed: 0,
					silentMatureDispatches: 2,
					lastDispatchAt: iso(30 * HOUR),
					lastSilentMatureAt: iso(30 * HOUR),
				}),
			),
		).toBe("never_observed");
	});

	it("calls a domain live while every mature dispatch has an event", () => {
		expect(
			classifyFeedbackLiveness(
				observation({
					dispatched: 5,
					observed: 5,
					lastEventAt: iso(HOUR),
					lastDispatchAt: iso(HOUR),
				}),
			),
		).toBe("live");
	});

	// The second failure shape, and the one a config check cannot see: the
	// subscription is still listed, but its events stopped arriving.
	it("calls a domain went_dark when mature silence follows the last event", () => {
		expect(
			classifyFeedbackLiveness(
				observation({
					dispatched: 6,
					observed: 4,
					lastEventAt: iso(10 * 24 * HOUR),
					lastDispatchAt: iso(26 * HOUR),
					silentMatureDispatches: 2,
					lastSilentMatureAt: iso(26 * HOUR),
				}),
			),
		).toBe("went_dark");
	});

	// A dropped event the channel already recovered from must not pin the signal
	// red forever, or the operator learns to ignore it.
	it("keeps a domain live when the silent dispatch predates the last event", () => {
		expect(
			classifyFeedbackLiveness(
				observation({
					dispatched: 6,
					observed: 5,
					lastEventAt: iso(2 * HOUR),
					lastDispatchAt: iso(2 * HOUR),
					silentMatureDispatches: 1,
					lastSilentMatureAt: iso(40 * HOUR),
				}),
			),
		).toBe("live");
	});
});

describe("feedbackMaturityCutoff", () => {
	it("is exactly one maturity window before the given instant", () => {
		expect(feedbackMaturityCutoff(NOW)).toBe(new Date(NOW - FEEDBACK_MATURITY_MS).toISOString());
	});
});

describe("summarizeSendingFeedback", () => {
	it("reports no_sends, healthily, when nothing has been dispatched", () => {
		const status = summarizeSendingFeedback([]);
		expect(status.mode).toBe("no_sends");
		expect(status.ok).toBe(true);
		expect(status.dark).toEqual([]);
	});

	it("stays healthy while every domain is merely too young to judge", () => {
		const status = summarizeSendingFeedback([observation({ dispatched: 1 })]);
		expect(status.mode).toBe("observing");
		expect(status.ok).toBe(true);
		expect(status.reason).toContain("not yet decidable");
	});

	it("names only the dark domain when one answers and another never has", () => {
		const status = summarizeSendingFeedback([
			observation({
				domain: "send.example.com",
				dispatched: 3,
				observed: 3,
				lastEventAt: iso(HOUR),
			}),
			observation({
				domain: "notify.example.com",
				dispatched: 2,
				observed: 0,
				silentMatureDispatches: 2,
				lastSilentMatureAt: iso(30 * HOUR),
			}),
		]);
		expect(status.mode).toBe("dark");
		expect(status.ok).toBe(false);
		expect(status.dark).toEqual(["notify.example.com"]);
		expect(status.reason).toContain("notify.example.com");
		expect(status.reason).not.toContain("send.example.com");
	});

	it("explains a dark domain in terms of the channel, not the message", () => {
		const status = summarizeSendingFeedback([
			observation({
				domain: "notify.example.com",
				dispatched: 2,
				observed: 0,
				silentMatureDispatches: 2,
				lastSilentMatureAt: iso(30 * HOUR),
			}),
		]);
		expect(status.reason).toContain("describes the channel, not the message");
		expect(status.reason).toContain("event subscription");
	});
});
