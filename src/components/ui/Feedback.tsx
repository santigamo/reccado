import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "#/lib/cn";

export function Spinner({ className }: { className?: string }) {
	return <Loader2 className={cn("h-5 w-5 animate-spin text-[var(--app-text-faint)]", className)} />;
}

export function CenteredSpinner({ label }: { label?: string }) {
	return (
		<div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 text-[var(--app-text-faint)]">
			<Spinner />
			{label ? <p className="text-sm">{label}</p> : null}
		</div>
	);
}

export function EmptyState({
	icon,
	title,
	hint,
}: {
	icon?: ReactNode;
	title: string;
	hint?: string;
}) {
	return (
		<div className="flex h-full min-h-60 flex-col items-center justify-center gap-3 px-6 text-center">
			{icon ? <div className="text-[var(--app-text-faint)]">{icon}</div> : null}
			<p className="text-[15px] font-medium text-[var(--app-text-soft)]">{title}</p>
			{hint ? <p className="max-w-sm text-sm text-[var(--app-text-faint)]">{hint}</p> : null}
		</div>
	);
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
	return (
		<div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 text-center">
			<p className="text-sm text-[var(--app-danger)]">{message}</p>
			{onRetry ? (
				<button
					type="button"
					onClick={onRetry}
					className="text-sm font-medium text-[var(--app-accent)] hover:underline"
				>
					Try again
				</button>
			) : null}
		</div>
	);
}
