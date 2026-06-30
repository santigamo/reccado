# Security Policy

## Security model

Reccado is designed as a **single-operator, self-hosted** inbox (v0). Each install lives entirely
in one Cloudflare account; there is no multi-tenant SaaS deployment of this codebase. The
security model reflects that scope — it is not yet hardened for "many untrusted users sharing one
deployment."

### Auth perimeter: Cloudflare Access

Reccado has no built-in login system. **Cloudflare Access is the auth perimeter** for the UI and
every `/api/*` route. The Worker validates the `CF-Access-JWT-Assertion` header against your
Access application's audience (`ACCESS_JWT_AUDIENCE`) and your Zero Trust team's JWKS
(`ACCESS_TEAM_DOMAIN`). If those two values are not configured, the Worker **fails closed**:
requests from any hostname other than `localhost`/`127.0.0.1`/`::1` are rejected outright rather
than falling back to an open or trust-the-client mode. Local dev (`localhost`) intentionally
bypasses Access so you can develop without a Cloudflare account.

On top of Access, an optional `ACCESS_ALLOWED_EMAILS` owner allowlist (comma-separated emails)
restricts which Access-authenticated identities are actually treated as authorized — useful if
your Cloudflare Access organization includes people who shouldn't see this particular mailbox.
Without it, **every** identity that passes your Access policy is treated as the single operator;
this is intentional default behavior for true single-user installs, but you should set
`ACCESS_ALLOWED_EMAILS` if your Access org is broader than "just me."

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
the deployed Worker's own origin before processing, as a CSRF defense layered on top of Access.
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
mailbox state). There is no separate, application-level encryption layer on top of that — this is
an explicit trade-off, not an oversight. It means:

- Anyone with sufficient access to your Cloudflare account (account owner, or a token with broad
  R2/D1/Durable Objects scopes) can read mailbox contents directly, bypassing the app's Access
  layer entirely. Scope Cloudflare API tokens narrowly and treat account-level access as
  equivalent to mailbox access.
- There is currently no per-mailbox or per-message application-level encryption, no
  envelope-encryption scheme, and no support for bring-your-own-key. If your threat model
  requires protecting mail content from someone with Cloudflare account access, this product does
  not yet meet that bar.

### Outbound sending requires human confirmation

Outbound mail always goes through an explicit `request-send` → `confirm-send` flow gated by an
idempotency key; there is no code path (UI, API, or — once it exists — MCP/agent) that sends mail
from a single unconfirmed call. This is treated as a hard invariant; see `AGENTS.md` and
`docs/ARCHITECTURE.md`.

### Secrets

`MAILBOX_ID_SECRET`, `ACCESS_JWT_AUDIENCE`, `ACCESS_TEAM_DOMAIN`, `ACCESS_ALLOWED_EMAILS`,
`CLOUDFLARE_API_TOKEN`, and `PHASE0_DEBUG_TOKEN` are Cloudflare Worker secrets (`wrangler secret
put`), never committed to the repository. `.dev.vars*` is gitignored except `.dev.vars.example`,
which documents names and placeholder values only. Never rotate `MAILBOX_ID_SECRET` after go-live
without a mailbox-ID migration plan — it's the HMAC key every mailbox ID is derived from, and
rotating it changes every mailbox ID in the system.

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

Please include: the affected component (e.g. "Access JWT validation", "attachment serving",
"inbound size handling"), reproduction steps or a proof of concept, and the impact you believe it
has. Given this is a single-maintainer self-hosted project, response times are best-effort, not
SLA-backed — but security reports get priority over feature work.
