/**
 * RFC 5322 header construction for outbound mail.
 *
 * Reccado stores message-ids in their bare form: no angle brackets, original case
 * (see normalizeMessageId in email-metadata.ts — msg-ids are case-sensitive, and
 * the lookups fold case instead of the data). Anything that goes *out* on the wire
 * has to be re-wrapped in angle brackets, so the two representations are kept apart
 * here: `...MessageId` values are bare, `...Header` values are wire-ready.
 */

/** Cap on the References chain. RFC 5322 allows any length, but real clients and
 * spam filters dislike unbounded headers, so keep the root of the thread (which is
 * what most clients thread on) plus the most recent ancestors. */
const MAX_REFERENCES = 20;

export function domainFromAddress(address: string): string | null {
	const at = address.lastIndexOf("@");
	if (at <= 0 || at === address.length - 1) {
		return null;
	}
	return (
		address
			.slice(at + 1)
			.trim()
			.toLowerCase() || null
	);
}

/**
 * Wraps a bare message-id for use in an In-Reply-To / References header.
 *
 * Note there is deliberately no generator for our *own* Message-ID: Cloudflare
 * Email Service treats Message-ID as platform-controlled and rejects a
 * caller-supplied one, so the sent id is whatever the provider returns.
 */
export function messageIdHeader(bareMessageId: string): string {
	return `<${bareMessageId}>`;
}

/**
 * References for a reply: the parent's own References chain, then the parent's
 * Message-ID (RFC 5322 §3.6.4). Trimmed from the middle when too long so the
 * thread root and the immediate ancestors both survive.
 */
export function buildReferences(
	parentReferences: string[],
	parentMessageId: string | null,
): string[] {
	const chain = [...parentReferences];
	// Case-insensitive membership: msg-ids keep their original case, and the same id
	// quoted by two clients can differ only in case — appending it twice would be a
	// malformed chain.
	const seen = new Set(chain.map((reference) => reference.toLowerCase()));
	if (parentMessageId && !seen.has(parentMessageId.toLowerCase())) {
		chain.push(parentMessageId);
	}
	if (chain.length <= MAX_REFERENCES) {
		return chain;
	}
	return [chain[0]!, ...chain.slice(chain.length - (MAX_REFERENCES - 1))];
}

export function referencesHeader(references: string[]): string {
	return references.map(messageIdHeader).join(" ");
}

/** "Re: x" — idempotent, so a reply to a reply doesn't become "Re: Re: x". */
export function replySubject(subject: string | null | undefined): string {
	const trimmed = (subject ?? "").trim();
	if (!trimmed) {
		return "Re:";
	}
	return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export type QuotedParent = {
	fromAddr: string;
	/** Date header of the parent if it had one, else its received_at. */
	date: string | null;
	/** Parent body as plain text. HTML parents are quoted from their text
	 * alternative: re-emitting a stranger's HTML inside our own message would mean
	 * shipping unsanitized markup we never inspected. */
	bodyText: string | null;
};

function attributionLine(parent: QuotedParent): string {
	const parsed = parent.date ? new Date(parent.date) : null;
	const when = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toUTCString() : null;
	return when ? `On ${when}, ${parent.fromAddr} wrote:` : `${parent.fromAddr} wrote:`;
}

/** Body limit for the quoted section, so a reply to a 2 MB newsletter stays sane. */
const MAX_QUOTE_CHARS = 4000;

function clampQuote(bodyText: string | null): string {
	const text = (bodyText ?? "").replace(/\r\n/g, "\n").trimEnd();
	if (text.length <= MAX_QUOTE_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_QUOTE_CHARS)}\n[…]`;
}

/** `body` followed by the classic "> " quoted parent. */
export function quoteTextForReply(body: string, parent: QuotedParent): string {
	const quoted = clampQuote(parent.bodyText);
	const quotedBlock = quoted
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n");
	return `${body.trimEnd()}\n\n${attributionLine(parent)}\n${quotedBlock}\n`;
}

/** Plain text as HTML paragraphs, escaped. For bodies that are not already HTML. */
export function plainTextToHtml(text: string): string {
	return text
		.trimEnd()
		.split(/\n{2,}/)
		.map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
		.join("\n");
}

/**
 * The same reply as minimal HTML: our body, then the parent in a <blockquote>.
 * `bodyHtml` must already be safe HTML — use plainTextToHtml() for plain text.
 */
export function quoteHtmlForReply(bodyHtml: string, parent: QuotedParent): string {
	const quoted = escapeHtml(clampQuote(parent.bodyText)).replace(/\n/g, "<br>");
	return [
		bodyHtml,
		`<div class="reccado-quote">`,
		`<p>${escapeHtml(attributionLine(parent))}</p>`,
		`<blockquote style="margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex">${quoted}</blockquote>`,
		`</div>`,
	].join("\n");
}
