import { sha256Hex } from "../lib/template-hash";

/**
 * Fetches the JSON document a `manage_template` sync names by URL, so an agent can load a set of
 * templates without re-emitting every subject and body inside the tool call.
 *
 * The fetch is deliberately narrow: https on the default port only, no credentials (no userinfo
 * in the URL, no headers of ours beyond Accept/User-Agent, never the caller's token), public
 * hostnames only (no IP literals, single-label or local/internal names, nor this deployment's own
 * host), redirects re-checked hop by hop (at most 3), a 10 s timeout, a 2 MB body cap, and the
 * body must parse as the template-sync JSON shape. Errors are coarse codes; the body of a failed
 * response is never echoed. The recorded URL drops the query string (signed URLs carry tokens).
 */
export const MAX_SOURCE_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const LOCAL_SUFFIX = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home\.arpa|corp)$/;

/** A refusal the agent sees as `refused: <code>` (plus a short detail in parentheses). */
export class SourceRefusal extends Error {
	constructor(
		readonly code: string,
		readonly detail?: string,
	) {
		super(`refused: ${code}${detail ? ` (${detail})` : ""}`);
		this.name = "SourceRefusal";
	}
}

export type TemplateSource = {
	/** The requested URL without its query string (`?…` marks that one was dropped). */
	url: string;
	sha256: string;
	bytes: number;
};

/** The URL if it may be fetched; a `SourceRefusal` otherwise. */
export function checkSourceUrl(raw: string, ownHost: string | null): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new SourceRefusal("source_url_invalid");
	}
	if (url.protocol !== "https:") throw new SourceRefusal("source_url_not_https");
	if (url.username || url.password) throw new SourceRefusal("source_url_has_credentials");
	if (url.port && url.port !== "443") throw new SourceRefusal("source_url_port_refused");
	const host = url.hostname.toLowerCase().replace(/\.$/, "");
	const refused =
		!host.includes(".") ||
		host.startsWith("[") ||
		host.includes(":") ||
		/^[0-9.]+$/.test(host) ||
		LOCAL_SUFFIX.test(host) ||
		(ownHost !== null && (host === ownHost || host.endsWith(`.${ownHost}`)));
	if (refused) throw new SourceRefusal("source_url_host_refused", host);
	return url;
}

export function recordedUrl(url: URL): string {
	return `${url.origin}${url.pathname}${url.search ? "?…" : ""}`;
}

async function readCapped(response: Response): Promise<Uint8Array<ArrayBuffer>> {
	const declared = Number(response.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
		await response.body?.cancel().catch(() => undefined);
		throw new SourceRefusal("source_too_large", `max ${MAX_SOURCE_BYTES} bytes`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_SOURCE_BYTES) {
			await reader.cancel().catch(() => undefined);
			throw new SourceRefusal("source_too_large", `max ${MAX_SOURCE_BYTES} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * GETs the document and returns its templates (the HTTP sync body `{ "templates": [...] }`, or a
 * bare array of the same items) with what to record about it. `expectedSha256`, when given, must
 * equal the SHA-256 of the exact bytes received.
 */
export async function fetchTemplateSource(
	raw: string,
	options: { ownHost: string | null; expectedSha256?: string },
): Promise<{ templates: unknown[]; source: TemplateSource }> {
	const requested = checkSourceUrl(raw, options.ownHost);
	const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	let url = requested;
	let response: Response;
	for (let hop = 0; ; hop++) {
		try {
			response = await fetch(url.toString(), {
				method: "GET",
				redirect: "manual",
				signal,
				headers: { accept: "application/json, text/plain;q=0.9", "user-agent": "Reccado" },
			});
		} catch (error) {
			const name = error instanceof Error ? error.name : "";
			throw new SourceRefusal(
				name === "TimeoutError" || name === "AbortError" ? "source_timeout" : "source_fetch_failed",
			);
		}
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			await response.body?.cancel().catch(() => undefined);
			if (hop >= MAX_REDIRECTS) throw new SourceRefusal("source_too_many_redirects");
			let next: string;
			try {
				next = new URL(location, url).toString();
			} catch {
				throw new SourceRefusal("source_url_invalid");
			}
			url = checkSourceUrl(next, options.ownHost);
			continue;
		}
		break;
	}
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new SourceRefusal("source_http_error", `HTTP ${response.status}`);
	}
	// An HTML answer is a login wall or an error page, never a template document.
	if (/html/i.test(response.headers.get("content-type") ?? "")) {
		await response.body?.cancel().catch(() => undefined);
		throw new SourceRefusal("source_not_json", "content-type is HTML");
	}
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = await readCapped(response);
	} catch (error) {
		if (error instanceof SourceRefusal) throw error;
		const name = error instanceof Error ? error.name : "";
		throw new SourceRefusal(
			name === "TimeoutError" || name === "AbortError" ? "source_timeout" : "source_fetch_failed",
		);
	}
	const sha256 = await sha256Hex(bytes);
	if (options.expectedSha256 && options.expectedSha256.toLowerCase() !== sha256)
		throw new SourceRefusal("source_hash_mismatch", `got ${sha256}`);
	let doc: unknown;
	try {
		doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new SourceRefusal("source_not_json");
	}
	let templates: unknown[] | null = null;
	if (Array.isArray(doc)) templates = doc;
	else if (doc && typeof doc === "object") {
		const extra = Object.keys(doc).filter((key) => key !== "templates");
		// `archiveMissing` belongs to the HTTP API; an MCP sync never archives.
		if (extra.length)
			throw new SourceRefusal("source_unsupported_field", extra.slice(0, 3).join(", "));
		const list = (doc as { templates?: unknown }).templates;
		if (Array.isArray(list)) templates = list;
	}
	if (!templates)
		throw new SourceRefusal("source_shape", 'expected {"templates":[...]} or a JSON array');
	return { templates, source: { url: recordedUrl(requested), sha256, bytes: bytes.byteLength } };
}
