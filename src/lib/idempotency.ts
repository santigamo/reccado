import { normalizeMessageId } from "./email-metadata";

export function inboundIdempotencyKey(input: {
	mailboxId: string;
	messageId: string | null;
	rawSha256: string;
}): string {
	// Folded here, not in normalizeMessageId: keys already written to D1/DO rows are
	// lowercase, and an id that only differs in case is the same message for dedup
	// purposes even though it is a different id on the wire.
	const normalized = normalizeMessageId(input.messageId)?.toLowerCase() ?? null;
	if (normalized) {
		return `email:v1:${input.mailboxId}:message-id:${normalized}`;
	}
	return `email:v1:${input.mailboxId}:raw-sha256:${input.rawSha256}`;
}

export function outboundSendIdempotencyKey(draftId: string, attemptKey: string): string {
	return `send:v1:${draftId}:${attemptKey}`;
}
