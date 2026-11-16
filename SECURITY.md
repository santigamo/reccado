# Security Policy

## Security model

Reccado is designed as a **single-operator, self-hosted** inbox (v0). Each install lives entirely
in one Cloudflare account; there is no multi-tenant SaaS deployment of this codebase. The
security model reflects that scope — it is not yet hardened for "many untrusted users sharing one
deployment."

### Auth perimeter: Better Auth in the worker

**The issuer is Better Auth running inside the Worker.** `/login` opens a web session via e-mail
OTP, `/api/auth/*` serves the auth endpoints, and `/mcp` accepts OAuth tokens (with `jwt()` signing
keys and a JWKS endpoint). Unlike the previous edge-perimeter model, every trust decision here is
**observable in the worker's own code and logs** — there is no unverifiable edge component whose
configuration the app has to take on faith.

- **Registration is closed at the issuer.** An OTP is only ever sent to an address the owner
  registry vouches for: `owner_identities` in D1 unioned with the `OWNER_BOOTSTRAP_EMAILS` secret,
  which remains the master key into the registry. With an empty registry and no bootstrap, `/api/*`
  and `/mcp` fail closed (`503`).
- **Session cookie cache** — session verification uses Better Auth's short-lived signed cookie
  cache (5 minutes) so a request does not cost a D1 read. The **confirm-send path deliberately
  bypasses the cache** and verifies the session against D1, so a revoked session takes effect
  the moment a send is about to happen.
- **Rate limiting** — Better Auth's built-in rate limiter is enabled with database-backed storage
  on the auth endpoints. As an outer layer, a Cloudflare WAF rate-limiting rule on `/api/auth/*`
  (created or printed by `pnpm setup:auth`) drops brute-force traffic before it reaches the
  worker; the perimeter works without it.
- **Pairing-code rescue** — the same single-use, expiring pairing codes the Telegram bridge uses
  can open a web session at `/login` when the code is minted via `wrangler d1 execute`. This is the
  only safety net: it lets the first owner log in before mail sending is configured, and it works
  even when the registry says nobody owns the deployment yet.
- **Fails closed** — without `BETTER_AUTH_SECRET` (or with one shorter than 32 characters), the
  issuer refuses to start and requests from any hostname other than `localhost`/`127.0.0.1`/`::1`
  are rejected outright rather than falling back to an open or trust-the-client mode. Local dev
  (`localhost`) intentionally falls back to a dev bypass so you can develop without secrets.

**This fails closed.** With no owner registered and no bootstrap variable, `/api/*` answers `503
owner_not_configured` and `/mcp` answers `503 mcp_not_configured` — an install that is half
configured authorizes nobody. The single exception is a loopback request during local development,
and it stops applying the moment a real owner exists. `/mcp` has no such exception at all, because
an MCP client acts without a human watching.

This check is defence in depth, not redundancy with the login flow. The failure it is there for is
a deployment whose perimeter was left half-configured — where nothing denies, nothing vouches, and
the worker's own list is the only thing left standing.

### Debug endpoints fail closed

The `/api/debug/phase0/*` introspection endpoints (R2 object head, Durable Object schema/state
dumps, local email simulation in a deployed environment) are gated by `PHASE0_DEBUG_TOKEN`. If
that token is unset, the endpoints are **unreachable**, not merely unauthenticated — there is no
default-open fallback. Treat this token like any other secret: only set it in environments where
you actively need it, and prefer to leave it unset on a deployment you consider production.

### Attachment and raw-message downloads

Attachments and raw MIME downloads are served with `Content-Disposition: attachment`,
`X-Content-Type-Options: nosniff`, and a sandboxing Content-Security-Policy. This is a deliberate
defense against stored content (an inbound HTML attachment or message body, which is
attacker-controlled by definition) executing as if it were same-origin app content — downloads
are forced to download rather than render inline, and any HTML that does get rendered is
sandboxed.

### CSRF / mutating requests

Mutating `/api/*` routes (anything that isn't a plain `GET`) check the request `Origin` against
the deployed Worker's own origin before processing, as a CSRF defense layered on top of the session perimeter.
Baseline response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy`) are set on API responses.

### Inbound size limits

Inbound email is capped at roughly 25 MiB, matching Cloudflare Email Routing's own inbound
message size limit, enforced before the raw message is buffered or stored — this bounds worst-case
memory/CPU use per inbound message regardless of what Cloudflare itself accepts.

### Dev-only data is not seeded in production

The dev convenience that seeds a `test@example.com` mailbox/domain/alias requires an explicit
opt-in and is a no-op by default; it is not invoked implicitly from the real inbound email path
your Cloudflare account's Email Routing rule calls.

### Encryption at rest

Reccado relies on **Cloudflare's platform-level encryption at rest** for R2 (raw MIME,
attachments, backups), D1 (the control-plane index), and Durable Object SQLite storage (canonical
mailbox state). For mailbox content there is no separate, application-level encryption layer on top
of that — this is an explicit trade-off, not an oversight. It means:

- Anyone with sufficient access to your Cloudflare account (account owner, or a token with broad
  R2/D1/Durable Objects scopes) can read mailbox contents directly, bypassing the app's auth
  layer entirely. Scope Cloudflare API tokens narrowly and treat account-level access as
  equivalent to mailbox access.

**One exception, and it is a sharp one.** The auth issuer *does* encrypt two things at the
application level, both with `BETTER_AUTH_SECRET`:

| Encrypted with `BETTER_AUTH_SECRET` | Table | What its loss costs |
|---|---|---|
| The `jwt()` plugin's signing key | `jwks` | Every `/api/*` request answers `503 auth_unavailable` with "Failed to decrypt private key" |
| Enrolled TOTP secrets | `twoFactor` | The authenticator is silently un-enrolled |

So **rotating `BETTER_AUTH_SECRET` is not the routine operation the word "rotate" suggests.** It
does not merely sign out live sessions: it orphans the ciphertext above, and the damage does not
announce itself — the perimeter simply starts failing closed at the next sign-in, which may be days
later. Recovery means deleting the `jwks` rows so the plugin mints a fresh keypair, and re-enrolling
every authenticator. There is no way to recover the old TOTP secrets.

`pnpm setup:auth` will not replace an existing secret for this reason; doing so requires
`--rotate-secret` by name. See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the recovery runbook.
- There is currently no per-mailbox or per-message application-level encryption, no
  envelope-encryption scheme, and no support for bring-your-own-key. If your threat model
  requires protecting mail content from someone with Cloudflare account access, this product does
  not yet meet that bar.

### Outbound sending requires human confirmation

Outbound mail from the **UI, Telegram, and the MCP endpoint** always goes through an explicit
`request-send` → `confirm-send` flow gated by an idempotency key; there is no code path on those
surfaces that sends mail from a single unconfirmed call. This is treated as a hard invariant; see
`AGENTS.md` and `docs/ARCHITECTURE.md`. For anything an agent initiates over MCP the invariant is
stronger: **an agent may read, draft and act on mailbox content, but every outbound send it
initiates requires the owner's approval, bound to the exact payload (`payload_hash`) and given only
on a server-rendered page with the owner web session**, and so does a short list of irreversible /
exfiltrating control-plane changes; every other control-plane write applies directly with its
narrow scope and is undoable (see [MCP](#mcp-agents-scopes-and-approvals)).

The **transactional API** is the one deliberate exception: an operator explicitly creates a
mailbox-bound API key (an explicit, human-created pre-authorization), and sends made with that key
happen without a per-message confirm step. The key itself is the authorization boundary — possession
of the pre-authorized credential is what permits the send. Test-environment keys
(`environment=test`) are rejected in the production send path, and the key can only send to its own
mailbox with its bound sender, template allowlist, recipient policy, and quota. This does not weaken
the UI/Telegram/MCP confirmation gate. API-key administration is reachable over MCP
(`manage_api_key`, scope `keys:write`: create / rotate / scopes need owner approval on the web page; `revoke` and `templates` apply directly) but the secret never reaches the agent.

### MCP: agents, scopes and approvals

`/mcp` is a stateless MCP server (spec 2026-07-28, with a legacy 2025-era path) authenticated by
Better Auth OAuth 2.1 tokens (protected-resource metadata, PKCE); the owner gate still applies
after the token. The design and its decision log are in `docs/plans/mcp-v2.md` ("2026-11-14 final
permission model").

**Model in one paragraph.** Connection is one URL plus a browser login. Authority is split into
narrow `resource:action` scopes the owner ticks at consent; `tools/list` only shows tools the token
can call. Server-side human approval is reserved for the few actions that are irreversible or
exfiltrate data. Everything else applies directly, with a before-snapshot so `restore` can undo it.

**Rationale and sources.**
- *Narrow scopes, no omnibus `admin`.* The MCP authorization spec (2025-11-25) and its security
  best practices call a catch-all scope an anti-pattern (a leaked or over-granted token gets
  everything) and define the `insufficient_scope` challenge for a call that needs more. We follow
  both: a call missing a scope gets HTTP 403 `insufficient_scope` naming the exact scope, and
  `tools/list` is filtered (the GitHub / Sentry MCP pattern).
- *Human confirmation only where it matters.* Stripe's MCP server keeps human confirmation for a
  short list of irreversible actions rather than every write; approving everything trains the owner
  to click through. We require it for sends, secret issuance, suppression removal, domain changes
  and external forwarding.
- *Why mail is the dangerous input.* Simon Willison's "lethal trifecta" (access to private data +
  exposure to untrusted content + a way to exfiltrate) and OWASP LLM01 (prompt injection) describe
  an agent that reads inbound mail and can also send or forward. The approval list is exactly the
  set of exfiltration / irreversible actions; mail-reading scopes are separate and opt-in.

- **Scopes** (`src/lib/mcp-scopes.ts`):

  | Scope | Grants | Default consent |
  |---|---|---|
  | `mail:read` | list / search / read (sensitive content redacted) | yes |
  | `mail:read:sensitive` | un-redacted OTP / reset / magic-link content, raw MIME and attachments of such mail | no, explicit tick |
  | `mail:draft` | create / update / cancel drafts, read/unread, archive, trash | yes |
  | `mail:send` | request a send (still needs approval) | no, explicit tick |
  | `config:read` | `get_health`, `list_ops`, `list_config` | yes |
  | `mailboxes:write` | create / update / disable mailboxes | no |
  | `templates:write` | upsert / archive templates | no |
  | `routing:write` | aliases and routing rules | no, explicit tick |
  | `domains:write` | add / provision / update / disable domains | no, explicit tick |
  | `keys:write` | API keys; `reconcile_stale` | no, explicit tick |
  | `suppressions:write` | remove a suppression | no |

  The consent page strips any high-risk scope (`mail:send`, `mail:read:sensitive`, `keys:write`,
  `routing:write`, `domains:write`) the owner did not tick, server-side. A token with the retired
  `admin` scope no longer matches any tool: re-consent. `restore` is visible with any write scope
  and requires the write scope of the snapshot's own resource.
- **Approval required (any token).** `send`; an alias or forward / routing rule whose destination is
  outside the owner's domains (also when `restore` would bring one back); `api_key_create`,
  `api_key_rotate`, `api_key_scopes` (they issue a secret); `suppression_remove`; `domain_add`,
  `domain_provision`, `domain_disable`. The tool creates an intent in `approvals` (`origin='mcp'`)
  and returns a URL (`input_required` URL-mode elicitation on 2026 clients; `{status:"pending",
  intentId, confirmUrl}` on legacy clients, which re-call the tool with `intentId`).
- **Applied directly (with its scope).** Templates, `api_key_templates` (a key's template
  allow-list), `api_key_revoke`, mailbox kinds, internal aliases and rules, `domain_update`,
  `restore`, `reconcile_stale`, `update_messages`. Each keeps an `admin.before_snapshot` + ops
  event, returns `{status:"applied", result, snapshotIds}` to the agent, and is undoable with
  `restore`. Deletes are soft (`disabled` / `revoked`). One operation per call; there are no batches.
  **Owner-registry changes (`owner_identities`, bootstrap emails, pairing) are never exposed over
  MCP**; they stay CLI/web only.
- **How approval works.** The intent stores a frozen payload and `payload_hash`; a send uses the
  snapshot, never the live draft, and editing the draft afterwards yields `intent_stale`. Intents
  expire after 10 minutes, are single use, and their status rows are kept 30 days. The owner
  approves **only** at `https://<host>/approve/:id`: it requires a Better Auth owner session (never
  pre-authenticated), renders only server-side content (no agent-authored text), checks `Origin`,
  and posts the payload hash back with the decision. Template bodies are shown in full (HTML as
  escaped source, linked hosts, warnings for external or unsafe links, a diff), plus API-key
  recipient policy, template allow-list and DMARC `rua` targets; a registry safety net appends any
  payload field a kind did not render. **Telegram only sends a notice with the link for these
  critical requests, with no ✅/❌ buttons, and sends no notices for direct changes.** The agent can
  never approve: it holds no web session. Intents record the requesting OAuth client / token
  `sub` / `jti`; only that principal can read an intent's status and only the same owner can
  approve it. At most 5 live pending MCP intents per token subject; Telegram notices are
  coalesced to one per minute. Audit fields (`intent_id`, `payload_hash`, OAuth `client_id`, token
  `sub`/`jti`, `approved_via`) land in `outbound_sends` and `ops_events`.
- **Secrets never reach the agent.** `api_key_create` / rotate / `api_key_scopes` show the secret
  once, in the owner's approve response on the approval page; only the redacted result is stored in
  `result_json` and tool results strip `secret|token|plaintext`.
- **Sticky draft origin.** A draft saved over MCP is permanently `origin='mcp'`; the web and
  Telegram confirm paths refuse it (`approval_required`, fail closed). The mailbox DO sends it only
  with an HMAC approval proof (`mcp-approval.v1`, 60 s, signed with `BETTER_AUTH_SECRET`) minted by
  the approval. Human-authored sends (reply typed in Telegram, composed in the web UI) keep the
  existing confirm flow: approval protects against the agent, not against the owner.
- **Instance authentication mail is never visible to agents.** Sign-in and other
  authentication mail sent by this instance carries an `X-Reccado-Auth` HMAC marker; a message
  with a valid marker **or** from this instance's auth sender is classified `instance_auth` (at
  ingest, and by sender at read time for older rows) and is omitted from every MCP tool, search
  match and resource, whatever the scopes, including `mail:read:sensitive`. Without this, an
  owner address hosted on the instance would let an agent with sensitive scope read login codes
  and open its own owner web session, which can approve.
- **Sensitive-mail redaction.** At ingest, OTP / password-reset / magic-link / verification mail is
  flagged (`messages.sensitive_kind`). `read_message` / `read_thread` redact codes and links unless
  the token holds `mail:read:sensitive`. Email bodies are labelled untrusted content in tool
  descriptions and results. Attachments and raw MIME are MCP resources re-checked (owner, scope)
  per read, capped at 5 MB, and audited. Codes with spaces or hyphens, alphanumeric codes near
  keywords and token-bearing links are redacted; search without `mail:read:sensitive` does not
  match inside sensitive bodies; unclassified or parse-failed messages need
  `mail:read:sensitive` for raw access (fail closed). Agents can update or cancel only drafts
  they created (`origin='mcp'`).
- **Host allow-list and framing.** `/mcp` accepts only localhost, the deployment's own origin and
  hosts listed in `MCP_ALLOWED_HOSTS`. Every HTML response carries `frame-ancestors 'none'` and
  `X-Frame-Options: DENY`; `/approve/*` also sends `Referrer-Policy: no-referrer`.
- **Client registration.** *CIMD preferred:* the client's `client_id` is an https URL to a Client ID
  Metadata Document (spec 2025-11-25 SHOULD; the 2026-07-28 spec deprecates DCR). It is **on**
  (`MCP_CIMD_ENABLED=true`) and runs on a Workers-native guarded fetch transport (https only, no IP
  literals / local names / own zone, no redirects, size and timeout limits), a documented deviation
  because `@better-auth/cimd` wants DNS/address pinning Workers `fetch` cannot provide. First-seen
  `client_id`s are logged to `ops_events`. *Open DCR stays as compatibility fallback:*
  `POST /api/auth/oauth2/register` accepts RFC 7591 requests **without a session**, so a stock
  client connects from just the server URL
  (`claude mcp add --transport http reccado https://<host>/mcp`). Registering grants nothing: no code
  or token until the owner logs in through the owner registry (e-mail OTP) **and** consents to that
  client and those scopes, and the high-risk scopes are never granted without their own tick.
  Registered clients are public PKCE clients; `client_credentials` is refused for unauthenticated
  registrations. Hardening: per-IP limit of 10 registrations/hour in D1 (holds across isolates);
  `redirect_uris` must be `https`, or `http` on loopback, with no credentials or fragment;
  `client_name` has control/bidi characters stripped and is capped at 100 characters; the hourly
  cron deletes clients with no consent or token older than 24 h; every registration writes an
  `mcp.client_registered` ops event; the first consent of a client raises a Telegram notice. The
  consent page shows client name, redirect host and a "Cliente nuevo" note.
  `pnpm operator mcp register` remains as an optional pre-registration fallback.
- **Revoking a client.** The owner opens `/settings/agent-access` → *Connected agents* and revokes, or
  runs `pnpm operator mcp revoke <client_id>`: access tokens, refresh tokens, consent and
  registration are deleted. Access JWTs already issued stay valid until they expire (≤ 3600 s), so
  revocation is not instant.

Accepted residual risk (honest list):

- **A prompt-injected agent holding `templates:write` can change template text directly.** The
  change is reversible (`restore` from the before-snapshot, each change audited) but not gated by a
  click, and a template is sent to real recipients by transactional keys. Accepted for a single
  owner; do not grant `templates:write` to a client you would not trust with that, and prefer
  keeping it off agents that also hold `mail:read`.
- **Approval relies on the owner web session.** There is no passkey / WebAuthn step (owner decision):
  theft of the owner session cookie, or control of the owner's inbox login (e-mail OTP), lets an
  attacker approve. Keep the owner address's mailbox protected and the device trusted.
- The model can leak mail it legitimately read (non-sensitive) through other tools or servers.
- A native client's localhost OAuth redirect can be intercepted by a local process.
- A convincing client name can still phish a consent click; the owner must check the redirect host.
- Compromise of the owner's device defeats approval.
- Direct writes (`mail:draft` actions such as trash, `mailboxes:write`, internal routing,
  `api_key_revoke`, ...) are unconfirmed, though recoverable through soft deletes and `restore`.

Known limits:

- A worker interruption in the middle of an approved intent leaves it approved without a final
  report and is not retried automatically; the operator reconciles it from `result_json` /
  `ops_events`.
- `api_key_scopes` issues a replacement key and revokes the old one (there is no in-place scope
  patch), so the key id and secret change. The template allow-list is the exception:
  `manage_api_key` action `templates` edits it in place (add/remove/set; same key id and secret).
- Archived templates cannot be restored (`restore_unsupported`); domains and mailbox-less routing
  rules are gated by owner role only (no per-row owner).
- `reconcile_stale` reports an approximate D1 count and never resends.

### Transactional API keys (HMAC + pepper)

Transactional API keys are formatted `rck_<environment>_<key-id>_<random-secret>` (256-bit random
secret). The plaintext key is shown once at creation and never stored: the Durable Object persists
`HMAC-SHA256(pepper, keyId + ":" + secret)` bound to the server-side `TRANSACTIONAL_API_KEY_PEPPER`
Worker secret, and verification runs a constant-time comparison. Without the pepper all
transactional key operations and the send/status endpoints fail closed (`503`).

- Keys are mailbox-scoped and sender-scoped, with scopes
  (`transactional:send`, `transactional:status`, `transactional:templates:use`), a template
  allowlist (null/empty = no template may be sent), a recipient policy (glob patterns,
  `!`-prefix deny rules take precedence), an optional per-key daily quota, and expiration.
- Key management (create, list, revoke, rotate) lives under `/api/mailboxes/:mailboxId/transactional/*`
  behind the Better Auth session perimeter **and** an explicit mailbox-ownership check (`owner_email` on the D1
  mailbox row).
- All authorization, quota, and idempotency decisions are made in the mailbox Durable Object. D1
  (`transactional_api_keys`, `transactional_request_log`) is only a rebuildable, non-authoritative
  projection that never carries the key hash, plaintext, or request bodies/variables.

### Transactional endpoint hardening

The external endpoint (`POST`/`GET /v1/mailboxes/:mailboxId/transactional/...`) is the only path
outside the `/api/*` session perimeter and authenticates via the API key `Bearer` header:

- JSON-only content type on POST, body size limited to 100 KB (by `content-length`), responses carry
  `Cache-Control: no-store`.
- No CORS (`Access-Control-Allow-Origin` is never emitted), no cookie-based auth, and the key is
  never accepted from a query string.
- `Idempotency-Key` (max 255 chars) is mandatory; the same key + same payload hash returns the
  original result, and the same key + different payload returns `409`. The request row is reserved
  atomically (with quota charged) at status `pending` *before* the provider call.
- Provider failures are classified into `permanent_failure` (definitely not delivered) or `unknown`
  (ambiguous). `unknown` is never auto-retried. Raw provider error messages are **never** stored or
  logged — only stable error categories.
- Ops events and D1 projections redact: Authorization header/plaintext key, idempotency key, request
  body, variables, payload hash, and raw provider errors. Recipient addresses and template ids are
  treated as mailbox metadata and appear only where the existing inbox-surface model already
  exposes them (mailbox Durable Object; D1 request-log projection).
- The status endpoint (`GET .../messages/:requestId`) requires a valid key with
  `transactional:status` and binds the request to the same key and mailbox.

### Delivery events and suppression

Cloudflare Email Sending lifecycle events are consumed through a Queue event subscription. The
mailbox Durable Object validates the provider message ID, sender, recipient, and event ID before
applying the event. Hard bounces and complaints create local suppressions; deferred, soft-bounce,
and delivery-failure events update delivery state without suppressing. Suppressed recipients are
blocked before transactional dispatch. Cloudflare's account suppression list remains upstream
authoritative, and provider-originated local suppressions require an explicit override to remove.
Event logs omit subjects, bodies, SMTP responses, provider reasons, variables, and credentials.

Transactional send outcomes marked `unknown` remain manual-review-required. The stale-request
reconciliation helper is wired to the hourly cron and an auth-protected operator endpoint.

### Secrets

`BETTER_AUTH_SECRET` (the issuer's signing key; rotating it signs out every session),
`OWNER_BOOTSTRAP_EMAILS` (the master key into the owner registry), `CLOUDFLARE_API_TOKEN`,
`PHASE0_DEBUG_TOKEN`, `TRANSACTIONAL_API_KEY_PEPPER`, and `TELEGRAM_BOT_TOKEN` are Cloudflare
Worker secrets (`wrangler secret put`), never committed to the repository. `.dev.vars*` is
gitignored except `.dev.vars.example`, which documents names and placeholder values only.
`TRANSACTIONAL_API_KEY_PEPPER` is the HMAC key that hashes transactional API key material: rotating
it breaks every existing transactional key (re-issue keys after a rotation).

Mailbox IDs are **not** derived from a secret. Each `mailbox_id` is 16 random bytes assigned by the
`INSERT` that creates the mailbox row, with D1 (`UNIQUE(primary_address)`) as the only source of
truth; nothing recomputes an ID offline, so no key rotation can invalidate mailbox identity.

The Telegram webhook secret is derived, never configured: it is
`HMAC-SHA256(TELEGRAM_BOT_TOKEN, "reccado:telegram:webhook-secret:v1")`, recomputed on demand by
the only two code paths that need it (webhook verification and webhook registration). It is
deliberately not persisted in D1 — it is what stops a forged update from sending mail as the
operator, and the allowlist such an update would have to satisfy is itself a D1 row, so storing it
there would let a single database read escalate from reading mail to sending it. Rotating
`TELEGRAM_BOT_TOKEN` rotates the webhook secret with it, and the hourly cron re-registers the
webhook.

## Supply-chain posture

### Dependency update cadence

This repository uses GitHub Dependabot for two update streams:

- `npm` dependencies in the workspace root.
- `github-actions` versions used by CI.

Both are scheduled weekly. That is the default maintenance cadence, not a promise that every PR
will be auto-merged unchanged. Review is still required, especially for packages or Actions that
touch build, deploy, auth, or parsing paths.

### Local and CI verification

The baseline verification for dependency changes is the same local checkpoint used for regular
code changes:

- `pnpm run lint`
- `pnpm run typecheck`
- `pnpm test`
- `pnpm run build`
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run`

CI also starts the local dev server and performs a minimal HTTP smoke against `/api/health` and
`/` so dependency churn has to survive more than static compilation.

### Secret scanning

CI runs a repository secret scan on every push and pull request. That is meant to catch
accidental credential commits before release, but it is not a substitute for scoping and rotating
real secrets correctly.

For GitHub-hosted copies of this repo, enable GitHub Secret Scanning and Push Protection when the
plan/account supports them. For self-hosted mirrors or other forge platforms, use an equivalent
pre-receive or CI secret-scanning control.

### GitHub Actions permissions

The CI workflow declares repository-level read-only `contents` permission by default and does not
grant write scopes for build/test jobs. If you add workflows later, keep permissions explicit and
job-scoped, and only widen them for a concrete need such as release publishing.

### Auditing and manual review expectations

Automated updates and scans reduce drift, but they do not prove a dependency is safe. Self-hosters
should still:

- review dependency and GitHub Actions update PRs before merging;
- prefer pinned major versions and avoid unreviewed action swaps;
- run `pnpm audit` or an equivalent advisory review as part of release preparation;
- verify Cloudflare/Wrangler/Auth changes against current upstream documentation before a real
  production deploy;
- keep branch protection, CODEOWNERS/reviewer rules, and repository secret-scanning settings in
  the Git hosting platform, since those controls are account/repo policy rather than application
  code.

## Supported versions

Reccado is pre-1.0 and self-hosted: there is one actively maintained line (`main`). Security fixes
land on `main` and are noted under `## [Unreleased]` or the next version in
[`CHANGELOG.md`](CHANGELOG.md). There is no long-term-support branch yet — self-hosters are
expected to track `main` (or tagged releases once they exist) rather than pin to an old commit
indefinitely.

## Reporting a vulnerability

Please report security issues privately rather than opening a public GitHub issue:

- Preferred: use **GitHub Security Advisories** for this repository
  (`https://github.com/santigamo/reccado/security/advisories/new`) to open a private report.
- If that's unavailable to you, contact the maintainer directly (see the GitHub profile linked
  from commit history) and avoid including exploit details in a public channel until a fix is
  available.

Please include: the affected component (e.g. "session verification", "attachment serving",
"inbound size handling"), reproduction steps or a proof of concept, and the impact you believe it
has. Given this is a single-maintainer self-hosted project, response times are best-effort, not
SLA-backed — but security reports get priority over feature work.
