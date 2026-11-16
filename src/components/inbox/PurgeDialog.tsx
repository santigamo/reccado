/**
 * The confirmation in front of the one action that cannot be undone: "Delete
 * forever" on conversations in the Trash, and "Empty trash". It says how many
 * and where, and that there is no way back; the destructive button is the
 * danger variant and is not the one focused first (Cancel is). While the
 * deletion runs the dialog stays put, cannot be dismissed, and shows progress
 * for a large Trash ("Deleted 250 of 1,234 messages…").
 */
import { useState } from "react";
import { Button } from "#/components/ui/Button";
import { Dialog } from "#/components/ui/Dialog";
import { formatCount } from "#/lib/use-unified-mail";

export type PurgeProgress = (deleted: number, total: number) => void;

export function PurgeDialog({
	title,
	description,
	confirmLabel,
	busyLabel,
	onClose,
	run,
}: {
	title: string;
	description: string;
	confirmLabel: string;
	/** "Deleting…", "Emptying trash…". */
	busyLabel: string;
	onClose: () => void;
	/** Does the deletion; resolves when it is over (success or reported failure). */
	run: (onProgress: PurgeProgress) => Promise<void>;
}) {
	const [busy, setBusy] = useState(false);
	const [progress, setProgress] = useState<{ deleted: number; total: number } | null>(null);

	async function confirm() {
		setBusy(true);
		try {
			await run((deleted, total) => setProgress({ deleted, total }));
		} finally {
			setBusy(false);
			onClose();
		}
	}

	const status =
		busy && progress && progress.total > 0
			? `Deleted ${formatCount(Math.min(progress.deleted, progress.total))} of ${formatCount(progress.total)} ${progress.total === 1 ? "message" : "messages"}…`
			: busy
				? busyLabel
				: null;

	return (
		<Dialog
			size="sm"
			title={title}
			description={description}
			onClose={busy ? () => {} : onClose}
			dismissible={!busy}
			bodyClassName="hidden"
			footer={
				<>
					<p aria-live="polite" className="m-0 min-w-0 flex-1 text-label text-text-muted">
						{status}
					</p>
					<Button data-autofocus variant="ghost" onClick={onClose} disabled={busy}>
						Cancel
					</Button>
					<Button variant="danger" onClick={() => void confirm()} disabled={busy}>
						{busy ? busyLabel : confirmLabel}
					</Button>
				</>
			}
		/>
	);
}
