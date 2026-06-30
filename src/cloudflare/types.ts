export type InboundEmailQueueMessage = {
	schemaVersion: 1;
	eventType: "email.received.v1";
	traceId: string;
	enqueuedAt: string;
	receivedAt: string;
	mailboxId: string;
	domain: string;
	recipient: string;
	sender: string;
	rawR2Key: string;
	rawSha256: string;
	rawSize: number;
	messageId: string | null;
	headers: {
		subject: string | null;
		date: string | null;
		inReplyTo: string | null;
		references: string[];
	};
	routing: {
		ruleId: string | null;
		action: "store" | "forward" | "reject";
		matchedAlias: string;
		forwardTo?: string[];
		rejectReason?: string;
	};
	idempotencyKey: string;
};

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
