# Operations

Current-state operating reference for a running Reccado instance: what each binding/secret does,
how to decide a deploy is safe, what to do when something breaks, and what data exists today. For
setup/deploy steps, see the [README Deploy guide](../README.md#deploy-your-own) and
[`SKILL.md`](../SKILL.md). For the design constraints behind these procedures, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Operational contract

- The mailbox Durable Object is the canonical mailbox state. D1 is a rebuildable control-plane and
  cross-mailbox index, not the source of truth. This extends to transactional state: API keys,
  quotas, idempotency, and transactional request records are DO-authoritative; D1 holds only
  non-authoritative projections.
- Queue payloads stay metadata-only. Raw MIME, parsed HTML bodies that spill out of SQLite, and
  attachments live in R2.
- Inbound processing must remain idempotent across Email Routing retries, Queue retries, and any
  manual replay.
- Outbound sending from the UI, Telegram, and the MCP endpoint still requires explicit human
  confirmation through `request-send` then `confirm-send`; there is no fully automated send path on
  those surfaces. The transactional API is the one deliberate exception: an operator-created,
  mailbox-bound API key is an explicit pre-authorization, and sends made with it skip the
  per-message confirm step (see `SECURITY.md`).
- This runbook documents what exists now. Where restore, replay, retention enforcement, or alerting
  automation is not implemented, that is called out explicitly rather than implied.

## Env vars, secrets, and bindings

### Secrets and vars

| Name | Kind | Purpose | Required? |
| --- | --- | --- | --- |
| `ACCESS_JWT_AUDIENCE` | secret | Cloudflare Access application `aud` tag; validates the `CF-Access-JWT-Assertion` header on every request. Auth fails closed outside `localhost` if unset. | **Required** (non-local) |
| `ACCESS_TEAM_DOMAIN` | secret | Zero Trust team domain (`https://<team>.cloudflareaccess.com`) used to fetch the Access JWKS. | **Required** (non-local) |
| `ACCESS_ALLOWED_EMAILS` | secret | Bootstrap for the D1 owner registry (`owner_identities`); the two are unioned. Both empty = auth fails closed (`503`), never open. | Optional once an owner is registered |
| `CLOUDFLARE_API_TOKEN` | secret | Least-privilege token for admin provisioning workflows (zone read, Email Routing write, Access app/policy write). | Optional |
| `TRANSACTIONAL_API_KEY_PEPPER` | secret | HMAC-SHA256 pepper for transactional API key hashing. Without it, transactional key operations and the `/v1/.../transactional/...` send/status endpoints fail closed (`503`). Rotation invalidates every existing transactional key. | **Required** to enable the transactional API |
| `PHASE0_DEBUG_TOKEN` | secret | Gates `/api/debug/phase0/*` introspection endpoints. Unset = endpoints unreachable. | Optional |
| `MAIL_FROM_ADDRESS` | var (`wrangler.jsonc` → `vars`) | Default outbound sender; must be verified on a domain onboarded to Email Sending. | **Required** |
| `MAIL_SENDING_DOMAINS` | var | Comma-separated domains verified in Email Sending. A mailbox on a listed domain replies as itself; otherwise the reply goes out as `MAIL_FROM_ADDRESS` with `Reply-To` set to the mailbox. | Optional |
| `TELEGRAM_BOT_TOKEN` | secret | Enables the Telegram bridge. Unset = `/telegram/webhook` answers 404 and no notifications are sent. | Optional |
| `TELEGRAM_ALLOWED_USER_IDS` | var | Bootstrap only, unioned with the Telegram identities in `owner_identities`. The normal path is pairing: while no operator is linked the hourly cron mints a single-use code, you read it from D1 and send `/start <code>`. The bridge no longer refuses to start without this — it could not, since answering `/start` is how anyone gets linked. | Optional |

### Bindings (`wrangler.jsonc`)

| Binding | Type | Resource (maintainer dev example) | Purpose |
| --- | --- | --- | --- |
| `MAILBOX_DO` | Durable Object, class `MailboxDurableObject`, SQLite storage | n/a (per-mailbox instances) | Canonical mailbox state: messages, threads, FTS, drafts, outbox, idempotency, realtime sessions. |
| `MAIL_OBJECTS` | R2 bucket | `inbox-mcp-raw-dev` | Raw inbound MIME, parsed HTML bodies, attachments, backup manifests. |
| `INBOUND_EMAIL_QUEUE` | Queue producer + consumer | `inbox-mcp-inbound-dev` (DLQ: `inbox-mcp-inbound-dlq-dev`) | Metadata-only inbound transport; `max_batch_size: 5`, `max_batch_timeout: 2`, `max_retries: 3`. |
| `EMAIL_EVENTS_QUEUE` | Queue producer + consumer | `inbox-mcp-email-events-dev` (DLQ: `inbox-mcp-email-events-dlq-dev`) | Cloudflare Email Sending lifecycle events (delivered/deferred/bounced/complained); `max_batch_size: 10`, `max_batch_timeout: 2`, `max_retries: 3`. |
| `NOTIFY_QUEUE` | Queue producer + consumer | `inbox-mcp-notify-dev` (DLQ: `inbox-mcp-notify-dlq-dev`) | Telegram push cards, off the ingest ack path so a Telegram outage never blocks or retries ingest; `max_batch_size: 5`, `max_batch_timeout: 1`, `max_retries: 5`. |
| `INDEX_DB` | D1 database | `inbox-mcp-index-dev` | Cross-mailbox/control-plane index (see data model below). |
| `EMAIL` | Email Sending (`send_email`) | n/a | Outbound `env.EMAIL.send()`, only after `confirm-send` (UI/Telegram/MCP) or a validated transactional API-key send. |
| `triggers.crons` | Cron Trigger | `0 * * * *` (hourly, maintainer dev) | Backup sweep + stale `outbound_sends` and transactional-request reconciliation + expired Telegram action sweep + Telegram webhook reconciliation (re-registers the webhook when Telegram's registered URL has drifted from this deployment's origin). |

Replace maintainer example names with your own. The verifier and migration commands are now
parameterized; self-hosters should pass their resource names by env vars/CLI args rather than
editing the repository.

## Transactional API (current state)

The transactional API is implemented on top of the Tier A mailbox core. It is an
explicit, operator-created pre-authorization exception to the normal human-confirmed send path;
the UI, Telegram, and MCP surfaces still require `request-send` → `confirm-send`.

### Surface

- `POST /v1/mailboxes/:mailboxId/transactional/messages` — send; body
  `{ "template": "<id>", "to": "<addr>", "variables": {...} }`; requires `Authorization: Bearer
  <api-key>` and `Idempotency-Key` (mandatory).
- `GET /v1/mailboxes/:mailboxId/transactional/messages/:requestId` — request status; key must carry
  `transactional:status`.
- `/api/mailboxes/:mailboxId/transactional/api-keys` (create/list) and
  `.../api-keys/:keyId/revoke`, `.../rotate` — Access-protected with an explicit mailbox-ownership
  check (D1 `mailboxes.owner_email`).
- `/api/mailboxes/:mailboxId/transactional/templates` (create/list) and
  `.../templates/:templateId/archive` — versioned per-mailbox templates; Access-protected with
  ownership check.

### Key format and auth

Keys are `rck_<env>_<key-id>_<secret>` (`env` ∈ `test|live`); the plaintext secret (256-bit) is
shown once at creation. Only the keyed hash
`HMAC-SHA256(TRANSACTIONAL_API_KEY_PEPPER, keyId + ":" + secret)` is stored in the mailbox DO;
keys carry scopes, a template allowlist (null/empty = nothing sendable), a recipient policy,
optional daily quota, and optional expiry. All auth decisions are DO-authoritative — D1 is never
consulted for authorization, quota, or idempotency.

### Guarantees and current limits

- Same `(key, Idempotency-Key)` + same payload → original result; different payload → `409`.
  The request row is inserted (and quota charged) at `pending` before the provider call.
- Test keys (`environment=test`) are rejected in the production send path with
  `test_key_not_allowed_in_production_send`. Test keys work for create/list/revoke/rotate only;
  there is no simulated/test delivery sink.
- Provider outcomes: `sent`, `permanent_failure` (definitely not delivered), `unknown`
  (ambiguous — never auto-retried), `accepted` (pending), `rejected`, `idempotency_conflict`,
  `duplicate`. Raw provider error messages are never stored.
- D1 projections (`transactional_api_keys`, `transactional_request_log`) are rebuildable and
  redact the key hash, plaintext, request body, variables, payload hash, and idempotency key.
- Cloudflare Email Sending lifecycle events are consumed through the
  `inbox-mcp-email-events` Queue. Hard bounces and complaints create a mailbox-DO suppression;
  suppressed recipients are rejected before quota reservation or provider dispatch. Soft
  bounces and deferred events update delivery state without suppressing. Cloudflare's own
  account suppression list remains upstream authoritative; the DO list is the local
  application-enforcement mirror and is never automatically unsuppressed.
- Configure one Email Sending event subscription per sending domain in Cloudflare Dashboard:
  **Queues → `inbox-mcp-email-events` → Subscriptions → Subscribe to events → Email Sending**;
  select the sending domain and `message.delivered`, `message.deferred`, `message.bounced`,
  `message.rejected`, `message.complained`, and `message.failed`. Repeat for the dev queue and
  dev sending domain. The currently installed Wrangler CLI does not yet expose
  `email.sending` in `queues subscription create`, so do not use its generic command with an
  unsupported source. The event queue has a configured DLQ; unresolved or invalid events are
  retried rather than silently acknowledged.
- Owner-gated suppression administration is available at
  `/api/mailboxes/:mailboxId/suppressions` and
  `/api/mailboxes/:mailboxId/suppressions/remove`. Provider-originated
  hard-bounce/complaint entries require explicit override to remove.
- The `/v1/...` routes are the only path outside the Access perimeter: JSON-only, 100 KB body cap,
  `Cache-Control: no-store`, no CORS, no cookies, no query-param credentials.

## Readiness before a deploy

Treat a deployment as ready only when all of these are true:

1. `pnpm run build`, `pnpm exec tsc --noEmit`, and `pnpm test -- --run` pass on the revision you
   intend to deploy.
2. D1 migrations for the target environment have been applied successfully.
3. `pnpm verify:cf` passes against the target environment's actual Worker/resource names, or you
   have manually run the equivalent checks with the same level of evidence.
4. An unauthenticated request to the target route returns a Cloudflare Access redirect or block,
   not a `200`.
5. An authenticated operator can reach `/api/health` and one mailbox read path.
6. For any change touching inbound/outbound mail, you have run the relevant smoke path
   (`pnpm smoke:email:local`, `pnpm smoke:ws`, or an authenticated dev/prod smoke) and captured the
   result.

Current limitation: there is no automated readiness endpoint that proves R2, Queue, D1, Email
Sending, and Access end-to-end in one call. Readiness is still an operator checklist plus evidence.

## Deployment and rollback

### Standard deploy

1. Apply D1 migrations for the target environment.
2. Deploy with the environment-specific command:
   - `pnpm run deploy:dev`
   - `pnpm run deploy`
3. Verify Access, `/api/health`, and at least one mailbox/API path.
4. Tail logs and Cloudflare dashboards for the first inbound message and the next cron window if
   the change touched ingest, indexing, or scheduled work.

### Rollback

Use rollback when the newly deployed revision breaks availability, auth, ingest, send, or causes
unexpected data mutation.

1. Stop further exposure:
   - if the issue is auth or data safety, disable the public route / tighten Access before anything
     else;
   - if the issue is inbound processing, consider disabling or redirecting the Email Routing rule
     only if continuing to accept traffic would be worse than delaying receipt.
2. Roll the Worker back to the last known-good deployment from Cloudflare:
   - dashboard: Workers & Pages → your Worker → Deployments → promote the last known-good version;
   - CLI alternative: use Wrangler's deployment rollback/promote flow for your account's current
     version of Wrangler if you already use it operationally.
3. Re-verify Access, `/api/health`, and one mailbox/API path on the rolled-back revision.
4. If the bad deploy included D1 schema changes, do not assume schema rollback is automatic:
   - additive/widening migrations are expected to be rollback-tolerant;
   - destructive/narrowing migrations need an explicit migration plan and backup/restore evidence
     before deploy.
5. Reindex affected mailboxes from the Durable Object if the failure left D1 inconsistent:
   - `POST /api/admin/reindex`
6. Review `ops_events`, Queue backlog/DLQ, and any `outbound_sends.status='sending'` rows after the
   rollback to find work left half-finished by the failed revision.

Current limitation: there is no one-command application rollback plus data repair workflow in this
repo. Worker rollback, route changes, and any D1 repair are still operator-driven.

## SLOs, metrics, and alerting expectations

This repo does not provision alerting resources for you. Self-hosters need to wire alerts in
Cloudflare dashboards or their own observability stack. The minimum expectations for a
production-like deployment are:

### Suggested SLO targets

| Area | Target | Notes |
| --- | --- | --- |
| API availability | 99.9% successful authenticated `/api/health` and mailbox reads over 30d | Access misconfiguration that bypasses auth is a severity-1 security failure even if availability looks good. |
| Inbound ingest durability | 0 dropped accepted messages | Duplicate delivery is acceptable; silent loss is not. |
| Inbound ingest latency | 99% indexed/visible within 5 minutes of Email Routing acceptance | During D1 incidents, the Durable Object may be current before the cross-mailbox D1 index catches up. |
| Outbound send safety | 0 sends without explicit confirmation; 0 duplicate sends for one idempotency key | Review stale `sending` reconciliations manually. |
| Scheduled backup sweep | 100% of expected hourly cron runs produce either backup evidence or an investigated failure | Backup manifests are not a full mailbox restore solution by themselves. |

### Minimum metrics to watch

- Worker request errors and latency.
- Queue backlog depth, consumer failures, retry count, and DLQ message count.
- D1 errors / failed queries during ingest, reindex, and admin operations.
- R2 put/get failures for raw MIME, attachments, and backup manifests.
- Access-protected route behavior for unauthenticated and authenticated health checks.
- Count of `ops_events` for parse failures, routing rejects/forwards, backup failures, and stale
  outbound-send reconciliation.

### Minimum alerts to wire

- Queue backlog above your normal envelope for more than one retry window.
- DLQ count greater than zero.
- Any unauthenticated `200` on a protected route.
- Hourly cron/backup sweep not observed within the expected window.
- Sustained D1 or R2 write failures.
- Any unexpected rise in `parse_status='failed'` or `outbound_sends.status='failed'`.

Current limitation: the product records useful events in D1, but does not ship pager rules,
email/webhook alerts, or Cloudflare Alert Policies.

## What lives where

### R2 (`MAIL_OBJECTS`) — blob storage

- Raw inbound MIME: `raw/{env}/{mailboxId}/{yyyy}/{mm}/{dd}/{receivedAtMs}-{rawSha256}.eml`
- Parsed HTML bodies too large for SQLite: `body/{env}/{mailboxId}/{messageLocalId}/html.html`
- Attachments: `attachments/{env}/{mailboxId}/{messageLocalId}/{attachmentSha256}-{safeFilename}`
- Backup manifests: `backups/{env}/{yyyy-mm-dd}/{mailboxId}.manifest.json`
- Sent message bodies: `sent/{draftId}`
- Future/export path reserved in the implementation docs: `exports/{env}/{mailboxId}/{yyyy-mm-dd}/{exportId}.ndjson`

### Mailbox Durable Object SQLite — source of truth

Tables (see `src/do/mailbox-schema-content.ts`): `schema_migrations`, `mailbox_meta`,
`ingest_events`, `threads`, `messages`, `message_headers`, `attachments`, `labels`,
`message_labels`, `contacts`, `rules`, `outbound_drafts`, `jobs`, `realtime_events`, plus the
`message_fts` FTS5 virtual table. Transactional state also lives here: `api_keys`, `api_key_events`,
`api_key_usage` (per-minute rate and daily quota counters), `templates`, and
`transactional_requests` (with the `(key_id, client_idempotency_key)` unique idempotency index and
`mailbox_meta` send markers).

### D1 (`INDEX_DB`) — rebuildable index and ops log

- Provisioning/routing catalog: `domains`, `mailboxes`, `aliases`, `routing_rules`
- Cross-mailbox message summary: `message_index`
- Ingest audit mirror: `ingest_events`
- Outbound send audit: `outbound_sends` (UI/Telegram/MCP confirm-send ledger)
- Transactional projections: `transactional_api_keys`, `transactional_request_log` (keys/requests;
  redacted; non-authoritative)
- Operational log: `ops_events`

If D1 and the Durable Object disagree, the Durable Object wins. Repair D1 with
`POST /api/admin/reindex`.

## Data lifecycle, retention, privacy, and current limitations

### What is retained today

- Raw inbound MIME is retained in R2 until an operator deletes it or an R2 lifecycle rule removes
  it.
- Attachments and oversized HTML bodies are retained in R2 on the same basis.
- Backup manifests written by cron or `POST /api/admin/backups/run` are retained in R2 until an
  operator or lifecycle rule deletes them.
- Mailbox metadata, message rows, search index entries, drafts, and send audit rows remain in the
  mailbox Durable Object / D1 until explicit deletion logic is implemented and exercised.

### What is not automated today

- No repo-managed R2 lifecycle policy is provisioned or enforced for raw MIME, attachments, sent
  bodies, or backup manifests.
- No full mailbox restore command exists.
- No user-facing export job exists, although the architecture and implementation docs reserve an
  export format/path.
- No end-user delete workflow guarantees removal of all raw MIME, attachment blobs, D1 rows, and
  backup artifacts for a mailbox.
- No documented trash-retention timer or legal-hold model exists.

### Operator policy you need to decide explicitly

Before claiming a production-ready deployment, set and document your own values for:

- raw MIME retention window;
- attachment retention window;
- backup-manifest retention window;
- whether sent bodies in R2 follow the same or a shorter retention period;
- who can perform mailbox export and deletion, and how those requests are audited.

Recommended current posture until full deletion/export tooling exists: keep retention conservative,
apply explicit R2 lifecycle rules in your Cloudflare account, and document that mailbox deletion or
privacy erasure is currently a manual operator procedure that must include DO state, D1 rows, and
all related R2 prefixes.

### Manual delete/export/restore reality

- **Export:** there is no supported full-fidelity mailbox export command today. `export-index`
  exists only as an internal Durable Object path used for reindex/backup manifests, not as a
  customer-ready archive/export feature.
- **Restore:** there is no automated restore path from R2 backup manifests back into Durable
  Objects. Backup manifests are operational evidence and partial recovery material, not a turnkey
  disaster-recovery workflow.
- **Delete:** mailbox erasure is manual. If you perform it, you must identify and remove the DO
  state plus the corresponding D1 rows and R2 prefixes, and you should capture evidence of exactly
  what was deleted.

## Failure modes and runbook

| Symptom | Cause | Response |
| --- | --- | --- |
| Queue backlog growing | Mailbox DO errors on ingest, or D1 index writes failing | Check Queue metrics, tail Worker logs, inspect recent `ops_events`, and determine whether data is blocked in the Queue or only the D1 index is behind. |
| DLQ non-empty | Poison messages or repeated transient failures | Follow the DLQ procedure below. Do not replay blindly. |
| R2 write failure inside `email()` | Transient R2 issue while writing raw MIME | The handler must not enqueue without a successful raw R2 write. Let Email Routing retry/reject rather than creating partial state. |
| D1 unavailable | D1 outage or quota exhaustion | The mailbox Durable Object remains authoritative. Restore D1 service, then reindex affected mailboxes. |
| Durable Object parse failure | MIME parser error on malformed/unusual message | Message row remains with `parse_status='failed'` and the raw R2 key preserved. Review the failure in `ops_events`. |
| Outbound send failure | Provider rejection, size/recipient-limit violation, or crash mid-send | Inspect `outbound_sends.status`, `error_code`, and provider response context. Retry only after deciding whether the same idempotency key still represents the same logical send. |
| `outbound_sends` row stuck at `status='sending'` | Crash/interruption mid-send | The hourly cron sweep marks stale sends `unknown` with `error_code='stale_sending_timeout_needs_review'` and an `outbound_send.stale_reconciled` ops event. Treat that as manual-review-required, not proof the message did or did not send. |
| Transactional request stuck at `pending` | Crash mid-send in the transactional path | `reconcileStaleTransactionalRequests` exists in the DO (marks rows `unknown` / `stale_reconciled`) but is not yet wired to cron or an endpoint. Until then, resolve manually after reviewing `transactional_request_log` / DO state and the provider console. |
| Transactional send returns `unknown` | Provider outcome is ambiguous (may have accepted before erroring) | Not auto-retried by design. Treat as manual-review-required; never re-send blindly with the same idempotency key. |
| Access misconfiguration | Route exposed without proper Access enforcement | Treat as a security incident. Block public access first, then fix Access and re-verify with an unauthenticated request. |
| Telegram bot token set but no cards ever arrive | The bridge is configured but not yet delivering: no chat adopted (nobody sent `/start` from an allowlisted account) and/or the worker has not observed its public origin yet, so the hourly `reconcileTelegramWebhook` skips registration | `GET /api/health` → `dependencies.telegram` reports `mode: "partial"` and `missing` names exactly which of the two it is waiting for. Load the authenticated UI once on the real hostname (the origin is only recorded from a request that cleared Access), send `/start` from an allowlisted account, then let the next hourly cron register the webhook. |
| Telegram webhook receives nothing | Cloudflare Access is intercepting `/telegram/webhook` | Telegram cannot present an Access JWT, so updates are redirected to the login page. Add an Access **Bypass** policy for that path only. Confirm with `getWebhookInfo` — `last_error_message` shows what Telegram received. |
| `telegram.topic_unavailable` in `ops_events` | `createForumTopic` was refused for this chat | Usually the bot lacks `can_manage_topics` in the supergroup. The bridge already fell back to plain messages and replies still work by quoting the notification, so this is degradation, not breakage. Grant the permission, or leave it — a plain chat is a supported mode, not a misconfiguration. |
| `telegram.topic_recreated` in `ops_events` | The mailbox's topic was deleted in Telegram | Self-healing: the stale mapping was dropped, the topic recreated and the card re-sent once. Repeated rows for the same mailbox mean someone is deleting topics faster than mail arrives. |
| `telegram.notify_failed` in `ops_events` | Telegram API error or rate limit while pushing a card | The mail is already ingested and safe — only the notification was lost. Telegram allows roughly one message per second per chat; a burst of mail is the usual cause. |
| Need to rotate a secret | Routine hygiene or suspected leak | Rotate with `wrangler secret put`. Rotating `TELEGRAM_BOT_TOKEN` also rotates the derived webhook secret, so the hourly cron re-registers the webhook on its next run; rotating `TRANSACTIONAL_API_KEY_PEPPER` invalidates every existing transactional key. Mailbox IDs are random rows in D1 and depend on no secret. |
| Local large-MIME smoke fails around 1 MiB | Local Email Routing tooling limit | Expected local behavior; use a smaller fixture for local smoke and do not infer a production 25 MiB failure from it. |

## Dead-letter queues

Every queue in this Worker has a dead-letter queue, and every dead-letter queue has a consumer:
`src/cloudflare/dlq-consumer.ts` writes one `ops_events` row per dead message
(`event_type='dlq.dead_letter'`, `severity='error'`, `subject` = the queue message id, payload
`{ queue, attempts, body }`) and acks. Before that consumer existed a message that exhausted its
retries simply expired with the Queues retention window and left no trace anywhere an operator
would look. The tombstone is the trace.

Two properties are deliberate:

- **No automatic redelivery.** A DLQ consumer that re-enqueues resurrects exactly the loop the DLQ
  exists to end. Replay is a human decision, made after the cause is fixed.
- **The DLQ consumers have no DLQ of their own.** If D1 is down the tombstone write is retried
  (never acked — a death cannot be recorded in a ledger that is down), and once the retries are
  spent the message is lost. That is the honest end of the chain; another hop would only move the
  silence further away.

Duplicate tombstones are possible: if an ack is lost after the insert lands, the message is
redelivered and the row is written twice. Harmless, and not worth a read per dead message to
prevent.

### What a dead message means, per queue

| Queue | A dead message means | Replay stance |
| --- | --- | --- |
| `inbox-mcp-inbound` (→ `-dlq`) | An accepted email whose raw MIME is in R2 but which is not indexed in the DO or D1: invisible mail. The most serious of the three. | Recoverable but manual. The raw object is intact and the message carries a stable idempotency key, so a re-ingest updates rather than duplicates — but there is no replay endpoint, so it is a deliberate operator action after the cause is fixed. |
| `inbox-mcp-email-events` (→ `-dlq`) | A lost Email Sending lifecycle event: a delivery/bounce/complaint that never updated `outbound_sends` or the DO suppression list. Local state now disagrees with the provider. | Do not replay stale events blindly — a bounce replayed out of order can suppress a recipient on obsolete information. Cloudflare's account suppression list is upstream authoritative; reconcile against the provider console instead. |
| `inbox-mcp-notify` (→ `-dlq`) | A Telegram card that never arrived. The mail itself is ingested and safe; only the push was lost. | Usually no replay: a late notification about mail already visible in the UI has little value. Fix the bridge (token, allowlist, chat adoption) and let the next message prove it. |

## Replay procedure

Current limitation first: there is no implemented `POST /api/admin/dlq/replay` endpoint. Replay is
still a manual Cloudflare operation plus an operator validation pass.

1. Inspect the symptom:
   - check Queue/DLQ counts in Cloudflare;
   - query `ops_events` for `event_type='dlq.dead_letter'` (via `GET /api/admin/ops-events`) — the
     rows carry the queue, attempt count and payload of every dead message;
   - inspect `GET /api/admin/dlq` and recent Worker logs.
2. Classify the failure:
   - poison/schema bug;
   - transient dependency failure (D1/R2/provider);
   - auth/config error;
   - malformed but acceptable email that should remain `parse_status='failed'`.
3. Fix the underlying cause before replaying anything.
4. Confirm replay safety, using the per-queue stance above:
   - verify the affected messages already have stable idempotency keys;
   - verify a successful replay would update existing records rather than create duplicate message
     rows.
5. Replay from the Cloudflare Queue/DLQ tooling you operate with today.
6. Validate the result:
   - the message becomes visible or the intended failure state is recorded;
   - no duplicate `messages` row was created;
   - `message_index` is correct, or you run `POST /api/admin/reindex`;
   - `ops_events` reflects the recovery.

If you cannot prove replay safety, do not replay. Keep the payload for investigation and treat the
issue as unresolved.

## Admin/ops endpoints

All require an authenticated, authorized Access identity:

- `GET /api/admin/ops-events` — recent operational events (rejections, forwards, conflicts,
  backups, reindexes, stale-send reconciliations, transactional request outcomes).
- `GET /api/admin/dlq` — recent ingest failures recorded in D1. This is not a direct Cloudflare
  DLQ browser.
- `POST /api/admin/reindex` — rebuild a mailbox's `message_index` rows in D1 from Durable Object
  state.
- `POST /api/admin/backups/run` — trigger the same backup-manifest export path used by the hourly
  cron sweep.

Transactional key management (create/list/revoke/rotate) and template CRUD are
`/api/mailboxes/:mailboxId/transactional/*` routes behind the same Access perimeter plus a
`mailboxes.owner_email` ownership check; the external send/status endpoints are
`/v1/mailboxes/:mailboxId/transactional/*` and use API-key auth instead.

## Evidence expectations for ops changes

When you change deployment, alerting, retention, auth, routing, DLQ handling, or backup behavior,
record at least:

- exact commands run;
- Worker name / URL / route tested;
- D1/R2/Queue/DLQ resource names and IDs touched;
- authenticated and unauthenticated health-check results;
- any mailbox IDs or test addresses used;
- queue backlog/DLQ before and after, if relevant;
- reindex/backup event evidence from `ops_events`, if relevant;
- explicit `PASS` or `FAIL`, with blockers called out exactly.
