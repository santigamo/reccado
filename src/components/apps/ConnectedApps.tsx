import { type ReactElement, useCallback, useEffect, useState } from "react";
import { Button } from "#/components/ui/Button";
import { cn } from "#/lib/cn";
import {
	AUTO_ELIGIBLE,
	type AutoKind,
	appName,
	type ClientPolicy,
	type ConnectedApp,
	canDelegate,
	delegationBlockedReason,
	draftFromPolicy,
	formatAppDate,
	KIND_LABELS,
	type PolicyDraft,
	policyRequestBody,
	readJson,
	validateDraft,
} from "./connected-apps";

type MailboxOption = { mailbox_id: string; primary_address: string };

const INPUT_CLASS =
	"rounded-md border border-[var(--app-border-strong)] bg-[var(--app-surface)] px-2 py-1 text-[13px] text-[var(--app-text)] outline-none focus:border-[var(--app-accent)]";

function PolicyEditor({
	app,
	policy,
	mailboxes,
	onChanged,
}: {
	app: ConnectedApp;
	policy: ClientPolicy | undefined;
	mailboxes: MailboxOption[];
	onChanged: () => Promise<void>;
}): ReactElement {
	const [draft, setDraft] = useState<PolicyDraft>(() => draftFromPolicy(policy));
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
	const url = `/api/mcp-client-policies/${encodeURIComponent(app.client_id)}`;

	function toggle<T>(list: T[], value: T, on: boolean): T[] {
		return on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);
	}

	async function save(): Promise<void> {
		const problem = validateDraft(draft);
		if (problem) return setMessage({ ok: false, text: problem });
		setBusy(true);
		setMessage(null);
		try {
			const response = await fetch(url, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(policyRequestBody(draft)),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as { message?: string } | null;
				return setMessage({ ok: false, text: body?.message ?? `No se pudo guardar (HTTP ${response.status}).` });
			}
			setMessage({ ok: true, text: "Política guardada." });
			await onChanged();
		} catch {
			setMessage({ ok: false, text: "La petición no llegó al servidor." });
		} finally {
			setBusy(false);
		}
	}

	async function remove(): Promise<void> {
		setBusy(true);
		setMessage(null);
		try {
			const response = await fetch(url, { method: "DELETE" });
			if (!response.ok) return setMessage({ ok: false, text: `No se pudo quitar (HTTP ${response.status}).` });
			setDraft(draftFromPolicy(undefined));
			await onChanged();
		} catch {
			setMessage({ ok: false, text: "La petición no llegó al servidor." });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-3 space-y-4 rounded-xl border border-[var(--app-border)] p-3">
			<p className="text-[13px] text-[var(--app-text-soft)]">
				Estos cambios se aplican sin pedirte aprobación, solo en los buzones y tipos que marques. Los envíos nunca se delegan.
			</p>

			<fieldset>
				<legend className="text-[12px] font-semibold text-[var(--app-text)]">Buzones</legend>
				{mailboxes.length === 0 ? (
					<p className="mt-1 text-[13px] text-[var(--app-text-faint)]">No hay buzones.</p>
				) : (
					<div className="mt-1 space-y-1">
						{mailboxes.map((mailbox) => (
							<label key={mailbox.mailbox_id} className="flex items-center gap-2 text-[13px] text-[var(--app-text)]">
								<input
									type="checkbox"
									checked={draft.mailboxIds.includes(mailbox.mailbox_id)}
									onChange={(event) => setDraft({ ...draft, mailboxIds: toggle(draft.mailboxIds, mailbox.mailbox_id, event.target.checked) })}
								/>
								{mailbox.primary_address}
							</label>
						))}
					</div>
				)}
			</fieldset>

			<fieldset>
				<legend className="text-[12px] font-semibold text-[var(--app-text)]">Qué puede cambiar sola</legend>
				<div className="mt-1 space-y-1.5">
					{AUTO_ELIGIBLE.map((kind: AutoKind) => (
						<label key={kind} className="flex items-start gap-2 text-[13px] text-[var(--app-text)]">
							<input
								type="checkbox"
								className="mt-0.5"
								checked={draft.kinds.includes(kind)}
								onChange={(event) => setDraft({ ...draft, kinds: toggle(draft.kinds, kind, event.target.checked) })}
							/>
							<span>
								{KIND_LABELS[kind].title}
								<span className="block text-[12px] text-[var(--app-text-faint)]">{KIND_LABELS[kind].hint}</span>
							</span>
						</label>
					))}
				</div>
			</fieldset>

			<label className="block text-[12px] font-semibold text-[var(--app-text)]">
				Dominios permitidos en enlaces
				<input
					value={draft.linkDomains}
					onChange={(event) => setDraft({ ...draft, linkDomains: event.target.value })}
					placeholder="ejemplo.com, otro.com"
					autoComplete="off"
					className={cn(INPUT_CLASS, "mt-1 block w-full font-normal")}
				/>
				<span className="mt-1 block text-[12px] font-normal text-[var(--app-text-faint)]">
					Separados por comas. Una plantilla con un enlace a otro dominio pasa a aprobación.
				</span>
			</label>

			<label className="flex items-start gap-2 text-[13px] text-[var(--app-text)]">
				<input
					type="checkbox"
					className="mt-0.5"
					checked={draft.allowVariableLinks}
					onChange={(event) => setDraft({ ...draft, allowVariableLinks: event.target.checked })}
				/>
				<span>
					Permitir enlaces variables
					<span className="block text-[12px] text-[var(--app-text-faint)]">
						Enlaces que se rellenan al enviar, como {"{{url}}"}. No se puede comprobar adónde apuntan, así que actívalo solo si confías en la app.
					</span>
				</span>
			</label>

			<label className="block text-[12px] font-semibold text-[var(--app-text)]">
				Máximo de cambios automáticos por hora
				<input
					type="number"
					min={1}
					max={1000}
					value={draft.maxAutoPerHour}
					onChange={(event) => setDraft({ ...draft, maxAutoPerHour: Number(event.target.value) })}
					className={cn(INPUT_CLASS, "mt-1 block w-28 font-normal")}
				/>
			</label>

			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
					{busy ? "Guardando…" : "Guardar política"}
				</Button>
				{policy && (
					<Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
						Quitar política
					</Button>
				)}
			</div>
			{message && (
				<p role="status" className={cn("text-[13px]", message.ok ? "text-[var(--palm)]" : "text-[var(--app-danger)]")}>
					{message.text}
				</p>
			)}
		</div>
	);
}

function AppCard({
	app,
	policy,
	mailboxes,
	onChanged,
}: {
	app: ConnectedApp;
	policy: ClientPolicy | undefined;
	mailboxes: MailboxOption[];
	onChanged: () => Promise<void>;
}): ReactElement {
	const [confirming, setConfirming] = useState(false);
	const [revoking, setRevoking] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const blocked = delegationBlockedReason(app);

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
				{policy && (
					<span className="rounded-full border border-[var(--app-border-strong)] px-2 py-0.5 text-[11px] text-[var(--app-text-soft)]">delegación activa</span>
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

			<div className="mt-3 border-t border-[var(--app-border)] pt-3">
				{blocked ? (
					<p className="text-[13px] text-[var(--app-text-faint)]">{blocked}</p>
				) : (
					<Button size="sm" variant="secondary" onClick={() => setEditing((open) => !open)} aria-expanded={editing}>
						{editing ? "Cerrar delegación" : policy ? "Editar delegación" : "Delegar cambios"}
					</Button>
				)}
				{canDelegate(app) && editing && <PolicyEditor app={app} policy={policy} mailboxes={mailboxes} onChanged={onChanged} />}
			</div>

			<div className="mt-3">
				{confirming ? (
					<div role="alert" className="rounded-xl border border-[var(--app-danger)] p-3 text-[13px] text-[var(--app-text)]">
						<p>
							¿Revocar «{appName(app)}»? Se borran su permiso y su política. Los tokens ya emitidos siguen valiendo hasta una hora.
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

/** "Aplicaciones conectadas": the owner's OAuth clients, their delegation policies, and revoke. */
export function ConnectedApps(): ReactElement {
	const [apps, setApps] = useState<ConnectedApp[] | null>(null);
	const [policies, setPolicies] = useState<ClientPolicy[]>([]);
	const [mailboxes, setMailboxes] = useState<MailboxOption[]>([]);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async (): Promise<void> => {
		try {
			const [clients, policyList, mailboxList] = await Promise.all([
				fetch("/api/oauth-clients").then((r) => readJson<{ clients: ConnectedApp[] }>(r)),
				fetch("/api/mcp-client-policies").then((r) => readJson<{ policies: ClientPolicy[] }>(r)),
				fetch("/api/mailboxes").then((r) => readJson<{ mailboxes: MailboxOption[] }>(r)),
			]);
			setApps(clients.clients);
			setPolicies(policyList.policies);
			setMailboxes(mailboxList.mailboxes);
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
					<AppCard
						key={app.client_id}
						app={app}
						policy={policies.find((p) => p.clientId === app.client_id)}
						mailboxes={mailboxes}
						onChanged={load}
					/>
				))}
			</div>
		</section>
	);
}
