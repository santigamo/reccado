import { normalizeAttachmentType, sanitizeAttachmentName } from "./attachment-limits";
import { sha256Hex } from "./crypto";
import { draftAttachmentR2Key, sanitizeFilename } from "./r2-keys";

/**
 * One uploaded file onto a draft, shared by the web upload route and the MCP
 * attachment tool: the bytes go to R2 under a draft-scoped key, and the mailbox
 * DO records the metadata and decides whether this draft may take them (limits,
 * status, whose draft it is — see editable() in do/mailbox-draft-attachments.ts).
 * A file the DO refuses is deleted again, so no call leaves an object nobody
 * points at. Answers the DO's response (201 with the attachment, or its error).
 *
 * Callers check the size limits before reading the bytes; this does not.
 */
export async function storeDraftUpload(
	env: { MAIL_OBJECTS: R2Bucket },
	stub: DurableObjectStub,
	input: {
		mailboxId: string;
		draftId: string;
		filename: string;
		contentType: string | null | undefined;
		bytes: Uint8Array;
		/** "mcp": the agent, allowed only on its own draft. Absent: the owner. */
		requester?: "mcp";
	},
): Promise<Response> {
	const contentType = normalizeAttachmentType(input.contentType);
	const id = crypto.randomUUID();
	const r2Key = draftAttachmentR2Key({
		mailboxId: input.mailboxId,
		draftId: input.draftId,
		attachmentId: id,
		safeFilename: sanitizeFilename(sanitizeAttachmentName(input.filename)),
	});
	const sha256 = await sha256Hex(input.bytes);
	await env.MAIL_OBJECTS.put(r2Key, input.bytes, {
		httpMetadata: { contentType, contentDisposition: "attachment" },
	});
	let response: Response;
	try {
		response = await stub.fetch(
			`https://mailbox-do/drafts/${encodeURIComponent(input.draftId)}/attachments`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id,
					filename: input.filename,
					contentType,
					size: input.bytes.byteLength,
					sha256,
					r2Key,
					...(input.requester ? { requester: input.requester } : {}),
				}),
			},
		);
	} catch (error) {
		await env.MAIL_OBJECTS.delete(r2Key).catch(() => undefined);
		throw error;
	}
	if (!response.ok) await env.MAIL_OBJECTS.delete(r2Key).catch(() => undefined);
	return response;
}
