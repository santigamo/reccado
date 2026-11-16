import { useCallback, useEffect, useMemo, useState } from "react";
import type { Mailbox } from "#/lib/mail";
import { sortMailboxesForColor } from "#/lib/mailbox-color";
import { useAsyncResource, useMailboxes } from "#/lib/use-mail";
import { domainOf } from "./SettingsParts";

/**
 * Mailboxes in the same stable order the colour assignment uses, one loader
 * run per mailbox (`per`, for the rail counts and the detail), and the
 * selected mailbox: `?mailbox=` when given, else the first mailbox whose data
 * loads. A mailbox that fails stays in the rail with its error; it is only
 * the default when every mailbox fails.
 */
export function useSelectedMailbox<T>(
	requested: string | undefined,
	loader: (mailboxId: string) => Promise<T>,
) {
	const resource = useMailboxes();
	const ordered = useMemo(() => sortMailboxesForColor(resource.data), [resource.data]);
	const per = usePerMailbox(ordered, loader);
	const selected = requested
		? ordered.find((m) => m.mailbox_id === requested)
		: pickDefault(ordered, per.get);
	return {
		...resource,
		ordered,
		per,
		selected: selected ?? null,
		unknownRequested: Boolean(requested && !selected && !resource.loading),
	};
}

/**
 * First mailbox that loaded; while earlier ones are still loading, the first
 * one not known to have failed (so the choice settles without jumping past a
 * mailbox that is about to load); the first mailbox when all of them failed.
 */
export function pickDefault<T>(
	ordered: readonly Mailbox[],
	stateOf: (mailboxId: string) => PerMailboxState<T>,
): Mailbox | undefined {
	return (
		ordered.find((m) => !stateOf(m.mailbox_id).error && stateOf(m.mailbox_id).data !== null) ??
		ordered.find((m) => !stateOf(m.mailbox_id).error) ??
		ordered[0]
	);
}

export type PerMailboxState<T> = {
	data: T | null;
	error: unknown;
	loading: boolean;
};

/**
 * One loader run for every mailbox, in parallel, so the rail can show counts
 * ("3 keys · 1 live") and the detail reads from the same cache. `refresh(id)`
 * reloads one mailbox after a mutation.
 */
export function usePerMailbox<T>(
	mailboxes: readonly Mailbox[],
	loader: (mailboxId: string) => Promise<T>,
) {
	const [state, setState] = useState<Record<string, PerMailboxState<T>>>({});
	const ids = mailboxes.map((m) => m.mailbox_id).join(",");

	const load = useCallback(
		(mailboxId: string) => {
			setState((prev) => ({
				...prev,
				[mailboxId]: { data: prev[mailboxId]?.data ?? null, error: null, loading: true },
			}));
			loader(mailboxId)
				.then((data) => {
					setState((prev) => ({ ...prev, [mailboxId]: { data, error: null, loading: false } }));
				})
				.catch((error: unknown) => {
					setState((prev) => ({
						...prev,
						[mailboxId]: { data: prev[mailboxId]?.data ?? null, error, loading: false },
					}));
				});
		},
		[loader],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `ids` is the stable identity of the mailbox list; `load` is stable per loader.
	useEffect(() => {
		for (const id of ids.split(",").filter(Boolean)) load(id);
	}, [ids]);

	const get = useCallback(
		(mailboxId: string): PerMailboxState<T> =>
			state[mailboxId] ?? { data: null, error: null, loading: true },
		[state],
	);
	return { get, refresh: load };
}

type HealthFeedback = {
	mode?: "no_sends" | "observing" | "live" | "dark";
	reason?: string | null;
	darkDomains?: string[];
};

export type DeliveryFeedbackView = {
	tone: "success" | "danger" | "muted" | "approval";
	label: string;
	detail: string | null;
};

/**
 * Delivery-feedback liveness as /api/health publishes it (src/lib/feedback-liveness.ts).
 * The health summary names dark domains but carries no per-domain timestamps,
 * so this says only what it can prove.
 */
export function useDeliveryFeedback(): (
	address: string | undefined,
) => DeliveryFeedbackView | null {
	const { data } = useAsyncResource<HealthFeedback | null>(
		async () => {
			const res = await fetch("/api/health");
			const body = (await res.json().catch(() => null)) as {
				dependencies?: { sendingFeedback?: HealthFeedback | null };
			} | null;
			return body?.dependencies?.sendingFeedback ?? null;
		},
		null,
		[],
	);
	return useCallback(
		(address: string | undefined) => {
			if (!data || !address) return null;
			const domain = domainOf(address);
			if (data.darkDomains?.includes(domain)) {
				return {
					tone: "danger",
					label: "Not answering",
					detail: "No delivery events arrive for this domain. Run pnpm doctor --cloud.",
				};
			}
			switch (data.mode) {
				case "no_sends":
					return { tone: "muted", label: "No sends yet", detail: null };
				case "observing":
					return { tone: "approval", label: "Waiting for events", detail: null };
				case "live":
					return { tone: "success", label: "Live", detail: null };
				case "dark":
					// Another domain is dark; this one is not on the list.
					return { tone: "success", label: "Not reported dark", detail: null };
				default:
					return null;
			}
		},
		[data],
	);
}
