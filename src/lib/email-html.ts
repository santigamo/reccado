/**
 * The last pass over a stored (sender-controlled) email body before the inbox
 * frames it. The CSP on the response and the iframe sandbox are the primary
 * guards; this pass removes what they do not cover, or do not cover in every
 * browser, so that opening a message with images off makes no request to
 * anyone but this origin:
 *
 *  Always (both modes):
 *   - `<meta http-equiv="refresh">`: navigation is not governed by the CSP, so
 *     a refresh is an open beacon wherever the body is loaded unsandboxed.
 *   - `<meta name="referrer">` and `referrerpolicy` / `ping` attributes: they
 *     would override the no-referrer policy and hand the message URL (mailbox
 *     and message ids) to whatever loads.
 *   - the sender's `<base>` (ours, `target="_blank"`, is added afterwards),
 *     every `<link>` (dns-prefetch, preconnect, prefetch, preload, stylesheet:
 *     DNS prefetch is outside the CSP entirely), and active or embedding
 *     elements: script, noscript, object, embed, applet, iframe, frame,
 *     frameset, portal, fencedframe.
 *  Images off (the default), additionally:
 *   - remote resource attributes (src, srcset, background, poster, lowsrc,
 *     dynsrc, data, and href/xlink:href on anything but a link) move to
 *     `data-blocked-<name>`; `img` sources too, which is how the client knows
 *     to offer "Show images" (it also looks for the marker below);
 *   - CSS: remote `url()` becomes `url(about:invalid)`, `image-set()` and
 *     `@import` are neutralised, in style attributes and `<style>` blocks; CSS
 *     that only reaches a remote URL through escapes is dropped whole.
 *
 * Same-origin (relative) URLs are left alone: they resolve to this origin.
 */

/** Present in a served body when this pass held remote content back. */
export const BLOCKED_REMOTE_MARKER = '<meta name="reccado-remote-blocked" content="1">';

const ALWAYS_REMOVED = [
	"script",
	"noscript",
	"object",
	"embed",
	"applet",
	"iframe",
	"portal",
	"fencedframe",
	"link",
	"base",
];

const RESOURCE_ATTRIBUTES = [
	"src",
	"srcset",
	"background",
	"poster",
	"lowsrc",
	"dynsrc",
	"data",
	"href",
	"xlink:href",
	"imagesrcset",
];

/** A URL that leaves this origin: a scheme other than data:/cid:/about:, or protocol-relative. */
export function isRemoteUrl(value: string): boolean {
	const url = value
		.trim()
		.replace(/^['"]|['"]$/g, "")
		.trim();
	if (url.startsWith("//") || url.startsWith("\\\\")) return true;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
	if (!scheme) return false;
	return !["data", "cid", "about", "mailto", "tel"].includes(scheme);
}

/** srcset: any candidate URL that leaves this origin. */
function srcsetIsRemote(value: string): boolean {
	return value.split(",").some((candidate) => isRemoteUrl(candidate.trim().split(/\s+/)[0] ?? ""));
}

/** CSS with escapes resolved, only to detect what an escape could hide. */
function decodeCssEscapes(css: string): string {
	return css
		.replace(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => {
			const code = Number.parseInt(hex, 16);
			return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
		})
		.replace(/\\(.)/g, "$1");
}

const URL_FUNCTION = /url\(\s*("[^"]*"|'[^']*'|[^)]*?)\s*\)/gi;

function hasRemoteCss(css: string): boolean {
	for (const match of css.matchAll(URL_FUNCTION)) if (isRemoteUrl(match[1] ?? "")) return true;
	return /image-set\s*\(|@import\b/i.test(css);
}

/**
 * Remote fetches taken out of a piece of CSS. `blocked` says whether anything
 * was; `css` is what to serve ("" when only escapes reached a remote URL).
 */
export function neutralizeRemoteCss(css: string): { css: string; blocked: boolean } {
	let blocked = false;
	let out = css.replace(URL_FUNCTION, (whole, target: string) => {
		if (!isRemoteUrl(target)) return whole;
		blocked = true;
		return "url(about:invalid)";
	});
	out = out.replace(/@import\b[^;]*;?/gi, () => {
		blocked = true;
		return "";
	});
	out = out.replace(/((?:-webkit-)?image-set)\s*\(/gi, () => {
		blocked = true;
		return "x-blocked-image-set(";
	});
	if (hasRemoteCss(decodeCssEscapes(out)) && !hasRemoteCss(out)) {
		// Only an escape sequence got there: no legitimate mail does that.
		return { css: "", blocked: true };
	}
	return { css: out, blocked };
}

/**
 * Prepare a stored body for the inbox frame. `cidMap` resolves inline images
 * (cid:) to this message's own attachments; `remoteImages` is the reader's
 * "Show images".
 */
export async function prepareEmailHtml(
	html: string,
	cidMap: Map<string, string>,
	remoteImages: boolean,
): Promise<string> {
	let blocked = false;
	let rewriter = new HTMLRewriter()
		.on(ALWAYS_REMOVED.join(", "), {
			element(el) {
				el.remove();
			},
		})
		// Tags only: the parser does not know <frame> is void, and removing it
		// with its "content" would take the rest of the body along.
		.on("frame, frameset", {
			element(el) {
				el.removeAndKeepContent();
			},
		})
		.on("meta", {
			element(el) {
				const equiv = (el.getAttribute("http-equiv") ?? "").trim().toLowerCase();
				const name = (el.getAttribute("name") ?? "").trim().toLowerCase();
				if (equiv === "refresh" || name === "referrer") el.remove();
			},
		})
		.on("a[href], area[href]", {
			element(el) {
				el.setAttribute("target", "_blank");
				el.setAttribute("rel", "noopener noreferrer");
			},
		})
		.on("img[src]", {
			element(el) {
				const src = el.getAttribute("src") ?? "";
				const match = /^cid:(.+)$/i.exec(src.trim());
				if (!match) return;
				let cid = match[1]!;
				try {
					cid = decodeURIComponent(cid);
				} catch {
					// Not percent-encoded after all: use it as written.
				}
				const target = cidMap.get(cid.replace(/^<|>$/g, "").trim().toLowerCase());
				if (target) el.setAttribute("src", target);
				else el.removeAttribute("src");
			},
		})
		.on("*", {
			element(el) {
				el.removeAttribute("referrerpolicy");
				el.removeAttribute("ping");
				if (remoteImages) return;
				const isLink = el.tagName === "a" || el.tagName === "area";
				for (const name of RESOURCE_ATTRIBUTES) {
					if (isLink && name === "href") continue;
					const value = el.getAttribute(name);
					if (value === null) continue;
					const remote = name.endsWith("srcset") ? srcsetIsRemote(value) : isRemoteUrl(value);
					if (!remote) continue;
					el.setAttribute(`data-blocked-${name.replace(":", "-")}`, value);
					el.removeAttribute(name);
					blocked = true;
				}
				const style = el.getAttribute("style");
				if (style) {
					const clean = neutralizeRemoteCss(style);
					if (clean.blocked) {
						blocked = true;
						if (clean.css) el.setAttribute("style", clean.css);
						else el.removeAttribute("style");
					}
				}
			},
		});
	if (!remoteImages) {
		let buffer = "";
		rewriter = rewriter.on("style", {
			text(chunk) {
				buffer += chunk.text;
				if (!chunk.lastInTextNode) {
					chunk.remove();
					return;
				}
				const clean = neutralizeRemoteCss(buffer);
				buffer = "";
				if (clean.blocked) blocked = true;
				// Raw text: the CSS came out of this very element and gains no "</".
				chunk.replace(clean.css, { html: true });
			},
		});
	}
	const out = await rewriter.transform(new Response(html)).text();
	return blocked ? injectIntoHead(out, BLOCKED_REMOTE_MARKER) : out;
}

/** Insert markup at the start of <head> (or create one). */
export function injectIntoHead(html: string, markup: string): string {
	// Not <header>: the tag name ends at whitespace or ">".
	if (/<head(\s[^>]*)?>/i.test(html)) return html.replace(/(<head(\s[^>]*)?>)/i, `$1${markup}`);
	if (/<html(\s[^>]*)?>/i.test(html))
		return html.replace(/(<html(\s[^>]*)?>)/i, `$1<head>${markup}</head>`);
	return `${markup}${html}`;
}
