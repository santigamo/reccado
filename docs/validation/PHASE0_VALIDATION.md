# Phase 0.1 Validation Evidence

> **Internal build-validation log — historical record, not current operating docs.** This file
> captures the evidence gathered while building Phase 0. Resource names, IDs, secrets, and
> commands below reflect the maintainer's environment at that point in time and may be stale —
> see [`README.md`](../../README.md), [`docs/OPERATIONS.md`](../OPERATIONS.md), and
> [`SECURITY.md`](../../SECURITY.md) for current, accurate operating guidance.

**Date:** 2026-06-30  
**Worktree:** `~/orca/workspaces/reccado/inbox-phase0-cursor`  
**Scaffold source:** `~/orca/workspaces/reccado/reccado-scaffold`  
**Result:** **PHASE 0.1 PASS**  
**Phase 0.2:** Not started

## 1. Scaffold inspection

Scaffold is a TanStack Start + Cloudflare Workers project:

- `package.json`: TanStack Start/Router, Vite 8, Wrangler 4, Tailwind 4
- `wrangler.jsonc`: `main` was `@tanstack/react-start/server-entry` (overridden in worktree)
- `src/`: routes (`index`, `about`, `__root__`), `router.tsx`, components, `styles.css`

## 2. rsync from scaffold

Dry-run:

```bash
rsync -avn --exclude='.git' --exclude='docs' --exclude='node_modules' \
  ~/orca/workspaces/reccado/reccado-scaffold/ \
  ~/orca/workspaces/reccado/inbox-phase0-cursor/
```

Output:

```
Transfer starting: 31 files
./
package.json
pnpm-lock.yaml
worker-configuration.d.ts
wrangler.jsonc
src/
```

Copy:

```bash
rsync -av --exclude='.git' --exclude='docs' --exclude='node_modules' \
  ~/orca/workspaces/reccado/reccado-scaffold/ \
  ~/orca/workspaces/reccado/inbox-phase0-cursor/
```

`node_modules` excluded; dependencies installed in worktree via `pnpm install`.

## 3. Phase 0.1 customizations

### `src/server.ts`

Hono `/api/health` with TanStack Start fallback for all other routes.

### `wrangler.jsonc`

- `name`: `reccado`
- `main`: `src/server.ts`

### `package.json`

- `name`: `reccado`
- Added dependency: `hono`

## 4. Validation gate

### `git status --short --untracked-files=all`

```
 M README.md
?? .cta.json
?? .gitignore
?? .vscode/settings.json
?? package.json
?? pnpm-lock.yaml
?? pnpm-workspace.yaml
?? public/favicon.ico
?? public/logo192.png
?? public/logo512.png
?? public/manifest.json
?? public/robots.txt
?? src/components/Footer.tsx
?? src/components/Header.tsx
?? src/components/ThemeToggle.tsx
?? src/routeTree.gen.ts
?? src/router.tsx
?? src/routes/__root.tsx
?? src/routes/about.tsx
?? src/routes/index.tsx
?? src/server.ts
?? src/styles.css
?? tsconfig.json
?? tsr.config.json
?? vite.config.ts
?? worker-configuration.d.ts
?? wrangler.jsonc
```

### `pnpm install`

```
Already up to date
Done in 815ms using pnpm v11.1.1
```

### `pnpm wrangler types`

```
✨ Types written to worker-configuration.d.ts
mainModule: typeof import("./src/server");
```

### `pnpm run build`

```
✓ built in 164ms   (client)
✓ built in 139ms   (ssr)
dist/server/index.js  691.05 kB
```

### Dev server + curl

```bash
pnpm dev
```

Note: port 3000 was occupied by another process; Vite bound to **3001**:

```
Port 3000 is in use, trying another one...
➜  Local:   http://localhost:3001/
```

```bash
curl -sS http://localhost:3001/api/health
# {"ok":true}

curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/
# HTTP 200

curl -sS http://localhost:3001/ | head -c 200
# <!DOCTYPE html><html lang="en" ... TanStack Start Starter ...
```

Server stopped after validation (`pkill` on port 3001).

## 5. Files modified / added (Phase 0.1)

| File | Action |
|------|--------|
| `package.json` | rsync + hono + rename |
| `pnpm-lock.yaml` | rsync + install |
| `wrangler.jsonc` | rsync + `main: src/server.ts` |
| `worker-configuration.d.ts` | rsync + wrangler types |
| `src/server.ts` | **new** — Hono health + TanStack fallback |
| `src/*` (routes, components, router) | rsync from scaffold |
| `public/*`, config files | rsync from scaffold |
| `docs/PHASE0_VALIDATION.md` | **new** — this file |

Not modified: `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION.md`

## 6. Phase status

| Phase | Status |
|-------|--------|
| 0.1 Scaffold sync + custom server | **PASS** |
| 0.2 | **Not started** (no deploy, no Cloudflare resource creation) |

---

## 7. Senior checkpoint remediation (2026-06-30)

Senior checkpoint rejected Phase 0.1 for three issues. Remediation applied before rerun.

### Fixes applied

| # | Issue | Remediation |
|---|-------|-------------|
| 1 | `README.md` overwritten by generic TanStack scaffold text | Restored project identity from git HEAD; linked `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION.md`; added local dev commands (`pnpm install`, `pnpm dev`, `pnpm run build`, `pnpm wrangler types`, health curl) |
| 2 | `wrangler.jsonc` `compatibility_date` was `2025-09-02` | Updated to `2026-06-30` per runbook; kept `nodejs_compat` and `main: src/server.ts` |
| 3 | No remediation record in this file | Added this section with rerun validation evidence below |

### Files changed (remediation)

- `README.md`
- `wrangler.jsonc`
- `docs/PHASE0_VALIDATION.md`

### Rerun validation gate

#### `git status --short --untracked-files=all`

```
 M README.md
?? .cta.json
?? .gitignore
?? .vscode/settings.json
?? docs/PHASE0_VALIDATION.md
?? package.json
?? pnpm-lock.yaml
?? pnpm-workspace.yaml
?? public/favicon.ico
?? public/logo192.png
?? public/logo512.png
?? public/manifest.json
?? public/robots.txt
?? src/components/Footer.tsx
?? src/components/Header.tsx
?? src/components/ThemeToggle.tsx
?? src/routeTree.gen.ts
?? src/router.tsx
?? src/routes/__root.tsx
?? src/routes/about.tsx
?? src/routes/index.tsx
?? src/server.ts
?? src/styles.css
?? tsconfig.json
?? tsr.config.json
?? vite.config.ts
?? worker-configuration.d.ts
?? wrangler.jsonc
```

#### `pnpm install`

```
Already up to date
Done in 135ms using pnpm v11.1.1
```

#### `pnpm wrangler types`

```
✨ Types written to worker-configuration.d.ts
mainModule: typeof import("./src/server");
```

#### `pnpm run build`

```
✓ built in 146ms   (client)
✓ built in 159ms   (ssr)
dist/server/index.js  678.07 kB
```

#### Dev server + curl

```bash
pnpm dev
```

Note: port 3000 was occupied; Vite bound to **3001**:

```
Port 3000 is in use, trying another one...
➜  Local:   http://localhost:3001/
```

```bash
curl -sS http://localhost:3001/api/health
# {"ok":true}

curl -sS -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3001/
# HTTP 200

curl -sS http://localhost:3001/ | head -c 200
# <!DOCTYPE html><html lang="en" data-tsd-source="/src/routes/__root.tsx:37:5">...
```

Server stopped after validation (`kill` on dev server PID).

### Remediation result

**PHASE 0.1 REMEDIATION PASS** — all three fixes applied; validation gate green. Phase 0.2 not started.

---

## 8. Phase 0.2 - Durable Object hibernatable WebSocket (2026-06-30)

### Implementation

| File | Change |
|------|--------|
| `src/do/mailbox-do.ts` | Added `MailboxDurableObject` WebSocket endpoint using `ctx.acceptWebSocket(server)` and per-socket `serializeAttachment` / `deserializeAttachment` for hibernation-safe mailbox state |
| `src/server.ts` | Exported `MailboxDurableObject`; proxied `GET /api/mailboxes/:mailboxId/ws` to `env.MAILBOX_DO.getByName(mailboxId)` |
| `wrangler.jsonc` | Added `MAILBOX_DO` Durable Object binding and SQLite migration; added dev worker name |
| `scripts/smoke-ws.ts` | Added smoke client validating `hello`, `pong`, and `echo` |
| `package.json` | Added `smoke:ws`; updated `deploy:dev` to pass `--name reccado-dev` explicitly |

Phase 0.3 was not started: no `email()` handler, R2, Queue, D1, or Email Routing implementation was added in this phase.

### Senior checkpoint fix

Initial junior implementation used `ctx.acceptWebSocket(server)` but kept `mailboxId` only on the Durable Object instance. That is not hibernation-safe because the object can be evicted and reconstructed. Senior remediation stores `{ mailboxId }` on each WebSocket with `server.serializeAttachment(...)` and reads it in `webSocketMessage(...)` with `ws.deserializeAttachment()`.

### Validation gate

#### `pnpm wrangler types --env dev`

```
✨ Types written to worker-configuration.d.ts
MAILBOX_DO: DurableObjectNamespace<import("./src/server").MailboxDurableObject>;
```

#### `pnpm run build`

```
✓ built in 128ms   (client)
✓ built in 125ms   (ssr)
dist/server/index.js  680.19 kB
```

#### Local dev + WebSocket smoke

```bash
pnpm dev
```

Port 3000 was occupied, so Vite bound to `http://localhost:3001/`.

```bash
pnpm smoke:ws ws://localhost:3001/api/mailboxes/mbx_test/ws
```

Output:

```
OK: connected
hello: {"type":"hello","mailboxId":"mbx_test","connectionCount":1}
OK: received hello
pong: {"type":"pong","mailboxId":"mbx_test","connectionCount":1}
OK: received pong
echo: {"type":"echo","mailboxId":"mbx_test","connectionCount":1,"payload":"{\"type\":\"echo-test\",\"payload\":\"phase-0.2\"}"}
OK: received echo
PASS: smoke-ws completed
```

Health and root also remained valid:

```
curl http://localhost:3001/api/health -> {"ok":true}
curl http://localhost:3001/ -> HTTP 200
```

#### Dev deploy

The first deploy attempt used:

```bash
pnpm wrangler deploy --env dev
```

The Cloudflare Vite plugin redirected Wrangler to `dist/server/wrangler.json`, which preserved the top-level worker name and deployed `reccado` instead of the intended dev worker. This was treated as a blocking gate issue.

Correct dev deploy command:

```bash
pnpm wrangler deploy --env dev --name reccado-dev
```

Output:

```
Uploaded reccado-dev
Deployed reccado-dev triggers
https://reccado-dev.<your-subdomain>.workers.dev
Current Version ID: 7eeeaa63-4966-4062-b26d-4cc6575b5201
```

#### Deployed WSS smoke

```bash
pnpm smoke:ws wss://reccado-dev.<your-subdomain>.workers.dev/api/mailboxes/mbx_test/ws
```

Output:

```
OK: connected
hello: {"type":"hello","mailboxId":"mbx_test","connectionCount":1}
OK: received hello
pong: {"type":"pong","mailboxId":"mbx_test","connectionCount":1}
OK: received pong
echo: {"type":"echo","mailboxId":"mbx_test","connectionCount":1,"payload":"{\"type\":\"echo-test\",\"payload\":\"phase-0.2\"}"}
OK: received echo
PASS: smoke-ws completed
```

Remote health and root:

```
curl https://reccado-dev.<your-subdomain>.workers.dev/api/health -> {"ok":true}
curl https://reccado-dev.<your-subdomain>.workers.dev/ -> HTTP 200
```

#### Cleanup of accidental non-dev worker

The accidental `reccado` Worker created by the first deploy attempt was removed because it was outside the dev-only Phase 0.2 scope:

```bash
pnpm wrangler delete reccado --force
```

Output:

```
Successfully deleted reccado
```

Verification:

```
pnpm wrangler deployments list --name reccado-dev --json
# version_id 7eeeaa63-4966-4062-b26d-4cc6575b5201 exists

pnpm wrangler deployments list --name reccado --json
# Worker does not exist on your account. [code: 10007]
```

### Phase 0.2 result

**PHASE 0.2 PASS** — hibernatable WebSocket Durable Object works locally and in deployed dev. Phase 0.3 not started.

---

## 9. Phase 0.3 - Email Routing to R2 to Queue to DO (2026-06-30)

### Implementation

| File | Change |
|------|--------|
| `src/cloudflare/email-handler.ts` | Added minimal Email Routing handler: reads raw MIME bytes, computes SHA-256, writes raw MIME to R2, sends metadata-only Queue message |
| `src/cloudflare/queue-consumer.ts` | Added Queue consumer: validates schema, checks R2 object exists, calls mailbox DO ingest, acks only after DO success |
| `src/cloudflare/local-email.ts` | Added local/dev simulation helper for `/cdn-cgi/handler/email` and `/api/debug/phase0/email` |
| `src/cloudflare/types.ts` | Added `InboundEmailQueueMessage` and ingest result contracts |
| `src/do/mailbox-do.ts` | Added minimal SQLite `ingest_events` and `messages` tables plus idempotent `/ingest` and `/debug` endpoints |
| `src/server.ts` | Exported `email()` and `queue()` handlers; added Phase 0 debug endpoints |
| `wrangler.jsonc` | Added R2, Queue/DLQ, D1 dev bindings and Queue consumer config |
| `fixtures/mime/*.eml` | Added local and Cloudflare Email Sending smoke fixtures |
| `scripts/smoke-email-local.ts` | Added duplicate-delivery smoke asserting one DO message |

The Email handler does **not** parse MIME body content. It reads only envelope plus headers available on `ForwardableEmailMessage`, stores raw bytes in R2, and sends a queue payload containing metadata only.

### Dev resources created

```bash
pnpm wrangler r2 bucket create inbox-mcp-raw-dev
pnpm wrangler queues create inbox-mcp-inbound-dev
pnpm wrangler queues create inbox-mcp-inbound-dlq-dev
pnpm wrangler d1 create inbox-mcp-index-dev --location=weur
```

Evidence:

```
R2 bucket: inbox-mcp-raw-dev
Queue: inbox-mcp-inbound-dev, producers=1, consumers=1
DLQ: inbox-mcp-inbound-dlq-dev
D1: inbox-mcp-index-dev, uuid ca3b5109-17bf-4a6e-9943-9892c4e04dbc
```

### Email Routing rule on `example.com`

Created a single literal test rule, leaving existing `hello@example.com` and catch-all untouched:

```bash
pnpm wrangler email routing rules create example.com \
  --name "inbox-mcp phase0 dev" \
  --match-type literal \
  --match-field to \
  --match-value test@example.com \
  --action-type worker \
  --action-value reccado-dev \
  --priority 10
```

Rule ID:

```
ed0c2b92a9e347348fafaa1f92848335
Matchers: literal to = test@example.com
Actions: worker: reccado-dev
```

### Validation gate

#### Typegen and build

```bash
pnpm wrangler types --env dev
pnpm run build
```

Output:

```
MAIL_OBJECTS: R2Bucket;
INDEX_DB: D1Database;
INBOUND_EMAIL_QUEUE: Queue;
MAILBOX_DO: DurableObjectNamespace<...MailboxDurableObject>;
✓ built in 150ms (client)
✓ built in 128ms (ssr)
```

#### Local Email Routing simulation

```bash
pnpm dev
pnpm smoke:email:local http://localhost:3001 fixtures/mime/simple-text.eml
```

Key output:

```
first-delivery: Worker successfully processed email
r2-head: {"exists":true,"key":"raw/dev/mbx_test/...-c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4.eml","size":250,...}
duplicate-delivery: Worker successfully processed email
debug: {"messageCount":1,"messages":[{"id":"02a9c077-382a-445f-afe2-45bf21778d8c","idempotency_key":"email:v1:mbx_test:message-id:phase-0.3-smoke@example.com",...}]}
queue-payload-sample: {"eventType":"email.received.v1","mailboxId":"mbx_test","rawR2Key":"raw/dev/mbx_test/...eml","rawSha256":"c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4","idempotencyKey":"email:v1:mbx_test:message-id:phase-0.3-smoke@example.com"}
PASS: local email smoke completed with one DO message after duplicate delivery
```

Worker logs confirmed metadata-only queue body size and idempotent duplicate ingest:

```
email.received { mailboxId: 'mbx_test', rawR2Key: 'raw/dev/...eml', rawSize: 250, queuePayloadBytes: 813 }
email.ingested { result: { status: 'inserted', messageCount: 1, ... } }
email.ingested { result: { status: 'duplicate', messageCount: 1, ... } }
QUEUE inbox-mcp-inbound-dev 2/2
```

#### Dev deploy

```bash
pnpm wrangler deploy --env dev --name reccado-dev
```

Output:

```
Binding env.MAILBOX_DO (MailboxDurableObject) Durable Object
Binding env.INBOUND_EMAIL_QUEUE (inbox-mcp-inbound-dev) Queue
Binding env.INDEX_DB (inbox-mcp-index-dev) D1 Database
Binding env.MAIL_OBJECTS (inbox-mcp-raw-dev) R2 Bucket
Uploaded reccado-dev
Producer for inbox-mcp-inbound-dev
Consumer for inbox-mcp-inbound-dev
Current Version ID: 4c1300f3-b98b-4e7c-90fa-90cf92cbc2f0
```

#### Remote R2 -> Queue -> DO smoke

Cloudflare blocks direct external `/cdn-cgi/handler/email` fetches with error 1042, so the remote spike used the dev-only debug endpoint `/api/debug/phase0/email`, which calls the same email handler code path with a posted raw MIME fixture.

```bash
curl --request POST \
  "https://reccado-dev.<your-subdomain>.workers.dev/api/debug/phase0/email?from=sender@example.com&to=test@example.com" \
  --data-binary @fixtures/mime/simple-text.eml
```

Output:

```
{"ok":true,"from":"sender@example.com","to":"test@example.com","rawSize":250}
```

Remote DO state after first delivery:

```
{"messageCount":1,"messages":[{"id":"e80683d2-c3d5-4482-b7d6-2da2f012327f","idempotency_key":"email:v1:mbx_test:message-id:phase-0.3-smoke@example.com","raw_r2_key":"raw/dev/mbx_test/2026/06/30/1782831679063-c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4.eml","raw_sha256":"c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4","subject":"Phase 0.3 smoke"}]}
```

Remote R2 head:

```
{"exists":true,"key":"raw/dev/mbx_test/2026/06/30/1782831679063-c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4.eml","size":250,"customMetadata":{"mailboxId":"mbx_test","messageId":"phase-0.3-smoke@example.com","rawSha256":"c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4","receivedAt":"2026-06-30T15:01:19.063Z","schemaVersion":"1"}}
```

After posting the same fixture again, remote DO state remained:

```
{"messageCount":1,...}
```

#### Real Email Routing attempt

`test@example.com -> reccado-dev` is configured. A same-account test using Cloudflare Email Sending:

```bash
pnpm wrangler email sending send-raw \
  --from smoke@mail.example.com \
  --to test@example.com \
  --mime-file fixtures/mime/cloudflare-send-raw.eml
```

returned:

```
Email sent successfully.
```

No message appeared in the DO after polling for roughly 40 seconds. This likely means same-account Email Sending did not recirculate through Email Routing, so it is recorded as inconclusive rather than used as pass evidence. The routing rule remains active for a future true external sender test.

#### Real external inbound email

Santi sent a real external email to `test@example.com` after the initial run. This validated Cloudflare Email Routing invoking the Worker and the full deployed path to R2, Queue, and DO.

Debug token was rotated temporarily for this validation because Cloudflare secrets are write-only. First read returned `404` during secret propagation; the second retry succeeded.

DO debug state:

```
{"messageCount":2,"messages":[{"id":"e80683d2-c3d5-4482-b7d6-2da2f012327f","idempotency_key":"email:v1:mbx_test:message-id:phase-0.3-smoke@example.com","raw_r2_key":"raw/dev/mbx_test/2026/06/30/1782831679063-c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4.eml","raw_sha256":"c689c8099dcfb9908c2bb78e5d345e9a98b0320f5d00fda0283b70c1883f2ed4","subject":"Phase 0.3 smoke"},{"id":"b7c0b58d-bd70-481d-a025-c77876becb06","idempotency_key":"email:v1:mbx_test:message-id:cahyeh2367r5g6ukq_r-pcxhkbuscf7ucguexwi5yu=pqez89ca@mail.gmail.com","raw_r2_key":"raw/dev/mbx_test/2026/06/30/1782834102709-837a404b5a856db15c1bbbc2f65c416fb11dd2a86ac3ff73f46a498b97e926b8.eml","raw_sha256":"837a404b5a856db15c1bbbc2f65c416fb11dd2a86ac3ff73f46a498b97e926b8","subject":"test from gmail"}]}
```

R2 head for the external message:

```
{"exists":true,"key":"raw/dev/mbx_test/2026/06/30/1782834102709-837a404b5a856db15c1bbbc2f65c416fb11dd2a86ac3ff73f46a498b97e926b8.eml","size":6696,"customMetadata":{"mailboxId":"mbx_test","messageId":"cahyeh2367r5g6ukq_r-pcxhkbuscf7ucguexwi5yu=pqez89ca@mail.gmail.com","rawSha256":"837a404b5a856db15c1bbbc2f65c416fb11dd2a86ac3ff73f46a498b97e926b8","receivedAt":"2026-06-30T15:41:42.709Z","schemaVersion":"1"}}
```

Active Worker after debug-token rotations:

```
Deployment ID: afe156d5-ce75-45e9-a33d-7c862bb9c6c4
Version ID: d9b30c39-84d2-43e1-af19-b606aecab091
Created: 2026-06-30T15:44:14.180057Z
```

### Phase 0.3 result

**PHASE 0.3 PASS** — local Email Routing simulation, deployed dev debug path, and true external inbound email all pass through R2 -> Queue -> DO. Duplicate delivery is idempotent, and `example.com` has a working worker routing rule for `test@example.com`.

### Final main-worktree verification

After integrating the validated worktree into `~/code/reccado`, the gates were rerun from the main checkout:

```bash
pnpm install
pnpm wrangler types --env dev
pnpm run build
pnpm run deploy:dev
pnpm smoke:ws wss://reccado-dev.<your-subdomain>.workers.dev/api/mailboxes/mbx_test/ws
```

Final deploy evidence:

```
Uploaded reccado-dev
Deployed reccado-dev triggers
https://reccado-dev.<your-subdomain>.workers.dev
Producer for inbox-mcp-inbound-dev
Consumer for inbox-mcp-inbound-dev
Current Version ID: 3392f7f0-444c-4f78-bcc7-63cb34fa2fd5
```

Final remote checks:

```
GET /api/health -> {"ok":true}
WSS smoke -> PASS: smoke-ws completed
Debug endpoints require `x-phase0-debug-token`; no header -> HTTP 404
POST /api/debug/phase0/email duplicate fixture with token -> {"ok":true,...}
GET /api/debug/phase0/mailboxes/mbx_test with token -> {"messageCount":1,...}
Queue list -> inbox-mcp-inbound-dev producers=1 consumers=1; inbox-mcp-inbound-dlq-dev present
```

## Phase 0.4 - Agentic Inbox Fork Deploy

**Date:** 2026-06-30  
**Result:** **PHASE 0.4 PASS**  
**Senior sign-off:** PASS after manual Cloudflare Access enablement on the disposable `workers.dev` route and authenticated UI load.

### Scope

The spike was limited to reading and deploying Cloudflare `agentic-inbox` unchanged in a disposable location. No `agentic-inbox` source was copied into this repository.

Temporary clone:

```
/tmp/agentic-inbox
origin git@github.com:cloudflare/agentic-inbox.git
HEAD 48039bb6785af34e592c2966f87cde2b255c4c80
```

### Disposable deploy attempt

The disposable deploy initially succeeded from `/tmp/agentic-inbox` with a worker-name override:

```
Uploaded agentic-inbox-spike04-20260630155638
Deployed agentic-inbox-spike04-20260630155638 triggers
https://agentic-inbox-spike04-20260630155638.<your-subdomain>.workers.dev
Current Version ID: c15483fc-f7e9-4610-8960-97e4b1ade239
```

The deployed app returned its own fail-closed message because Access vars were not configured:

```bash
curl -i -sS https://agentic-inbox-spike04-20260630155638.<your-subdomain>.workers.dev/
```

Observed body:

```
Cloudflare Access must be configured in production. Set POLICY_AUD and TEAM_DOMAIN.
```

This is not sufficient gate evidence. It is app-level enforcement, not Cloudflare Access edge enforcement.

The first disposable Worker was later removed or not retained by Cloudflare:

```bash
pnpm wrangler deployments list --name agentic-inbox-spike04-20260630155638
```

Output:

```
This Worker does not exist on your account. [code: 10007]
```

R2 bucket list did not show a new `agentic-inbox` bucket after the aborted spike; only pre-existing buckets and `inbox-mcp-raw-dev` were listed.

### Manual Access-protected deploy

Santi redeployed the upstream fork unchanged to:

```
https://agentic-inbox-spike04-manual.<your-subdomain>.workers.dev
```

Deployment evidence:

```bash
npx wrangler deployments list --name agentic-inbox-spike04-manual
```

Output:

```
Created:     2026-06-30T16:12:00.710Z
Author:      user@example.com
Source:      Upload
Version(s):  (100%) 815a0d45-c1a0-4728-8a9e-f3fa3cb05ee0
```

Cloudflare Dashboard showed:

```
This Worker URL requires Access login.
Access is restricting:
agentic-inbox-spike04-manual.<your-subdomain>.workers.dev
Audience (aud):
9cfdebba30b8527878cdd86690ec0862cf038e34c2f50127011de92827e21de7
JWK URL:
https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs
```

The upstream app requires the Access audience and team domain to validate the JWT after the edge login. These were uploaded as Worker secrets:

```bash
printf '%s' '9cfdebba30b8527878cdd86690ec0862cf038e34c2f50127011de92827e21de7' \
  | wrangler secret put POLICY_AUD --name agentic-inbox-spike04-manual

printf '%s' 'https://<your-team>.cloudflareaccess.com' \
  | wrangler secret put TEAM_DOMAIN --name agentic-inbox-spike04-manual
```

Outputs:

```
Success! Uploaded secret POLICY_AUD
Success! Uploaded secret TEAM_DOMAIN
```

Secret-change deployments:

```
Created:     2026-06-30T16:15:41.375Z
Source:      Secret Change
Version(s):  (100%) d6e90eca-d389-4800-b2f3-8c1d063c7607

Created:     2026-06-30T16:15:41.416Z
Source:      Secret Change
Version(s):  (100%) 25fb21aa-5dd9-4264-932d-f389731ceb7c
```

### Access validation

Unauthenticated request:

```bash
curl -si https://agentic-inbox-spike04-manual.<your-subdomain>.workers.dev/ | sed -n '1,30p'
```

Output excerpt:

```
HTTP/2 302
location: https://<your-team>.cloudflareaccess.com/cdn-cgi/access/login/agentic-inbox-spike04-manual.<your-subdomain>.workers.dev?kid=9cfdebba30b8527878cdd86690ec0862cf038e34c2f50127011de92827e21de7...
www-authenticate: Cloudflare-Access resource_metadata="https://agentic-inbox-spike04-manual.<your-subdomain>.workers.dev/.well-known/cloudflare-access-protected-resource/"
server: cloudflare
```

This proves the Worker is protected by Cloudflare Access at the edge, not merely by the app's own fail-closed handler.

Authenticated browser result:

```
Screenshot: /var/folders/jt/kd146lv50yx9_f93069569280000gn/T/orca-paste-1782836245634-a2d04945-590a-44fb-b301-7dc6ff6bd318.png
Observed UI: Mailboxes page for example.com with "New Mailbox" and "No mailboxes yet".
```

### Access automation note

Wrangler version:

```bash
pnpm wrangler --version
# 4.105.0
```

Wrangler has no Access command:

```bash
pnpm wrangler access --help
```

Output excerpt:

```
Unknown argument: access
```

Future API-only Access setup for custom hostnames requires a Cloudflare API token with Access Apps/Policies write permissions. For `workers.dev`, the documented path used here was the Dashboard `Enable Cloudflare Access` control.

### License/provenance notes

- `agentic-inbox` was inspected only as an external reference.
- No source code from `agentic-inbox`, `mailflare`, or another inbox implementation was copied into this product repo.
- If any implementation later reuses concepts from `agentic-inbox`, keep it at the behavior/pattern level and record Apache 2.0 attribution obligations before copying any text or code. Current decision: **copied code: none; reimplemented concepts only.**

Observed reusable concepts:

- App-level fail-closed Access JWT validation with `POLICY_AUD` and `TEAM_DOMAIN`.
- Mailbox Durable Object as mailbox-local state boundary.
- Separate MCP/agent Durable Objects from the core mailbox object.
- R2 for object/attachment storage rather than storing large blobs in SQLite.

Observed concepts not accepted as-is:

- Shared Access authorization model where any Access-approved teammate can access all mailboxes.
- Direct outbound send endpoint without the Phase 1.7 human confirmation/idempotency contract.
- Importing upstream UI/API code; this product will reimplement the Tier A surface from `docs/ARCHITECTURE.md`.

References checked:

- Cloudflare Workers `workers.dev` Access setup: https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- Cloudflare Access self-hosted applications: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Cloudflare Zero Trust organizations API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/organizations/
- Cloudflare Access application policy API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/subresources/policies/
- Cloudflare Access service tokens API: https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/service_tokens/

### Phase 0.4 result

**PHASE 0.4 PASS** — unchanged upstream deploy was feasible on a disposable Worker, real Cloudflare Access edge protection was validated by unauthenticated `302` to `<your-team>.cloudflareaccess.com`, authenticated login loaded the upstream UI, provenance is clear, and no external inbox source was copied into this repo.

## Phase 0.5 - Limits And Failure Modes

**Date:** 2026-06-30
**Result:** **PHASE 0.5 PASS**
**Senior sign-off:** PASS. Queue payload remains metadata-only and comfortably below Cloudflare Queues limits; raw MIME is stored in R2; local/prod test-size mismatch is documented.

### Confirmed Cloudflare limits

| Area | Accepted value | Source | Repo implication |
| --- | ---: | --- | --- |
| Email Routing inbound message size | 25 MiB | https://developers.cloudflare.com/email-service/platform/limits/ | Incoming raw MIME can be up to 25 MiB; store it in R2, never SQLite or Queue. |
| Queue message body | 128 KiB per message; `sendBatch` is 100 messages or 256 KiB total | https://developers.cloudflare.com/queues/platform/limits/ | Queue body must stay a metadata envelope only. |
| Email Sending recipients | 50 combined `to`/`cc`/`bcc` recipients | https://developers.cloudflare.com/email-service/platform/limits/ | Outbound fan-out must split above 50 recipients. |
| Email Sending message size | 5 MiB default; 25 MiB for verified destination addresses | https://developers.cloudflare.com/email-service/platform/limits/ | Draft/send UI must budget attachments and treat 25 MiB as verified-destination-only. |
| Durable Objects SQLite storage | 10 GB per object; max row/string/BLOB 2 MB; 100 columns/table; 100 bound params/query; 100 KiB SQL statement length | https://developers.cloudflare.com/durable-objects/platform/limits/ | SQLite stores metadata/indexes/state, not raw MIME or attachment blobs. |
| Durable Objects SQLite quota/billing | Free plan includes limited row reads/writes/storage; paid plan has higher included monthly caps | https://developers.cloudflare.com/durable-objects/platform/pricing/ | Keep ingest write amplification low and index selectively. |
| R2 object limits | 5 TiB max object; 5 GiB single-part upload; 4.995 TiB multipart; same-key concurrent writes limited | https://developers.cloudflare.com/r2/platform/limits/ | One immutable R2 object per raw message is well within limits; use unique keys and idempotency. |

### Implementation added

- `scripts/generate-large-mime.ts` generates deterministic large MIME fixtures outside git.
- `scripts/smoke-large-email-local.ts` posts a generated MIME fixture to local `/cdn-cgi/handler/email`, waits for DO ingest, checks R2 head, and prints queue payload size.
- `package.json` scripts:
  - `pnpm generate:large-mime`
  - `pnpm smoke:email:large`
- `.gitignore` excludes `.tmp/` so generated near-limit fixtures are not committed.

### Validation commands

Typegen and build:

```bash
pnpm exec tsc --noEmit
pnpm wrangler types --env dev
pnpm run build
```

Outputs:

```
pnpm exec tsc --noEmit -> no output, exit 0
Types written to worker-configuration.d.ts
✓ built in 166ms   (client)
✓ built in 133ms   (ssr)
```

Generate near-production fixture:

```bash
pnpm generate:large-mime .tmp/large-email-near-limit.eml 24
```

Output:

```
{
  "outputPath": ".tmp/large-email-near-limit.eml",
  "targetMiB": 24,
  "targetBytes": 25165824,
  "size": 25165824,
  "sizeMiB": 24,
  "messageId": "phase-0.5-large-smoke@example.com"
}
```

Local dev cannot ingest the 24 MiB fixture because Cloudflare's local email testing path has a lower limit:

```bash
pnpm smoke:email:large http://localhost:3001 .tmp/large-email-near-limit.eml
```

Output:

```
delivery: Email message size is within the production size limit of 25MiB, but exceeds the lower 1Mib limit for testing locally.
Error: delivery failed with 400
```

This is recorded as expected local tooling behavior, not product pass evidence.

Generate and smoke a local-limit fixture:

```bash
pnpm generate:large-mime .tmp/large-email-local-limit.eml 0.9
pnpm smoke:email:large http://localhost:3001 .tmp/large-email-local-limit.eml
```

Output:

```
{
  "outputPath": ".tmp/large-email-local-limit.eml",
  "targetMiB": 0.9,
  "targetBytes": 943718,
  "size": 943718,
  "sizeMiB": 0.9,
  "messageId": "phase-0.5-large-smoke@example.com"
}
delivery: Worker successfully processed email
large-smoke: {
  "fileSize": 943718,
  "fileSizeMiB": 0.9,
  "durationMs": 2294,
  "r2Head": {
    "exists": true,
    "key": "raw/dev/mbx_test/2026/06/30/1782836596871-f21d1d4f57aeaae2386747a11fe6ed75e0c351181e672cd63262e51a9fd0ccc4.eml",
    "size": 943718,
    "customMetadata": {
      "mailboxId": "mbx_test",
      "messageId": "phase-0.5-large-smoke@example.com",
      "rawSha256": "f21d1d4f57aeaae2386747a11fe6ed75e0c351181e672cd63262e51a9fd0ccc4",
      "receivedAt": "2026-06-30T16:23:16.871Z",
      "schemaVersion": "1"
    }
  },
  "queuePayloadBytes": 341,
  "queuePayloadUnder128KiB": true,
  "rawR2Key": "raw/dev/mbx_test/2026/06/30/1782836596871-f21d1d4f57aeaae2386747a11fe6ed75e0c351181e672cd63262e51a9fd0ccc4.eml",
  "subject": "Phase 0.5 large MIME smoke"
}
PASS: large local email smoke stored raw MIME in R2 and kept Queue payload small
```

Handler log from local dev:

```
email.received {
  mailboxId: 'mbx_test',
  rawR2Key: 'raw/dev/mbx_test/2026/06/30/1782836596871-f21d1d4f57aeaae2386747a11fe6ed75e0c351181e672cd63262e51a9fd0ccc4.eml',
  rawSha256: 'f21d1d4f57aeaae2386747a11fe6ed75e0c351181e672cd63262e51a9fd0ccc4',
  rawSize: 943718,
  queuePayloadBytes: 839
}
email.ingested {
  attempts: 1,
  result: {
    status: 'inserted',
    mailboxId: 'mbx_test',
    messageCount: 1,
    idempotencyKey: 'email:v1:mbx_test:message-id:phase-0.5-large-smoke@example.com'
  }
}
QUEUE inbox-mcp-inbound-dev 1/1
```

The script's printed `341` byte sample is a reduced evidence sample; the authoritative handler log reports the actual queue body as `839` bytes. Both are far below the 128 KiB Queue limit.

After TypeScript cleanup, the smoke was rerun and remained green. The second run hit the same Message-ID and the DO correctly returned `status: 'duplicate'` with `messageCount: 1`, while the handler still logged `queuePayloadBytes: 839`.

### Mitigations accepted

- Raw MIME is written to R2 before queue enqueue.
- Queue payload contains only metadata, object key, hashes, headers, routing, and idempotency data.
- `handleEmail()` calculates serialized queue payload size and fails before enqueue if it exceeds `128 * 1024` bytes.
- DO SQLite rows hold only metadata and object keys, avoiding the 2 MB row/string/BLOB limit.
- R2 keys include mailbox/date/hash entropy and avoid hot same-key overwrites.
- Outbound implementation in Phase 1.7 must enforce 50-recipient and 5 MiB default Email Sending limits before `env.EMAIL.send()`.

### Phase 0.5 result

**PHASE 0.5 PASS** — official limits are recorded, a 24 MiB near-production MIME fixture can be generated without committing it, local email testing limit behavior is documented, and the executable local smoke proves the handler stores raw MIME in R2 while keeping Queue payload size far below 128 KiB.
