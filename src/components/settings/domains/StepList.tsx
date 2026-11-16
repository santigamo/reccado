import { Check, X } from "lucide-react";
import type { ReactElement } from "react";
import {
	type ProvisionResult,
	type ProvisionStep,
	type StepOutcome,
	type StepState,
	stepTitle,
} from "#/components/domains/domains";
import { cn } from "#/lib/cn";

/**
 * Five states, rendered as five distinguishable things (Paper "Add domain — 2").
 *
 * "already" and "done" are both fine but mean different things on a re-run;
 * "skipped", "blocked" and "failed" need three different responses from the
 * operator — wait for a dependency, grant a permission, or investigate. The
 * remedy of a blocked step is never behind a disclosure.
 */
const STATE_LABEL: Record<StepState, { label: string; className: string }> = {
	done: { label: "Done", className: "text-success" },
	already: { label: "Already set", className: "text-text-muted" },
	skipped: { label: "Skipped", className: "text-text-muted" },
	blocked: { label: "Needs you", className: "font-semibold text-brand" },
	failed: { label: "Failed", className: "font-semibold text-danger" },
};

function StepIcon({ state }: { state: StepState }) {
	switch (state) {
		case "done":
			return (
				<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-white [&_svg]:size-3">
					<Check strokeWidth={3.5} aria-hidden />
				</span>
			);
		case "already":
			return (
				<span className="flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-[#AEB5BF] text-icon [&_svg]:size-[11px]">
					<Check strokeWidth={3.5} aria-hidden />
				</span>
			);
		case "skipped":
			return (
				<span className="flex size-5 shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-[#AEB5BF]">
					<span className="h-0.5 w-2 rounded-[1px] bg-[#8A919C]" />
				</span>
			);
		case "blocked":
			return (
				<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand text-label font-bold text-panel">
					!
				</span>
			);
		case "failed":
			return (
				<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-danger text-white [&_svg]:size-2.5">
					<X strokeWidth={4} aria-hidden />
				</span>
			);
	}
}

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

function StepRow({
	step,
	result,
	mailbox,
	last,
}: {
	step: ProvisionStep;
	result: ProvisionResult;
	mailbox?: string;
	last: boolean;
}) {
	const state = step.outcome.state;
	const label = STATE_LABEL[state];
	return (
		<li className={cn("flex items-start gap-3 py-3", !last && "border-b border-border-card")}>
			<StepIcon state={state} />
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<div className="flex items-start gap-3">
					<div className="flex min-w-0 flex-1 flex-col gap-px">
						<span
							className={cn(
								"text-body font-medium",
								state === "skipped" ? "text-text-secondary" : "text-ink",
							)}
						>
							{stepTitle(step.name, { sendingDomain: result.sendingDomain, mailbox })}
						</span>
						{state !== "blocked" ? (
							<span
								className={cn(
									"break-words text-label",
									state === "failed" ? "text-danger" : "text-text-muted",
								)}
							>
								{outcomeText(step.outcome)}
							</span>
						) : null}
					</div>
					<span className={cn("w-24 shrink-0 text-right text-label leading-5", label.className)}>
						{label.label}
					</span>
				</div>
				{step.outcome.state === "blocked" ? (
					<div className="flex flex-col gap-1 rounded-[10px] border border-brand/14 bg-brand/6 px-3 py-2.5 text-label leading-[19px] text-text">
						<span className="text-text-muted">{step.outcome.reason}</span>
						<span>{step.outcome.remedy}</span>
					</div>
				) : null}
			</div>
		</li>
	);
}

export function StepList({
	result,
	mailbox,
}: {
	result: ProvisionResult;
	mailbox?: string;
}): ReactElement {
	return (
		<ol className="m-0 flex list-none flex-col p-0">
			{result.steps.map((step, i) => (
				<StepRow
					key={step.name}
					step={step}
					result={result}
					mailbox={mailbox}
					last={i === result.steps.length - 1}
				/>
			))}
		</ol>
	);
}

/** "4 of 6 in place · 1 needs you · 1 failed" */
export function summarizeSteps(result: ProvisionResult): string {
	const count = (states: StepState[]) =>
		result.steps.filter((s) => states.includes(s.outcome.state)).length;
	const inPlace = count(["done", "already"]);
	const parts = [`${inPlace} of ${result.steps.length} in place`];
	const blocked = count(["blocked"]);
	const failed = count(["failed"]);
	const skipped = count(["skipped"]);
	if (blocked) parts.push(`${blocked} need${blocked === 1 ? "s" : ""} you`);
	if (failed) parts.push(`${failed} failed`);
	if (skipped) parts.push(`${skipped} skipped`);
	return parts.join(" · ");
}
