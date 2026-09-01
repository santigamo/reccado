import { AlertTriangle, Check, CircleDashed, Minus, X } from "lucide-react";
import type { ReactElement } from "react";
import {
	type ProvisionResult,
	STEP_LABELS,
	type StepOutcome,
	type StepState,
} from "#/components/domains/domains";
import { cn } from "#/lib/cn";

/**
 * Five states, rendered as five distinguishable things.
 *
 * The temptation is to collapse these into pass/fail, and it is exactly the
 * temptation that produced the runbook drift this flow exists to fix: "already"
 * and "done" are both fine but mean different things on a re-run, and "skipped",
 * "blocked" and "failed" need three different responses from the operator —
 * wait for a dependency, grant a permission, or investigate.
 */
const STATE_STYLE: Record<
	StepState,
	{ icon: ReactElement; ring: string; label: string; tone: string }
> = {
	done: {
		icon: <Check className="h-3.5 w-3.5" aria-hidden />,
		ring: "border-[var(--app-accent)] text-[var(--app-accent)]",
		label: "Done",
		tone: "text-[var(--app-text)]",
	},
	already: {
		icon: <Check className="h-3.5 w-3.5" aria-hidden />,
		ring: "border-[var(--app-border-strong)] text-[var(--app-text-soft)]",
		label: "Already set",
		tone: "text-[var(--app-text-soft)]",
	},
	skipped: {
		icon: <Minus className="h-3.5 w-3.5" aria-hidden />,
		ring: "border-[var(--app-border)] text-[var(--app-text-soft)]",
		label: "Skipped",
		tone: "text-[var(--app-text-soft)]",
	},
	blocked: {
		icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden />,
		ring: "border-[var(--app-warning,#b45309)] text-[var(--app-warning,#b45309)]",
		label: "Needs you",
		tone: "text-[var(--app-text)]",
	},
	failed: {
		icon: <X className="h-3.5 w-3.5" aria-hidden />,
		ring: "border-[var(--app-danger)] text-[var(--app-danger)]",
		label: "Failed",
		tone: "text-[var(--app-text)]",
	},
};

function outcomeText(outcome: StepOutcome): string {
	switch (outcome.state) {
		case "already":
		case "done":
			return outcome.detail;
		case "skipped":
			return `Skipped because ${outcome.reason}.`;
		case "blocked":
			return outcome.reason;
		case "failed":
			return outcome.error;
	}
}

export function ProvisionSteps({ result }: { result: ProvisionResult }): ReactElement {
	return (
		<ol className="mt-4 space-y-2">
			{result.steps.map((step) => {
				const style = STATE_STYLE[step.outcome.state];
				const labels = STEP_LABELS[step.name];
				return (
					<li
						key={step.name}
						className="flex gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)] p-3"
					>
						<span
							className={cn(
								"mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border",
								style.ring,
							)}
							aria-hidden
						>
							{style.icon}
						</span>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-baseline justify-between gap-x-3">
								<span className={cn("text-sm font-medium", style.tone)}>{labels.title}</span>
								<span className="text-[12px] text-[var(--app-text-soft)]">{style.label}</span>
							</div>
							<p className="mt-0.5 break-words text-[13px] text-[var(--app-text-soft)]">
								{outcomeText(step.outcome)}
							</p>
							{step.outcome.state === "blocked" && (
								// The remedy is the entire point of distinguishing "blocked" from
								// "failed", so it is never behind a disclosure.
								<p className="mt-1.5 break-words rounded-lg bg-[var(--app-surface-2)] px-2.5 py-2 text-[13px] text-[var(--app-text)]">
									{step.outcome.remedy}
								</p>
							)}
						</div>
					</li>
				);
			})}
		</ol>
	);
}

export function ProvisionPreview(): ReactElement {
	return (
		<ol className="mt-3 space-y-1.5">
			{(Object.keys(STEP_LABELS) as Array<keyof typeof STEP_LABELS>).map((name) => (
				<li key={name} className="flex gap-2.5 text-[13px] text-[var(--app-text-soft)]">
					<CircleDashed className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
					<span>
						<span className="text-[var(--app-text)]">{STEP_LABELS[name].title}</span> —{" "}
						{STEP_LABELS[name].blurb}
					</span>
				</li>
			))}
		</ol>
	);
}
