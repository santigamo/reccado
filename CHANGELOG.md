# Changelog

All notable changes to Reccado are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project
does not yet follow Semantic Versioning strictly (pre-1.0, self-hosted, no published package) —
version numbers here track meaningful release checkpoints of the self-hosted app, not an npm
package.

## [Unreleased]

Security hardening and public-readiness pass on top of the Phase 1 Tier A inbox.

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
  stuck in `sending` past a timeout are flipped to `failed` with a clear `ops_events` trail
  instead of blocking idempotent retries indefinitely.

### Tooling & docs

- Added `PRODUCTION-READINESS.md` to declare the current production claim honestly and record the
  remaining gaps that still keep Reccado at `READY-WITH-CAVEATS` rather than an unqualified
  production-ready status.
- Updated `docs/ARCHITECTURE.md` status language so it reflects the current repo state: Tier A is
  implemented, while Tier B agent/MCP/RAG capabilities remain roadmap items.
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
- Marked `docs/PHASE0_VALIDATION.md` and `docs/PHASE1_VALIDATION.md` as historical
  build-validation logs rather than current operating docs.
- Fixed a stale "Inbox MCP" UI string (the product was renamed to Reccado).

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
  `docs/PHASE0_VALIDATION.md` and `docs/PHASE1_VALIDATION.md` for the historical validation
  record (debug tokens, deployment names, and account identifiers in those files are the
  maintainer's own and have since been redacted/placeholder'd where they leaked into current
  docs).

[Unreleased]: https://github.com/santigamo/reccado/compare/main...HEAD
[0.1.0]: https://github.com/santigamo/reccado/releases/tag/v0.1.0
