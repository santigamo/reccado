// Raster formats only: SVG can carry script, so it always downloads.
const PREVIEWABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isPreviewableImage(contentType: string | null | undefined): boolean {
	const type = contentType?.split(";")[0]?.trim().toLowerCase();
	return type ? PREVIEWABLE_IMAGE_TYPES.has(type) : false;
}
