# Operations

Current-state operating reference for a running Reccado instance: what each binding/secret does,
what to do when something breaks, and where data actually lives. For *how to deploy* one, see the
[README Deploy guide](../README.md#deploy-your-own) and [`SKILL.md`](../SKILL.md). For *why* the
system is shaped this way, see [`ARCHITECTURE.md`](ARCHITECTURE.md). For the full original
implementation spec (including things not summarized here), see
[`IMPLEMENTATION.md`](IMPLEMENTATION.md).

## Env vars, secrets, and bindings

### Secrets and vars

| Name | Kind | Purpose | Required? |
| --- | --- | --- | --- |
| `MAILBOX_ID_SECRET` | secret | HMAC key deriving stable, privacy-preserving mailbox IDs from canonical email addresses (`mbx_` + base32url(HMAC-SHA256)). Never rotate without a mailbox-ID migration plan. | **Required** |
| `ACCESS_JWT_AUDIENCE` | secret | Cloudflare Access application `aud` tag; validates the `CF-Access-JWT-Assertion` header on every request. Auth fails closed outside `localhost` if unset. | **Required** (non-local) |
| `ACCESS_TEAM_DOMAIN` | secret | Zero Trust team domain (`https://<team>.cloudflareaccess.com`) used to fetch the Access JWKS. | **Required** (non-local) |
| `ACCESS_ALLOWED_EMAILS` | secret | Comma-separated owner allowlist enforced on top of Access. Unset = every Access-authenticated identity is treated as the single operator. | Optional, recommended for shared Access orgs |
| `CLOUDFLARE_API_TOKEN` | secret | Least-privilege token for admin provisioning workflows (zone read, Email Routing write, Access app/policy write). | Optional |
| `PHASE0_DEBUG_TOKEN` | secret | Gates `/api/debug/phase0/*` introspection endpoints. Unset = endpoints unreachable. | Optional |
| `MAIL_FROM_ADDRESS` | var (`wrangler.jsonc` → `vars`) | Default outbound sender; must be verified on a domain onboarded to Email Sending. | **Required** |

### Bindings (`wrangler.jsonc`)

| Binding | Type | Resource (maintainer dev example) | Purpose |
| --- | --- | --- | --- |
| `MAILBOX_DO` | Durable Object, class `MailboxDurableObject`, SQLite storage | n/a (per-mailbox instances) | Canonical mailbox state: messages, threads, FTS, drafts, outbox, idempotency, realtime sessions. |
| `MAIL_OBJECTS` | R2 bucket | `inbox-mcp-raw-dev` | Raw inbound MIME, parsed HTML bodies, attachments, backup manifests. |
| `INBOUND_EMAIL_QUEUE` | Queue producer + consumer | `inbox-mcp-inbound-dev` (DLQ: `inbox-mcp-inbound-dlq-dev`) | Metadata-only inbound transport; `max_batch_size: 5`, `max_batch_timeout: 2`, `max_retries: 3`. |
| `INDEX_DB` | D1 database | `inbox-mcp-index-dev` | Cross-mailbox/control-plane index (see data model below). |
| `EMAIL` | Email Sending (`send_email`) | n/a | Outbound `env.EMAIL.send()`, only after `confirm-send`. |
| `triggers.crons` | Cron Trigger | `0 * * * *` (hourly, maintainer dev) | Backup sweep + stale outbound-send reconciliation (see below). |

Replace every maintainer-example resource name with your own; see
[README § Deploy your own](../README.md#deploy-your-own). The default (production) environment in
`wrangler.jsonc` uses its own resource names (no `-dev` suffix: `inbox-mcp-raw`,
`inbox-mcp-inbound`/`inbox-mcp-inbound-dlq`, `inbox-mcp-index`) and sets `workers_dev: false`, so a
production deploy is only reachable through a route/custom domain you configure — never on the
shared `*.workers.dev` subdomain. The `dev` environment (`reccado-dev`) keeps the
`*.workers.dev` behavior used throughout this document's examples.

## What lives where (data model summary)

Reccado deliberately splits state across three stores with different durability/consistency
properties. The mailbox Durable Object is authoritative; everything else is either a blob store or
a rebuildable index.

### R2 (`MAIL_OBJECTS`) — blob storage

- Raw inbound MIME (`raw/{env}/{mailboxId}/{yyyy}/{mm}/{dd}/{receivedAtMs}-{rawSha256}.eml`).
- Parsed HTML bodies too large for SQLite (`body/{env}/{mailboxId}/{messageLocalId}/html.html`).
- Attachments (`attachments/{env}/{mailboxId}/{messageLocalId}/{attachmentSha256}-{safeFilename}`).
- Backup manifests (`backups/{env}/{yyyy-mm-dd}/{mailboxId}.manifest.json`).
- Sent-message bodies, keyed under `sent/{draftId}`.

### Mailbox Durable Object SQLite (one instance per mailbox) — source of truth

Tables (see `src/do/mailbox-schema-content.ts`): `schema_migrations`, `mailbox_meta`,
`ingest_events`, `threads`, `messages`, `message_headers`, `attachments`, `labels`,
`message_labels`, `contacts`, `rules`, `outbound_drafts`, `jobs`, `realtime_events`, plus the
`message_fts` FTS5 virtual table (subject, sender, recipients, snippet, body_text). This is the
only place canonical mailbox state lives — D1 and R2 reference it, never replace it.

### D1 (`INDEX_DB`) — rebuildable cross-mailbox/control-plane index

Tables (see `migrations/d1/0001_initial.sql`, `migrations/d1/0002_message_index.sql`):

- `domains`, `mailboxes`, `aliases`, `routing_rules` — the provisioning/routing catalog (which
  domain/alias maps to which mailbox, and store/forward/reject rules per domain).
- `message_index` — thin cross-mailbox summary row per message (subject, from, snippet, state,
  R2 key/hash) used for cross-mailbox listing without hitting every Durable Object.
- `ingest_events` — D1-side mirror of inbound ingest attempts, keyed by idempotency key.
- `outbound_sends` — audit row per outbound send attempt: idempotency key, status
  (`pending_confirmation` → `sending` → `sent`/`failed`/`cancelled`), provider message ID.
- `ops_events` — operational log (rejections, forwards, conflicts, backups, reindexes, stale-send
  reconciliations).

If D1 ever diverges from a mailbox Durable Object, **the Durable Object wins** —
`POST /api/admin/reindex` rebuilds `message_index` for a mailbox from DO state.

## Failure modes and runbook

| Symptom | Cause | Response |
| --- | --- | --- |
| Queue backlog growing | Mailbox DO errors on ingest, or D1 index writes failing | Inspect Queues metrics, tail Worker logs, check DO errors. Pause inbound routing only if there's real data-loss risk. |
| DLQ non-empty | Poison messages (unsupported schema version) or repeated transient failures | Inspect `/api/admin/dlq`, classify poison vs. transient, fix the underlying issue, replay only after confirming idempotency keys make replay safe. |
| R2 write failure inside `email()` | Transient R2 issue during raw-MIME write | The handler must not enqueue without a successful raw R2 key — let Email Routing's own retry/reject behavior handle it rather than enqueueing partial state. |
| D1 unavailable | D1 outage or quota exhaustion | The mailbox Durable Object remains authoritative and keeps ingesting normally. Retry the D1 index write through the Queue; run `/api/admin/reindex` for affected mailboxes after recovery. |
| Durable Object parse failure | MIME parser error on a malformed/unusual message | Message row is kept with `parse_status='failed'` and the raw R2 key preserved — the email is never dropped. Check `/api/admin/ops-events` for the failure entry. |
| Outbound send failure | Provider rejection, recipient-limit violation, or a worker/DO crash mid-send | `outbound_sends.status` moves to `failed` with an `error_code`; the draft requires a manual retry decision (same idempotency key to retry the same logical send, new key for a deliberately new attempt). |
| `outbound_sends` row stuck at `status='sending'` | Worker/DO crashed or the call never returned mid-send (interrupted saga, not necessarily a duplicate send) | The hourly scheduled handler reconciles rows stuck in `sending` past a timeout: it flips them to `failed` with `error_code='stale_sending_timeout_needs_review'` and a `outbound_send.stale_reconciled` ops event, so idempotency checks aren't blocked indefinitely. Review reconciled rows manually — the provider send may or may not have actually gone out. |
| Access misconfiguration (API reachable without login) | Access app/policy missing or misconfigured | Treat as a security incident: block public access to the route first, then fix and re-verify the Access app/policy (unauthenticated request must `302` to your team's Access login) before reopening. |
| Need to rotate a secret | Routine credential hygiene, or suspected leak | Rotate `CLOUDFLARE_API_TOKEN`, `ACCESS_JWT_AUDIENCE`/`ACCESS_TEAM_DOMAIN`, `ACCESS_ALLOWED_EMAILS`, or `PHASE0_DEBUG_TOKEN` normally via `wrangler secret put`. **Do not** rotate `MAILBOX_ID_SECRET` without a mailbox-ID migration plan — it changes every derived mailbox ID. |
| Local large-MIME smoke fails around 1 MiB | Cloudflare's local Email Routing test path enforces a ~1 MiB limit, far below the 25 MiB production inbound limit | Expected local-tooling behavior; generate a smaller fixture for local smoke (`pnpm generate:large-mime`) and trust the 25 MiB production limit. |
| `wrangler deploy --env dev` deploys the wrong Worker name | The Cloudflare Vite plugin can redirect Wrangler to a generated config that drops the `--env`/name override | Always pass both flags explicitly: `pnpm wrangler deploy --env dev --name reccado-dev` (this is what `pnpm run deploy:dev` does). |

## Admin/ops endpoints

All require an authenticated, authorized Access identity (see `SECURITY.md`):

- `GET /api/admin/ops-events` — recent operational events (rejections, forwards, conflicts,
  backups, reindexes, stale-send reconciliations).
- `GET /api/admin/dlq` — lists recorded ingest failures from D1 (`ingest_events`/`ops_events`).
  Actual Cloudflare Queue DLQ message inspection/replay is a dashboard/`wrangler` operation today,
  not an in-app endpoint — `docs/IMPLEMENTATION.md` specs a `POST /api/admin/dlq/replay` endpoint
  for this, but it is not implemented yet.
- `POST /api/admin/reindex` — rebuild a mailbox's `message_index` row(s) in D1 from Durable Object
  state.
- `POST /api/admin/backups/run` — trigger the backup-manifest export on demand (the same work the
  hourly Cron sweep does).
