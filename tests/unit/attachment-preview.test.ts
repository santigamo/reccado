import { describe, expect, it } from "vitest";
import { isPreviewableImage } from "#/lib/attachment-preview";

describe("isPreviewableImage", () => {
	it("accepts raster images, ignoring case and parameters", () => {
		expect(isPreviewableImage("image/png")).toBe(true);
		expect(isPreviewableImage("IMAGE/JPEG; name=photo.jpg")).toBe(true);
	});

	it("rejects SVG, non-images and missing types", () => {
		expect(isPreviewableImage("image/svg+xml")).toBe(false);
		expect(isPreviewableImage("text/html")).toBe(false);
		expect(isPreviewableImage(null)).toBe(false);
	});
});
