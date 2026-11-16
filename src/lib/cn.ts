import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge only knows Tailwind's default theme. Teach it the custom
 * tokens from styles.css so `text-body` is merged as a font size (not a colour
 * that would knock out `text-white`), `rounded-card` as a radius, and so on.
 */
const twMerge = extendTailwindMerge({
	extend: {
		theme: {
			text: ["meta", "label", "body", "sender", "title"],
			radius: ["control", "card", "panel", "shell", "pill"],
			shadow: ["card", "primary", "dialog", "popover", "sticky"],
			font: ["brand"],
		},
	},
});

/**
 * Merge conditional class names, with later Tailwind utilities winning over
 * earlier conflicting ones (e.g. `cn("px-2", condition && "px-4")`).
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
