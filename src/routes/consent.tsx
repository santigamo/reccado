import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactElement } from "react";
import { useState } from "react";

/**
 * Resolves the OAuth client's display name through the provider's
 * session-authenticated public-client endpoint. A server function because it
 * needs the incoming request's cookie header during SSR (there is no cookie jar
 * server-side); in the browser the same call carries the session cookie on its
 * own, so the name survives client-side navigations too.
 */
const fetchClientName = createServerFn({ method: "GET" })
	.validator((input: { clientId: string }) => input)
	.handler(async ({ data }): Promise<{ clientName: string | null }> => {
		try {
			const { getRequest } = await import("@tanstack/react-start/server");
			const request = getRequest();
			const origin = new URL(request.url).origin;
			const cookie = request.headers.get("cookie") ?? "";
			const response = await fetch(
				`${origin}/api/auth/oauth2/public-client?client_id=${encodeURIComponent(data.clientId)}`,
				cookie ? { headers: { cookie } } : undefined,
			);
			if (!response.ok) return { clientName: null };
			const client = (await response.json()) as { client_name?: string };
			return { clientName: client.client_name ?? null };
		} catch {
			return { clientName: null };
		}
	});

/** Plain-Spanish risk line shown next to each high-risk scope's checkbox. */
const HIGH_RISK_LINES: Record<string, string> = {
	"mail:send":
		"Permite pedir envíos de correo en tu nombre. Cada envío sigue necesitando tu aprobación en Telegram o en la página de aprobación, pero el cliente podrá redactar y proponer mensajes sin límite.",
	"mail:read:sensitive":
		"Expone códigos de verificación y enlaces de restablecimiento de contraseña de tus otros servicios que lleguen a tus buzones. Los correos de autenticación de esta instancia nunca se exponen.",
	admin:
		"Permite proponer cambios de configuración: dominios, buzones, alias, reglas, plantillas y claves de API. Cada cambio sigue necesitando tu aprobación en Telegram o en la página de aprobación.",
};
const HIGH_RISK_SCOPES: ReadonlySet<string> = new Set(Object.keys(HIGH_RISK_LINES));

export const Route = createFileRoute("/consent")({
	validateSearch: (
		search: Record<string, unknown>,
	): { client_id?: string; scope?: string; redirect_uri?: string } => ({
		...(typeof search.client_id === "string" ? { client_id: search.client_id } : {}),
		...(typeof search.scope === "string" ? { scope: search.scope } : {}),
		...(typeof search.redirect_uri === "string" ? { redirect_uri: search.redirect_uri } : {}),
	}),
	loaderDeps: ({ search }) => ({ clientId: search.client_id }),
	loader: async ({ deps }): Promise<{ clientName: string | null }> => {
		if (!deps.clientId) return { clientName: null };
		return fetchClientName({ data: { clientId: deps.clientId } });
	},
	component: ConsentPage,
});

/**
 * The OAuth consent screen (the mcp() plugin's consentPage, src/api/better-auth.ts).
 *
 * The browser lands here as a 302 from /api/auth/oauth2/authorize, carrying the
 * signed authorization request in the query string. The whole decision is
 * delegated to the consent endpoint itself, which fails closed: it verifies the
 * query signature, requires the session cookie and requires a same-origin
 * request — this page adds no authorization of its own. On Approve (or Deny)
 * it POSTs the query back exactly as received and follows the redirect URI the
 * endpoint returns (with the authorization code, or the access_denied error).
 */
function ConsentPage(): ReactElement {
	const { clientName } = Route.useLoaderData();
	const { client_id: clientId, scope, redirect_uri: redirectUri } = Route.useSearch();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// High-risk scopes start unchecked: each needs its own explicit tick.
	const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

	const clientLabel = clientName ?? clientId ?? "the requesting client";
	const requestedScopes = (scope ?? "").split(" ").filter(Boolean);
	const scopes = requestedScopes.filter((s) => !HIGH_RISK_SCOPES.has(s));
	const highScopes = requestedScopes.filter((s) => HIGH_RISK_SCOPES.has(s));
	const hostOf = (value?: string) => {
		try {
			return value ? new URL(value).host : null;
		} catch {
			return null;
		}
	};
	const clientHost = hostOf(clientId);
	const redirectHost = hostOf(redirectUri);
	const known =
		clientHost &&
		["claude.ai", "anthropic.com", "localhost"].some(
			(host) => clientHost.split(":")[0] === host || clientHost.split(":")[0]?.endsWith(`.${host}`),
		);
	const descriptions: Record<string, string> = {
		"mail:read": "Leer mensajes y buscar en el buzón.",
		"mail:draft": "Crear y editar borradores.",
		"mail:send": "Solicitar el envío de mensajes, sujeto a confirmación humana.",
		"mail:read:sensitive": "Leer el contenido sensible y los archivos adjuntos.",
		admin: "Administrar la configuración y los recursos de Reccado.",
	};

	async function respond(accept: boolean): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/oauth2/consent", {
				method: "POST",
				headers: { "content-type": "application/json" },
				// The raw signed query, byte-for-byte as the authorize redirect delivered it.
				body: JSON.stringify({
					accept,
					// Only what is read/draft plus the high-risk scopes explicitly ticked.
					scope: [...scopes, ...highScopes.filter((s) => ticked.has(s))].join(" "),
					oauth_query: window.location.search.slice(1),
				}),
			});
			const body = (await response.json().catch(() => null)) as {
				url?: string;
				redirect_uri?: string;
			} | null;
			const target = body?.url ?? body?.redirect_uri;
			if (!response.ok || !target) {
				setError("The consent decision could not be processed. Close this tab and retry.");
				return;
			}
			window.location.assign(target);
		} catch {
			setError("The request never reached the server. Check your connection and retry.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<main className="page-wrap px-4 pb-8 pt-14">
			<section className="island-shell rise-in mx-auto max-w-md rounded-[2rem] px-6 py-10">
				<p className="island-kicker mb-3">Reccado</p>
				<p className="mb-2 break-all text-lg font-semibold">
					{clientHost ?? clientId ?? "Cliente desconocido"}
				</p>
				<p className="mb-3 text-sm">
					Cliente: {clientName ?? "Nombre no disponible"} · Destino:{" "}
					{redirectHost ?? "No disponible"}
				</p>
				{!known && (
					<p role="alert" className="mb-4 rounded-xl bg-amber-100 p-3 text-sm text-amber-900">
						Este cliente no está en la lista de dominios conocidos. Comprueba su identidad antes de
						continuar.
					</p>
				)}
				<h1 className="mb-2 text-2xl font-bold tracking-tight text-[var(--sea-ink)]">
					Authorize {clientLabel} to access Reccado MCP
				</h1>
				<p className="mb-5 text-sm text-[var(--sea-ink-soft)]">
					{clientLabel} is asking to connect to this deployment's MCP endpoint on your behalf.
					Approve only if you recognize it.
				</p>

				{scopes.length > 0 && (
					<div className="mb-6">
						<p className="mb-2 text-sm text-[var(--sea-ink-soft)]">Requested access</p>
						<ul className="flex flex-wrap gap-2">
							{scopes.map((s) => (
								<li
									key={s}
									className="rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-3 py-1 font-mono text-xs text-[var(--lagoon-deep)]"
								>
									{s}: {descriptions[s] ?? "Permiso desconocido; revisa antes de aprobar."}
								</li>
							))}
						</ul>
					</div>
				)}

				{highScopes.length > 0 && (
					<fieldset className="mb-6 rounded-xl border border-amber-300 p-3">
						<legend className="px-1 text-sm font-semibold text-amber-900">
							Permisos de alto riesgo (desactivados por defecto)
						</legend>
						{highScopes.map((s) => (
							<label key={s} className="mb-3 flex items-start gap-2 text-sm last:mb-0">
								<input
									type="checkbox"
									className="mt-1"
									checked={ticked.has(s)}
									onChange={(event) =>
										setTicked((current) => {
											const next = new Set(current);
											if (event.target.checked) next.add(s);
											else next.delete(s);
											return next;
										})
									}
								/>
								<span>
									<span className="font-mono text-xs">{s}</span>
									<br />
									{HIGH_RISK_LINES[s]}
								</span>
							</label>
						))}
					</fieldset>
				)}

				<div className="flex gap-3">
					<button
						type="button"
						onClick={() => respond(true)}
						disabled={busy}
						className="flex-1 rounded-full border border-[rgba(50,143,151,0.3)] bg-[rgba(79,184,178,0.14)] px-5 py-2.5 text-sm font-semibold text-[var(--lagoon-deep)] transition hover:bg-[rgba(79,184,178,0.24)] disabled:opacity-50"
					>
						Approve
					</button>
					<button
						type="button"
						onClick={() => respond(false)}
						disabled={busy}
						className="flex-1 rounded-full border border-[rgba(50,143,151,0.3)] px-5 py-2.5 text-sm font-semibold text-[var(--sea-ink-soft)] transition hover:bg-[rgba(79,184,178,0.14)] disabled:opacity-50"
					>
						Deny
					</button>
				</div>
				{error && <p className="mt-3 text-sm text-red-500">{error}</p>}
			</section>
		</main>
	);
}
