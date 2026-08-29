import { z } from "zod";
import type { TelegramCardRefresh } from "../telegram/cards";
import { CARD_STATUS_LABELS, type TelegramCardStatus } from "../telegram/format";
import type { InboundNotificationInput } from "../telegram/notify";

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

/**
 * A queued Telegram push. Carries everything the notifier needs, so the
 * consumer never has to re-read the message it is announcing: by the time this
 * is delivered the ingest queue has long acked, and a second read of D1/R2
 * would only add a way for the notification to fail.
 */
export type InboundNotificationQueueMessage = {
	schemaVersion: 1;
	eventType: "mail.notify.v1";
	notification: InboundNotificationInput;
};

const inboundNotificationObjectSchema = z.object({
	schemaVersion: z.literal(1),
	eventType: z.literal("mail.notify.v1"),
	notification: z.object({
		mailboxId: z.string().min(1),
		mailboxAddress: z.string().min(1),
		messageLocalId: z.string().min(1),
		threadId: z.string().min(1),
		subject: z.string().nullable(),
		fromAddr: z.string().min(1),
		snippet: z.string().nullable(),
		hasAttachments: z.boolean(),
	}),
});

// Annotated rather than inferred: the annotation is what makes TypeScript
// reject a schema that drifts from InboundNotificationInput.
export const inboundNotificationQueueMessageSchema: z.ZodType<InboundNotificationQueueMessage> =
	inboundNotificationObjectSchema;

/**
 * "A card is stale — go fix it."
 *
 * Rides the notification queue rather than one of its own: it is addressed to the
 * same chat, spends the same ~1 message per second, and needs the same 429
 * backoff. A second queue would only be a second way to exceed the first one's
 * budget.
 */
export type TelegramCardRefreshQueueMessage = {
	schemaVersion: 1;
	eventType: "telegram.card_refresh.v1";
	refresh: TelegramCardRefresh;
};

// Derived from the labels rather than retyped, so a status the renderer knows how
// to draw and the queue refuses to carry cannot exist.
const CARD_STATUS_VALUES = Object.keys(CARD_STATUS_LABELS) as [
	TelegramCardStatus,
	...TelegramCardStatus[],
];

const cardRefreshObjectSchema = z.object({
	schemaVersion: z.literal(1),
	eventType: z.literal("telegram.card_refresh.v1"),
	refresh: z.object({
		mailboxId: z.string().min(1),
		// Nullable rather than optional, and never both null in practice: the actor
		// knows either the message it touched or the thread it answered. A payload
		// naming neither resolves to no card and is acked, which is what an edit
		// with no address deserves.
		messageLocalId: z.string().min(1).nullable(),
		threadId: z.string().min(1).nullable(),
		status: z.enum(CARD_STATUS_VALUES),
	}),
});

export const telegramCardRefreshQueueMessageSchema: z.ZodType<TelegramCardRefreshQueueMessage> =
	cardRefreshObjectSchema;

export type NotifyQueueMessage = InboundNotificationQueueMessage | TelegramCardRefreshQueueMessage;

/** What the notify consumer accepts: a new card, or an edit to one already sent. */
export const notifyQueueMessageSchema: z.ZodType<NotifyQueueMessage> = z.discriminatedUnion(
	"eventType",
	[inboundNotificationObjectSchema, cardRefreshObjectSchema],
);
