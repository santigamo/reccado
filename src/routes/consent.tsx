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
			const client = (await response.json()) as { name?: string };
			return { clientName: client.name ?? null };
		} catch {
			return { clientName: null };
		}
	});

export const Route = createFileRoute("/consent")({
	validateSearch: (search: Record<string, unknown>): { client_id?: string; scope?: string } => ({
		...(typeof search.client_id === "string" ? { client_id: search.client_id } : {}),
		...(typeof search.scope === "string" ? { scope: search.scope } : {}),
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
	const { client_id: clientId, scope } = Route.useSearch();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const clientLabel = clientName ?? clientId ?? "the requesting client";
	const scopes = (scope ?? "").split(" ").filter(Boolean);

	async function respond(accept: boolean): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch("/api/auth/oauth2/consent", {
				method: "POST",
				headers: { "content-type": "application/json" },
				// The raw signed query, byte-for-byte as the authorize redirect delivered it.
				body: JSON.stringify({ accept, oauth_query: window.location.search.slice(1) }),
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
									{s}
								</li>
							))}
						</ul>
					</div>
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
