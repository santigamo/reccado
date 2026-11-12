import { createFileRoute, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState, type ReactElement } from "react";
import { authenticatePasskey } from "../../components/webauthn";

type ApprovalView = {
	id: string;
	status: string;
	title: string;
	fields: Array<{ label: string; value: string }>;
	warnings: Array<{ code: string; message: string }>;
	challenge: string | null;
	hasPasskey: boolean;
	allowCredentials: Array<{ id: string; transports: string[] }>;
};

const loadApproval = createServerFn({ method: "GET" })
	.validator((id: string) => {
		if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error("missing id");
		return id;
	})
	.handler(
		async ({
			data,
		}): Promise<{ unauthenticated: true } | { unauthenticated: false; view: ApprovalView }> => {
			const { getRequest } = await import("@tanstack/react-start/server");
			const { env } = await import("cloudflare:workers");
			const { requireAuth } = await import("../../api/auth");
			const { getIntentView } = await import("../../lib/approvals");
			const request = getRequest();
			try {
				const auth = await requireAuth(request, env, { disableCookieCache: true });
				const view = await getIntentView(env, data, { userId: auth.userId });
				return { unauthenticated: false, view };
			} catch (error) {
				if (error instanceof Response && error.status === 401) return { unauthenticated: true };
				throw error;
			}
		},
	);

export const Route = createFileRoute("/approve/$id")({
	loader: async ({ params }) => {
		const result = await loadApproval({ data: params.id });
		if (result.unauthenticated) {
			throw redirect({ href: `/login?next=${encodeURIComponent(`/approve/${params.id}`)}` });
		}
		return result.view;
	},
	component: ApprovePage,
});

const STATUS_COPY: Record<string, string> = {
	pending: "Pendiente de tu aprobación",
	approved: "Aprobada. El envío está en curso.",
	sent: "Enviado.",
	executed: "Cambio aplicado.",
	failed: "El cambio no se completó. Revisa el resultado de cada operación.",
	denied: "Rechazada. No se ha enviado nada.",
	expired: "Esta solicitud ha caducado.",
	stale: "El borrador cambió después de la solicitud. No se ha enviado nada.",
};

const BUTTON_CLASS =
	"rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50";
const QUIET_BUTTON_CLASS =
	"rounded-full border border-[rgba(50,143,151,0.3)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.14)] disabled:opacity-50";

function ApprovePage(): ReactElement {
	const view = Route.useLoaderData();
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	async function approve(): Promise<void> {
		if (!view.challenge) return;
		setBusy(true);
		setError(null);
		try {
			const assertion = await authenticatePasskey({
				challenge: view.challenge,
				allowCredentials: view.allowCredentials,
			});
			const response = await fetch(`/api/approvals/${encodeURIComponent(view.id)}/approve`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ assertion }),
			});
			if (!response.ok) {
				setError("No se ha aprobado. La solicitud sigue pendiente o ya no vale.");
				setBusy(false);
				return;
			}
			window.location.reload();
		} catch {
			setError("No se ha aprobado. La solicitud sigue pendiente o ya no vale.");
			setBusy(false);
		}
	}

	async function deny(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/approvals/${encodeURIComponent(view.id)}/deny`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			if (!response.ok) {
				setError("No se ha podido rechazar.");
				setBusy(false);
				return;
			}
			window.location.reload();
		} catch {
			setError("No se ha podido rechazar.");
			setBusy(false);
		}
	}

	return (
		<main className="mx-auto max-w-2xl px-4 py-10">
			<article className="island-shell rounded-2xl p-6">
				<h1 className="text-2xl font-semibold text-[var(--sea-ink)]">{view.title}</h1>
				<p className="mt-2 text-sm text-[var(--sea-ink-soft)]">
					{STATUS_COPY[view.status] ?? "Esta solicitud ha caducado."}
				</p>
				{view.warnings.length > 0 && (
					<ul className="mt-4 space-y-2 rounded-xl border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-700">
						{view.warnings.map((warning) => (
							<li key={warning.code}>{warning.message}</li>
						))}
					</ul>
				)}
				<dl className="mt-6 space-y-4">
					{view.fields.map((field) => (
						<div key={field.label}>
							<dt className="text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]">
								{field.label}
							</dt>
							<dd className="mt-1 whitespace-pre-wrap text-sm text-[var(--sea-ink)]">
								{field.value}
							</dd>
						</div>
					))}
				</dl>
				{view.status === "pending" && view.hasPasskey && view.challenge && (
					<div className="mt-6 flex flex-wrap gap-3">
						<button
							type="button"
							className={BUTTON_CLASS}
							disabled={busy}
							onClick={() => void approve()}
						>
							Aprobar con passkey
						</button>
						<button
							type="button"
							className={QUIET_BUTTON_CLASS}
							disabled={busy}
							onClick={() => void deny()}
						>
							Rechazar
						</button>
					</div>
				)}
				{view.status === "pending" && !view.hasPasskey && (
					<p className="mt-6 text-sm text-[var(--sea-ink)]">
						Para aprobar hace falta una passkey.{" "}
						<a className="underline" href="/security#passkeys">
							Registrar una passkey
						</a>
					</p>
				)}
				{error && <p className="mt-4 text-sm text-red-500">{error}</p>}
			</article>
		</main>
	);
}
