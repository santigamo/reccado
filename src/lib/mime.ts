import PostalMime from "postal-mime";

export type ParsedEmail = {
	from: string;
	/** The From display name exactly as parsed (unsanitised; see display-name.ts). */
	fromName: string | null;
	/** To/Cc display names as parsed, one entry per named recipient. */
	recipientNames: Array<{ address: string; name: string }>;
	to: string[];
	cc: string[];
	bcc: string[];
	/** Reply-To addresses, lowercased (empty when the header is absent). */
	replyTo: string[];
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
	const recipientNames = [...(email.to ?? []), ...(email.cc ?? [])].flatMap((addr) =>
		addr && "address" in addr && addr.address && addr.name
			? [{ address: addr.address, name: addr.name }]
			: [],
	);
	const references = Array.isArray(email.references)
		? email.references
		: email.references
			? [email.references]
			: [];
	return {
		from: from.toLowerCase(),
		fromName: email.from?.name || null,
		recipientNames,
		to: (email.to ?? []).map(mapAddr).filter(Boolean),
		cc: (email.cc ?? []).map(mapAddr).filter(Boolean),
		bcc: (email.bcc ?? []).map(mapAddr).filter(Boolean),
		replyTo: replyToAddresses(email.replyTo),
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

const SIMPLE_ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

/** Most Reply-To addresses kept: the header is the sender's free choice. */
export const MAX_REPLY_TO = 10;

/**
 * Reply-To as plain lowercased addresses: groups flattened, anything that is
 * not a plain address dropped, duplicates removed, capped.
 */
export function replyToAddresses(
	list: ReadonlyArray<{ address?: string; group?: Array<{ address?: string }> }> | null | undefined,
): string[] {
	const out: string[] = [];
	for (const entry of list ?? []) {
		const members = entry.group ?? [entry];
		for (const member of members) {
			const address = member.address?.trim().toLowerCase();
			if (!address || !SIMPLE_ADDRESS.test(address) || out.includes(address)) continue;
			out.push(address);
			if (out.length >= MAX_REPLY_TO) return out;
		}
	}
	return out;
}

/**
 * The header block of a raw message, read from its first bytes: everything up
 * to the first empty line (or all of it when the slice ends first). Enough for
 * a header-only parse without reading the body.
 */
export function headerBlock(head: Uint8Array): Uint8Array {
	for (let i = 0; i < head.length - 1; i++) {
		if (head[i] === 10 && head[i + 1] === 10) return head.subarray(0, i + 1);
		if (head[i] === 10 && head[i + 1] === 13 && head[i + 2] === 10) return head.subarray(0, i + 1);
	}
	return head;
}

/**
 * From display name and Reply-To from a header block alone (see headerBlock).
 * Both unsanitised as to the name: callers pass it through sanitizeDisplayName.
 */
export async function parseHeaderFields(
	headers: Uint8Array,
): Promise<{ fromAddress: string | null; fromName: string | null; replyTo: string[] }> {
	const bytes = new Uint8Array(headers.length + 4);
	bytes.set(headers);
	bytes.set([13, 10, 13, 10], headers.length);
	const email = await new PostalMime().parse(bytes);
	return {
		fromAddress: email.from?.address?.toLowerCase() ?? null,
		fromName: email.from?.name || null,
		replyTo: replyToAddresses(email.replyTo),
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
