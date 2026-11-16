import type { ReactElement } from "react";

/**
 * Small inline icons for the standalone pages (login, consent, approve), drawn
 * from the Paper file so they match it stroke for stroke. Decorative: every one
 * is aria-hidden and sits next to text that carries the meaning.
 */

type IconProps = { size?: number; className?: string; color?: string };

function Svg({
	size = 15,
	className,
	children,
}: {
	size?: number;
	className?: string;
	children: React.ReactNode;
}): ReactElement {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
			className={`inline-block shrink-0 ${className ?? ""}`}
		>
			{children}
		</svg>
	);
}

export function LogoGlyph({ size = 16 }: { size?: number }): ReactElement {
	return (
		<Svg size={size}>
			<path
				d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3L5.3 18.7"
				fill="none"
				stroke="#FFFFFF"
				strokeWidth="2.4"
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function LockIcon({
	size = 15,
	className,
	color = "var(--color-text-secondary)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<rect
				x="5"
				y="10.5"
				width="14"
				height="10"
				rx="2.5"
				fill="none"
				stroke={color}
				strokeWidth="1.8"
			/>
			<path
				d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"
				fill="none"
				stroke={color}
				strokeWidth="1.8"
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function ChevronDownIcon({ size = 14, className }: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<path
				d="M6 9l6 6 6-6"
				fill="none"
				stroke="var(--color-icon)"
				strokeWidth="2.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</Svg>
	);
}

export function AlertCircleIcon({
	size = 14,
	className,
	color = "var(--color-danger)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="2" />
			<path
				d="M12 7.5v5.5M12 16.5v.2"
				fill="none"
				stroke={color}
				strokeWidth="2.2"
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function WarningIcon({
	size = 15,
	className,
	color = "var(--color-approval)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<path
				d="M12 3.5L2.8 19.5h18.4z"
				fill="none"
				stroke={color}
				strokeWidth="2"
				strokeLinejoin="round"
			/>
			<path
				d="M12 10v4.5M12 17v.2"
				fill="none"
				stroke={color}
				strokeWidth="2.2"
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function ClockIcon({
	size = 15,
	className,
	color = "var(--color-approval)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="2" />
			<path
				d="M12 7v5.5l3.5 2"
				fill="none"
				stroke={color}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</Svg>
	);
}

export function CheckIcon({
	size = 14,
	className,
	color = "var(--color-success)",
	strokeWidth = 2.6,
}: IconProps & { strokeWidth?: number }): ReactElement {
	return (
		<Svg size={size} className={className}>
			<path
				d="M5 12.5l4.5 4.5L19 7.5"
				fill="none"
				stroke={color}
				strokeWidth={strokeWidth}
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</Svg>
	);
}

export function CheckCircleIcon({
	size = 15,
	className,
	color = "var(--color-success)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<circle cx="12" cy="12" r="10" fill={color} />
			<path
				d="M7.5 12.3l3 3 6-6.3"
				fill="none"
				stroke="#FFFFFF"
				strokeWidth="2.2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</Svg>
	);
}

export function XCircleIcon({
	size = 15,
	className,
	color = "var(--color-text-muted)",
	filled = false,
}: IconProps & { filled?: boolean }): ReactElement {
	return (
		<Svg size={size} className={className}>
			{filled ? (
				<circle cx="12" cy="12" r="10" fill={color} />
			) : (
				<circle cx="12" cy="12" r="9" fill="none" stroke={color} strokeWidth="2" />
			)}
			<path
				d="M9 9l6 6M15 9l-6 6"
				fill="none"
				stroke={filled ? "#FFFFFF" : color}
				strokeWidth={filled ? 2.2 : 2}
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function ProgressArcIcon({
	size = 15,
	className,
	color = "var(--color-brand)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<path
				d="M12 3a9 9 0 1 0 9 9"
				fill="none"
				stroke={color}
				strokeWidth="2.2"
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function CopyIcon({
	size = 15,
	className,
	color = "var(--color-text)",
}: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<rect
				x="9"
				y="9"
				width="11"
				height="11"
				rx="2.5"
				fill="none"
				stroke={color}
				strokeWidth="2"
			/>
			<path
				d="M5 15V6.5A1.5 1.5 0 0 1 6.5 5H15"
				fill="none"
				stroke={color}
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</Svg>
	);
}

export function VerifiedIcon({ size = 15, className }: IconProps): ReactElement {
	return (
		<Svg size={size} className={className}>
			<path
				d="M12 2l2.4 1.8 3-.2 1 2.8 2.5 1.7-.8 2.9.8 2.9-2.5 1.7-1 2.8-3-.2L12 22l-2.4-1.8-3 .2-1-2.8-2.5-1.7.8-2.9-.8-2.9 2.5-1.7 1-2.8 3 .2z"
				fill="var(--color-verified)"
			/>
			<path
				d="M8.3 12.2l2.5 2.5 4.9-5"
				fill="none"
				stroke="#FFFFFF"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</Svg>
	);
}
