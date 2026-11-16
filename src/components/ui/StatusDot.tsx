import { cn } from "#/lib/cn";

export type StatusTone = "success" | "agent" | "approval" | "danger" | "brand" | "muted";

const TONE_COLOR: Record<StatusTone, string> = {
	success: "var(--color-success)",
	agent: "var(--color-agent-on)",
	approval: "var(--color-approval)",
	danger: "var(--color-danger)",
	brand: "var(--color-brand)",
	muted: "var(--color-disabled)",
};

/**
 * The small round dot used everywhere in the design: mailbox colour, agent
 * status, "awaiting approval". Pass either a semantic `tone` or any CSS
 * `color` (e.g. a mailbox colour's `css`). Decorative: hidden from AT, so say
 * the status in text next to it.
 */
export function StatusDot({
	tone,
	color,
	size = 7,
	className,
}: {
	tone?: StatusTone;
	color?: string;
	size?: 6 | 7 | 8 | 12;
	className?: string;
}) {
	return (
		<span
			aria-hidden="true"
			className={cn("inline-block shrink-0 rounded-full", className)}
			style={{
				width: size,
				height: size,
				backgroundColor: color ?? TONE_COLOR[tone ?? "muted"],
			}}
		/>
	);
}
