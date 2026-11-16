import { ChevronDown } from "lucide-react";
import {
	forwardRef,
	type InputHTMLAttributes,
	type ReactNode,
	type SelectHTMLAttributes,
	useId,
} from "react";
import { cn } from "#/lib/cn";

/**
 * Shared look for text controls (Paper "Add mailbox" address field): 44px,
 * 10px radius, border, navy border + 3px navy-12% ring on focus.
 */
export function controlClassName(className?: string, invalid?: boolean): string {
	return cn(
		"w-full min-w-0 rounded-[10px] border bg-panel px-3.5 text-[15px] text-ink outline-none transition placeholder:text-text-faint",
		"focus:border-brand focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-brand)_12%,transparent)]",
		"disabled:cursor-not-allowed disabled:bg-content disabled:text-text-muted",
		invalid
			? "border-danger focus:border-danger focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-danger)_14%,transparent)]"
			: "border-border",
		className,
	);
}

type FieldChrome = {
	label?: ReactNode;
	hint?: ReactNode;
	error?: ReactNode;
	/** Wrapper class (the label/hint column). */
	containerClassName?: string;
};

function FieldFrame({
	id,
	label,
	hint,
	error,
	containerClassName,
	children,
}: FieldChrome & { id: string; children: ReactNode }) {
	return (
		<div className={cn("flex flex-col gap-2", containerClassName)}>
			{label ? (
				<label htmlFor={id} className="text-label leading-4 font-medium text-text">
					{label}
				</label>
			) : null}
			{children}
			{error ? (
				<p id={`${id}-error`} className="m-0 text-label leading-4 text-danger">
					{error}
				</p>
			) : hint ? (
				<p id={`${id}-hint`} className="m-0 text-label leading-4 text-text-muted">
					{hint}
				</p>
			) : null}
		</div>
	);
}

function describedBy(id: string, hint: unknown, error: unknown): string | undefined {
	if (error) return `${id}-error`;
	if (hint) return `${id}-hint`;
	return undefined;
}

export const TextField = forwardRef<
	HTMLInputElement,
	InputHTMLAttributes<HTMLInputElement> & FieldChrome
>(function TextField({ label, hint, error, containerClassName, className, id, ...props }, ref) {
	const autoId = useId();
	const inputId = id ?? autoId;
	return (
		<FieldFrame
			id={inputId}
			label={label}
			hint={hint}
			error={error}
			containerClassName={containerClassName}
		>
			<input
				ref={ref}
				id={inputId}
				aria-invalid={error ? true : undefined}
				aria-describedby={describedBy(inputId, hint, error)}
				className={controlClassName(cn("h-11", className), Boolean(error))}
				{...props}
			/>
		</FieldFrame>
	);
});

/** Native <select> styled like the text controls (pass <option> children). */
export const Select = forwardRef<
	HTMLSelectElement,
	SelectHTMLAttributes<HTMLSelectElement> & FieldChrome
>(function Select(
	{ label, hint, error, containerClassName, className, id, children, ...props },
	ref,
) {
	const autoId = useId();
	const inputId = id ?? autoId;
	return (
		<FieldFrame
			id={inputId}
			label={label}
			hint={hint}
			error={error}
			containerClassName={containerClassName}
		>
			<div className="relative">
				<select
					ref={ref}
					id={inputId}
					aria-invalid={error ? true : undefined}
					aria-describedby={describedBy(inputId, hint, error)}
					className={controlClassName(cn("h-11 appearance-none pr-9", className), Boolean(error))}
					{...props}
				>
					{children}
				</select>
				<ChevronDown
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-icon"
				/>
			</div>
		</FieldFrame>
	);
});
