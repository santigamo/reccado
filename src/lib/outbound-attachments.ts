import { MAX_ATTACHMENT_COUNT, MAX_TOTAL_ATTACHMENT_BYTES } from "./attachment-limits";
import { sha256Hex } from "./crypto";

/**
 * One attachment as the send intent freezes it. This is what `payload_hash`
 * covers, in this order: changing a file (its bytes, so its sha256), its name,
 * its type or its position changes the hash, and a confirm-send against the old
 * hash is refused as stale. A draft with no attachments freezes `[]`, which is
 * exactly what every intent carried before attachments existed — so their
 * hashes, and approvals already bound to them, are unchanged.
 */
export type SnapshotAttachment = {
	id: string;
	filename: string;
	contentType: string;
	size: number;
	sha256: string;
	r2Key: string;
};

/** The bytes of a frozen attachment, read back at confirm-send time. */
export type LoadedAttachment = SnapshotAttachment & { bytes: Uint8Array };

export class AttachmentUnavailableError extends Error {
	constructor(
		readonly reason: "attachment_missing" | "attachment_changed" | "attachments_too_large",
		readonly attachmentId?: string,
	) {
		super(reason);
	}
}

/**
 * Base64 without a 3x string blow-up: encoded in chunks that are a multiple of 3
 * bytes, so each chunk's output concatenates cleanly with the next.
 */
export function bytesToBase64(bytes: Uint8Array): string {
	const CHUNK = 0x8000 * 3;
	let out = "";
	for (let offset = 0; offset < bytes.length; offset += CHUNK) {
		const slice = bytes.subarray(offset, offset + CHUNK);
		let binary = "";
		for (let i = 0; i < slice.length; i += 0x8000) {
			binary += String.fromCharCode(...slice.subarray(i, i + 0x8000));
		}
		out += btoa(binary);
	}
	return out;
}

/**
 * The attachments in the shape Cloudflare Email Sending's `send()` takes. The
 * provider composes the wire message from these: a multipart/mixed whose first
 * part is the multipart/alternative (text + html) we already send, followed by
 * one base64 part per file with Content-Disposition: attachment and the name
 * encoded for non-ASCII. We hand it base64 strings rather than ArrayBuffers
 * because the documented builder accepts both and only strings survive the
 * local `wrangler dev` simulator (binary content cannot be serialised there).
 *
 * Every file goes out as a regular attachment: the compose editor does not keep
 * <img> tags, so an inline (cid:) image of a forwarded original is forwarded as
 * a file instead of being referenced from the body.
 */
export function providerAttachments(files: readonly LoadedAttachment[]): EmailAttachment[] {
	return files.map((file) => ({
		disposition: "attachment" as const,
		filename: file.filename,
		type: file.contentType,
		content: bytesToBase64(file.bytes),
	}));
}

/**
 * Reads every frozen attachment back from R2 and proves each is still the file
 * that was confirmed (same sha256) — the bytes that leave are the bytes that
 * were hashed. Throws instead of sending anything short.
 */
export async function loadSnapshotAttachments(
	r2: Pick<R2Bucket, "get">,
	attachments: readonly SnapshotAttachment[],
): Promise<LoadedAttachment[]> {
	if (attachments.length === 0) return [];
	const total = attachments.reduce((sum, a) => sum + a.size, 0);
	if (attachments.length > MAX_ATTACHMENT_COUNT || total > MAX_TOTAL_ATTACHMENT_BYTES) {
		throw new AttachmentUnavailableError("attachments_too_large");
	}
	const loaded: LoadedAttachment[] = [];
	for (const attachment of attachments) {
		const object = await r2.get(attachment.r2Key);
		if (!object) throw new AttachmentUnavailableError("attachment_missing", attachment.id);
		const bytes = new Uint8Array(await object.arrayBuffer());
		if (bytes.byteLength !== attachment.size || (await sha256Hex(bytes)) !== attachment.sha256) {
			throw new AttachmentUnavailableError("attachment_changed", attachment.id);
		}
		loaded.push({ ...attachment, bytes });
	}
	return loaded;
}
