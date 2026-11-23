import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { ReactElement, ReactNode } from "react";
import { useState } from "react";
import { CheckIcon, VerifiedIcon } from "#/components/auth/icons";
import {
	AuthPage,
	Brand,
	Card,
	Checkbox,
	Eyebrow,
	InlineError,
	Notice,
	PrimaryButton,
	SecondaryButton,
} from "#/components/auth/primitives";

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

/**
 * Whether this client has ever been consented, and when it registered. Open dynamic
 * client registration means a never-seen client is the normal case for a freshly added
 * MCP connection, and the owner should be told so. Non-sensitive: a timestamp and a bool.
 */
const fetchClientHistory = createServerFn({ method: "GET" })
	.validator((input: { clientId: string }) => input)
	.handler(async ({ data }): Promise<{ registeredAt: number | null; consentedBefore: boolean }> => {
		try {
			const { env } = await import("cloudflare:workers");
			const db = (env as unknown as { INDEX_DB: D1Database }).INDEX_DB;
			const client = await db
				.prepare(`SELECT "createdAt" AS created_at FROM "oauthClient" WHERE "clientId" = ?`)
				.bind(data.clientId)
				.first<{ created_at: number | null }>();
			const consent = await db
				.prepare(`SELECT 1 AS n FROM "oauthConsent" WHERE "clientId" = ? LIMIT 1`)
				.bind(data.clientId)
				.first();
			return { registeredAt: client?.created_at ?? null, consentedBefore: Boolean(consent) };
		} catch {
			return { registeredAt: null, consentedBefore: true };
		}
	});

/** "5 min ago" / "3 h ago" / "2 d ago" */
export function formatAgo(thenMs: number, nowMs: number = Date.now()): string {
	const minutes = Math.max(0, Math.round((nowMs - thenMs) / 60000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

/** Amber "needs your approval" fragment used inside scope copy. */
function Gate({ children }: { children: ReactNode }): ReactElement {
	return <span className="font-medium text-approval">{children}</span>;
}

/**
 * High-risk scopes: each is a checkbox, off by default, with a plain-English
 * line on what ticking it allows.
 */
const HIGH_RISK: Record<string, { title: string; detail: ReactNode }> = {
	"mail:read:sensitive": {
		title: "Read sensitive mail",
		detail:
			"Verification codes and password-reset links from your other services. Reccado's own sign-in mail is never exposed.",
	},
	"mail:send": {
		title: "Ask to send mail in your name",
		detail: (
			<>
				It can propose as many messages as it likes.{" "}
				<Gate>Each one is sent only after you approve it here.</Gate>
			</>
		),
	},
	"routing:write": {
		title: "Manage aliases and routing rules",
		detail: (
			<>
				Including forwarding to outside addresses, <Gate>which needs your approval.</Gate>
			</>
		),
	},
	"domains:write": {
		title: "Manage domains",
		detail: (
			<>
				Adding, provisioning or disabling a domain <Gate>needs your approval.</Gate>
			</>
		),
	},
	"keys:write": {
		title: "Manage transactional API keys",
		detail: (
			<>
				Creating or rotating a key <Gate>needs your approval</Gate>, and only you ever see the
				secret.
			</>
		),
	},
};
const HIGH_RISK_SCOPES: ReadonlySet<string> = new Set(Object.keys(HIGH_RISK));

/** Plain-English line for every scope that comes with the connection. */
const SCOPE_DESCRIPTIONS: Record<string, ReactNode> = {
	"mail:read": "Read messages and search your mailboxes",
	"config:read": "See service health, events and configuration, never secrets",
	"mail:draft": "Write and edit drafts, and tidy mail: mark read, archive, trash",
	"mailboxes:write": "Create, rename and disable mailboxes",
	"templates:write": "Create, edit and archive transactional templates",
	offline_access: "Stay connected until you revoke it under Connected agents",
	"suppressions:write": (
		<>
			Remove suppressed addresses <span className="text-approval">· needs your approval</span>
		</>
	),
};

const SCOPE_GROUPS: ReadonlyArray<{ title: string; scopes: readonly string[] }> = [
	{ title: "Read", scopes: ["mail:read", "config:read", "mail:read:sensitive"] },
	{ title: "Draft", scopes: ["mail:draft"] },
	{ title: "Send", scopes: ["mail:send"] },
	{ title: "Connection", scopes: ["offline_access"] },
	{
		title: "Manage",
		scopes: [
			"mailboxes:write",
			"templates:write",
			"suppressions:write",
			"routing:write",
			"domains:write",
			"keys:write",
		],
	},
];

export const Route = createFileRoute("/consent")({
	validateSearch: (
		search: Record<string, unknown>,
	): { client_id?: string; scope?: string; redirect_uri?: string } => ({
		...(typeof search.client_id === "string" ? { client_id: search.client_id } : {}),
		...(typeof search.scope === "string" ? { scope: search.scope } : {}),
		...(typeof search.redirect_uri === "string" ? { redirect_uri: search.redirect_uri } : {}),
	}),
	loaderDeps: ({ search }) => ({ clientId: search.client_id }),
	loader: async ({
		deps,
	}): Promise<{
		clientName: string | null;
		registeredAt: number | null;
		consentedBefore: boolean;
	}> => {
		if (!deps.clientId) return { clientName: null, registeredAt: null, consentedBefore: true };
		const [name, history] = await Promise.all([
			fetchClientName({ data: { clientId: deps.clientId } }),
			fetchClientHistory({ data: { clientId: deps.clientId } }),
		]);
		return { ...name, ...history };
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
 * request — this page adds no authorization of its own. On Allow (or Deny)
 * it POSTs the query back exactly as received and follows the redirect URI the
 * endpoint returns (with the authorization code, or the access_denied error).
 */
function ConsentPage(): ReactElement {
	const { clientName, registeredAt, consentedBefore } = Route.useLoaderData();
	const { client_id: clientId, scope, redirect_uri: redirectUri } = Route.useSearch();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// High-risk scopes start unchecked: each needs its own explicit tick.
	const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

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
	const redirectHost = hostOf(redirectUri);
	// DCR client ids are opaque random strings, so identity is judged by where the
	// authorization code will be sent.
	const redirectName = redirectHost?.split(":")[0] ?? null;
	const known =
		redirectName &&
		["claude.ai", "anthropic.com", "localhost", "127.0.0.1", "[::1]"].some(
			(host) => redirectName === host || redirectName.endsWith(`.${host}`),
		);

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

	function toggle(s: string, on: boolean): void {
		setTicked((current) => {
			const next = new Set(current);
			if (on) next.add(s);
			else next.delete(s);
			return next;
		});
	}

	const grouped = [
		...SCOPE_GROUPS.map((g) => ({
			title: g.title,
			items: g.scopes.filter((s) => requestedScopes.includes(s)),
		})),
		{
			title: "Other",
			items: requestedScopes.filter((s) => !SCOPE_GROUPS.some((g) => g.scopes.includes(s))),
		},
	].filter((g) => g.items.length > 0);

	const heading = clientName
		? `${clientName} wants to connect to this Reccado`
		: "An unnamed client wants to connect to this Reccado";

	return (
		<AuthPage className="py-6 sm:py-10">
			<Card className="max-w-[980px]" aria-labelledby="consent-title">
				<div className="flex flex-col md:flex-row">
					<aside className="flex shrink-0 flex-col gap-5 border-b border-border-card bg-content p-6 sm:p-7 md:w-[340px] md:border-b-0 md:border-r">
						<Brand />
						<div className="flex flex-col gap-1.5">
							<h1
								id="consent-title"
								className="text-[20px] font-semibold leading-[26px] tracking-[-0.015em] text-ink"
							>
								{heading}
							</h1>
							<p className="text-[14px] leading-5 text-text-muted">
								It will act on your behalf through the MCP endpoint. Allow it only if you recognise
								it.
							</p>
						</div>

						<dl className="flex flex-col rounded-[10px] border border-border bg-panel">
							{!clientName && (
								<IdentityRow label="Client ID">
									<span className="break-all font-mono text-[13px] font-medium">
										{clientId ?? "Not available"}
									</span>
								</IdentityRow>
							)}
							<IdentityRow label="Redirects to">
								{redirectHost ? (
									<span className="flex flex-wrap items-center gap-2">
										<span className="break-all font-mono text-[13px] font-medium">
											{redirectHost}
										</span>
										{known && (
											<span className="flex items-center gap-1.5 text-[12px] leading-4 text-text-muted">
												<VerifiedIcon />
												Known
											</span>
										)}
									</span>
								) : (
									<span className="text-text-muted">Not available</span>
								)}
							</IdentityRow>
							{registeredAt ? (
								<IdentityRow label="Registered">{formatAgo(registeredAt)}</IdentityRow>
							) : null}
						</dl>

						{!consentedBefore && (
							<div role="note" className="flex flex-col gap-1">
								<p className="text-[13px] font-medium leading-[18px] text-text">
									New client · first time it asks for access
								</p>
								<p className="text-[13px] leading-[19px] text-text-muted">
									Allow it only if you added this connector yourself just now.
								</p>
							</div>
						)}

						{!known && (
							<Notice tone="danger" role="alert" className="md:mt-auto">
								{redirectHost ? (
									<>
										<span className="font-mono font-medium">{redirectHost}</span> is not on the list
										of known domains. Check who this is before you continue.
									</>
								) : (
									"Where this client sends you back to could not be read. Check who this is before you continue."
								)}
							</Notice>
						)}
					</aside>

					<section
						aria-labelledby="consent-scopes-title"
						className="flex min-w-0 grow flex-col px-6 pb-5 pt-6 sm:px-7"
					>
						<div className="flex flex-col gap-1 pb-3.5">
							<h2
								id="consent-scopes-title"
								className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-ink"
							>
								What it is asking for
							</h2>
							<p className="text-[13px] leading-[19px] text-text-muted">
								Checked items come with the connection. Higher-risk ones stay off unless you tick
								them. Sends and critical changes always need your approval on this site.
							</p>
						</div>

						{grouped.length === 0 && (
							<p className="border-t border-border pt-3 text-[14px] leading-5 text-text-muted">
								No specific permissions were requested.
							</p>
						)}

						{grouped.map((group, index) => (
							<div
								key={group.title}
								className={`flex flex-col border-t border-border pt-2.5 ${
									index === grouped.length - 1 ? "" : "pb-2"
								}`}
							>
								<Eyebrow as="h3" className="pb-1">
									{group.title}
								</Eyebrow>
								<ul className="flex flex-col">
									{group.items.map((s) => (
										<li key={s}>
											{HIGH_RISK_SCOPES.has(s) ? (
												<Checkbox
													className="py-1.5"
													checked={ticked.has(s)}
													onChange={(on) => toggle(s, on)}
													description={HIGH_RISK[s]?.detail}
													trailing={<ScopeCode scope={s} />}
												>
													<span className="font-medium">{HIGH_RISK[s]?.title}</span>
												</Checkbox>
											) : (
												<div className="flex min-h-[30px] items-center gap-3 py-1">
													<span className="flex w-[18px] shrink-0 justify-center">
														<CheckIcon />
													</span>
													<span className="grow text-[14px] leading-5 text-text">
														{SCOPE_DESCRIPTIONS[s] ?? (
															<span className="text-approval">
																Unknown permission. Review it before allowing.
															</span>
														)}
													</span>
													<ScopeCode scope={s} />
												</div>
											)}
										</li>
									))}
								</ul>
							</div>
						))}
					</section>
				</div>

				<footer className="flex flex-col gap-3 border-t border-border-card bg-content px-6 py-4 sm:flex-row sm:items-center sm:gap-2.5 sm:pl-7 sm:pr-5">
					<div className="flex grow flex-col gap-2">
						{error && <InlineError>{error}</InlineError>}
						<p className="text-[13px] leading-[18px] text-text-muted">
							You can disconnect it any time under Settings · Agent access.
						</p>
					</div>
					<div className="flex gap-2.5">
						<SecondaryButton
							onClick={() => respond(false)}
							disabled={busy}
							className="h-12 flex-1 sm:h-9 sm:flex-none"
						>
							Deny
						</SecondaryButton>
						<PrimaryButton
							onClick={() => respond(true)}
							disabled={busy}
							aria-busy={busy}
							className="h-12 flex-1 sm:h-9 sm:flex-none"
						>
							{busy ? "Working…" : "Allow"}
						</PrimaryButton>
					</div>
				</footer>
			</Card>
		</AuthPage>
	);
}

function IdentityRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
	return (
		<div className="flex min-h-[42px] items-center gap-2 border-t border-border px-3.5 py-2 first:border-t-0">
			<dt className="w-[84px] shrink-0 text-[13px] leading-[18px] text-text-muted">{label}</dt>
			<dd className="min-w-0 text-[13px] leading-[18px] text-text">{children}</dd>
		</div>
	);
}

function ScopeCode({ scope }: { scope: string }): ReactElement {
	return (
		<code className="max-w-[42%] shrink-0 break-all text-right font-mono text-[12px] leading-5 text-text-muted">
			{scope}
		</code>
	);
}
