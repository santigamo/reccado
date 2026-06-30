import { z } from "zod";

export const inboundEmailQueueMessageSchema = z.object({
	schemaVersion: z.literal(1),
	eventType: z.literal("email.received.v1"),
	traceId: z.string().min(1),
	enqueuedAt: z.string().min(1),
	receivedAt: z.string().min(1),
	mailboxId: z.string().min(1),
	domain: z.string(),
	recipient: z.string().min(1),
	sender: z.string().min(1),
	rawR2Key: z.string().min(1),
	rawSha256: z.string().min(1),
	rawSize: z.number(),
	messageId: z.string().nullable(),
	headers: z.object({
		subject: z.string().nullable(),
		date: z.string().nullable(),
		inReplyTo: z.string().nullable(),
		references: z.array(z.string()),
	}),
	routing: z.object({
		ruleId: z.string().nullable(),
		action: z.enum(["store", "forward", "reject"]),
		matchedAlias: z.string(),
		forwardTo: z.array(z.string()).optional(),
		rejectReason: z.string().optional(),
	}),
	idempotencyKey: z.string().min(1),
});

export type InboundEmailQueueMessage = z.infer<typeof inboundEmailQueueMessageSchema>;

export type MailboxIngestResult = {
	status: "inserted" | "duplicate" | "conflict";
	mailboxId: string;
	messageCount: number;
	idempotencyKey: string;
	messageLocalId: string;
	rawR2Key: string;
	threadId?: string;
	subject?: string | null;
	snippet?: string;
	fromAddr?: string;
	toJson?: string;
	receivedAt?: string;
	hasAttachments?: boolean;
	rfcMessageId?: string | null;
	parseStatus?: "parsed" | "failed";
	realtimeSeq?: number;
	errorCode?: string;
};
