import { useId } from "react";
import { RECCADO_MARK_VIEWBOX, reccadoMarkInner } from "#/lib/reccado-mark";

/** The Reccado logomark (stacked envelopes). Decorative unless `title` is given. */
export function ReccadoMark({
	size = 28,
	className,
	title,
}: {
	size?: number;
	className?: string;
	title?: string;
}) {
	const id = `rm${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
	return (
		<svg
			width={size}
			height={size}
			viewBox={RECCADO_MARK_VIEWBOX}
			className={className}
			role={title ? "img" : undefined}
			aria-label={title}
			aria-hidden={title ? undefined : true}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: static brand markup built from constants, no user input
			dangerouslySetInnerHTML={{ __html: reccadoMarkInner(id) }}
		/>
	);
}
