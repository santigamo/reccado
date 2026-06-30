import { normalizeMessageId } from "./email-metadata";

export function inboundIdempotencyKey(input: {
	mailboxId: string;
	messageId: string | null;
	rawSha256: string;
}): string {
	const normalized = normalizeMessageId(input.messageId);
	if (normalized) {
		return `email:v1:${input.mailboxId}:message-id:${normalized}`;
	}
	return `email:v1:${input.mailboxId}:raw-sha256:${input.rawSha256}`;
}

export function outboundSendIdempotencyKey(draftId: string, attemptKey: string): string {
	return `send:v1:${draftId}:${attemptKey}`;
}
