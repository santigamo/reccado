import { confirmSendDraft as confirm, requestSendDraft } from "#/do/mailbox-do";

// Legacy send tests seed drafts directly; arm them as a real caller does.
export async function confirmSendDraft(...args: Parameters<typeof confirm>) {
	const [ctx, draftId] = args;
	await requestSendDraft(ctx.sql, draftId, {
		from: ctx.fromAddress,
		fromName: ctx.fromName ?? null,
		replyTo: ctx.replyToAddress,
	});
	return confirm(...args);
}
