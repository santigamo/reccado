import { cn } from "#/lib/cn";
import { avatarHue, initials } from "#/lib/mail";

/**
 * Gmail-style round sender avatar: initials on a per-sender deterministic hue.
 */
export function Avatar({
	from,
	size = "md",
	className,
}: {
	from: string | null | undefined;
	size?: "sm" | "md" | "lg";
	className?: string;
}) {
	const hue = avatarHue(from);
	const dim =
		size === "sm" ? "h-7 w-7 text-xs" : size === "lg" ? "h-10 w-10 text-base" : "h-9 w-9 text-sm";
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-full font-medium text-white",
				dim,
				className,
			)}
			style={{ backgroundColor: `hsl(${hue} 52% 45%)` }}
		>
			{initials(from)}
		</span>
	);
}
