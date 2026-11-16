/**
 * Automated mail that the web inbox keeps out of the way: stored like any other
 * message (raw MIME in R2, a row in the mailbox DO, searchable over MCP), but
 * not listed, counted or badged in the normal web folders.
 *
 * The only kind today is the DMARC aggregate ("rua") report of RFC 7489 §7.2:
 * a daily machine-to-machine XML file that a mailbox receiving rua mail gets
 * from every large receiver (Google, Yahoo, Microsoft, …). Reading one in the
 * inbox is worthless; losing one is not acceptable either, hence "hidden" and
 * never "dropped".
 *
 * Deliberately conservative: a false positive hides a person's mail, a false
 * negative only shows a report. Only structural signals count, never the sender
 * alone, and anything that looks like part of a conversation is left alone.
 */
export type AutomatedKind = "dmarc_report";

export type AutomatedMailInput = {
	from: string | null;
	subject: string | null;
	/** In-Reply-To of the message (normalised or raw; only presence matters). */
	inReplyTo: string | null;
	/** References of the message. */
	references?: readonly string[];
	attachments: ReadonlyArray<{ filename: string | null; contentType: string | null }>;
};

/**
 * RFC 7489 §7.2.1.1: `Report Domain: <domain> Submitter: <submitter>
 * Report-ID: <id>`. Receivers vary the case ("Report domain:"), the spacing and
 * the hyphen ("Report ID"), and some prefix a tag ("[Preview]"). The submitter
 * may contain spaces ("Yahoo Inc."), so it runs up to the Report-ID label.
 */
const REPORT_SUBJECT =
	/^\s*(?:\[[^\]]{1,40}\]\s*)?report\s+domain\s*:\s*\S+\s+submitter\s*:\s*\S.*?(?:\s+report[\s-]?id\s*:\s*(\S.*))?\s*$/i;

/**
 * RFC 7489 §7.2.1.1 file name: `receiver "!" policy-domain "!" begin "!" end
 * ["!" unique-id] "." extension`, timestamps in epoch seconds; the extension is
 * `xml`, `xml.gz`, `gz` or `zip`.
 */
const REPORT_FILENAME =
	/^[^!\s/\\]+![^!\s/\\]+!\d{9,11}!\d{9,11}(?:![^!\s/\\]{1,128})?\.(?:xml|xml\.gz|gz|zip)$/i;

const REPORT_CONTENT_TYPES = new Set([
	"application/zip",
	"application/x-zip-compressed",
	"application/gzip",
	"application/x-gzip",
	"text/xml",
	"application/xml",
	// Some receivers label the archive generically; the file name still has to match.
	"application/octet-stream",
]);

/** A reply or forward prefix ("Re:", "Fwd:", "RV:", "AW:", "WG:", "TR:", "SV:"). */
const CONVERSATION_PREFIX = /^\s*(?:re|fwd?|rv|aw|wg|tr|sv|vs|r)\s*(?:\[\d+\])?\s*:/i;

/** Local parts that only machines send from, for the attachment-only path. */
const AUTOMATED_LOCAL_PART =
	/^(?:[a-z0-9._+-]*(?:dmarc|rua|noreply|no-reply|donotreply|do-not-reply|postmaster|reports?|mailer-daemon)[a-z0-9._+-]*)@/i;

export function isDmarcReportSubject(subject: string | null | undefined): boolean {
	return Boolean(subject && REPORT_SUBJECT.test(subject));
}

/** Report-ID present in a subject that already matched the RFC 7489 shape. */
function subjectHasReportId(subject: string): boolean {
	return Boolean(REPORT_SUBJECT.exec(subject)?.[1]);
}

export function isDmarcReportAttachment(attachment: {
	filename: string | null;
	contentType: string | null;
}): boolean {
	const name = attachment.filename?.trim();
	if (!name || !REPORT_FILENAME.test(name)) return false;
	const type = (attachment.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	return REPORT_CONTENT_TYPES.has(type);
}

/**
 * Classify a received message. Returns `"dmarc_report"` only when:
 *
 *  - it is not part of a conversation: no In-Reply-To, no References, no
 *    reply/forward prefix on the subject (a report a person forwards or quotes
 *    stays a person's mail), and
 *  - either the subject has the full RFC 7489 shape (domain, submitter and
 *    Report-ID), or it has the shape without the Report-ID and carries a report
 *    file, or every attachment is a conventionally named report file, the
 *    subject talks about a report, and the sender is an automated mailbox.
 *
 * A parse failure is never classified: the caller does not call this then.
 */
export function classifyAutomatedMail(input: AutomatedMailInput): AutomatedKind | null {
	const subject = input.subject ?? "";
	if (input.inReplyTo) return null;
	if (input.references && input.references.length > 0) return null;
	if (CONVERSATION_PREFIX.test(subject)) return null;

	const reportFiles = input.attachments.filter(isDmarcReportAttachment);
	if (isDmarcReportSubject(subject)) {
		if (subjectHasReportId(subject) || reportFiles.length > 0) return "dmarc_report";
		return null;
	}
	const onlyReportFiles = reportFiles.length > 0 && reportFiles.length === input.attachments.length;
	if (
		onlyReportFiles &&
		/\b(?:dmarc|report|aggregate)\b/i.test(subject) &&
		AUTOMATED_LOCAL_PART.test((input.from ?? "").trim())
	) {
		return "dmarc_report";
	}
	return null;
}
