/**
 * Limits and name/type hygiene for files the owner attaches to a draft. Shared by
 * the worker (which enforces them) and the compose dialog (which explains them
 * before a byte is uploaded), so both sides refuse the same thing.
 *
 * Where the numbers come from:
 *  - Cloudflare Email Sending caps the TOTAL message at 25 MiB, attachments
 *    included, after MIME encoding (developers.cloudflare.com/email-service/
 *    platform/limits). Base64 grows a file by 4/3 plus a CRLF every 76 columns,
 *    so 17 MiB of attachments become ~23.3 MiB on the wire, leaving ~1.7 MiB for
 *    the headers and both bodies (the HTML body is capped at 1,000,000 chars in
 *    api/schemas.ts). Cloudflare's own upload example caps a single file at
 *    18 MiB for the same reason; we keep a little more headroom because our
 *    bodies can be large.
 *  - The Worker request body limit (100 MB on Free/Pro) is far above one file,
 *    so a single upload request always fits.
 *  - Inbound mail is capped at the same 25 MiB (cloudflare/email-handler.ts), so
 *    a forwarded message's attachments are bounded the same way.
 */

const MiB = 1024 * 1024;

/** Largest single file. Equal to the total: one big file may use the whole budget. */
export const MAX_ATTACHMENT_BYTES = 17 * MiB;
/** All of a draft's attachments together (raw bytes, before base64). */
export const MAX_TOTAL_ATTACHMENT_BYTES = 17 * MiB;
/** Files per draft. */
export const MAX_ATTACHMENT_COUNT = 20;
/** Characters kept of a file name (the extension survives truncation). */
export const MAX_FILENAME_CHARS = 180;

/**
 * A file name safe to store, show and put in a MIME header: no path (a name like
 * `../../etc/passwd` or `C:\x\y.pdf` keeps only its last segment), no control
 * characters (CR/LF would be header injection), no quotes or backslashes, no
 * leading dots (hidden files), NFC-normalised, length-bounded with the
 * extension kept. Non-ASCII letters stay: the provider encodes them (RFC 2231)
 * and the reader should see "Presupuesto año 2026.pdf", not underscores.
 */
export function sanitizeAttachmentName(name: string | null | undefined): string {
	let value = (name ?? "").normalize("NFC");
	value = value.split(/[/\\]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	value = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"]/g, "");
	value = value.replace(/\s+/g, " ").trim().replace(/^\.+/, "").trim();
	if (!value) return "attachment";
	if (value.length > MAX_FILENAME_CHARS) {
		const dot = value.lastIndexOf(".");
		const ext = dot > 0 && value.length - dot <= 12 ? value.slice(dot) : "";
		value = value.slice(0, MAX_FILENAME_CHARS - ext.length).trimEnd() + ext;
	}
	return value;
}

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

/**
 * The declared type, reduced to a bare `type/subtype` (parameters dropped), or
 * application/octet-stream when it is missing or malformed. It is only a label
 * for the recipient's client: we never render an upload, and downloads are
 * served with nosniff, a sandbox CSP and Content-Disposition: attachment.
 */
export function normalizeAttachmentType(type: string | null | undefined): string {
	const bare = (type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	return MIME_TYPE.test(bare) ? bare : "application/octet-stream";
}

/** "1.2 MB", "340 KB", "12 bytes". */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} ${bytes === 1 ? "byte" : "bytes"}`;
	if (bytes < MiB) return `${Math.round(bytes / 1024)} KB`;
	const mb = bytes / MiB;
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
