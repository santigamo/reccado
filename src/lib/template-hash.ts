/**
 * Content hash of one transactional template, so an agent can compare a stored template with a
 * local copy without downloading its bodies.
 *
 * Recipe (reproducible anywhere): SHA-256, hex, of the UTF-8 bytes of the compact JSON array
 * `[subject, body_text, body_html]`, with an absent body as `null` and non-ASCII characters left
 * unescaped — JavaScript `JSON.stringify([s, t, h])`, Python
 * `json.dumps([s, t, h], separators=(",", ":"), ensure_ascii=False)`.
 */
export async function templateContentHash(template: {
	subject: string;
	body_text?: string | null;
	body_html?: string | null;
}): Promise<string> {
	const json = JSON.stringify([
		template.subject,
		template.body_text ?? null,
		template.body_html ?? null,
	]);
	return sha256Hex(new TextEncoder().encode(json));
}

export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
