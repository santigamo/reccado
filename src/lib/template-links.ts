/**
 * Link policy for templates a delegated MCP client may change without approval.
 *
 * Every URL a template can emit (href/src/srcset/action/poster, `url()` and
 * `@import` in CSS, meta refresh, plus bare URLs in the text body) must point at a
 * host the owner allow-listed for that client, or be a mailto:. Anything the check
 * cannot prove fails: the change then goes to the normal human approval.
 */

export type LinkPolicy = {
	/** Allowed host suffixes: a host matches when equal to, or a subdomain of, an entry. */
	linkDomains: readonly string[];
	/** Permit `href="{{var}}"` (the whole attribute value one variable). */
	allowVariableLinks: boolean;
};
export type LinkCheck =
	| { ok: true; variableLinks: string[] }
	| { ok: false; reason: string };

const ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos|colon|tab|newline|nbsp));?/gi;
const NAMED: Record<string, string> = {
	amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", nbsp: " ",
};
function decodeEntities(value: string): string {
	return value.replace(ENTITY, (_m, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
		if (name) return NAMED[name.toLowerCase()] ?? "";
		const code = hex ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
		return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
	});
}

/** Hostname as `new URL` normalises it (lower-case, punycode). Null when it is not a valid host. */
export function normalizeHost(host: string): string | null {
	const trimmed = host.trim().replace(/^\*?\./, "").replace(/\.$/, "");
	if (!trimmed || /[\s/?#@:{}]/.test(trimmed)) return null;
	try {
		const parsed = new URL(`https://${trimmed}`);
		return parsed.hostname || null;
	} catch {
		return null;
	}
}
export function normalizeLinkDomains(domains: readonly string[]): string[] {
	const out: string[] = [];
	for (const domain of domains) {
		const host = normalizeHost(domain);
		if (!host) throw new Error(`invalid_link_domain: ${domain}`);
		if (!out.includes(host)) out.push(host);
	}
	return out;
}
const hostAllowed = (host: string, domains: readonly string[]) =>
	domains.some((d) => host === d || host.endsWith(`.${d}`));

type Found = { value: string; attr: string };

const ATTR = /(?<![\w-])(href|src|srcset|action|poster|background|formaction|data|cite|longdesc|usemap|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
const CSS_IMPORT = /@import\s+(?:"([^"]*)"|'([^']*)')/gi;
const META_REFRESH = /content\s*=\s*(?:"[^"]*?\burl\s*=\s*([^";]*)|'[^']*?\burl\s*=\s*([^';]*))/gi;
const TEXT_URL = /(?:\b(?:https?:)?\/\/|\bwww\.)[^\s"'<>)\]]+/gi;
const SCHEME_URL = /\b(?:javascript|vbscript|data):[^\s"'<>]*/gi;

const textUrl = (value: string): Found => ({ value: /^www\./i.test(value) ? `https://${value}` : value, attr: "text" });

function extract(html: string | null | undefined, text: string | null | undefined): Found[] {
	const found: Found[] = [];
	if (html) {
		for (const m of html.matchAll(ATTR)) {
			const attr = (m[1] ?? "").toLowerCase();
			const value = m[2] ?? m[3] ?? m[4] ?? "";
			if (attr === "srcset") {
				for (const candidate of value.split(",")) {
					const url = candidate.trim().split(/\s+/)[0];
					if (url) found.push({ value: url, attr });
				}
			} else found.push({ value, attr });
		}
		for (const m of html.matchAll(CSS_URL)) found.push({ value: m[1] ?? m[2] ?? m[3] ?? "", attr: "css" });
		for (const m of html.matchAll(CSS_IMPORT)) found.push({ value: m[1] ?? m[2] ?? "", attr: "css" });
		for (const m of html.matchAll(META_REFRESH)) found.push({ value: m[1] ?? m[2] ?? "", attr: "refresh" });
		// Link text such as <a>https://evil.example</a> is a URL a reader sees.
		for (const m of html.replace(/<[^>]*>/g, " ").matchAll(TEXT_URL)) found.push(textUrl(m[0]));
		for (const m of html.matchAll(SCHEME_URL)) found.push({ value: m[0], attr: "text" });
	}
	if (text) {
		for (const m of text.matchAll(TEXT_URL)) found.push(textUrl(m[0]));
		for (const m of text.matchAll(SCHEME_URL)) found.push({ value: m[0], attr: "text" });
	}
	return found;
}

const WHOLE_VARIABLE = /^\{\{\s*[A-Za-z_][\w.-]{0,63}\s*\}\}$/;
const PLACEHOLDER_HOST = "relative.invalid";

/** `null` when the single value is fine, else the refusal reason. */
function checkOne(found: Found, policy: LinkPolicy, domains: readonly string[], variables: string[]): string | null {
	// Whitespace/control characters inside a scheme are ignored by browsers (`java\tscript:`).
	let value = decodeEntities(found.value).replace(/[\u0000- \u007f-\u009f]+/g, "").replace(/\\/g, "/");
	if (!value || value.startsWith("#")) return null;
	if (value.includes("{{")) {
		if (found.attr === "href" && WHOLE_VARIABLE.test(value)) {
			if (!policy.allowVariableLinks) return `link is a template variable (${value.slice(0, 60)}) and variable links are not allowed`;
			variables.push(value);
			return null;
		}
		const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(value);
		if (!authority) return `template syntax in a link whose host cannot be determined: ${value.slice(0, 80)}`;
		if (authority[1]!.includes("{{")) return `template syntax in link host: ${value.slice(0, 80)}`;
		value = value.replace(/\{\{[^}]*\}\}/g, "x");
	}
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
	if (scheme === "mailto") return null;
	if (scheme && scheme !== "http" && scheme !== "https") return `disallowed link scheme: ${scheme}:`;
	let url: URL;
	try {
		url = new URL(value, `https://${PLACEHOLDER_HOST}/`);
	} catch {
		return `unparseable link: ${value.slice(0, 80)}`;
	}
	// A relative reference has no destination of its own.
	if (url.hostname === PLACEHOLDER_HOST && !scheme && !value.startsWith("//")) return null;
	if (!hostAllowed(url.hostname, domains)) return `link host not allowed: ${url.hostname}`;
	return null;
}

export function checkTemplateLinks(
	content: { bodyHtml?: string | null; bodyText?: string | null },
	policy: LinkPolicy,
): LinkCheck {
	let domains: string[];
	try {
		domains = normalizeLinkDomains(policy.linkDomains);
	} catch {
		return { ok: false, reason: "policy has an invalid link domain" };
	}
	const variableLinks: string[] = [];
	for (const found of extract(content.bodyHtml, content.bodyText)) {
		const reason = checkOne(found, policy, domains, variableLinks);
		if (reason) return { ok: false, reason };
	}
	return { ok: true, variableLinks: [...new Set(variableLinks)] };
}
