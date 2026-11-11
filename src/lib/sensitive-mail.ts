export type SensitiveKind = "otp" | "password_reset" | "magic_link" | "verification";
export type SensitiveInput = {
	from: string | null;
	subject: string | null;
	text: string | null;
	html?: string | null;
};

const keyword =
	/(?:c[oó]digo|verificaci[oó]n|verificar|contraseñ[ao]|restablecer|inicio de sesi[oó]n|\bcode\b|verif(?:y|ication)|one[ -]time|password|sign[ -]?in|log[ -]?in|magic link|\b(?:otp|2fa)\b)/i;
const secretUrl =
	/[?&#](?:token|code|key|sig(?:nature)?|otp|reset)(?:=|%3d)|\/(?:[A-Za-z0-9_-]{24,})(?:[/?#]|$)/i;

export function classifySensitive(input: SensitiveInput): {
	kind: SensitiveKind | null;
	reasons: string[];
} {
	const content = `${input.subject ?? ""}\n${input.text ?? ""}\n${input.html ?? ""}`;
	const sender = /(?:no-?reply|security|accounts)@/i.test(input.from ?? "");
	const signals = keyword.test(content);
	const withoutUrls = content.replace(/https?:\/\/[^\s<>"']+/gi, "");
	const hasCode = Array.from(
		withoutUrls.matchAll(/\b(?=[A-Z0-9]{4,10}\b)(?=[A-Z0-9]*\d)[A-Z0-9]+\b/gi),
	).some((match) =>
		keyword.test(
			withoutUrls.slice(Math.max(0, match.index - 100), match.index + match[0].length + 100),
		),
	);
	const hasLink = (content.match(/https?:\/\/[^\s<>"']+/gi) ?? []).some((url) =>
		secretUrl.test(url.replace(/&amp;/gi, "&")),
	);
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
		sensitive_kind: SensitiveKind | null;
		sensitive_classified: number;
		from_addr: string;
		subject: string | null;
		body_text: string | null;
	},
	html?: string | null,
): SensitiveKind | null {
	return row.sensitive_classified === 1
		? row.sensitive_kind
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
		const links = text.replace(/https?:\/\/[^\s<>"']+/gi, (value) => {
			if (!secretUrl.test(value.replace(/&amp;/gi, "&"))) return value;
			try {
				const url = new URL(value);
				redactions++;
				return `${url.origin}/[enlace oculto]`;
			} catch {
				return value;
			}
		});
		const masked = links.replace(/\b(?=[A-Z0-9]{4,10}\b)(?=[A-Z0-9]*\d)[A-Z0-9]+\b/gi, () => {
			redactions++;
			return "••••••";
		});
		return { text: masked, redactions };
	} catch {
		return { text, redactions: 0 };
	}
}
