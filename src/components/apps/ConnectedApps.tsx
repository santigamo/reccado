import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/Button";
import { cn } from "#/lib/cn";
import { appName, type ConnectedApp, formatAppDate, readJson } from "./connected-apps";

function AppCard({ app, onChanged }: { app: ConnectedApp; onChanged: () => Promise<void> }): ReactElement {
	const [confirming, setConfirming] = useState(false);
	const [revoking, setRevoking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function revoke(): Promise<void> {
		setRevoking(true);
		setError(null);
		try {
			const response = await fetch(`/api/oauth-clients/${encodeURIComponent(app.client_id)}/revoke`, { method: "POST" });
			if (!response.ok) return setError(`No se pudo revocar (HTTP ${response.status}).`);
			await onChanged();
		} catch {
			setError("La petición no llegó al servidor.");
		} finally {
			setRevoking(false);
		}
	}

	return (
		<article className={cn("rounded-2xl border border-[var(--app-border)] bg-[var(--app-surface)] p-4", !app.authorized && "opacity-70")}>
			<div className="flex flex-wrap items-center gap-2">
				<h3 className="text-sm font-semibold text-[var(--app-text)]">{appName(app)}</h3>
				{!app.authorized && (
					<span className="rounded-full border border-[var(--app-border-strong)] px-2 py-0.5 text-[11px] text-[var(--app-text-faint)]">sin autorizar</span>
				)}
			</div>
			<dl className="mt-2 grid gap-2 text-[13px] sm:grid-cols-2">
				<div>
					<dt className="text-[11px] uppercase tracking-wide text-[var(--app-text-faint)]">Sitio</dt>
					<dd className="break-words text-[var(--app-text)]">{app.redirect_hosts.join(", ") || "—"}</dd>
				</div>
				<div>
					<dt className="text-[11px] uppercase tracking-wide text-[var(--app-text-faint)]">Permisos</dt>
					<dd className="break-words text-[var(--app-text)]">{app.granted_scopes.join(", ") || "—"}</dd>
				</div>
				<div>
					<dt className="text-[11px] uppercase tracking-wide text-[var(--app-text-faint)]">Creada</dt>
					<dd className="text-[var(--app-text)]">{formatAppDate(app.created_at)}</dd>
				</div>
				<div>
					<dt className="text-[11px] uppercase tracking-wide text-[var(--app-text-faint)]">Último token</dt>
					<dd className="text-[var(--app-text)]">{formatAppDate(app.last_token_at)}</dd>
				</div>
			</dl>

			<div className="mt-3">
				{confirming ? (
					<div role="alert" className="rounded-xl border border-[var(--app-danger)] p-3 text-[13px] text-[var(--app-text)]">
						<p>
							¿Revocar «{appName(app)}»? Se borra su permiso. Los tokens ya emitidos siguen valiendo hasta una hora.
						</p>
						<div className="mt-2 flex gap-2">
							<Button size="sm" variant="primary" disabled={revoking} onClick={() => void revoke()}>
								{revoking ? "Revocando…" : "Sí, revocar"}
							</Button>
							<Button size="sm" variant="ghost" disabled={revoking} onClick={() => setConfirming(false)}>
								Cancelar
							</Button>
						</div>
					</div>
				) : (
					<Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
						Revocar
					</Button>
				)}
				{error && <p className="mt-2 text-[13px] text-[var(--app-danger)]">{error}</p>}
			</div>
		</article>
	);
}

/** "Aplicaciones conectadas": the owner's OAuth clients, and revoke. */
export function ConnectedApps(): ReactElement {
	const [apps, setApps] = useState<ConnectedApp[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
			const clients = await fetch("/api/oauth-clients").then((r) => readJson<{ clients: ConnectedApp[] }>(r));
			setApps(clients.clients);
			setError(null);
		} catch {
			setError("No se pudieron cargar las aplicaciones.");
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	return (
		<section className="island-shell rise-in mx-auto mt-6 max-w-2xl rounded-[2rem] px-6 py-8">
			<h2 className="mb-1 text-xl font-bold tracking-tight text-[var(--sea-ink)]">Aplicaciones conectadas</h2>
			<p className="mb-4 text-sm text-[var(--sea-ink-soft)]">
				Apps que se conectan a tu correo por MCP. Revoca las que ya no uses.
			</p>
			{error && <p className="text-sm text-red-500">{error}</p>}
			{!error && apps === null && <p className="text-sm text-[var(--sea-ink-soft)]">Cargando…</p>}
			{apps?.length === 0 && <p className="text-sm text-[var(--sea-ink-soft)]">No hay aplicaciones conectadas.</p>}
			<div className="space-y-3">
				{apps?.map((app) => (
					<AppCard key={app.client_id} app={app} onChanged={load} />
				))}
			</div>
		</section>
	);
}
