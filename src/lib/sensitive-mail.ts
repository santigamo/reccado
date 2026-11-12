export type SensitiveKind = "otp" | "password_reset" | "magic_link" | "verification";
/** What the mailbox stores: the public kinds plus this instance's own auth mail, which MCP never shows. */
export type StoredSensitiveKind = SensitiveKind | "instance_auth";
export type SensitiveInput = {
	from: string | null;
	subject: string | null;
	text: string | null;
	html?: string | null;
};

const keyword =
	/(?:c[oó]digo|verificaci[oó]n|verificar|contraseñ[ao]|restablecer|inicio de sesi[oó]n|\bcode\b|verif(?:y|ication)|one[ -]time|password|sign[ -]?in|log[ -]?in|magic link|passcode|\b(?:otp|pin|2fa)\b)/i;

/** Query/fragment parameter names that carry a credential. `id` only counts when its value is long. */
const SECRET_PARAM =
	/^(?:t|token|code|key|sig|signature|otp|reset|auth|login|magic|session|verify|verification|access_token|id_token|ticket|nonce)$/i;
const LONG_VALUE_PARAM = /^(?:id|uid|sid|u|h|s|k|ref|link|r)$/i;
const CODE_STOPWORDS = new Set([
	"CODE",
	"YOUR",
	"SIGN",
	"LOGIN",
	"LOG",
	"PASSWORD",
	"VERIFY",
	"EMAIL",
	"THIS",
	"THAT",
	"WITH",
	"FROM",
	"HERE",
	"PIN",
	"OTP",
]);

function normalizeUrl(value: string): string {
	return value.replace(/&amp;/gi, "&");
}

function urlParts(value: string): URL | null {
	try {
		return new URL(normalizeUrl(value));
	} catch {
		return null;
	}
}

function hasSecretParam(url: URL): boolean {
	const pairs = [
		...url.searchParams.entries(),
		...new URLSearchParams(url.hash.replace(/^#/, "").replace(/^\//, "").replace(/^[^=]*\?/, "")).entries(),
	];
	return pairs.some(
		([name, val]) =>
			SECRET_PARAM.test(name) || (LONG_VALUE_PARAM.test(name) && val.length >= 16),
	);
}

function longestSegment(url: URL): number {
	return Math.max(0, ...url.pathname.split("/").map((segment) => segment.length));
}

/** Does this URL look like it carries a credential? */
function isSecretUrl(value: string, minSegment = 24): boolean {
	const url = urlParts(value);
	if (!url) return /[?&#](?:t|token|code|key|sig|otp|reset|auth|login|magic|session|verify)(?:=|%3d)/i.test(value);
	return hasSecretParam(url) || longestSegment(url) >= minSegment;
}

/** Magic-link / reset mails: every link is suspect unless it has no query, hash or long path segment. */
function isPlainUrl(value: string): boolean {
	const url = urlParts(value);
	return Boolean(url && !url.search && !url.hash && longestSegment(url) < 16);
}

type Span = { start: number; end: number };

/** Digits grouped by space/hyphen: "123 456", "12-34-56", total 4-12 digits. */
const GROUPED_DIGITS = /(?<![\w-])\d{1,4}(?:[ -]\d{1,4}){1,3}(?![\w-])/g;

/** `digitsAnywhere`: in an already-classified mail, digit codes are masked wherever they appear. */
function codeSpans(text: string, digitsAnywhere: boolean): Span[] {
	const spans: Span[] = [];
	const near = (start: number, end: number) =>
		keyword.test(text.slice(Math.max(0, start - 100), end + 100));
	for (const m of text.matchAll(GROUPED_DIGITS)) {
		const digits = m[0].replace(/\D/g, "").length;
		if (digits >= 4 && digits <= 12 && (digitsAnywhere || near(m.index, m.index + m[0].length)))
			spans.push({ start: m.index, end: m.index + m[0].length });
	}
	// 4-12 character tokens: digit-bearing ones anywhere near a keyword, and
	// letters-only ones when upper-case (a code, not a word).
	for (const m of text.matchAll(/\b[A-Za-z0-9]{4,12}\b/g)) {
		const token = m[0];
		const hasDigit = /\d/.test(token);
		const upperOnly = /^[A-Z]+$/.test(token) && !CODE_STOPWORDS.has(token);
		if (
			(hasDigit && (digitsAnywhere || near(m.index, m.index + token.length))) ||
			(upperOnly && near(m.index, m.index + token.length))
		)
			spans.push({ start: m.index, end: m.index + token.length });
	}
	// "code: abcdefgh" -- any 4-12 alphanumeric right after a labelled colon.
	for (const m of text.matchAll(
		/(?:c[oó]digo|\bcode\b|\botp\b|\bpin\b|passcode|contraseñ[ao]|password)(?:\s+(?:is|es))?\s*[:=]\s*([A-Za-z0-9]{4,12})\b/gi,
	)) {
		const start = m.index + m[0].length - (m[1] ?? "").length;
		spans.push({ start, end: m.index + m[0].length });
	}
	return spans;
}

export function classifySensitive(input: SensitiveInput): {
	kind: SensitiveKind | null;
	reasons: string[];
} {
	const content = `${input.subject ?? ""}\n${input.text ?? ""}\n${input.html ?? ""}`;
	const sender = /(?:no-?reply|security|accounts)@/i.test(input.from ?? "");
	const signals = keyword.test(content);
	const withoutUrls = content.replace(/https?:\/\/[^\s<>"']+/gi, "");
	const hasCode = codeSpans(withoutUrls, false).length > 0;
	const hasLink = (content.match(/https?:\/\/[^\s<>"']+/gi) ?? []).some((url) => isSecretUrl(url));
	const reset =
		/(?:password reset|reset (?:your |the )?password|restablec\w* (?:tu |la )?contraseñ|recuper\w* (?:tu |la )?contraseñ)/i.test(
			content,
		);
	const magic =
		(hasLink && /(?:sign[ -]?in|log[ -]?in|inicio de sesi[oó]n)/i.test(content)) ||
		/(?:magic link|enlace m[aá]gico|sign[ -]?in link|login link|enlace (?:de|para) (?:inicio de sesi[oó]n|acceder))/i.test(
			content,
		);
	const verification =
		/(?:verificaci[oó]n|verificar|verif(?:y|ication)|confirm(?:ar|ation)? (?:your |tu )?(?:email|account|correo|cuenta))/i.test(
			content,
		);
	const otp = /(?:one[ -]time|\botp\b|\b2fa\b|c[oó]digo|\bcode\b)/i.test(content);
	if (!signals || !(hasCode || hasLink || (sender && (reset || magic))))
		return { kind: null, reasons: [] };
	const kind = reset
		? "password_reset"
		: magic
			? "magic_link"
			: otp
				? "otp"
				: verification
					? "verification"
					: null;
	return {
		kind,
		reasons: kind
			? [
					hasCode
						? "code near security keyword"
						: hasLink
							? "security link"
							: "security subject or body",
					...(sender ? ["automated sender"] : []),
				]
			: [],
	};
}

/** Legacy and failed-classification rows are classified when their stored bodies are read. */
export function sensitiveKindForRead(
	row: {
		sensitive_kind: StoredSensitiveKind | null;
		sensitive_classified: number;
		from_addr: string;
		subject: string | null;
		body_text: string | null;
	},
	html?: string | null,
): SensitiveKind | null {
	return row.sensitive_classified === 1
		? row.sensitive_kind === "instance_auth"
			? "otp"
			: row.sensitive_kind
		: classifySensitive({ from: row.from_addr, subject: row.subject, text: row.body_text, html })
				.kind;
}

export function redactSensitive(
	text: string,
	kind: SensitiveKind | null,
): { text: string; redactions: number } {
	try {
		if (!kind) return { text, redactions: 0 };
		let redactions = 0;
		const strict = kind === "magic_link" || kind === "password_reset";
		const links = text.replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
			if (strict ? isPlainUrl(value) : !isSecretUrl(value)) return value;
			redactions++;
			const url = urlParts(value);
			return url ? `${url.origin}/[enlace oculto]` : "[enlace oculto]";
		});
		// Mask codes outside the (already handled) links, merging overlapping spans.
		const pieces = links.split(/(\[enlace oculto\]|https?:\/\/[^\s<>"']+)/gi);
		const masked = pieces
			.map((piece, index) => {
				if (index % 2 === 1) return piece;
				const spans = codeSpans(piece, true).sort((x, y) => x.start - y.start);
				let out = "";
				let cursor = 0;
				for (const span of spans) {
					if (span.end <= cursor) continue;
					const start = Math.max(span.start, cursor);
					out += piece.slice(cursor, start) + "••••••";
					cursor = span.end;
					redactions++;
				}
				return out + piece.slice(cursor);
			})
			.join("");
		return { text: masked, redactions };
	} catch {
		return { text, redactions: 0 };
	}
}
