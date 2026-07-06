import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class names, with later Tailwind utilities winning over
 * earlier conflicting ones (e.g. `cn("px-2", condition && "px-4")`).
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
