import { describe, expect, it } from "vitest";
import missingMessageIdEml from "../../fixtures/mime/missing-message-id.eml?raw";
import simpleTextEml from "../../fixtures/mime/simple-text.eml?raw";
import {
	addressesIn,
	parseInboundDlqSummary,
	rebuildInboundPayload,
	receivedAtFromKey,
	skipReason,
} from "../../scripts/lib/replay-dlq-core";
import { inboundEmailQueueMessageSchema } from "../../src/cloudflare/types";
import { sha256Hex } from "../../src/lib/crypto";
import { inboundIdempotencyKey } from "../../src/lib/idempotency";

const encode = (text: string) => new TextEncoder().encode(text);
const MAILBOX = {
	mailboxId: "mbx_abc",
	primaryAddress: "test@example.com",
	aliases: ["hello@example.com"],
};

async function summaryFor(eml: string, extra: Record<string, unknown> = {}) {
	const bytes = encode(eml);
	const rawSha256 = await sha256Hex(bytes);
	const summary = parseInboundDlqSummary(
		JSON.stringify({
			queue: "inbound-dlq",
			attempts: 5,
			summary: {
				kind: "inbound",
				eventType: "email.received.v1",
				schemaVersion: 1,
				traceId: "t1",
				mailboxId: "mbx_abc",
				rawR2Key: `raw/dev/mbx_abc/2026/11/14/1763128800000-${rawSha256}.eml`,
				rawSha256,
				rawSize: bytes.byteLength,
				recipientDomain: "example.com",
				...extra,
			},
		}),
	);
	if (!summary) throw new Error("summary did not parse");
	return { summary, bytes };
}

describe("parseInboundDlqSummary", () => {
	it("rejects non-inbound, malformed and incomplete tombstones", () => {
		expect(parseInboundDlqSummary("not json")).toBeNull();
		expect(parseInboundDlqSummary(JSON.stringify({ summary: { kind: "notify" } }))).toBeNull();
		expect(
			parseInboundDlqSummary(JSON.stringify({ summary: { kind: "inbound", mailboxId: "m" } })),
		).toBeNull();
	});
});

describe("rebuildInboundPayload", () => {
	it("rebuilds a schema-valid payload from the MIME and tombstone summary", async () => {
		const { summary, bytes } = await summaryFor(simpleTextEml);
		const now = new Date("2026-11-16T10:00:00Z");
		const { payload, notes } = await rebuildInboundPayload({
			summary,
			metadata: {},
			rawBytes: bytes,
			mailbox: MAILBOX,
			now,
		});
		expect(inboundEmailQueueMessageSchema.safeParse(payload).success).toBe(true);
		expect(payload).toMatchObject({
			mailboxId: "mbx_abc",
			domain: "example.com",
			recipient: "test@example.com",
			sender: "sender@example.com",
			rawR2Key: summary.rawR2Key,
			rawSha256: summary.rawSha256,
			rawSize: bytes.byteLength,
			messageId: "phase-0.3-smoke@example.com",
			receivedAt: "2025-11-14T14:00:00.000Z",
			enqueuedAt: now.toISOString(),
			headers: {
				subject: "Phase 0.3 smoke",
				date: "Tue, 30 Jun 2026 14:00:00 +0000",
				inReplyTo: null,
				references: [],
			},
			routing: { ruleId: null, action: "store", matchedAlias: "test@example.com" },
		});
		expect(payload.idempotencyKey).toBe(
			inboundIdempotencyKey({
				mailboxId: "mbx_abc",
				messageId: "phase-0.3-smoke@example.com",
				rawSha256: summary.rawSha256,
			}),
		);
		expect(payload.traceId).not.toBe("t1");
		expect(notes).toEqual([]);
	});

	it("prefers Delivered-To (an alias) over To, and Return-Path over From", async () => {
		const eml = [
			"Return-Path: <bounce@mailer.example.net>",
			"Delivered-To: hello@example.com",
			"From: Someone <someone@example.net>",
			"To: Undisclosed <list@lists.example.org>",
			"Subject: Hi",
			"Message-ID: <a@b>",
			"In-Reply-To: <x@y>",
			"References: <r1@y> <r2@y>",
			"",
			"body",
		].join("\r\n");
		const { summary, bytes } = await summaryFor(eml);
		const { payload } = await rebuildInboundPayload({
			summary,
			metadata: {},
			rawBytes: bytes,
			mailbox: MAILBOX,
		});
		expect(payload.recipient).toBe("hello@example.com");
		expect(payload.routing.matchedAlias).toBe("hello@example.com");
		expect(payload.sender).toBe("bounce@mailer.example.net");
		expect(payload.headers.inReplyTo).toBe("x@y");
		expect(payload.headers.references).toEqual(["r1@y", "r2@y"]);
	});

	it("falls back to the primary address with a note, and to a raw-sha256 key without Message-ID", async () => {
		const { summary, bytes } = await summaryFor(missingMessageIdEml);
		const { payload, notes } = await rebuildInboundPayload({
			summary,
			metadata: {},
			rawBytes: bytes,
			mailbox: { ...MAILBOX, primaryAddress: "nobody@example.com", aliases: [] },
		});
		expect(payload.recipient).toBe("nobody@example.com");
		expect(notes.some((n) => n.includes("primary address"))).toBe(true);
		expect(payload.messageId).toBeNull();
		expect(payload.idempotencyKey).toBe(`email:v1:mbx_abc:raw-sha256:${summary.rawSha256}`);
	});

	it("throws when receivedAt cannot be determined", async () => {
		const { summary, bytes } = await summaryFor(simpleTextEml, { rawR2Key: "weird-key" });
		await expect(
			rebuildInboundPayload({ summary, metadata: {}, rawBytes: bytes, mailbox: MAILBOX }),
		).rejects.toThrow(/receivedAt/);
	});

	it("uses customMetadata.receivedAt and messageId when provided", async () => {
		const { summary, bytes } = await summaryFor(simpleTextEml);
		const { payload } = await rebuildInboundPayload({
			summary,
			metadata: {
				receivedAt: "2026-11-14T08:00:00.000Z",
				messageId: "phase-0.3-smoke@example.com",
			},
			rawBytes: bytes,
			mailbox: MAILBOX,
		});
		expect(payload.receivedAt).toBe("2026-11-14T08:00:00.000Z");
	});
});

describe("helpers", () => {
	it("extracts addresses and receivedAt from a raw key", () => {
		expect(addressesIn('"A B" <A@X.com>, b@y.org')).toEqual(["a@x.com", "b@y.org"]);
		expect(receivedAtFromKey("raw/dev/m/2026/11/14/1763128800000-abc.eml")).toBe(
			"2025-11-14T14:00:00.000Z",
		);
		expect(receivedAtFromKey("nope")).toBeNull();
	});
});

describe("skipReason", () => {
	it("covers every skip and the push case", async () => {
		const { summary } = await summaryFor(simpleTextEml);
		const sha = summary.rawSha256;
		expect(skipReason(summary, { objectFound: false, indexedBySha: false })).toMatch(/missing/);
		expect(
			skipReason(summary, { objectFound: true, actualSha256: "deadbeef", indexedBySha: false }),
		).toMatch(/sha256 mismatch/);
		expect(
			skipReason(summary, {
				objectFound: true,
				actualSha256: sha,
				ingestStatus: "processed",
				indexedBySha: false,
			}),
		).toMatch(/already processed/);
		expect(
			skipReason(summary, { objectFound: true, actualSha256: sha, indexedBySha: true }),
		).toMatch(/message_index/);
		// queued/failed ingest rows do not block a replay
		expect(
			skipReason(summary, {
				objectFound: true,
				actualSha256: sha,
				ingestStatus: "failed",
				indexedBySha: false,
			}),
		).toBeNull();
	});
});
