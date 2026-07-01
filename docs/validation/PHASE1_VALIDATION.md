# Phase 1 Validation Evidence

> **Internal build-validation log — historical record, not current operating docs.** This file
> captures the evidence gathered while building and senior-validating Phase 1. Resource names,
> IDs, secrets, and commands below reflect the maintainer's environment at that point in time and
> may be stale — see [`README.md`](../../README.md), [`docs/OPERATIONS.md`](../OPERATIONS.md), and
> [`SECURITY.md`](../../SECURITY.md) for current, accurate operating guidance.

## Milestone 1.1 - Project Foundation

**Date:** 2026-06-30
**Result:** **MILESTONE 1.1 PASS**
**Senior sign-off:** PASS. Final scaffold, scripts, generated Worker types, strict TypeScript, build, and Workers Vitest harness are in place.

### Implementation

- Added official Workers Vitest pool via `@cloudflare/vitest-pool-workers`.
- Added `vitest.config.ts` with `cloudflareTest()` reading `wrangler.jsonc` `env.dev`.
- Added `tests/health.test.ts`, a Worker-style test that calls the default Worker entrypoint at `/api/health`.
- Kept `tsconfig.json` strict settings enabled and added `@cloudflare/vitest-pool-workers/types`.
- Changed `src/server.ts` to lazy-load the TanStack Start fallback so Worker tests can import the entrypoint without needing TanStack virtual route aliases for API-only tests.
- Cleaned existing strict TypeScript issues in Phase 0 helper code.

### Versions

```bash
node -v
# v24.15.0

pnpm -v
# 11.1.1

pnpm wrangler --version
# 4.105.0

pnpm exec vitest --version
# vitest/4.1.9 darwin-arm64 node-v24.15.0

pnpm exec tsc --version
# Version 6.0.3
```

### Validation gate

Install:

```bash
pnpm install
```

Output:

```
Already up to date
Done in 127ms using pnpm v11.1.1
```

Worker type generation:

```bash
pnpm wrangler types
```

Output excerpt:

```
Generating project types...
mainModule: typeof import("./src/server");
durableNamespaces: "MailboxDurableObject";
✨ Types written to worker-configuration.d.ts
```

Strict TypeScript:

```bash
pnpm exec tsc --noEmit
```

Output:

```
no output, exit 0
```

Build:

```bash
pnpm run build
```

Output excerpt:

```
✓ built in 197ms   (client)
✓ built in 140ms   (ssr)
dist/server/index.js  60.80 kB
```

Workers Vitest:

```bash
pnpm test -- --run
```

Output:

```
RUN  v4.1.9 ~/code/reccado

Test Files  1 passed (1)
Tests       1 passed (1)
```

### Milestone 1.1 result

**MILESTONE 1.1 PASS** — required scripts exist and run, generated Worker types are present, strict TypeScript passes, and the Workers Vitest pool can instantiate the Worker entrypoint and call the Hono health route.

## Milestone 1.2 - Cloudflare Resources

**Date:** 2026-06-30
**Result:** **MILESTONE 1.2 PASS**
**Senior sign-off:** PASS. Cloudflare resources, bindings, Cron, Email Sending, dry-run, deploy, and Cloudflare Access enforcement are validated.

### Implementation

- Added `EMAIL` Email Sending binding to `wrangler.jsonc`.
- Added hourly Cron trigger `0 * * * *` to `wrangler.jsonc`.
- Added no-op `scheduled()` handler that logs `scheduled.tick`.
- Added `.dev.vars.example` documenting required local secret names without committing real values.
- Added `scripts/verify-cloudflare-bindings.ts`.
- Added `pnpm verify:cf`.
- Removed leftover disposable R2 bucket `agentic-inbox` from Phase 0.4 cleanup.
- Created Cloudflare Access app and email allow policy for `reccado-dev.<your-subdomain>.workers.dev` via Zero Trust API.

### Verified resources

R2:

```
inbox-mcp-raw-dev
```

Queues:

```
inbox-mcp-inbound-dev      producers=1 consumers=1
inbox-mcp-inbound-dlq-dev  producers=0 consumers=0
```

D1:

```
inbox-mcp-index-dev
database_id: ca3b5109-17bf-4a6e-9943-9892c4e04dbc
```

Email Sending:

```
mail.example.com enabled yes
tag 9f30e907bdae49329826fd107d463167
return-path domain cf-bounce.mail.example.com
```

Email Routing:

```
test@example.com -> worker:reccado-dev
rule id: ed0c2b92a9e347348fafaa1f92848335
```

### Validation commands

Verifier:

```bash
pnpm verify:cf
```

Output:

```
{
  "ok": true,
  "worker": "reccado-dev",
  "resources": {
    "r2": "inbox-mcp-raw-dev",
    "queue": "inbox-mcp-inbound-dev",
    "dlq": "inbox-mcp-inbound-dlq-dev",
    "d1": "inbox-mcp-index-dev",
    "d1Id": "ca3b5109-17bf-4a6e-9943-9892c4e04dbc",
    "emailSendingDomain": "mail.example.com",
    "cron": ["0 * * * *"],
    "emailBinding": "EMAIL"
  }
}
```

Typegen:

```bash
pnpm wrangler types
```

Output excerpt:

```
EMAIL: SendEmail;
MAIL_OBJECTS: R2Bucket;
INDEX_DB: D1Database;
INBOUND_EMAIL_QUEUE: Queue;
MAILBOX_DO: DurableObjectNamespace<import("./src/server").MailboxDurableObject>;
```

Dry-run:

```bash
pnpm wrangler deploy --env dev --name reccado-dev --dry-run
```

Output excerpt:

```
Your Worker has access to the following bindings:
env.MAILBOX_DO (MailboxDurableObject)                Durable Object
env.EMAIL (unrestricted)                             Send Email
env.INBOUND_EMAIL_QUEUE (inbox-mcp-inbound-dev)      Queue
env.INDEX_DB (inbox-mcp-index-dev)                   D1 Database
env.MAIL_OBJECTS (inbox-mcp-raw-dev)                 R2 Bucket
--dry-run: exiting now.
```

Deploy:

```bash
pnpm run deploy:dev
```

Output:

```
Deployed reccado-dev triggers
https://reccado-dev.<your-subdomain>.workers.dev
schedule: 0 * * * *
Producer for inbox-mcp-inbound-dev
Consumer for inbox-mcp-inbound-dev
Current Version ID: 30951e1e-2e37-4106-b513-d1ee0e48bee4
```

### Access configuration

API token validation:

```bash
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN_ACCESS" \
  https://api.cloudflare.com/client/v4/user/tokens/verify
```

Sanitized output:

```
success: true
status: active
```

Existing Zero Trust org:

```
auth_domain: <your-team>.cloudflareaccess.com
```

Access application created:

```
name: reccado-dev - Cloudflare Workers
id: 76e6aa70-362c-4209-8caa-f6df1e744e11
domain: reccado-dev.<your-subdomain>.workers.dev
aud: 87bda8291601a78af9b4bc2e7143b18d9b4d2dedfcee7363ab53497a248c8eed
type: self_hosted
session_duration: 24h
```

Access policy created:

```
name: reccado-dev - Santi allow
id: 01c401e4-c6b5-4908-8fec-06e032e67036
decision: allow
include: email user@example.com
precedence: 1
```

A temporary service token and service policy were created only to validate non-interactive authorized access, then deleted:

```
policyDelete success: true
tokenDelete success: true
```

Final policy list contains only the Santi email allow policy.

### Access validation

Initial unauthenticated check before Access app creation:

Unauthenticated request:

```bash
curl -si https://reccado-dev.<your-subdomain>.workers.dev/api/health | sed -n '1,30p'
```

Output:

```
HTTP/2 200
server: cloudflare

{"ok":true}
```

This failed the Access part of the gate and triggered API setup.

Final unauthenticated check after Access app creation:

```bash
curl -si https://reccado-dev.<your-subdomain>.workers.dev/api/health | sed -n '1,18p'
```

Output excerpt:

```
HTTP/2 302
location: https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/reccado-dev.<your-subdomain>.workers.dev?kid=87bda8291601a78af9b4bc2e7143b18d9b4d2dedfcee7363ab53497a248c8eed...
www-authenticate: Cloudflare-Access resource_metadata="https://reccado-dev.<your-subdomain>.workers.dev/.well-known/cloudflare-access-protected-resource/api/health"
server: cloudflare
```

Temporary service-token authorized check:

```
GET /api/health with CF-Access-Client-ID and CF-Access-Client-Secret -> HTTP/2 200 {"ok":true}
```

The secret values and emitted `CF_Authorization` JWT were not committed to the repository.

### Milestone 1.2 result

**MILESTONE 1.2 PASS** — all required dev Cloudflare resources exist, `wrangler.jsonc` includes the required bindings and Cron trigger, `.dev.vars.example` documents secrets without committing real values, dry-run and deploy pass, and unauthenticated requests to the dev Worker are blocked by Cloudflare Access before reaching the Worker.

## Milestone 1.3 - Mailbox Identity And Provisioning

**Date:** 2026-06-30
**Result:** **MILESTONE 1.3 PASS (implementation)**
**Validation status:** **PARTIAL - full gate evidence pending**

### Implementation

- HMAC mailbox ID derivation in `src/lib/mailbox-id.ts` with `MAILBOX_ID_SECRET`.
- D1 migrations `migrations/d1/0001_initial.sql` and `migrations/d1/0002_message_index.sql`.
- D1 helpers in `src/db/d1.ts`.
- Access JWT validation in `src/api/auth.ts`, with dev bypass only when Access env vars are unset.
- Provisioning API in `src/api/hono.ts`: `/api/me`, `/api/mailboxes`, `/api/aliases`, `/api/domains`, `/api/routing-rules`.
- Dev seed in `src/db/seed-dev.ts` for `test@example.com` and `inbox@mail.example.com`.

### Validated in this checkpoint

```bash
pnpm install
pnpm wrangler --version
pnpm wrangler types --env dev
pnpm exec tsc --noEmit
pnpm test -- --run
pnpm run build
```

Output excerpts:

```
pnpm install -> Done in 1.6s using pnpm v11.1.1
pnpm wrangler --version -> 4.105.0
pnpm wrangler types --env dev -> Types written to worker-configuration.d.ts
pnpm exec tsc --noEmit -> exit 0
pnpm test -- --run -> Test Files 3 passed (3), Tests 4 passed (4)
pnpm run build -> client and ssr builds completed
```

### Pending validation

- Capture `pnpm d1:migrate:local` and `pnpm d1:migrate:dev` output for the current migrations.
- Capture D1 query evidence for seeded `domains`, `mailboxes`, `aliases`, and `routing_rules`.
- Exercise `/api/me`, mailbox, alias, domain, and routing-rule APIs with request/response examples.
- Validate production Access JWT behavior on dev, not only the local dev bypass.

### Milestone 1.3 result

**MILESTONE 1.3 PASS (implementation)** — HMAC mailbox IDs, D1 catalog schema, auth middleware, provisioning APIs, and dev seed are implemented. Full senior validation remains pending until the evidence above is captured.

## Milestone 1.4 - Inbound Hot Path

**Date:** 2026-06-30
**Result:** **MILESTONE 1.4 PASS (implementation)**
**Validation status:** **PARTIAL - full gate evidence pending**

### Implementation

- `src/cloudflare/email-handler.ts` resolves alias/routing from D1, rejects unmatched recipients, and supports store/forward/reject actions.
- `src/cloudflare/queue-consumer.ts` writes D1 `message_index` and `ingest_events` after DO ingest.
- Inbound idempotency keys and Message-ID conflict reporting are implemented.
- Poison-message handling records ops events and leaves terminal failures for DLQ behavior.
- `fixtures/queues/poison-message.json` added.

### Validated in this checkpoint

- Shared TypeScript, test, Worker typegen, and build checks listed under Milestone 1.3.

### Pending validation

- Run local inbound smoke against a running dev server for `simple-text.eml`.
- Capture duplicate delivery evidence showing one stored message and a duplicate ingest event.
- Capture Message-ID conflict evidence using `duplicate-message-id-a.eml` and `duplicate-message-id-b.eml`.
- Capture missing Message-ID idempotency behavior using `missing-message-id.eml`.
- Capture D1 `message_index` and `ingest_events` rows after queue consume.
- Capture R2 raw MIME object key/head evidence.
- Validate poison-message retry/DLQ behavior with ops event output.
- Validate real dev Email Routing delivery to the Worker, not only local smoke.

### Milestone 1.4 result

**MILESTONE 1.4 PASS (implementation)** — inbound routing, queue consumption, D1 indexing, idempotency, and poison-message handling are implemented. End-to-end evidence is still pending.

## Milestone 1.5 - Mailbox Durable Object Core

**Date:** 2026-06-30
**Result:** **MILESTONE 1.5 PASS (implementation)**
**Validation status:** **PARTIAL - full gate evidence pending**

### Implementation

- Full DO SQLite schema in `src/do/mailbox-schema-content.ts`.
- MIME ingest via `postal-mime` in `src/do/mailbox-ingest.ts`.
- Text, HTML body, attachments, contacts, threading, labels, FTS, and realtime event rows are persisted.
- HTML bodies and attachments are stored in R2 with deterministic keys.
- MIME fixtures added under `fixtures/mime/`.

### Validated in this checkpoint

- `tests/unit/mime.test.ts` passed as part of `pnpm test -- --run`.
- Shared TypeScript, Worker typegen, and build checks listed under Milestone 1.3.

### Pending validation

- Run local smoke ingestion for `html-only.eml`, `multipart-alternative.eml`, `attachment-small.eml`, and duplicate fixtures.
- Capture DO message/thread/contact/attachment row output after ingest.
- Capture FTS search evidence against ingested text.
- Capture R2 object evidence for HTML bodies and attachments.
- Capture realtime `message.created` event emission during ingest.

### Milestone 1.5 result

**MILESTONE 1.5 PASS (implementation)** — the DO mailbox store, MIME parsing, R2 body/attachment storage, FTS, threading, and realtime event recording are implemented. Fixture-level smoke evidence remains pending.

## Milestone 1.6 - HTTP API And UI

**Date:** 2026-06-30
**Result:** **MILESTONE 1.6 PASS (implementation)**
**Validation status:** **PARTIAL - full gate evidence pending**

### Implementation

- Mailbox read/search/action/raw/attachment endpoints in `src/api/mailbox-routes.ts`.
- TanStack UI routes: `/mailboxes`, `/mailboxes/$mailboxId`, `/mailboxes/$mailboxId/compose`.
- WebSocket v1 envelopes with `hello`, `pong`, `echo`, `snapshot`, and broadcast support.
- Zod validation in `src/api/schemas.ts`.

### Validated in this checkpoint

- UI routes compile in `pnpm run build`.
- Shared TypeScript, Worker typegen, and tests listed under Milestone 1.3.

### Pending validation

- Run `pnpm smoke:ws` against a local dev server and capture `hello`, `pong`, `echo`, and `message.created`.
- Capture API examples for mailbox list, threads, message detail, search, raw, attachment, and message action endpoints.
- Walk the TanStack inbox UI locally and capture the mailbox list, thread view, search, and live refresh behavior.
- Validate protected API behavior through Cloudflare Access on dev.

### Milestone 1.6 result

**MILESTONE 1.6 PASS (implementation)** — Hono mailbox APIs, inbox UI, Zod validation, and WebSocket realtime support are implemented. API/UI/WebSocket smoke evidence remains pending.

## Milestone 1.7 - Outbound Sending With Human Confirmation

**Date:** 2026-06-30
**Result:** **MILESTONE 1.7 PASS (implementation)**
**Validation status:** **PENDING - full gate evidence pending**

### Implementation

- DO draft CRUD plus `request-send`, `confirm-send`, and `cancel` flows in `src/do/mailbox-do.ts`.
- API draft/send endpoints in `src/api/mailbox-routes.ts`.
- Compose UI at `/mailboxes/$mailboxId/compose`.
- Outbound idempotency via `mailbox_meta` key `send:{idempotencyKey}` and D1 `outbound_sends`.
- Recipient limit guard before `env.EMAIL.send()`.
- Sent-message indexing through the same mailbox index surface.

### Validated in this checkpoint

- Shared TypeScript, Worker typegen, test, and build checks listed under Milestone 1.3.

### Pending validation

- Exercise draft create/update/delete through API and UI.
- Exercise `request-send` and `confirm-send` with a captured confirmation payload.
- Repeat `confirm-send` with the same idempotency key and capture `duplicate: true` with no second send.
- Capture D1 `outbound_sends` row evidence.
- Capture sent-message indexing evidence in DO and D1.
- Capture recipient-limit rejection behavior.
- Decide and document whether dev validation uses a real Email Sending recipient, a controlled test recipient, or a mocked send path.

### Milestone 1.7 result

**MILESTONE 1.7 PASS (implementation)** — outbound drafts, explicit confirmation, idempotent send confirmation, and sent indexing are implemented. This milestone still needs functional send-flow validation.

## Milestone 1.8 - Multi-Domain, Rules, Backup, Ops

**Date:** 2026-06-30
**Result:** **MILESTONE 1.8 PASS (implementation)**
**Validation status:** **PENDING - full gate evidence pending**

### Implementation

- Second domain seed: `mail.example.com` plus `inbox@mail.example.com`.
- Routing rules API with D1-backed store/forward/reject resolution.
- Cron backup sweep in `src/cloudflare/scheduled.ts`.
- Backup manifests write to R2 under `backups/{env}/{date}/{mailboxId}.manifest.json`.
- Ops/admin endpoints: `/api/admin/ops-events`, `/api/admin/dlq`, `/api/admin/reindex`, `/api/admin/backups/run`.

### Validated in this checkpoint

- Shared TypeScript, Worker typegen, test, and build checks listed under Milestone 1.3.

### Pending validation

- Capture D1 evidence for two seeded domains and isolated mailbox mappings.
- Exercise routing rules for store, forward, and reject behavior.
- Trigger the scheduled backup handler locally and on dev, then capture ops events and R2 manifest evidence.
- Exercise `/api/admin/ops-events`, `/api/admin/dlq`, `/api/admin/reindex`, and `/api/admin/backups/run`.
- Capture reindex evidence showing D1 `message_index` rebuilt from DO export output.
- Validate second-domain Email Routing behavior on dev.

### Milestone 1.8 result

**MILESTONE 1.8 PASS (implementation)** — multi-domain seed, routing rules, cron backup, ops endpoints, and D1 reindex are implemented. Full ops and multi-domain validation remains pending.

## Phase 1 Summary

**PHASE 1 IMPLEMENTATION PASS / VALIDATION PENDING** — Milestones 1.1 and 1.2 have full validation evidence. Milestones 1.3 through 1.8 are implemented and pass the local checkpoint (`install`, Wrangler version, typegen, strict TypeScript, tests, and build), but they are not yet fully senior-validated because the end-to-end D1, queue, email, WebSocket, outbound, backup, and ops evidence listed above is still pending.

## Senior Validation Checkpoint - Milestones 1.3-1.8

**Date:** 2026-06-30
**Reviewer:** senior validation pass
**Result:** **FAIL**
**Senior sign-off:** **BLOCKED**. The implementation has useful local evidence, but it does not fully follow the Phase 1.3-1.8 plan. Do not checkpoint Phase 1 as senior-approved until the blockers below are fixed and rerun.

### Scope

Validated the `aedb2ae` checkpoint against `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION.md`, `docs/PHASE0_VALIDATION.md`, and this Phase 1 validation file.

Assigned milestones:

- Milestone 1.3 - Mailbox Identity And Provisioning
- Milestone 1.4 - Inbound Hot Path
- Milestone 1.5 - Mailbox Durable Object Core
- Milestone 1.6 - HTTP API And UI
- Milestone 1.7 - Outbound Sending With Human Confirmation
- Milestone 1.8 - Multi-Domain, Rules, Backup, Ops

### Baseline preflight

```bash
git status --short --untracked-files=all
# no output; worktree clean before senior validation edits

git log -1 --oneline
# aedb2ae Complete Phase 1 implementation checkpoint

node -v
# v24.15.0

pnpm -v
# 11.1.1

pnpm wrangler --version
# 4.105.0
```

Cloudflare resource preflight:

```bash
pnpm wrangler whoami
# account <your-cloudflare-account-id>; user@example.com

pnpm wrangler deployments list --name reccado-dev
# latest after senior deploy: version 0a0035e7-b707-4806-b089-42747b6baea2

pnpm wrangler r2 bucket list
# includes inbox-mcp-raw-dev

pnpm wrangler queues list
# inbox-mcp-inbound-dev producers=1 consumers=1
# inbox-mcp-inbound-dlq-dev producers=0 consumers=0

pnpm wrangler d1 list
# inbox-mcp-index-dev id ca3b5109-17bf-4a6e-9943-9892c4e04dbc
```

### Static gates

```bash
pnpm wrangler types --env dev
# Types written to worker-configuration.d.ts
# MAIL_OBJECTS, INDEX_DB, EMAIL, INBOUND_EMAIL_QUEUE, MAILBOX_ID_SECRET, MAILBOX_DO present

pnpm exec tsc --noEmit
# exit 0

pnpm test -- --run
# Test Files 3 passed (3), Tests 4 passed (4)

pnpm run build
# client and SSR builds pass

pnpm wrangler deploy --env dev --name reccado-dev --dry-run
# dry-run shows MAILBOX_DO, EMAIL, INBOUND_EMAIL_QUEUE, INDEX_DB, MAIL_OBJECTS bindings

pnpm run deploy:dev
# Deployed reccado-dev
# https://reccado-dev.<your-subdomain>.workers.dev
# schedule: 0 * * * *
# Producer/Consumer for inbox-mcp-inbound-dev
# Current Version ID: 0a0035e7-b707-4806-b089-42747b6baea2
```

### D1 validation

```bash
pnpm d1:migrate:local
# No migrations to apply

pnpm d1:migrate:dev
# No migrations to apply

pnpm wrangler d1 execute inbox-mcp-index-dev --remote --env dev \
  --command "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name;"
# remote schema includes domains, mailboxes, aliases, routing_rules, message_index,
# ingest_events, outbound_sends, ops_events and expected indexes

pnpm wrangler d1 execute inbox-mcp-index-dev --remote --env dev \
  --command "SELECT * FROM d1_migrations ORDER BY id;"
# 0001_initial.sql and 0002_message_index.sql applied at 2026-06-30 17:13:59
```

Note: `pnpm wrangler d1 list` still reported `num_tables: 0`, but direct `sqlite_master` and `d1_migrations` queries proved the remote schema exists. Use the direct query evidence for this checkpoint.

Remote D1 has no seeded Phase 1 catalog rows:

```bash
pnpm wrangler d1 execute inbox-mcp-index-dev --remote --env dev \
  --command "SELECT domain FROM domains; SELECT mailbox_id, primary_address FROM mailboxes; SELECT alias_address, mailbox_id FROM aliases;"
# all three result sets empty
```

### Access and deployed-secret validation

Unauthenticated deployed requests are blocked by Cloudflare Access at the edge:

```bash
curl -si https://reccado-dev.<your-subdomain>.workers.dev/api/health | sed -n '1,20p'
# HTTP/2 302
# location: https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/...
# www-authenticate: Cloudflare-Access ... audience 87bda8291601a78af9b4bc2e7143b18d9b4d2dedfcee7363ab53497a248c8eed

curl -si https://reccado-dev.<your-subdomain>.workers.dev/api/mailboxes | sed -n '1,20p'
# HTTP/2 302
# location: https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/...
```

Worker secret list:

```bash
pnpm wrangler secret list --name reccado-dev
# PHASE0_DEBUG_TOKEN only
```

Blocking issue: the deployed Worker lacks `MAILBOX_ID_SECRET`, `ACCESS_JWT_AUDIENCE`, and `ACCESS_TEAM_DOMAIN`. Edge Access is configured, but the Worker cannot validate Access JWTs for API writes and remote mailbox creation would fail after authorized Access traffic reaches the Worker.

### Local functional evidence that passed

Local dev server:

```bash
pnpm dev
# port 3000 occupied; Vite bound to http://localhost:3001/
```

Health:

```bash
curl -sS http://localhost:3001/api/health
# {"ok":true}
```

Mailbox identity/API:

```bash
curl -sS -X POST http://localhost:3001/api/mailboxes \
  -H 'content-type: application/json' \
  --data '{"primaryAddress":"Senior.Check@example.com","displayName":"Senior Check"}'
# mailbox_id mbx_1kpe78onbh47qi0vb7bb6gv9s0, primary_address senior.check@example.com

curl -sS -X POST http://localhost:3001/api/aliases \
  -H 'content-type: application/json' \
  --data '{"aliasAddress":"senior.check@example.com","mailboxId":"mbx_1kpe78onbh47qi0vb7bb6gv9s0"}'
# alias senior.check@example.com created

curl -sS -X POST http://localhost:3001/api/aliases \
  -H 'content-type: application/json' \
  --data '{"aliasAddress":"bad@unregistered.example","mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}'
# {"error":"domain_not_found","message":"Domain not registered"}
```

Seeded local catalog:

```bash
curl -sS http://localhost:3001/api/mailboxes
# test@example.com -> mbx_qokds9a0nlpt2jkno6uoc1j6sn
# inbox@mail.example.com -> mbx_hmlgkp76l6q4ev7tq4ickeqdi1

curl -sS http://localhost:3001/api/aliases
# test@example.com and inbox@mail.example.com aliases present
```

Inbound duplicate smoke:

```bash
pnpm smoke:email:local http://localhost:3001 fixtures/mime/simple-text.eml
# first delivery ok
# R2 head exists for raw/dev/mbx_qokds9a0nlpt2jkno6uoc1j6sn/...c689c8....eml, size 250
# duplicate delivery ok
# debug messageCount stayed 1
# queue-payload-sample eventType=email.received.v1, rawR2Key, rawSha256, idempotencyKey only
```

WebSocket smoke against the seeded Phase 1 mailbox:

```bash
pnpm smoke:ws ws://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/ws
# hello, pong, echo
# PASS: smoke-ws completed
```

Realtime on inbound:

```bash
node -e '...connect ws, POST html-only.eml, wait for message.created...'
# hello {"type":"hello","mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}
# message.created {"messageId":"3e4d7a72-11a0-49a7-8c02-2cb08fc456bb","threadId":"7e6f360a-be21-444b-9ff7-f05df2cb7785","subject":"HTML only fixture"}
# PASS: received message.created
```

MIME fixtures, FTS, R2 body/attachment storage:

```bash
curl -sS --request POST "http://localhost:3001/api/debug/phase0/email?from=sender@example.com&to=test@example.com" \
  --data-binary @fixtures/mime/html-only.eml

curl -sS --request POST "http://localhost:3001/api/debug/phase0/email?from=sender@example.com&to=test@example.com" \
  --data-binary @fixtures/mime/attachment-small.eml

curl -sS --request POST "http://localhost:3001/api/debug/phase0/email?from=sender@example.com&to=test@example.com" \
  --data-binary @fixtures/mime/multipart-alternative.eml

curl -sS "http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/search?q=attachment"
# message_id 732a9576-f2f9-4f3f-85c9-f4f9be4a444b

curl -sS "http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/search?q=multipart"
# message_id 8b2c5945-750c-474e-9e33-f211ac858203

curl -sS http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/messages/732a9576-f2f9-4f3f-85c9-f4f9be4a444b
# has_attachments=1; attachment note.txt has R2 key attachments/dev/.../note.txt

curl -sS "http://localhost:3001/api/debug/phase0/r2/head?key=attachments/dev/...note.txt"
# exists true, size 27

curl -sS http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/messages/3e4d7a72-11a0-49a7-8c02-2cb08fc456bb
# body_html_r2_key body/dev/.../html.html

curl -sS "http://localhost:3001/api/debug/phase0/r2/head?key=body/dev/.../html.html"
# exists true, size 48
```

HTTP API/UI basics:

```bash
curl -sS -o /tmp/raw-email-senior.eml -w "raw_status=%{http_code} raw_size=%{size_download}\n" \
  http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/messages/3e4d7a72-11a0-49a7-8c02-2cb08fc456bb/raw
# raw_status=200 raw_size=273

curl -sS -o /tmp/attachment-senior.txt -w "attachment_status=%{http_code} attachment_size=%{size_download}\n" \
  http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/messages/732a9576-f2f9-4f3f-85c9-f4f9be4a444b/attachments/f976763b-5932-44dc-8cc1-3a247cb4bc22
# attachment_status=200 attachment_size=27

curl -sS -X POST http://localhost:3001/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/messages/3e4d7a72-11a0-49a7-8c02-2cb08fc456bb/actions \
  -H 'content-type: application/json' --data '{"action":"mark_read"}'
# {"ok":true,"messageId":"3e4d7a72-11a0-49a7-8c02-2cb08fc456bb","action":"mark_read"}

curl -sS -o /tmp/ui-mailboxes.html -w "ui_status=%{http_code} ui_size=%{size_download}\n" http://localhost:3001/mailboxes
# ui_status=200 ui_size=9319
```

Backup, ops, and reindex:

```bash
curl -sS -i -X POST "http://localhost:3001/cdn-cgi/handler/scheduled?cron=0+*+*+*+*" | sed -n '1,40p'
# HTTP/1.1 200 OK
# ok

curl -sS -X POST http://localhost:3001/api/admin/backups/run \
  -H 'content-type: application/json' --data '{"mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}'
# backups/dev/2026-06-30/mbx_qokds9a0nlpt2jkno6uoc1j6sn.manifest.json

curl -sS "http://localhost:3001/api/debug/phase0/r2/head?key=backups/dev/2026-06-30/mbx_qokds9a0nlpt2jkno6uoc1j6sn.manifest.json"
# exists true, size 3674

curl -sS http://localhost:3001/api/admin/ops-events
# backup.completed and cron.backup_sweep events present

pnpm wrangler d1 execute inbox-mcp-index-dev --local \
  --command "SELECT COUNT(*) AS before_count FROM message_index WHERE mailbox_id='mbx_qokds9a0nlpt2jkno6uoc1j6sn';"
# before_count 6

curl -sS -X POST http://localhost:3001/api/admin/reindex \
  -H 'content-type: application/json' --data '{"mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}'
# {"ok":true,"count":6}

pnpm wrangler d1 execute inbox-mcp-index-dev --local \
  --command "SELECT COUNT(*) AS after_count FROM message_index WHERE mailbox_id='mbx_qokds9a0nlpt2jkno6uoc1j6sn';"
# after_count 6
```

Routing rules local evidence:

```bash
curl -sS -X POST http://localhost:3001/api/domains \
  -H 'content-type: application/json' --data '{"domain":"rules.local","zoneId":"zone-rules-local"}'
# domain id c9a70bbd-ad31-40f2-ae0f-d79beb37eadc

curl -sS -X POST http://localhost:3001/api/routing-rules ... storeme/store
# id eaf1af3c-5f83-4af3-9287-6bec0844442c

curl -sS -X POST http://localhost:3001/api/routing-rules ... rejectme/reject
# id f07abbe6-a7e3-4650-99dc-721b0a4fde07

curl -sS -X POST http://localhost:3001/api/routing-rules ... forwardme/forward
# id 50bbbc28-7f6d-408c-baf2-c9ffb2291d08

POST storeme@rules.local through debug email simulation
# D1 message_index subject Rule store senior

POST rejectme@rules.local through debug email simulation
# D1 ops_events inbound.rejected subject rejectme@rules.local reason senior_reject

POST forwardme@rules.local through debug email simulation
# HTTP 500 because local simulation throws "forward is not implemented in local simulation"
```

### Blocking findings

1. **Remote Worker secrets are incomplete.** `pnpm wrangler secret list --name reccado-dev` shows only `PHASE0_DEBUG_TOKEN`. The runbook requires `MAILBOX_ID_SECRET`, `ACCESS_JWT_AUDIENCE`, and `ACCESS_TEAM_DOMAIN`; without them the Worker cannot create mailbox IDs remotely or validate Access JWTs for API writes.

2. **Worker auth fails open when Access env vars are missing.** `src/api/auth.ts` returns `{ userId: "dev-local", email: "dev@local" }` whenever `ACCESS_JWT_AUDIENCE` is absent. That is acceptable only for local dev. It is not acceptable in the deployed Worker, especially because the deployed Worker currently lacks the Access JWT secrets.

3. **Old Durable Object instances are not migrated.** `pnpm smoke:ws ws://localhost:3001/api/mailboxes/mbx_test/ws` failed with `api.error Error: no such column: thread_id`. The constructor runs `CREATE TABLE IF NOT EXISTS`, which does not alter Phase 0 `messages` tables. This violates the Milestone 1.5 idempotent migration requirement for existing mailbox DOs.

4. **Same Message-ID with different raw body is incorrectly treated as duplicate, not conflict.** After posting `duplicate-message-id-a.eml` and `duplicate-message-id-b.eml`, logs showed the second delivery as:

```text
result: {
  status: 'duplicate',
  idempotencyKey: 'email:v1:mbx_qokds9a0nlpt2jkno6uoc1j6sn:message-id:duplicate-shared-id@example.com',
  rawR2Key: '...dd757b5b0db0d5ccd9303792a122a3bca8eb317417ffd51e8f878f21095e4570.eml'
}
```

D1 `ingest_events` kept that idempotency key as `processed` with `error_code=null`; no `ingest.conflict` ops event was recorded. Root cause: `src/do/mailbox-ingest.ts` returns duplicate at lines 99-108 before comparing `existing.raw_sha256` at lines 110-126.

5. **Poison-message DLQ behavior is not plan-compliant.** `src/cloudflare/queue-consumer.ts` acks invalid schema messages once `attempts >= MAX_RETRIES`. That prevents Cloudflare Queues from moving the terminal poison message to the configured DLQ. The Phase 1.4 and test-plan gate requires poison messages to reach DLQ.

6. **Outbound send audit is not implemented.** The plan requires one `outbound_sends` row, provider message ID, and sent message indexing. `src/api/mailbox-routes.ts` only writes `message_index` after a sent result; there is no D1 `outbound_sends` insert/update in the API or DO path. Local D1 query returned `outbound_sends_count=0`.

7. **Outbound confirmation still needs functional validation and has a malformed sent-message insert.** `src/do/mailbox-do.ts` calls `env.EMAIL.send()` before marking the idempotency key, and the sent message SQL uses literal empty strings for `raw_r2_key`/`raw_sha256` while also binding an extra `sent/${draftId}` argument. The local recipient-limit test returned `HTTP 500 {"error":"internal_error"}` instead of a validation error:

```bash
POST /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/drafts/71374f09-3b21-4e67-8c2d-fd6d9f5d47e3/confirm-send
# {"error":"internal_error"} HTTP 500
```

8. **Routing-rule API does not validate `domainId` before insert.** Posting routing rules with `domainId="zone-rules-local"` returned `internal_error` instead of a clear 400. Posting with the real domain table id succeeded. The API should validate `domains.id` explicitly before `insertRoutingRule`.

9. **Forward routing is not validated.** Store and reject rules were locally validated. Forward routing returns `HTTP 500` under the local email simulation because `message.forward()` is intentionally not implemented there. A real dev Email Routing or test double path is still needed.

10. **Remote Phase 1 data path is not validated on the current deployed version.** Current dev Worker version `0a0035e7-b707-4806-b089-42747b6baea2` is deployed and edge-protected, but remote D1 has no seed rows, and no authenticated Access/service-token path was available in this run to exercise `/api/mailboxes`, inbound, WebSocket, outbound, backup, or reindex remotely.

### Milestone senior results

| Milestone | Senior result | Reason |
| --- | --- | --- |
| 1.3 Mailbox Identity And Provisioning | **FAIL** | Local mailbox ID/API works, but deployed Worker is missing `MAILBOX_ID_SECRET` and Access JWT secrets; remote API provisioning cannot be signed off. |
| 1.4 Inbound Hot Path | **FAIL** | Local store/duplicate/missing-Message-ID paths mostly work, but Message-ID conflict handling is wrong and poison DLQ behavior is not plan-compliant. |
| 1.5 Mailbox Durable Object Core | **FAIL** | New mailbox fixture ingest, FTS, HTML, attachments, contacts/realtime evidence is good; old DO schema migration and conflict policy block sign-off. |
| 1.6 HTTP API And UI | **FAIL** | Local API/WS/UI basics work and edge Access blocks unauthenticated dev requests; Worker-level Access JWT validation and remote authorized API/WS validation are missing. |
| 1.7 Outbound Sending With Human Confirmation | **FAIL** | Draft/request-send gate works locally, but no real send validation, no D1 `outbound_sends` audit row, malformed sent-message insert, and recipient-limit error maps to 500. |
| 1.8 Multi-Domain, Rules, Backup, Ops | **FAIL** | Local backup/ops/reindex and store/reject routing pass; forward routing, remote multi-domain isolation, and routing-rule validation are incomplete. |

### Files changed by senior validation

- `docs/PHASE1_VALIDATION.md`

### Cloudflare resources touched

- Worker: `reccado-dev`
- Worker URL: `https://reccado-dev.<your-subdomain>.workers.dev`
- Worker version deployed for validation: `0a0035e7-b707-4806-b089-42747b6baea2`
- R2 bucket: `inbox-mcp-raw-dev`
- Queue: `inbox-mcp-inbound-dev`
- DLQ: `inbox-mcp-inbound-dlq-dev`
- D1 database: `inbox-mcp-index-dev`, id `ca3b5109-17bf-4a6e-9943-9892c4e04dbc`
- Access app/audience observed: `87bda8291601a78af9b4bc2e7143b18d9b4d2dedfcee7363ab53497a248c8eed`

No new Cloudflare resources were created. No production resources were touched.

### Required next remediation

1. Add required dev Worker secrets: `MAILBOX_ID_SECRET`, `ACCESS_JWT_AUDIENCE`, `ACCESS_TEAM_DOMAIN`; make missing Access config fail closed outside local dev.
2. Add DO SQLite migrations that alter or rebuild old Phase 0 mailbox tables safely.
3. Fix Message-ID conflict detection to compare `raw_sha256` before returning duplicate.
4. Change poison handling so invalid schemas reach the Cloudflare DLQ and document replay.
5. Implement outbound `outbound_sends` audit rows, provider message ID persistence, idempotency before/around provider send, and sent message indexing with valid raw/sent storage semantics.
6. Validate outbound send exactly-once behavior against a verified dev recipient.
7. Validate routing-rule `domainId`/mailbox references before insert; rerun store, reject, and forward against a real or properly mocked forwarding path.
8. Seed or create dev data through an authenticated Access/service-token path and rerun remote API, inbound, WebSocket, backup, ops, and reindex gates on the deployed Worker.

## Senior Remediation Validation - 2026-06-30

### Result

**PHASE 1.3-1.8 SENIOR VALIDATION PASS** after remediation.

The previous senior checkpoint correctly failed 1.3-1.8. This checkpoint fixes the blocking deviations and validates the remediated behavior locally and against the deployed dev Worker.

Current deployed validation target:

```text
Worker: reccado-dev
URL: https://reccado-dev.<your-subdomain>.workers.dev
Current Version ID: f0008bbe-9179-4bfe-a5ce-e5032699fd60
Account: <your-cloudflare-account-id>
D1: inbox-mcp-index-dev ca3b5109-17bf-4a6e-9943-9892c4e04dbc
R2: inbox-mcp-raw-dev
Queue: inbox-mcp-inbound-dev
DLQ: inbox-mcp-inbound-dlq-dev
```

### Remediations Applied

- Worker auth now fails closed outside localhost when Access JWT config is missing.
- Dev Worker secrets were added: `MAILBOX_ID_SECRET`, `ACCESS_JWT_AUDIENCE`, `ACCESS_TEAM_DOMAIN`.
- Existing Phase 0 Durable Object `messages` tables are migrated/rebuilt before Phase 1 indexes are created.
- Message-ID idempotency conflict detection now compares `raw_sha256` before returning duplicate.
- Invalid queue schema messages now always `retry()` and no longer `ack()` at max attempts.
- Outbound sends now create/update `outbound_sends`, persist provider Message-ID, index sent messages with valid sent metadata, and return 400 for recipient-limit rejection.
- Repeated outbound `confirm-send` with the same idempotency key now returns `duplicate: true` and preserves `outbound_sends.status='sent'`.
- Routing-rule creation now validates `domainId`, store `mailboxId`, and forward destination requirements before insert.
- Real forward routing now records `inbound.forwarded` ops evidence after `message.forward()`.

### Static Gates

```bash
git log -1 --oneline
# aedb2ae Complete Phase 1 implementation checkpoint

node -v
# v24.15.0

pnpm -v
# 11.1.1

pnpm wrangler --version
# 4.105.0

pnpm wrangler types --env dev
# Types written to worker-configuration.d.ts

pnpm exec tsc --noEmit
# exit 0

pnpm test -- --run
# Test Files 4 passed (4), Tests 5 passed (5)

pnpm run build
# client and SSR builds pass

pnpm run deploy:dev
# Deployed reccado-dev
# Current Version ID: f0008bbe-9179-4bfe-a5ce-e5032699fd60
```

New DLQ regression test:

```text
tests/unit/queue-consumer.test.ts
invalid schema -> insert ops event, retry({ delaySeconds: 2 }), ack not called
```

### Cloudflare Resource Checks

```bash
pnpm wrangler whoami
# account <your-cloudflare-account-id>; logged in as user@example.com

pnpm wrangler secret list --name reccado-dev
# ACCESS_JWT_AUDIENCE
# ACCESS_TEAM_DOMAIN
# MAILBOX_ID_SECRET
# PHASE0_DEBUG_TOKEN

pnpm wrangler queues info inbox-mcp-inbound-dev
# producers=1 worker:reccado-dev
# consumers=1 worker:reccado-dev

pnpm wrangler queues info inbox-mcp-inbound-dlq-dev
# producers=0 consumers=0

pnpm wrangler d1 execute inbox-mcp-index-dev --remote --env dev \
  --command "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name;"
# remote schema includes domains, mailboxes, aliases, routing_rules, message_index,
# ingest_events, outbound_sends, ops_events and expected indexes
```

Access service-token validation was used only for this run and then deleted:

```text
temporary Access policy: 254520d9-ca00-4177-a4c6-cb7307009dd6 deleted
temporary Access service token: 6691b004-f78a-4258-928f-033c94881b48 deleted
```

Authenticated and unauthenticated API behavior:

```bash
GET /api/health with Access service token
# HTTP 200 {"ok":true}

GET /api/me with Access service token
# HTTP 200 {"userId":"","email":""}

GET /api/mailboxes with Access service token
# HTTP 200

GET /api/mailboxes without Access
# HTTP 302 to Cloudflare Access login
```

### 1.3 Mailbox Identity And Provisioning

Remote provisioning via authenticated API:

```bash
POST /api/domains {"domain":"example.com","zoneId":"dev-zone-placeholder"}
# HTTP 201 id 4ff09755-6ec6-42fb-a65a-18b4d81290a3

POST /api/mailboxes {"primaryAddress":"test@example.com","displayName":"Dev Test Mailbox"}
# HTTP 201 mailbox_id mbx_qokds9a0nlpt2jkno6uoc1j6sn

POST /api/aliases {"aliasAddress":"test@example.com","mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}
# HTTP 201

POST /api/domains {"domain":"mail.example.com","zoneId":"dev-zone-mail-placeholder"}
# HTTP 201 id 356d5ca5-6c44-4bf0-9b83-0f944da1f71c

POST /api/mailboxes {"primaryAddress":"inbox@mail.example.com","displayName":"Dev Mail Domain Inbox"}
# HTTP 201 mailbox_id mbx_hmlgkp76l6q4ev7tq4ickeqdi1

POST /api/aliases {"aliasAddress":"inbox@mail.example.com","mailboxId":"mbx_hmlgkp76l6q4ev7tq4ickeqdi1"}
# HTTP 201
```

**Senior result: PASS.** Deterministic mailbox IDs match the approved dev secret and both dev domains are provisioned remotely through Access.

### 1.4 Inbound Hot Path

Real dev inbound through Cloudflare Email Sending -> Email Routing -> Worker -> R2 -> Queue -> DO:

```bash
pnpm wrangler email sending send-raw \
  --from smoke@mail.example.com \
  --to test@example.com \
  --mime-file fixtures/mime/cloudflare-send-raw.eml
# Email sent successfully.

GET /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/threads?limit=10
# HTTP 200
# latest_subject "Phase 0.3 Cloudflare routing smoke"

GET /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/threads/6fc5e636-f27d-4c0e-a59d-d977c385d045
# message id 32540c35-2fdb-4d4a-ba42-809d05507b47
# raw_r2_key raw/dev/mbx_qokds9a0nlpt2jkno6uoc1j6sn/2026/06/30/1782843332181-4a6b7433f26e4ddebbd82afd4231fe8740cbda645f5c4101011691701c39735e.eml
# raw_sha256 4a6b7433f26e4ddebbd82afd4231fe8740cbda645f5c4101011691701c39735e

GET /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/messages/32540c35-2fdb-4d4a-ba42-809d05507b47/raw
# HTTP 200 bytes=4778

pnpm wrangler d1 execute inbox-mcp-index-dev --remote --env dev \
  --command "SELECT mailbox_id, message_local_id, thread_id, subject, from_addr, state, raw_r2_key FROM message_index ORDER BY received_at DESC LIMIT 5;"
# row for Phase 0.3 Cloudflare routing smoke, from smoke@mail.example.com, state inbox
```

Message-ID conflict remediation evidence:

```text
Local duplicate Message-ID with different raw body now produces ingest_events.status='failed',
error_code='message_id_conflict', and an ingest.conflict ops event. The second body is not stored.
```

Poison handling evidence:

```text
src/cloudflare/queue-consumer.ts invalid-schema branch now calls retry({ delaySeconds: 2 }) unconditionally.
tests/unit/queue-consumer.test.ts asserts retry is called and ack is not called for invalid schema.
Cloudflare queue config has max_retries=3 and dead_letter_queue=inbox-mcp-inbound-dlq-dev.
```

**Senior result: PASS.** Store path is validated on the deployed Worker; duplicate/conflict and poison behavior are validated locally with focused evidence and Cloudflare queue/DLQ configuration.

### 1.5 Mailbox Durable Object Core

Legacy DO migration evidence:

```bash
GET http://localhost:3001/api/debug/phase0/schema/mbx_test
# messages columns include thread_id

pnpm smoke:ws ws://localhost:3001/api/mailboxes/mbx_test/ws
# PASS: smoke-ws completed
```

Remote DO API and search evidence:

```bash
GET /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/search?q=Routing&limit=10
# HTTP 200 {"results":[{"message_id":"32540c35-2fdb-4d4a-ba42-809d05507b47"}]}

WebSocket wss://reccado-dev.<your-subdomain>.workers.dev/api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/ws
# hello mailboxId mbx_qokds9a0nlpt2jkno6uoc1j6sn connectionCount 1
# pong mailboxId mbx_qokds9a0nlpt2jkno6uoc1j6sn
# echo payload phase-1-remote-ws

Second inbound while WebSocket was open
# message.created messageId 4a7937cf-9e05-4b50-bd95-c943ad24a0c9
# threadId 6fc5e636-f27d-4c0e-a59d-d977c385d045
# subject Phase 0.3 Cloudflare routing smoke
```

**Senior result: PASS.** DO schema is migration-safe for the old Phase 0 mailbox, and remote thread/search/raw/WS/realtime behavior is validated.

### 1.6 HTTP API And UI

Remote API evidence:

```bash
GET /api/mailboxes
# HTTP 200 with Access service token

GET /api/mailboxes without Access
# HTTP 302 Cloudflare Access

GET /api/mailboxes/:mailboxId/threads
# HTTP 200

GET /api/mailboxes/:mailboxId/search?q=Routing
# HTTP 200
```

Local UI smoke remained valid:

```bash
curl -sS -o /tmp/ui-mailboxes.html -w "ui_status=%{http_code} ui_size=%{size_download}\n" http://localhost:3001/mailboxes
# ui_status=200
```

**Senior result: PASS.** Edge Access blocks unauthenticated API access, authenticated API requests reach the Worker, and the UI route builds/serves locally.

### 1.7 Outbound Sending With Human Confirmation

Real outbound send to approved recipient `user@example.com`:

```bash
POST /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/drafts
# HTTP 201 draft 43130d54-6a8a-423c-b773-accc90b3bd77

POST /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/drafts/43130d54-6a8a-423c-b773-accc90b3bd77/request-send
# HTTP 200 {"status":"pending_confirmation"}

POST /api/mailboxes/mbx_qokds9a0nlpt2jkno6uoc1j6sn/drafts/43130d54-6a8a-423c-b773-accc90b3bd77/confirm-send
# HTTP 200
# sent true
# providerMessageId <NTpXbWgDsoO6nf8X6pUQq7X07Z955P2NNBdB@mail.example.com>
# messageLocalId 5f561958-f769-46f3-a370-6590476aaba8

Repeat same confirm-send with same idempotency key
# HTTP 200
# sent false
# duplicate true
# same providerMessageId <NTpXbWgDsoO6nf8X6pUQq7X07Z955P2NNBdB@mail.example.com>
```

D1 audit evidence:

```bash
SELECT draft_id, idempotency_key, status, provider_message_id, error_code
FROM outbound_sends
WHERE draft_id='43130d54-6a8a-423c-b773-accc90b3bd77';
# status sent
# provider_message_id <NTpXbWgDsoO6nf8X6pUQq7X07Z955P2NNBdB@mail.example.com>
# error_code null

SELECT mailbox_id, message_local_id, subject, from_addr, to_json, state, raw_r2_key, raw_sha256
FROM message_index
WHERE message_local_id='5f561958-f769-46f3-a370-6590476aaba8';
# state sent
# from_addr noreply@mail.example.com
# to_json ["user@example.com"]
# raw_r2_key sent/43130d54-6a8a-423c-b773-accc90b3bd77
```

Recipient-limit evidence:

```bash
POST confirm-send for draft 2b9bf99b-8ca4-4217-a2ae-b2823013ec94 with 51 recipients
# HTTP 400
# {"error":"too_many_recipients","recipientCount":51}

SELECT draft_id, status, provider_message_id, error_code
FROM outbound_sends
WHERE draft_id='2b9bf99b-8ca4-4217-a2ae-b2823013ec94';
# status failed
# provider_message_id null
# error_code http_400
```

**Senior result: PASS.** Human-confirmed outbound send works against Email Sending, exactly-once repeat returns duplicate without another provider send, provider ID is persisted, sent message is indexed, and recipient-limit rejection is clean.

### 1.8 Multi-Domain, Rules, Backup, Ops

Multi-domain rows:

```text
example.com -> test@example.com -> mbx_qokds9a0nlpt2jkno6uoc1j6sn
mail.example.com -> inbox@mail.example.com -> mbx_hmlgkp76l6q4ev7tq4ickeqdi1
```

Routing validation:

```bash
POST /api/routing-rules with domainId missing-domain
# HTTP 400 {"error":"domain_not_found","message":"Domain not found"}

Temporary Cloudflare Email Routing rules created:
# a641a5528f7c4bbc973bc0800eede566 -> forward-senior-20260630182653@example.com -> worker
# 27ed6ac7dcca49179d397748fc40fa33 -> reject-senior-20260630182653@example.com -> worker

Forward route:
# wrangler tail showed email.forwarded
# recipient forward-senior-20260630182653@example.com
# forwardTo ["user@example.com"]

SELECT event_type, severity, subject, payload_json
FROM ops_events
WHERE subject='forward-senior-20260630182653@example.com';
# inbound.forwarded info with forwardTo ["user@example.com"]

SELECT COUNT(*) AS c FROM message_index
WHERE to_json LIKE '%forward-senior-20260630182653@example.com%' OR subject LIKE '%forward senior%';
# c 0

Reject route:
SELECT event_type, severity, subject, payload_json
FROM ops_events
WHERE subject='reject-senior-20260630182653@example.com';
# inbound.rejected info reason senior_validation_reject

SELECT COUNT(*) AS c FROM message_index
WHERE to_json LIKE '%reject-senior-20260630182653@example.com%' OR subject LIKE '%reject senior%';
# c 0
```

Temporary routing cleanup:

```bash
pnpm wrangler email routing rules delete example.com a641a5528f7c4bbc973bc0800eede566 --force
# Deleted routing rule

pnpm wrangler email routing rules delete example.com 27ed6ac7dcca49179d397748fc40fa33 --force
# Deleted routing rule

pnpm wrangler email routing rules list example.com
# temp rules absent; existing test@example.com worker rule remains

DELETE FROM routing_rules WHERE id IN ('c4f228e4-9d05-4b0a-a74d-0101dc1c7ab0','38f65c4d-8ba4-4a81-93f1-26f26b9451d3')
# remaining 0
```

Backup and reindex:

```bash
POST /api/admin/reindex {"mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}
# HTTP 200 {"ok":true,"count":1}

POST /api/admin/backups/run {"mailboxId":"mbx_qokds9a0nlpt2jkno6uoc1j6sn"}
# HTTP 200 backups/dev/2026-06-30/mbx_qokds9a0nlpt2jkno6uoc1j6sn.manifest.json

pnpm wrangler r2 object get inbox-mcp-raw-dev/backups/dev/2026-06-30/mbx_qokds9a0nlpt2jkno6uoc1j6sn.manifest.json --remote --file /tmp/remote_backup_manifest_remote.json
# messageCount 1
# firstSubject Phase 0.3 Cloudflare routing smoke

SELECT event_type, severity, subject, payload_json
FROM ops_events
ORDER BY created_at DESC LIMIT 5;
# backup.completed
# admin.reindex
# cron.backup_sweep
```

**Senior result: PASS.** Multi-domain provisioning, routing validation, real forward/reject behavior, backup manifest, reindex, scheduled ops, and cleanup were validated.

### Final Senior Results By Milestone

| Milestone | Senior result | Evidence |
| --- | --- | --- |
| 1.3 Mailbox Identity And Provisioning | **PASS** | Remote Access-authenticated domain/mailbox/alias creation, deterministic mailbox IDs, required Worker secrets present. |
| 1.4 Inbound Hot Path | **PASS** | Real dev inbound through Email Routing, R2 raw fetch, D1 index, Message-ID conflict fix, poison retry/no-ack unit test plus DLQ config. |
| 1.5 Mailbox Durable Object Core | **PASS** | Legacy DO migration, remote threads/search/raw, remote WS hello/pong/echo, and live `message.created`. |
| 1.6 HTTP API And UI | **PASS** | Edge Access 302 unauthenticated, service-token API 200s, mailbox API routes and local UI smoke. |
| 1.7 Outbound Sending With Human Confirmation | **PASS** | Real Email Sending to approved Gmail, duplicate confirm idempotency, `outbound_sends` audit, sent message index, recipient-limit 400. |
| 1.8 Multi-Domain, Rules, Backup, Ops | **PASS** | Two domains provisioned, invalid route 400, real forward/reject with ops evidence, backup/reindex/ops events, temp resources cleaned. |

### Files Changed By Senior Remediation

- `docs/PHASE1_VALIDATION.md`
- `src/api/auth.ts`
- `src/api/hono.ts`
- `src/api/mailbox-routes.ts`
- `src/cloudflare/email-handler.ts`
- `src/cloudflare/local-email.ts`
- `src/cloudflare/queue-consumer.ts`
- `src/db/d1.ts`
- `src/do/mailbox-do.ts`
- `src/do/mailbox-ingest.ts`
- `src/server.ts`
- `tests/unit/queue-consumer.test.ts`

### Cloudflare Resources Touched

- Worker `reccado-dev`; deployed validation version `f0008bbe-9179-4bfe-a5ce-e5032699fd60`.
- Worker secrets added/verified: `MAILBOX_ID_SECRET`, `ACCESS_JWT_AUDIENCE`, `ACCESS_TEAM_DOMAIN`.
- D1 `inbox-mcp-index-dev`: dev catalog rows, message index rows, outbound audit rows, ops events, temporary routing rules inserted then removed.
- R2 `inbox-mcp-raw-dev`: inbound raw email objects and backup manifest.
- Queue `inbox-mcp-inbound-dev`: real inbound deliveries.
- DLQ `inbox-mcp-inbound-dlq-dev`: config verified; poison no-ack behavior covered by unit test.
- Email Sending `mail.example.com`: sent inbound smoke and outbound validation messages.
- Email Routing `example.com`: temporary worker rules `a641a5528f7c4bbc973bc0800eede566` and `27ed6ac7dcca49179d397748fc40fa33` created for forward/reject validation and deleted.
- Access temporary service token `6691b004-f78a-4258-928f-033c94881b48` and temporary policy `254520d9-ca00-4177-a4c6-cb7307009dd6` created for validation and deleted.

No production resources were touched.

### Residual Notes

- A pre-fix outbound validation draft `9aee7ea3-4a56-45d5-9efa-7d95c5eb71c8` exposed the idempotency audit bug by changing its `outbound_sends` row to `failed` on repeat confirm. The fixed validation used draft `43130d54-6a8a-423c-b773-accc90b3bd77` and passed.
- Live DLQ terminal movement was not directly inspected because Wrangler exposes queue/DLQ config but no message publish/pull command for this workflow. The blocking code deviation was corrected and covered by unit test: invalid schema now retries and never acks, allowing Cloudflare's configured `max_retries=3` plus `dead_letter_queue` to handle terminal movement.
