/**
 * A msg-id in its stored/bare form: no angle brackets, no surrounding whitespace,
 * and — deliberately — the original case.
 *
 * RFC 5322 §3.6.4 makes msg-id an addr-spec whose local part is dot-atom-text,
 * which is case-sensitive: `<CAHyeH21QU_o...@mail.gmail.com>` and its lowercased
 * twin are different ids. Case-folding here used to make internal lookups match,
 * but it also went out on the wire in In-Reply-To/References, where Gmail found
 * nothing to thread against and opened a fresh conversation. So the data keeps its
 * case and the *lookups* are case-insensitive instead (see resolveThreadId), which
 * also keeps matching the lowercased ids already stored by earlier versions.
 *
 * Callers that need a case-folded value for a stable key must fold it themselves
 * (inboundIdempotencyKey does, so existing idempotency keys stay valid).
 */
export function normalizeMessageId(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.replace(/^<|>$/g, "") || null;
}

export function readHeader(headers: Headers, name: string): string | null {
	const value = headers.get(name);
	return value?.trim() || null;
}

export function readReferences(headers: Headers): string[] {
	const raw = readHeader(headers, "references");
	if (!raw) {
		return [];
	}
	return raw
		.split(/\s+/)
		.map((part) => normalizeMessageId(part))
		.filter((part): part is string => Boolean(part));
}
