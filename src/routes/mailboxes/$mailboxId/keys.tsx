import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiKeyCard } from "#/components/keys/ApiKeyCard";
import {
	type ApiKeyError,
	asApiKeyError,
	describeApiKeyError,
	displayStatus,
	fetchApiKeys,
	type MintedApiKey,
	revokeApiKey,
	rotateApiKey,
	updateApiKeySenderName,
	type TransactionalApiKey,
} from "#/components/keys/api-keys";
import { CreateApiKeyForm } from "#/components/keys/CreateApiKeyForm";
import { OneTimeSecret } from "#/components/keys/OneTimeSecret";
import { Button } from "#/components/ui/Button";
import { CenteredSpinner, EmptyState, ErrorState } from "#/components/ui/Feedback";
import { IconButton } from "#/components/ui/IconButton";
import { useMailboxes } from "#/lib/use-mail";

export const Route = createFileRoute("/mailboxes/$mailboxId/keys")({
	component: ApiKeysPage,
});

/**
 * Client-side resource for the key list. Deliberately local to this route
 * (rather than in `#/lib/use-mail`) because it must not participate in the mail
 * sync token — a new inbound email should not re-fetch credentials.
 */
function useApiKeys(mailboxId: string) {
	const [data, setData] = useState<TransactionalApiKey[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<ApiKeyError | null>(null);
	const [nonce, setNonce] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `nonce` is a deliberate re-run trigger — bumping it is what `refetch()` does.
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		fetchApiKeys(mailboxId)
			.then((keys) => {
				if (alive) setData(keys);
			})
			.catch((caught: unknown) => {
				if (alive) setError(asApiKeyError(caught));
			})
			.finally(() => {
				if (alive) setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [mailboxId, nonce]);

	const refetch = useCallback(() => setNonce((n) => n + 1), []);
	return { data, loading, error, refetch };
}

/**
 * Transactional API key management, the admin counterpart to the transactional
 * send API (docs/plans/transactional-api.md). Everything here sits behind
 * Cloudflare Access; the fetches are same-origin so the Access cookie and the
 * Origin header the CSRF guard wants ride along automatically.
 *
 * The plaintext secret returned by create/rotate is held in this component's
 * state and nowhere else — no storage, no URL, no logging — so navigating away
 * destroys it, which is exactly the intended contract.
 */
function ApiKeysPage(): ReactElement {
	const { mailboxId } = Route.useParams();
	const keys = useApiKeys(mailboxId);
	const { data: mailboxes } = useMailboxes();
	const [minted, setMinted] = useState<MintedApiKey | null>(null);
	const [formOpen, setFormOpen] = useState(false);
	const topRef = useRef<HTMLDivElement | null>(null);

	const defaultSender = mailboxes.find((m) => m.mailbox_id === mailboxId)?.primary_address;

	// Active keys first, revoked ones sink to the bottom; each group keeps the
	// server's newest-first ordering.
	const ordered = useMemo(() => {
		const rank = (key: TransactionalApiKey) => (key.status === "revoked" ? 1 : 0);
		return [...keys.data].sort((a, b) => rank(a) - rank(b));
	}, [keys.data]);

	const liveActiveCount = ordered.filter(
		(key) => key.environment === "live" && displayStatus(key) === "active",
	).length;

	// The one-time secret must never be missed because it rendered off-screen.
	useEffect(() => {
		if (minted) topRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
	}, [minted]);

	function handleCreated(result: MintedApiKey) {
		setFormOpen(false);
		setMinted(result);
		keys.refetch();
	}

	async function handleRevoke(keyId: string) {
		await revokeApiKey(mailboxId, keyId);
		keys.refetch();
	}

	async function handleRotate(keyId: string) {
		const result = await rotateApiKey(mailboxId, keyId);
		setMinted(result);
		keys.refetch();
	}

	return (
		<div className="h-full overflow-y-auto app-scroll">
			<div ref={topRef} className="mx-auto flex max-w-4xl flex-col gap-4 p-4 sm:p-6">
				<header className="flex flex-wrap items-start justify-between gap-3">
					<div className="min-w-0">
						<h1 className="text-xl font-medium tracking-tight text-[var(--app-text)]">
							Transactional API keys
						</h1>
						<p className="mt-1 max-w-2xl text-sm text-[var(--app-text-soft)]">
							Pre-authorized credentials that let an application send transactional mail through
							this mailbox without the human confirmation step. Each key is bound to one sender
							address, and its secret is shown only once.
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-2">
						<IconButton title="Refresh" onClick={keys.refetch}>
							<RefreshCw className="h-4 w-4" />
						</IconButton>
						<Button
							variant="primary"
							onClick={() => setFormOpen((open) => !open)}
							aria-expanded={formOpen}
						>
							<Plus className="h-4 w-4" />
							New key
						</Button>
					</div>
				</header>

				{minted ? <OneTimeSecret minted={minted} onDismiss={() => setMinted(null)} /> : null}

				{formOpen ? (
					<CreateApiKeyForm
						mailboxId={mailboxId}
						defaultSender={defaultSender}
						onCreated={handleCreated}
						onCancel={() => setFormOpen(false)}
					/>
				) : null}

				{keys.loading && ordered.length === 0 ? (
					<CenteredSpinner label="Loading keys…" />
				) : keys.error ? (
					<ErrorState message={describeApiKeyError(keys.error)} onRetry={keys.refetch} />
				) : ordered.length === 0 ? (
					<EmptyState
						icon={<KeyRound className="h-10 w-10" />}
						title="No API keys yet"
						hint="Create one to let an application send transactional email as this mailbox. You can revoke or rotate it at any time."
					/>
				) : (
					<>
						<p className="text-xs text-[var(--app-text-faint)]">
							{ordered.length} key{ordered.length === 1 ? "" : "s"}
							{liveActiveCount > 0
								? ` · ${liveActiveCount} live key${liveActiveCount === 1 ? "" : "s"} active`
								: ""}
						</p>
						<div className="flex flex-col gap-3">
							{ordered.map((key) => (
								<ApiKeyCard
									key={key.keyId}
									apiKey={key}
									onRevoke={() => handleRevoke(key.keyId)}
									onRenameSender={async (senderName) => {
										await updateApiKeySenderName(mailboxId, key.keyId, senderName);
										keys.refetch();
									}}
									onRotate={() => handleRotate(key.keyId)}
								/>
							))}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
