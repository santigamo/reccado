import { cn } from "#/lib/cn";
import { avatarHue, initials } from "#/lib/mail";

export type AvatarSize = "sm" | "md" | "lg";

const SIZES: Record<AvatarSize, string> = {
	sm: "h-7 w-7 text-[11px]",
	md: "h-8 w-8 text-meta",
	lg: "h-10 w-10 text-label",
};

/**
 * Round initials avatar.
 * - `tone="sender"` (default): soft pastel derived from the address, so a
 *   sender always gets the same colour (deterministic, SSR-safe).
 * - `tone="neutral"`: the grey owner chip in the app header.
 * `label` overrides the initials (e.g. "SA" for the signed-in owner).
 * `name` is the sender's stored display name: initials prefer it, the colour
 * stays keyed on the address.
 */
export function Avatar({
	from,
	name,
	label,
	size = "md",
	tone = "sender",
	className,
}: {
	from: string | null | undefined;
	name?: string | null;
	label?: string;
	size?: AvatarSize;
	tone?: "sender" | "neutral";
	className?: string;
}) {
	const hue = avatarHue(from);
	const style =
		tone === "neutral"
			? { backgroundColor: "#E4E4E4", color: "#3A3A3A" }
			: { backgroundColor: `hsl(${hue} 62% 90%)`, color: `hsl(${hue} 48% 28%)` };
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold",
				SIZES[size],
				className,
			)}
			style={style}
		>
			{label ?? initials(from, name)}
		</span>
	);
}
