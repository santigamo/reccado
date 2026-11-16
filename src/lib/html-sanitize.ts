/**
 * Server-side sanitiser for HTML the owner sends (web compose drafts). Streams
 * the markup through the Workers HTMLRewriter against the allowlist in
 * rich-text.ts: unknown tags are unwrapped, dangerous ones are dropped with
 * their content, every attribute outside the per-tag allowlist goes (event
 * handlers, class, id, src…), `style` keeps only inert properties, links keep
 * http(s)/mailto targets only, and comments are removed.
 *
 * Runs before a draft is stored, so what the approval page shows, what the
 * payload hash covers, what goes on the wire and what the sent copy renders are
 * all the same, already-clean markup.
 */
import {
	ALLOWED_TAGS,
	allowedAttribute,
	DROP_WITH_CONTENT,
	safeHref,
	sanitizeStyle,
} from "./rich-text";

export async function sanitizeOwnerHtml(html: string): Promise<string> {
	const rewriter = new HTMLRewriter()
		.on("*", {
			element(el) {
				const tag = el.tagName.toLowerCase();
				if (DROP_WITH_CONTENT.has(tag)) {
					el.remove();
					return;
				}
				if (!ALLOWED_TAGS.has(tag)) {
					el.removeAndKeepContent();
					return;
				}
				// The DOM lib's Element type shadows HTMLRewriter's here; attributes are [name, value] pairs.
				const attributes = [...(el.attributes as unknown as Iterable<[string, string]>)].map(
					([name, value]) => [name.toLowerCase(), value] as const,
				);
				for (const [name, value] of attributes) {
					if (!name) continue;
					if (!allowedAttribute(tag, name)) {
						el.removeAttribute(name);
						continue;
					}
					if (name === "style") {
						const clean = sanitizeStyle(value);
						if (clean) el.setAttribute("style", clean);
						else el.removeAttribute("style");
					} else if (name === "href") {
						const href = safeHref(value);
						if (href) el.setAttribute("href", href);
						else el.removeAttribute("href");
					} else if (name === "start" && !/^\d{1,6}$/.test(value ?? "")) {
						el.removeAttribute("start");
					}
				}
				if (tag === "a" && el.getAttribute("href")) {
					el.setAttribute("target", "_blank");
					el.setAttribute("rel", "noopener noreferrer");
				}
			},
		})
		.onDocument({
			comments(comment) {
				comment.remove();
			},
			doctype() {
				// A fragment has no business declaring one; HTMLRewriter cannot remove it,
				// and a stray doctype is inert, so it is left as is.
			},
		});
	const out = await rewriter.transform(new Response(html)).text();
	return out.trim();
}
