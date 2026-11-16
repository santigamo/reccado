/**
 * The Reccado mark: two stacked envelopes in the Cloudflare amber→orange→ember
 * family (docs/BRAND.md). This is the flat form, legible from 16px, used in
 * the app header, the standalone pages and the favicon. Kept as plain strings
 * so the favicon (a data: URL) and the React component draw the same shapes.
 */
export const RECCADO_MARK_VIEWBOX = "0 0 32 32";

/** Inner SVG markup of the mark. `id` keeps gradient ids unique per instance. */
export function reccadoMarkInner(id = "rm"): string {
	return (
		`<defs><linearGradient id="${id}" x1="4" y1="11" x2="25" y2="28" gradientUnits="userSpaceOnUse">` +
		`<stop offset="0" stop-color="#FBAD41"/><stop offset="0.55" stop-color="#F38020"/><stop offset="1" stop-color="#E2400F"/>` +
		`</linearGradient></defs>` +
		`<rect x="8.5" y="4.5" width="20" height="14.5" rx="3.2" fill="#FBAD41" opacity="0.5"/>` +
		`<rect x="3.5" y="11" width="22" height="16.5" rx="3.6" fill="url(#${id})"/>` +
		`<path d="M6.2 14.4l8.3 6.1 8.3-6.1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`
	);
}

/** Standalone SVG document of the mark, optionally on the dark favicon tile. */
export function reccadoMarkSvg(opts: { tile?: boolean; extra?: string } = {}): string {
	const tile = opts.tile ? `<rect width="32" height="32" rx="7.5" fill="#161310"/>` : "";
	const mark = opts.tile
		? `<g transform="translate(3.6 3.4) scale(0.775)">${reccadoMarkInner()}</g>`
		: reccadoMarkInner();
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${RECCADO_MARK_VIEWBOX}"><title>Reccado</title>${tile}${mark}${opts.extra ?? ""}</svg>`;
}
