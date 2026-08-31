# Changelog

All notable changes to Reccado are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project
does not yet follow Semantic Versioning strictly (pre-1.0, self-hosted, no published package) —
version numbers here track meaningful release checkpoints of the self-hosted app, not an npm
package.

## [Unreleased]

Security hardening and public-readiness pass on top of the Phase 1 Tier A inbox, plus the
transactional API (Phases 2–4 of the `docs/plans/transactional-api.md` plan) and the MCP
read/search/draft endpoint.

### Fixed

- **A failed transactional send no longer answers `200`.** `permanent_failure` and `unknown` were
  returned with HTTP 200 and the failure only in the JSON body, so the obvious integration — throw
  on non-2xx — reported an undelivered message as sent. Nothing undelivered is 2xx any more:
  `permanent_failure` → `502`, `unknown` → `504` (distinguishable without parsing the body, because
  they call for different handling), `accepted` → `202`, and `quota_exceeded` → `429` rather than a
  `403` that gave the caller no reason to retry. The mapping lives in one tested function,
  `httpStatusForTransactionalResult`, instead of a conditional at the response site. **Breaking for
  any existing client**, of which there are none — the transactional API has never been called in
  production.

- **Transactional variables are no longer retained after the send.** `variables_json` was written to
  the mailbox Durable Object before the provider call and never removed, so every verification link,
  password reset and invitation URL a caller passed accumulated indefinitely as live credentials.
  Terminal states now null the column, as does the stale-request reconciler; `payload_hash` and
  status remain, so idempotent replay and conflict detection are unaffected. D1 projections never
  carried the values.

- **Suppressions expire when the reason does.** `addSuppression` always wrote `expires_at` as
  `null`, so the column existed and was honoured at read time but was never populated — a hard
  bounce poisoned an address permanently, with an owner-gated removal as the only way back. Hard
  bounces now expire after 90 days; complaints, manual and provider-rejected entries stay permanent.
  The distinction is the point: a hard bounce is a fact about a mailbox at a moment in time and
  mailboxes come back, while a complaint is a statement of intent by a person and intent does not
  lapse on a schedule.

### Added

- **Telegram: one forum topic per mailbox, not per email thread.** When the bound chat is a
  supergroup with forum mode, each mailbox gets a topic named after the mailbox. Previously a
  topic was created per email thread, named with the email's subject — which let anyone who sent
  mail write the permanent labels in the operator's Telegram sidebar, and tied topic creation to
  unbounded inbound volume. Forum support is now detected via `getChat` at `/start` and cached in
  `runtime_config`, replacing the `TELEGRAM_TOPICS` flag (removed). Replies resolve only through
  `reply_to_message`: a topic now holds many conversations, so "the newest card in this topic"
  would answer the wrong email. A deleted topic self-heals — the stale mapping is dropped, the
  topic recreated, and the card re-sent once.

- **Control-plane API reaches parity with the CLI.** `PATCH` and `DELETE` on mailboxes, domains,
  aliases and routing rules, and `POST /api/mailboxes` now creates the alias for its own primary
  address when the domain is registered. Delete is soft where other rows or stored data depend on
  the identity (mailboxes, domains) and hard where the row is pure configuration (aliases, routing
  rules). See `docs/IMPLEMENTATION.md` for the reasoning.

- **A disabled mailbox stops receiving mail.** `resolveRoutingForRecipient` now treats a mailbox's
  own status as authoritative over the alias and routing rows that point at it, rejecting with
  `mailbox_disabled`. Previously a disabled mailbox kept accepting mail, which would have made
  `DELETE /api/mailboxes/:id` a lie, and a fall-through to the domain catch-all would have quietly
  diverted someone's mail into a different mailbox.

- **Cloudflare Email Sending lifecycle integration.** Email Sending event subscriptions feed the
  `inbox-mcp-email-events` Queue. Delivery, deferred, bounce, rejection, complaint, and failure
  events update canonical transactional delivery state; hard bounces and complaints create
  mailbox-DO suppressions that block future sends. Events are idempotent and unresolved/poison
  messages retry to the configured DLQ.

- **Transactional API (Phase 2 — MVP).** External REST API at `/v1/mailboxes/:id/transactional/messages`
  for programmatic outbound sending with:
  - HMAC-authenticated API keys (`rck_<env>_<id>_<secret>`) with scopes
    (`transactional:send`, `transactional:status`, `transactional:templates:use`),
    per-key quotas and rate limits, template allowlists, and recipient policies.
  - API key management (create, list, revoke, rotate) via the DO's internal routes.
  - DO-authoritative auth and state — D1 is only a rebuildable projection.
  - Atomic idempotency via `(key_id, client_idempotency_key)` with payload hash verification.
    Same payload returns original result; different payload returns `409 Conflict`.
    Request record is inserted BEFORE the provider call at status `pending`.
  - Template CRUD (create, list, archive) per mailbox, with variable interpolation
    (HTML-escaped for `body_html`, literal for text), variable validation (missing/unknown),
    and subject CR/LF rejection.
  - Provider outcome classification: `sent`, `permanent_failure` (definitely not delivered),
    `unknown` (ambiguous — preserved for human review, never auto-retried).
  - Status endpoint (`GET /v1/mailboxes/:id/transactional/messages/:requestId`)
    scoped to `transactional:status`.
  - Quota enforcement with atomic per-key minute and daily counters in the DO
    (no D1 dependency for quota decisions).
  - Rejection: missing/invalid auth, expired/revoked keys, wrong mailbox, insufficient scope,
    missing template, template not allowlisted, missing/unknown variables, CR/LF in subject,
    quota exceeded, recipient policy deny, test keys in production send path.
  - Security: `Cache-Control: no-store` on all responses, JSON-only content-type check,
    body size limit (100 KB), no CORS, no Access dependency, no Reply-To/headers from client.
  - `TRANSACTIONAL_API_KEY_PEPPER` secret required to enable transactional features.
  - Test keys (`environment=test`) are rejected in the production send path — they must not
    silently send real email without a test/simulation sink.
  - Provider error messages are NEVER stored; only stable error categories
    (`ambiguous`, `permanent_failure`) are persisted.

### Added

- **Telegram bridge (optional, off by default).** Inbound mail is pushed to a Telegram chat as a
  preview card (sender, subject, snippet — never the full body, which would put 2FA codes into a
  cloud chat), and replying to that card drafts an email reply. The reply still goes through the
  existing draft → request-send → confirm-send flow, now surfaced as inline ✅/✖️ buttons, and
  through the same send path as the web UI. Threading resolves via `reply_to_message`, or via one
  forum topic per email thread when `TELEGRAM_TOPICS=1`. The webhook lives outside the `/api/*`
  perimeter (Telegram can present neither an Access JWT nor an `Origin` header) and authenticates
  with a constant-time secret-token check plus a Telegram user allowlist; the bridge refuses to
  start half-configured. See the README for the Cloudflare Access bypass this requires.
- `MAIL_SENDING_DOMAINS`: mailboxes on a domain verified in Cloudflare Email Sending now reply as
  themselves instead of as the single global `MAIL_FROM_ADDRESS`.
- The Telegram webhook registers itself: the hourly cron (`reconcileTelegramWebhook`) compares
  what Telegram believes against this deployment's origin and re-registers on drift. The worker
  learns that origin by observing a request that already cleared Cloudflare Access, and the
  webhook secret is an HMAC of the bot token, so no URL and no secret is ever configured by hand.
- The bot adopts its chat on the first `/start` from an allowlisted user and stores it in D1
  (`runtime_config`), first writer wins. `/start` now also answers *unauthorized* users with
  their own user id, so a first-time operator can learn the id they need for
  `TELEGRAM_ALLOWED_USER_IDS` instead of getting silence.
- **MCP endpoint (`/mcp`) — read/search/draft only.** Access-authenticated (requires
  `ACCESS_ALLOWED_EMAILS`, fails closed with `503` when unset). Exposes `list_mailboxes`,
  `list_threads`, `search_messages`, `read_message`, and `draft_reply`; there is deliberately no
  send/cancel tool (`src/mcp/*`, with a closed-operation `McpMailboxFacade` and a security test
  asserting no send path is reachable). `pnpm setup:mcp-claim` backfills `mailboxes.owner_email`
  for pre-existing mailboxes so MCP can serve them.

### Known limitations

- Telegram replies go to the original sender only (no reply-all) and are sent from the mailbox's
  primary address even when the mail arrived at an alias.
- Attachments cannot be sent from Telegram.
- `request-send` now refuses to move a `sent` or `cancelled` draft back to `pending_confirmation`,
  so a retried Telegram update can no longer resurrect mail that already went out.

### Known limitations (transactional API)

- Cloudflare Email Sending event subscriptions must be configured separately for each sending
  domain; Wrangler queue bindings alone do not create the subscription. Cloudflare's account
  suppression list remains upstream authoritative; Reccado's DO suppression list is a local
  enforcement mirror and does not automatically unsuppress recipients.
- Test keys (`environment=test`) are rejected in the production send path. A simulated/test sink
  for test-mode delivery does not exist yet; test keys only work for creation/listing/revocation
  operations.
- Stale transactional-request reconciliation remains manual-review-oriented: it flips stuck
  `pending`/`sending` rows to `unknown` and never retries delivery automatically.

### Removed

Configuration surface that the system can decide for itself, deleted rather than deprecated. Every
one of these was a value a human had to invent, store and keep in sync, and every one of them had a
failure mode where the deployment looked configured and silently did nothing.

- **`MAILBOX_ID_SECRET` (worker secret).** Mailbox ids are no longer an HMAC of the primary
  address: they are 16 random bytes assigned by the `INSERT` that creates the row
  (`INSERT ... ON CONFLICT(primary_address) DO NOTHING` + re-read), with D1 as the only source of
  truth. Nothing at runtime ever recomputed an id — ingest resolves the mailbox by D1 lookup — so
  the secret only bought offline recomputation at the price of making one write-only value part of
  the identity of every mailbox. The id format (`mbx_` + 26 base32url chars) is unchanged, so
  existing rows, R2 keys and Durable Object names stay valid and no migration is required. Gone
  with it: `wrangler secret put MAILBOX_ID_SECRET`, `setup:cloud --reset-secret`,
  `setup:mailbox --secret`, the `mailboxSecretFingerprint` field in `.reccado/setup.<env>.json`
  (the manifest keeps every other field), the `devvars.mailbox-secret`, `cloud.secret.mailbox` and
  `cloud.mailbox-secret-recovery` doctor checks, and the whole "orphaned secret" / "rotating the
  secret invalidates every derived mailbox id" class of failure, which can no longer occur.
- **`TELEGRAM_WEBHOOK_SECRET` (worker secret).** Derived instead of configured:
  `HMAC-SHA256(TELEGRAM_BOT_TOKEN, "reccado:telegram:webhook-secret:v1")` (`deriveWebhookSecret`,
  `src/telegram/api.ts`). The only two parties that need this value are the worker and Telegram,
  so asking a human to invent one, store it as a secret and re-supply it to a script was three
  manual steps for a number with no human meaning — and the step everyone forgot, which is how the
  bridge stayed dead in production without a word. It is deliberately not persisted in D1: it is
  what stops a forged update from sending mail, and the allowlist such an update must satisfy is
  itself a D1 row. Rotating the bot token now rotates it automatically.
- **`TELEGRAM_CHAT_ID` (var).** Auto-adopted instead of declared: the first `/start` from an
  allowlisted user writes the chat to `runtime_config` in D1, first writer wins — a later `/start`
  from another chat does not move the binding, and the bot says so. The value always arrived inside
  the update, so the old flow had the bot print the chat id and ask the human to copy it into a
  config file and redeploy: the system observing a value, telling a human, and asking that human to
  tell it back.
- **`scripts/setup-telegram.ts` / `pnpm setup:telegram`.** Replaced by the hourly cron
  reconciliation (`reconcileTelegramWebhook`, `src/telegram/registration.ts`). Telegram onboarding
  is now: create the bot and set `TELEGRAM_BOT_TOKEN`, put your user id in
  `TELEGRAM_ALLOWED_USER_IDS`, deploy, load the authenticated UI once (that is how the worker
  learns its own public origin — only ever from a request that cleared Access, because the `Host`
  header is forgeable and that value decides where Telegram delivers), then send `/start`.
  `GET /api/health` reports `dependencies.telegram` with `mode: off | partial | on` and a `missing`
  list, so a bridge that is not yet delivering says what it is waiting for.

The allowlist (`TELEGRAM_ALLOWED_USER_IDS`) stays configuration on purpose: declaring whom you
trust is not derivable, and whoever can drive the bot can send mail as the operator.

### Fixed

- **Outbound replies now thread.** `confirm-send` sent no `In-Reply-To`/`References`, so a reply
  appeared as a loose message in the recipient's client; and it minted a fresh thread id per send,
  so the reply also detached from its own conversation inside Reccado. Replies now reuse the
  draft's thread, carry the RFC 5322 reply headers, and upsert the thread row instead of inserting
  a duplicate.
- Sent messages now store the `Message-ID` Cloudflare assigned (it is a platform-controlled
  header — a caller-supplied one is rejected as restricted) in the mailbox and the D1 index.
  Without it, the answer to a reply matched nothing in `resolveThreadId` and forked a new thread on
  every round trip.
- Outbound thread subjects are normalized with `normalizeSubject` rather than a raw `toLowerCase`,
  so `Re:`-prefixed replies no longer defeat subject-based thread matching.
- A reply sent from a mailbox on an unverified domain now sets `Reply-To` to the mailbox address,
  so responses come back to the address the human wrote to.

### Security

- Debug endpoints (`/api/debug/phase0/*`) now fail closed: they are unreachable unless
  `PHASE0_DEBUG_TOKEN` is explicitly configured, and requests are compared against it in
  constant time. Previously, an unset token left these endpoints open.
- Attachment and raw-message downloads are now served with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, and a sandboxing Content-Security-Policy, preventing stored
  attachment content (including inbound HTML/script content) from executing in the browser
  origin.
- `seedDevData` (the dev-only `test@example.com` mailbox/domain/alias scaffolding) is no longer
  invoked implicitly from the production inbound email path; seeding now requires an explicit
  opt-in and is a no-op by default.
- Added an optional `ACCESS_ALLOWED_EMAILS` owner allowlist, enforced on top of Cloudflare
  Access, so a shared Access org doesn't implicitly grant every authenticated identity full
  mailbox access.
- Added an inbound email size cap (~25 MiB, matching Cloudflare's Email Routing inbound limit)
  enforced before the raw message is buffered/stored.
- Added baseline security response headers (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`) and an Origin-check CSRF defense on mutating
  `/api/*` routes.
- Added stale outbound-send reconciliation in the scheduled (Cron) handler: `outbound_sends` rows
  stuck in `sending` past a timeout are flipped to `unknown` with
  `error_code='stale_sending_timeout_needs_review'` and a clear `ops_events` trail instead of
  blocking idempotent retries indefinitely (manual review required).

### Tooling & docs

- Added `PRODUCTION-READINESS.md` to declare the current production claim honestly and record the
  remaining gaps that still keep Reccado at `READY-WITH-CAVEATS` rather than an unqualified
  production-ready status.
- Updated `docs/ARCHITECTURE.md` status language so it reflects the current repo state: Tier A and
  the minimal MCP read/search/draft endpoint are implemented, while the rest of Tier B
  (Workflows, EmailAgent drafting, RAG/Vectorize, AI Gateway) remains roadmap-only.
- Docs now reflect the actual state of the transactional API (Phases 2–4 of
  `docs/plans/transactional-api.md`): HMAC/pepper API keys, Access+owner-gated admin routes,
  versioned template CRUD, `POST/GET /v1/.../transactional/...` with Bearer +
  `Idempotency-Key` + scopes/limits/quota, test-key rejection for sending, `unknown` → no
  auto-retry, non-authoritative D1 projections, log redaction, no CORS/query/cookies, and the
  Cloudflare Email Sending event subscription setup and no simulated delivery sink for test keys.
  `SECURITY.md`, `README.md`, `docs/OPERATIONS.md`, `AGENTS.md`, and
  `PRODUCTION-READINESS.md` were updated; the MCP/UI/Telegram human-confirm gate is unchanged and
  Tier B (Workflows, EmailAgent, RAG) is not claimed as implemented.
- Added Biome for linting/formatting (`pnpm lint`, `pnpm format`, `pnpm format:check`) and a
  combined `pnpm check` (typecheck + lint + test) script; wired into CI alongside a Worker
  bundle dry-run deploy check and a check that generated artifacts
  (`worker-configuration.d.ts`, `src/routeTree.gen.ts`) are committed and up to date.
- Pinned a minimum Node engine (`>=22.12.0`) in `package.json`.
- Added a `d1:migrate:prod` script and split production D1/R2/Queue resource names from the `dev`
  environment's; the default (production) environment now sets `workers_dev: false` so it isn't
  reachable on the shared `*.workers.dev` subdomain.
- Restructured `README.md` into a full product README (features, architecture diagram,
  quickstart, deploy guide, configuration reference, compatibility, troubleshooting).
- Added `SECURITY.md`, `CONTRIBUTING.md`, `SKILL.md`, `CHANGELOG.md`, and `docs/OPERATIONS.md`.
- Split `AGENTS.md` into durable invariants vs. one-time build/process notes, and scrubbed
  maintainer-specific Cloudflare resource literals (D1 database ID, account/worker URLs) in favor
  of placeholders.
- Marked `docs/validation/PHASE0_VALIDATION.md` and `docs/validation/PHASE1_VALIDATION.md` as historical
  build-validation logs rather than current operating docs.
- Fixed a stale "Inbox MCP" UI string (the product was renamed to Reccado).

### Self-host setup hardening

- `setup:cloud` now checks the inbound queue's consumer before deploying and aborts with the exact
  `wrangler queues consumer remove <queue> <old-worker>` fix if a different Worker (e.g. left over
  from a rename) is still registered as its consumer, instead of letting deploy fail with a
  generic error.
- `setup:mailbox` resolves the domain row by name and reuses it instead of assuming a fresh insert,
  so reseeding an env with pre-existing (including foreign-key-owning) domain rows is idempotent
  rather than failing.
- `setup:routing` adds `--catch-all`, which configures `*@<domain> -> Worker` via Cloudflare's
  Email Routing REST API (`PUT .../rules/catch_all`) because Wrangler currently rejects that rule
  shape client-side even though the platform endpoint supports it.
- Added `setup:domain`: attaches a custom domain to a Worker env through a generated, gitignored
  Wrangler config (never edits the tracked `wrangler.jsonc`). Idempotent for the same Worker;
  refuses to reattach a hostname already claimed by a **different** Worker, checked up front via
  the Workers Custom Domains API when `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are available,
  falling back to an error-string guard around `wrangler deploy` otherwise.
- Added `setup:sending`: provisions a dedicated Cloudflare Email Sending subdomain (`send.<domain>`
  by default) and writes `MAIL_FROM_ADDRESS` + `allowed_sender_addresses` into the generated
  config. Prints a prominent Workers Paid preflight (arbitrary-recipient sending needs a paid plan;
  free-plan accounts are limited to verified destinations). DMARC defaults to `p=none` (monitor
  mode, relaxed alignment) as the start of a documented none → quarantine → reject ramp
  (`--dmarc-policy`, `--dmarc-alignment relaxed|strict`, `--dmarc-rua`). With
  `CLOUDFLARE_API_TOKEN` it also auto-adds the provider-generated DKIM + MX records (parsed from
  `wrangler email sending dns get`, an open-beta command with no `--json` mode) unless
  `--skip-provider-records` is passed; SPF and DMARC remain exclusively script-owned, so the
  provider's own suggested DMARC record (typically `p=reject`) is never applied.
- Aligned the `workers.dev` vs. custom-domain narrative across `doctor`, `setup:domain`, and
  `setup:access`: the `dev` environment keeps `workers_dev: true` only for local-to-cloud smoke
  tests, and Access verification is only ever treated as valid against a custom domain.

## [0.1.0] — Phase 1: Tier A inbox complete

Initial senior-validated milestone: a usable self-hosted inbox without any AI/agent layer.

### Added

- **Inbound hot path**: Cloudflare Email Routing → R2 (raw MIME) → Queue (metadata-only,
  &lt;128 KiB) → mailbox Durable Object, with idempotent ingest (Message-ID + raw-hash dedupe),
  Message-ID conflict detection, and a Dead Letter Queue for poison messages.
- **Mailbox Durable Object store**: one Durable Object (SQLite storage) per mailbox owns
  messages, threads, labels, contacts, drafts, outbox, idempotency records, and a SQLite FTS5
  full-text search index.
- **HTTP API + UI**: Hono API under `/api/*` and a TanStack Start inbox UI (mailbox list, thread
  view, message detail, search, raw view, attachments, compose).
- **Realtime**: hibernatable WebSocket connections (`/api/mailboxes/{mailboxId}/ws`) push new
  mail and state changes into open UI sessions without polling.
- **Human-confirmed outbound sending**: drafts go through an explicit
  `request-send` → `confirm-send` flow with an idempotency key before `env.EMAIL.send()` is
  called; sent messages are indexed and audited in D1 (`outbound_sends`).
- **Multi-domain routing**: per-domain store/forward/reject routing rules, with isolated
  mailboxes per address; validated against two real Cloudflare-managed domains.
- **Backup and ops**: scheduled (Cron) backup sweep writing per-mailbox manifests to R2, plus
  admin endpoints for ops events, DLQ inspection, and D1 reindexing from Durable Object state.
- **D1 control-plane index**: `domains`, `mailboxes`, `aliases`, `routing_rules`, `message_index`,
  `ingest_events`, `outbound_sends`, and `ops_events` — a rebuildable cross-mailbox index, not the
  source of truth (the mailbox Durable Object is).
- D1 migrations `migrations/d1/0001_initial.sql` and `migrations/d1/0002_message_index.sql`.

### Notes for self-hosters

- Schema/migration changes in this and future releases matter for anyone running their own
  instance: always run the `wrangler d1 migrations apply` step (`d1:migrate:local` /
  `d1:migrate:dev` package scripts) after pulling a release that touches `migrations/d1/`, and
  review new migrations before applying them to a database with real mail in it.
- Validated end-to-end against real Cloudflare resources in a `dev` environment; see
  `docs/validation/PHASE0_VALIDATION.md` and `docs/validation/PHASE1_VALIDATION.md` for the historical validation
  record (debug tokens, deployment names, and account identifiers in those files are the
  maintainer's own and have since been redacted/placeholder'd where they leaked into current
  docs).

[Unreleased]: https://github.com/santigamo/reccado/compare/main...HEAD
[0.1.0]: https://github.com/santigamo/reccado/releases/tag/v0.1.0
