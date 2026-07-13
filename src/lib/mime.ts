import PostalMime from "postal-mime";

export type ParsedEmail = {
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string | null;
	date: string | null;
	messageId: string | null;
	inReplyTo: string | null;
	references: string[];
	text: string | null;
	html: string | null;
	attachments: Array<{
		filename: string | null;
		mimeType: string;
		content: Uint8Array;
		disposition: string | null;
		contentId: string | null;
		related: boolean;
	}>;
};

function toBytes(content: string | ArrayBuffer | Uint8Array): Uint8Array {
	if (typeof content === "string") {
		return new TextEncoder().encode(content);
	}
	if (content instanceof Uint8Array) {
		return content;
	}
	return new Uint8Array(content);
}

export async function parseMimeBytes(rawBytes: Uint8Array): Promise<ParsedEmail> {
	const parser = new PostalMime();
	const email = await parser.parse(rawBytes);
	const from = email.from?.address ?? "unknown@invalid";
	const mapAddr = (addr: { address?: string } | null | undefined) => addr?.address ?? "";
	const references = Array.isArray(email.references)
		? email.references
		: email.references
			? [email.references]
			: [];
	return {
		from: from.toLowerCase(),
		to: (email.to ?? []).map(mapAddr).filter(Boolean),
		cc: (email.cc ?? []).map(mapAddr).filter(Boolean),
		bcc: (email.bcc ?? []).map(mapAddr).filter(Boolean),
		subject: email.subject ?? null,
		date: email.date ?? null,
		messageId: email.messageId ?? null,
		inReplyTo: email.inReplyTo ?? null,
		references,
		text: email.text ?? null,
		html: email.html ?? null,
		attachments: (email.attachments ?? []).map((attachment) => ({
			filename: attachment.filename ?? null,
			mimeType: attachment.mimeType,
			content: toBytes(attachment.content),
			disposition: attachment.disposition ?? null,
			contentId: attachment.contentId ?? null,
			related: attachment.related ?? false,
		})),
	};
}

export function normalizeSubject(subject: string | null): string | null {
	if (!subject) return null;
	// Strip any chain of leading reply/forward prefixes ("Re:", "Fwd:"), tolerating leading
	// whitespace before the prefix, so threading collapses "Re: Re: X", "  Fwd: X", etc. to "x".
	let result = subject.trim();
	let previous: string;
	do {
		previous = result;
		result = result.replace(/^(?:re|fwd):\s*/i, "").trim();
	} while (result !== previous);
	return result.toLowerCase() || null;
}

/**
 * Flatten HTML to readable plain text for previews: drop the parts that carry no
 * visible copy (head/style/script), turn tags into spaces, decode the handful of
 * entities that show up in real mail, strip zero-width padding some senders use to
 * pad the preview, then collapse whitespace.
 */
export function htmlToText(html: string): string {
	return html
		.replace(/<(head|style|script|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&quot;/gi, '"')
		.replace(/&amp;/gi, "&")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * Build the list-row/snippet preview. When an HTML part exists it is the canonical
 * representation of a multipart/alternative message (and the one the client now
 * renders), so we derive the snippet from it — otherwise a sender that ships an
 * empty-but-present text/plain part (logo + footer only, e.g. LabsMobile 2FA mail)
 * yields a useless preview with the real body hidden in HTML. Falls back to the
 * plain-text part when HTML flattens to nothing (image-only emails).
 */
export function snippetFromText(text: string | null, html: string | null, max = 200): string {
	const fromHtml = html != null ? htmlToText(html) : "";
	if (fromHtml) return fromHtml.slice(0, max);
	const fromText = (text ?? "").replace(/\s+/g, " ").trim();
	return fromText.slice(0, max);
}
