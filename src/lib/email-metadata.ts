export function normalizeMessageId(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	return trimmed.replace(/^<|>$/g, "").toLowerCase();
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
