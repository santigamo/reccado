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

export function snippetFromText(text: string | null, html: string | null, max = 200): string {
	const source = text ?? html?.replace(/<[^>]+>/g, " ") ?? "";
	return source.replace(/\s+/g, " ").trim().slice(0, max);
}
