# Reccado Implementation Runbook

## Scope

Source of truth: `internal planning notes (not in repo)`, read on 2026-06-30.

This document is the implementation and runbook spec for building a self-hosted multi-domain email inbox on Cloudflare Workers with TanStack Start, Hono, Durable Objects, R2, Queues, D1, Email Routing, Email Sending, Access, Cron, and later Workflows/Agents/MCP/RAG.

This document does not define the final architecture narrative. Another worker owns `docs/ARCHITECTURE.md`. Do not modify that file as part of implementing this runbook unless explicitly asked.

Non-goals for Tier A:

- No AI drafting, MCP, embeddings, or RAG in the hot path.
- No copying code from `mailflare`; only reimplement architectural patterns from scratch.
- No D1-as-primary-store design. D1 is only a cross-mailbox index and operational catalog.
- No Workflow in the ingest hot path.

Tier A must be usable as a real inbox without AI. Tier B adds the agent/MCP/RAG layer on top without rewriting Tier A.

## Prerequisites

- Cloudflare account with Workers, Durable Objects, R2, Queues, D1, Email Routing, Email Sending, Cron Triggers, Access, and optionally Workflows enabled.
- Workers Paid plan before arbitrary outbound sending or production-ish usage. The wiki calls this out for send-to-arbitrary-recipient behavior.
- At least one test domain fully active on Cloudflare DNS, plus one disposable test mailbox/alias.
- Node.js installed. Use the current active LTS supported by Wrangler and record the version in the first validation gate.
- Package manager chosen before bootstrap. Recommended: `pnpm`.
- Wrangler authenticated locally: `pnpm wrangler login` or `npx wrangler login`.
- Access/Zero Trust tenant configured with Santi's identity provider or email allowlist.
- A stable dev environment name: `dev`.
- A stable production environment name: `prod`.
- Test sender mailbox outside Cloudflare, so inbound and outbound tests are not circular.
- Senior decision on OSS license before publishing beyond private development.

## Proposed Repo Structure

Use this as the target shape after bootstrap. Some files will not exist until their phase.

```text
.
|-- docs/
|   |-- ARCHITECTURE.md
|   `-- IMPLEMENTATION.md
|-- fixtures/
|   |-- mime/
|   |   |-- simple-text.eml
|   |   |-- html-only.eml
|   |   |-- multipart-alternative.eml
|   |   |-- attachment-small.eml
|   |   |-- inline-image.eml
|   |   |-- missing-message-id.eml
|   |   |-- duplicate-message-id-a.eml
|   |   |-- duplicate-message-id-b.eml
|   |   `-- prompt-injection.eml
|   `-- queues/
|       |-- inbound-email.json
|       `-- poison-message.json
|-- migrations/
|   `-- d1/
|       |-- 0001_initial.sql
|       `-- 0002_message_index.sql
|-- scripts/
|   |-- generate-large-mime.ts
|   |-- smoke-email-local.ts
|   |-- smoke-ws.ts
|   `-- verify-cloudflare-bindings.ts
|-- src/
|   |-- server.ts
|   |-- app/
|   |   |-- routes/
|   |   |-- components/
|   |   `-- styles/
|   |-- api/
|   |   |-- hono.ts
|   |   |-- auth.ts
|   |   |-- endpoints/
|   |   `-- schemas.ts
|   |-- cloudflare/
|   |   |-- email-handler.ts
|   |   |-- queue-consumer.ts
|   |   |-- scheduled.ts
|   |   |-- bindings.ts
|   |   `-- workflows.ts
|   |-- db/
|   |   |-- d1.ts
|   |   `-- d1-schema.sql
|   |-- do/
|   |   |-- mailbox-do.ts
|   |   |-- mailbox-schema.sql
|   |   |-- mailbox-realtime.ts
|   |   `-- mailbox-ingest.ts
|   |-- lib/
|   |   |-- mailbox-id.ts
|   |   |-- r2-keys.ts
|   |   |-- crypto.ts
|   |   |-- mime.ts
|   |   |-- idempotency.ts
|   |   |-- outbound.ts
|   |   `-- errors.ts
|   `-- tests/
|       |-- unit/
|       |-- workers/
|       `-- e2e/
|-- package.json
|-- tsconfig.json
|-- vite.config.ts
|-- vitest.config.ts
|-- worker-configuration.d.ts
`-- wrangler.jsonc
```

## Bootstrap Steps

Commands below are intentionally explicit. Commands that depend on current package versions or scaffold behavior are marked `VERIFY` and must be checked against upstream docs immediately before execution.

### 1. Scaffold TanStack Start for Workers

The repository already contains docs and `.git`, so avoid running a scaffold that refuses non-empty directories. Use a temporary scaffold and copy generated app files back without deleting docs.

```sh
cd ~/code

# VERIFY: current Cloudflare C3 command and framework flag before running.
pnpm create cloudflare@latest reccado-scaffold --framework=tanstack-start

cd ~/code/reccado-scaffold
pnpm install
pnpm run build
```

Copy the scaffolded application into the real repo with supervision:

```sh
cd ~/code

# VERIFY: run with --dry-run first and confirm it does not touch docs/ARCHITECTURE.md
# or docs/IMPLEMENTATION.md.
rsync -av --dry-run \
  --exclude '.git/' \
  --exclude 'docs/' \
  reccado-scaffold/ reccado/

rsync -av \
  --exclude '.git/' \
  --exclude 'docs/' \
  reccado-scaffold/ reccado/
```

Acceptance criteria:

- `package.json`, `vite.config.ts`, `wrangler.jsonc`, and `src/` exist in the real repo.
- `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION.md` are unchanged by the copy.
- `pnpm run build` succeeds in the real repo.

Validation gate:

- Command/manual test: run `git status --short --untracked-files=all`, `pnpm install`, and `pnpm run build`.
- Expected evidence: status shows scaffold files plus docs only; build completes without TypeScript or Vite errors.
- Pass/fail: fail if docs are overwritten, the scaffold creates nested app directories, or build fails.
- Document before moving on: paste the exact C3 version/command used and any prompts selected into the issue or implementation log.

### 2. Convert to a Custom Worker Entrypoint

Cloudflare's TanStack Start Workers guide uses `@tanstack/react-start/server-entry` by default, but a custom entrypoint is required for `email`, `queue`, `scheduled`, DO exports, and later Workflow exports.

Target `src/server.ts` shape:

```ts
import startHandler from "@tanstack/react-start/server-entry";
import { Hono } from "hono";

export { MailboxDurableObject } from "./do/mailbox-do";

const api = new Hono<{ Bindings: Env }>();

api.get("/api/health", (c) => c.json({ ok: true }));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }
    return startHandler.fetch(request, env, ctx);
  },
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    const { handleEmail } = await import("./cloudflare/email-handler");
    return handleEmail(message, env, ctx);
  },
  async queue(batch: MessageBatch<InboundEmailQueueMessage>, env: Env, ctx: ExecutionContext) {
    const { handleInboundQueue } = await import("./cloudflare/queue-consumer");
    return handleInboundQueue(batch, env, ctx);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { handleScheduled } = await import("./cloudflare/scheduled");
    return handleScheduled(event, env, ctx);
  },
} satisfies ExportedHandler<Env, InboundEmailQueueMessage>;
```

Update `wrangler.jsonc`:

```jsonc
{
  "main": "src/server.ts",
  "compatibility_date": "2026-06-30",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true }
}
```

Acceptance criteria:

- TanStack pages still render through the custom `fetch`.
- `/api/health` returns JSON from Hono.
- Worker type generation still succeeds.

Validation gate:

- Command/manual test: `pnpm wrangler types`, `pnpm run build`, `pnpm run dev`, then `curl http://localhost:5173/api/health` or the active Vite port.
- Expected evidence: generated `worker-configuration.d.ts`, successful build, and `{"ok":true}` from health.
- Pass/fail: fail if TanStack routes 404, Hono routes shadow frontend routes, or typegen fails.
- Document before moving on: record actual local dev port and any custom entrypoint changes.

### 3. Add Core Packages

```sh
cd ~/code/reccado

# VERIFY versions before running.
pnpm add hono zod postal-mime mimetext

# VERIFY test package versions before running.
pnpm add -D vitest @cloudflare/vitest-pool-workers

pnpm wrangler types
```

Acceptance criteria:

- Dependencies install without peer dependency conflicts.
- `postal-mime` can parse a fixture in a Workers-compatible test.
- `mimetext` is only used where raw MIME construction is needed; prefer Email Service structured `send()` for new outbound mail.

Validation gate:

- Command/manual test: `pnpm test -- --run` after adding a minimal parser test, plus `pnpm run build`.
- Expected evidence: one parser test passes and build remains green.
- Pass/fail: fail if any package requires unsupported Node APIs under Workers even with `nodejs_compat`.
- Document before moving on: record package versions in the implementation log.

## Cloudflare Resources And Bindings Checklist

Use environment-specific names. Examples below use `dev`.

### Durable Object

- Class: `MailboxDurableObject`
- Binding: `MAILBOX_DO`
- Storage backend: SQLite only.
- Creation: via Wrangler DO binding and migration on deploy.

`wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "MAILBOX_DO", "class_name": "MailboxDurableObject" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["MailboxDurableObject"] }
  ]
}
```

Checklist:

- [ ] DO class exported from `src/server.ts`.
- [ ] `new_sqlite_classes` migration present.
- [ ] Mailbox ID maps to DO name through `env.MAILBOX_DO.getByName(mailboxId)`.
- [ ] Constructor migration is idempotent and fast.
- [ ] Hibernatable WebSockets use `ctx.acceptWebSocket(server)`.

### R2

- Bucket: `inbox-mcp-raw-dev`
- Binding: `MAIL_OBJECTS`
- Contents: raw MIME, parsed bodies too large for DO SQLite, attachments, exports/backups.

Commands:

```sh
# VERIFY location/jurisdiction flags before using them.
pnpm wrangler r2 bucket create inbox-mcp-raw-dev
```

`wrangler.jsonc`:

```jsonc
{
  "r2_buckets": [
    { "binding": "MAIL_OBJECTS", "bucket_name": "inbox-mcp-raw-dev" }
  ]
}
```

Checklist:

- [ ] Raw MIME is stored before queue send.
- [ ] Queue message carries R2 key, hash, and metadata only.
- [ ] R2 custom metadata includes `mailboxId`, `messageId`, `rawSha256`, `receivedAt`.
- [ ] Large attachments use R2, not DO SQLite blobs.
- [ ] Retention policy is documented before production.

### Queue And DLQ

- Queue: `inbox-mcp-inbound-dev`
- DLQ: `inbox-mcp-inbound-dlq-dev`
- Producer binding: `INBOUND_EMAIL_QUEUE`
- Consumer: same Worker initially.

Commands:

```sh
pnpm wrangler queues create inbox-mcp-inbound-dev
pnpm wrangler queues create inbox-mcp-inbound-dlq-dev
```

`wrangler.jsonc`:

```jsonc
{
  "queues": {
    "producers": [
      { "binding": "INBOUND_EMAIL_QUEUE", "queue": "inbox-mcp-inbound-dev" }
    ],
    "consumers": [
      {
        "queue": "inbox-mcp-inbound-dev",
        "dead_letter_queue": "inbox-mcp-inbound-dlq-dev",
        "max_batch_size": 5,
        "max_batch_timeout": 2,
        "max_retries": 3
      }
    ]
  }
}
```

Checklist:

- [ ] Queue body is below 128 KB.
- [ ] Consumer calls `msg.ack()` only after DO ingest and D1 index update succeed.
- [ ] Recoverable failures use `msg.retry({ delaySeconds })`.
- [ ] Poison messages reach DLQ after configured retries.
- [ ] DLQ has a manual replay/admin inspection plan before production.

### D1

- Database: `inbox-mcp-index-dev`
- Binding: `INDEX_DB`
- Purpose: domain/mailbox/alias catalog and cross-mailbox message index only.

Command:

```sh
# VERIFY location and --update-config support before running.
pnpm wrangler d1 create inbox-mcp-index-dev --location=weur --binding=INDEX_DB --update-config
```

Checklist:

- [ ] D1 migrations live under `migrations/d1`.
- [ ] D1 stores no raw MIME and no full attachment bodies.
- [ ] All D1 writes are idempotent by mailbox/message keys.
- [ ] D1 can be rebuilt from DO/R2 if needed.

### Email Routing And Email Sending

Inbound:

- Email Routing routes each test address or catch-all pattern to this Worker.
- `email()` handler validates, stores raw MIME in R2, and enqueues a small JSON message.

Outbound:

- Binding: `EMAIL`
- Prefer structured Email Service `env.EMAIL.send(...)`.
- Use `allowed_sender_addresses` for production; avoid unrestricted send binding.

`wrangler.jsonc`:

```jsonc
{
  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": [
        "noreply@example.com",
        "support@example.com"
      ]
    }
  ]
}
```

Checklist:

- [ ] Sender domains are onboarded to Email Service.
- [ ] Routing domain MX and routing rules are active.
- [ ] Inbound size limit is respected; Cloudflare rejects messages above its inbound limit.
- [ ] Outbound sends require explicit human confirmation in Tier A.
- [ ] Outbound sends use idempotency keys to avoid double-send.

### Access And Secrets

Secrets:

```sh
pnpm wrangler secret put MAILBOX_ID_SECRET
pnpm wrangler secret put CLOUDFLARE_API_TOKEN
pnpm wrangler secret put ACCESS_JWT_AUDIENCE
pnpm wrangler secret put ACCESS_TEAM_DOMAIN
```

Checklist:

- [ ] `.dev.vars*` and `.env*` are in `.gitignore`.
- [ ] Access protects UI and `/api/*`.
- [ ] Service token policy exists for automation if needed.
- [ ] Worker validates Access identity headers/JWT for API writes, not just UI pages.
- [ ] Cloudflare API token is least privilege for DNS, Email Routing, Workers deploy resources, and only zones needed.

### Cron

Use Cron for global periodic jobs only: backup/export sweep, DLQ alert scan, stale job reconciliation. Use DO Alarms for mailbox-local light jobs.

`wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["15 3 * * *"]
  }
}
```

Checklist:

- [ ] `scheduled()` handler is present in custom server entrypoint.
- [ ] Cron can run safely more than once.
- [ ] Cron writes an operational event row in D1.
- [ ] Cron does not parse inbound MIME.

### Workflows Lazy

Do not add Workflows in Tier A unless a real saga appears. Add later for:

- IMAP/mbox import.
- Reindex/export/backup with multiple resumable steps.
- Human-approved outbound send saga.
- RAG embedding backfill.

Future binding example:

```jsonc
{
  "workflows": [
    {
      "name": "inbox-mcp-backup-dev",
      "binding": "BACKUP_WORKFLOW",
      "class_name": "BackupWorkflow"
    }
  ]
}
```

## Data Contracts

### Mailbox ID Convention

Mailbox IDs must be stable, privacy-preserving, and valid as Durable Object names.

Canonical input:

```text
primaryAddress = lowercase(trim(localPart)) + "@" + lowercase(trim(domain))
mailboxId = "mbx_" + base32url(hmacSha256(MAILBOX_ID_SECRET, primaryAddress)).slice(0, 26)
```

Rules:

- Never use raw email addresses as DO names.
- D1 maps aliases to `mailboxId`.
- One DO instance owns one logical mailbox.
- Multiple aliases can route to one mailbox.
- `MAILBOX_ID_SECRET` must not rotate without a migration plan.

### R2 Key Convention

All keys are lowercase except hash and safe filename segments produced by code.

```text
raw/{env}/{mailboxId}/{yyyy}/{mm}/{dd}/{receivedAtMs}-{rawSha256}.eml
body/{env}/{mailboxId}/{messageLocalId}/text.txt
body/{env}/{mailboxId}/{messageLocalId}/html.html
attachments/{env}/{mailboxId}/{messageLocalId}/{attachmentSha256}-{safeFilename}
exports/{env}/{mailboxId}/{yyyy-mm-dd}/{exportId}.ndjson
backups/{env}/{yyyy-mm-dd}/{mailboxId}.sqlite.snapshot.json
```

Rules:

- `rawSha256` is SHA-256 over the exact raw MIME bytes stored in R2.
- `messageLocalId` is generated by the DO after idempotency check.
- Attachment filenames must be sanitized and may be replaced with `attachment.bin`.
- R2 metadata must include `mailboxId`, `rawSha256`, `receivedAt`, and `schemaVersion`.

### Queue Message Shape

Queue message type: `email.received.v1`.

```ts
export type InboundEmailQueueMessage = {
  schemaVersion: 1;
  eventType: "email.received.v1";
  traceId: string;
  enqueuedAt: string;
  receivedAt: string;

  mailboxId: string;
  domain: string;
  recipient: string;
  sender: string;

  rawR2Key: string;
  rawSha256: string;
  rawSize: number;

  messageId: string | null;
  headers: {
    subject: string | null;
    date: string | null;
    inReplyTo: string | null;
    references: string[];
  };

  routing: {
    ruleId: string | null;
    action: "store" | "forward" | "reject";
    matchedAlias: string;
  };

  idempotencyKey: string;
};
```

Idempotency key:

```text
if messageId exists:
  email:v1:{mailboxId}:message-id:{normalizedMessageId}
else:
  email:v1:{mailboxId}:raw-sha256:{rawSha256}
```

Rules:

- Queue message must stay below 128 KB.
- Queue message must never contain raw MIME, parsed HTML, parsed text body, or attachment content.
- Consumer must validate `schemaVersion` and `eventType`.
- Unknown schema goes to retry only if deploy skew is expected; otherwise DLQ with reason `unsupported_schema`.

### D1 Tables

Initial D1 schema:

```sql
CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  zone_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mailboxes (
  mailbox_id TEXT PRIMARY KEY,
  primary_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE aliases (
  alias_address TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(mailbox_id),
  domain_id TEXT NOT NULL REFERENCES domains(id),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE routing_rules (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  pattern TEXT NOT NULL,
  priority INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('store', 'forward', 'reject')),
  mailbox_id TEXT REFERENCES mailboxes(mailbox_id),
  forward_to_json TEXT NOT NULL DEFAULT '[]',
  reject_reason TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE message_index (
  mailbox_id TEXT NOT NULL,
  message_local_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  rfc_message_id TEXT,
  subject TEXT,
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL,
  snippet TEXT,
  received_at TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  labels_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL CHECK (state IN ('inbox', 'archive', 'trash', 'sent', 'draft')),
  raw_r2_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mailbox_id, message_local_id)
);

CREATE INDEX idx_message_index_received
  ON message_index(mailbox_id, received_at DESC);

CREATE INDEX idx_message_index_thread
  ON message_index(mailbox_id, thread_id);

CREATE INDEX idx_message_index_rfc_message_id
  ON message_index(mailbox_id, rfc_message_id);

CREATE TABLE ingest_events (
  idempotency_key TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  message_local_id TEXT,
  raw_r2_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'processed', 'failed')),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE outbound_sends (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'sending', 'sent', 'failed', 'cancelled')),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ops_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  subject TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

D1 write rules:

- Update `message_index` after DO ingest commits.
- If D1 index write fails after DO ingest succeeds, retry queue message. The DO idempotency table must make retry safe.
- If D1 is down, the mailbox remains authoritative and an index repair job can rebuild D1 later.

### Durable Object SQLite Tables

Each `MailboxDurableObject` owns one private SQLite database.

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailbox_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_events (
  idempotency_key TEXT PRIMARY KEY,
  raw_r2_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'processed', 'failed')),
  message_local_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  subject_norm TEXT,
  last_message_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL REFERENCES threads(id),
  rfc_message_id TEXT,
  in_reply_to TEXT,
  references_json TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  state TEXT NOT NULL CHECK (state IN ('inbox', 'archive', 'trash', 'sent', 'draft')),
  from_addr TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT,
  snippet TEXT,
  date_header TEXT,
  received_at TEXT NOT NULL,
  raw_r2_key TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  raw_size INTEGER NOT NULL,
  body_text TEXT,
  body_html_r2_key TEXT,
  parse_status TEXT NOT NULL CHECK (parse_status IN ('pending', 'parsed', 'failed')),
  has_attachments INTEGER NOT NULL DEFAULT 0,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_thread
  ON messages(thread_id, received_at ASC);

CREATE INDEX IF NOT EXISTS idx_messages_received
  ON messages(received_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_rfc_message_id
  ON messages(rfc_message_id);

CREATE TABLE IF NOT EXISTS message_headers (
  message_id TEXT NOT NULL REFERENCES messages(id),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  filename TEXT,
  content_type TEXT,
  disposition TEXT,
  content_id TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  color TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS message_labels (
  message_id TEXT NOT NULL REFERENCES messages(id),
  label_id TEXT NOT NULL REFERENCES labels(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);

CREATE TABLE IF NOT EXISTS contacts (
  email TEXT PRIMARY KEY,
  name TEXT,
  last_seen_at TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  match_json TEXT NOT NULL,
  action_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_drafts (
  id TEXT PRIMARY KEY,
  thread_id TEXT REFERENCES threads(id),
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_confirmation', 'sent', 'cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS realtime_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  subject,
  sender,
  recipients,
  snippet,
  body_text
);
```

FTS rules:

- Insert/update `message_fts` in the same DO transaction as `messages`.
- Store only normalized searchable text in FTS. Keep raw MIME and large HTML in R2.
- On parser failure, create a message row with `parse_status='failed'` and no FTS body; do not drop the email.
- Reindex is a mailbox-local job or later Workflow, never part of the inbound email handler.

### WebSocket Event Envelopes

Endpoint:

```text
GET /api/mailboxes/{mailboxId}/ws
```

Worker proxies upgrade requests to the mailbox DO. The DO accepts with the hibernation API.

Client to server:

```ts
type ClientWsEnvelope = {
  v: 1;
  id: string;
  type: "ping" | "subscribe" | "unsubscribe" | "mark_read" | "archive" | "request_snapshot";
  mailboxId: string;
  ts: string;
  payload: unknown;
};
```

Server to client:

```ts
type ServerWsEnvelope = {
  v: 1;
  id?: string;
  type:
    | "hello"
    | "pong"
    | "mailbox.snapshot"
    | "message.created"
    | "message.updated"
    | "thread.updated"
    | "ingest.started"
    | "ingest.failed"
    | "draft.updated"
    | "error";
  mailboxId: string;
  seq: number;
  ts: string;
  payload: unknown;
};
```

Rules:

- Batch logical server events when possible: `{ v: 1, type: "batch", messages: ServerWsEnvelope[] }`.
- WebSocket attachment stores `{ mailboxId, userId, scopes, lastSeenSeq }`.
- After hibernation, reconstruct subscriber state from `deserializeAttachment()`.
- No auth token should be sent as a WebSocket message. Auth is established before upgrade.

### HTTP API Endpoints

All `/api/*` endpoints require Access-authenticated identity unless explicitly marked public.

Health and identity:

```text
GET  /api/health
GET  /api/me
```

Mailboxes:

```text
GET  /api/mailboxes
POST /api/mailboxes
GET  /api/mailboxes/{mailboxId}
GET  /api/mailboxes/{mailboxId}/threads?limit=&cursor=&q=&label=
GET  /api/mailboxes/{mailboxId}/threads/{threadId}
GET  /api/mailboxes/{mailboxId}/messages/{messageId}
GET  /api/mailboxes/{mailboxId}/messages/{messageId}/raw
GET  /api/mailboxes/{mailboxId}/messages/{messageId}/attachments/{attachmentId}
POST /api/mailboxes/{mailboxId}/messages/{messageId}/actions
GET  /api/mailboxes/{mailboxId}/search?q=&limit=&cursor=
GET  /api/mailboxes/{mailboxId}/ws
```

Aliases and routing:

```text
GET  /api/domains
POST /api/domains
GET  /api/aliases
POST /api/aliases
GET  /api/routing-rules
POST /api/routing-rules
PATCH /api/routing-rules/{ruleId}
```

Outbound:

```text
POST /api/mailboxes/{mailboxId}/drafts
PATCH /api/mailboxes/{mailboxId}/drafts/{draftId}
POST /api/mailboxes/{mailboxId}/drafts/{draftId}/request-send
POST /api/mailboxes/{mailboxId}/drafts/{draftId}/confirm-send
POST /api/mailboxes/{mailboxId}/drafts/{draftId}/cancel
```

Admin/ops:

```text
GET  /api/admin/ops-events
GET  /api/admin/dlq
POST /api/admin/dlq/replay
POST /api/admin/reindex
POST /api/admin/backups/run
```

Future Tier B:

```text
GET  /mcp
POST /mcp
POST /api/ai/drafts
POST /api/ai/reindex-embeddings
```

## Phase 0 - Risk Spikes

Each spike should be short, isolated, and documented before production implementation starts.

### Spike 0.1 - Scaffold And Custom Entrypoint

Task:

- Scaffold TanStack Start for Workers.
- Replace default entrypoint with `src/server.ts`.
- Add one Hono `/api/health` endpoint.

Acceptance criteria:

- Local dev works.
- Build works.
- Hono API and TanStack route both respond.

Validation gate:

- Command/manual test: `pnpm run build`, `pnpm run dev`, `curl /api/health`, open `/`.
- Expected evidence: command output plus screenshot or curl response.
- Pass/fail: pass only if frontend and API work through the custom entrypoint.
- Document before moving on: actual C3 command, generated package versions, dev port, and entrypoint notes.

### Spike 0.2 - Durable Object Hibernatable WebSocket

Task:

- Create `MailboxDurableObject` with a hibernatable WebSocket echo endpoint.
- Proxy `/api/mailboxes/{mailboxId}/ws` to `env.MAILBOX_DO.getByName(mailboxId)`.
- Add a small client smoke script.

Acceptance criteria:

- WebSocket connects locally and in deployed dev.
- Echo response includes mailbox ID and connection count.
- DO uses `ctx.acceptWebSocket(server)`, not `server.accept()`.

Validation gate:

- Command/manual test: `pnpm run dev`, run `node scripts/smoke-ws.ts ws://localhost:<port>/api/mailboxes/mbx_test/ws`; then deploy dev and run the same smoke against HTTPS/WSS.
- Expected evidence: script logs `hello`, `pong`, and one echoed event; Worker logs show DO handling.
- Pass/fail: fail if upgrade goes through TanStack instead of DO, hibernation API is not used, or local/prod behavior diverges without explanation.
- Document before moving on: hibernation limitations observed locally and the exact deployed URL tested.

### Spike 0.3 - Email Routing To R2 To Queue To DO

Task:

- Implement minimal `email()` handler.
- Store raw MIME in R2.
- Send small queue message.
- Consumer calls DO ingest RPC.
- DO creates one `messages` row with idempotency.

Acceptance criteria:

- Local simulated email stores exactly one raw R2 object.
- Queue message contains no raw body.
- Duplicate delivery does not create a second DO message.

Validation gate:

- Command/manual test:

```sh
pnpm run dev
curl --request POST "http://localhost:<port>/cdn-cgi/handler/email" \
  --url-query "from=sender@example.com" \
  --url-query "to=test@example.com" \
  --data-binary @fixtures/mime/simple-text.eml
```

- Expected evidence: R2 key logged, queue body logged under 128 KB, DO message count remains `1` after sending the same fixture twice.
- Pass/fail: fail if MIME parsing happens in `email()` instead of queue/DO, if duplicate ingest creates duplicates, or if raw MIME appears in Queue logs.
- Document before moving on: R2 key example, queue payload example, and duplicate test result.

### Spike 0.4 - Agentic Inbox Fork Deploy

Task:

- Fork or clone Cloudflare `agentic-inbox` only to understand legal/base behavior and deploy unchanged to a test domain if still feasible.
- Do not copy mailflare source.
- Record reusable concepts only.

Acceptance criteria:

- Test deployment is Access-protected.
- Notes identify useful UI/DO/MCP patterns and what will not be copied.
- Any Apache 2.0 attribution obligations are recorded.

Validation gate:

- Command/manual test: deploy fork to a disposable worker/domain, login through Access, send one test request or open UI.
- Expected evidence: deployed URL, screenshots/logs, notes on license-safe reuse.
- Pass/fail: fail if deploy requires invasive changes or if code provenance is unclear.
- Document before moving on: attribution notes and explicit "copied vs reimplemented" decision.

### Spike 0.5 - Limits And Failure Modes

Task:

- Verify Cloudflare limits that matter: inbound size, Queue payload size, Email Sending size/recipients, DO SQLite row/write behavior, R2 object handling.
- Generate a near-limit MIME fixture via script rather than committing a huge binary fixture.

Acceptance criteria:

- Limit assumptions are confirmed against official docs and at least one local/prod smoke where feasible.
- Spec is updated if any limit changed.

Validation gate:

- Command/manual test: run `scripts/generate-large-mime.ts`, simulate local inbound, and record Cloudflare doc links/values checked.
- Expected evidence: generated file size, handler behavior, and link list.
- Pass/fail: fail if queue payload can exceed limit or if handler attempts to buffer large raw MIME unnecessarily.
- Document before moving on: final accepted limits and mitigations.

## Phase 1 - Tier A Inbox

### Milestone 1.1 - Project Foundation

Tasks:

1. Create final repo scaffold and scripts.
   - Acceptance criteria: `pnpm install`, `pnpm run build`, `pnpm wrangler types`, and `pnpm test -- --run` exist and run.
2. Add `wrangler.jsonc` with custom entrypoint and environment naming.
   - Acceptance criteria: dev config includes main, compatibility date, node compatibility, observability, and placeholder bindings.
3. Add test harness with Workers Vitest pool.
   - Acceptance criteria: one Worker-style test can call the Hono health route.
4. Add code style guard.
   - Acceptance criteria: TypeScript strictness is enabled or deviations are documented.

Validation gate:

- Command/manual test: `pnpm install`, `pnpm wrangler types`, `pnpm run build`, `pnpm test -- --run`.
- Expected evidence: all commands pass in a clean checkout after `pnpm install`.
- Pass/fail: fail if any generated type file is missing or if test harness cannot instantiate Worker bindings.
- Document before moving on: package versions, Node version, and Wrangler version.

### Milestone 1.2 - Cloudflare Resources

Tasks:

1. Create R2 bucket, Queue, DLQ, D1 database, DO binding, Email send binding, and Cron trigger.
   - Acceptance criteria: all resources exist in Cloudflare dashboard and `wrangler.jsonc`.
2. Add least-privilege secrets and local `.dev.vars.example`.
   - Acceptance criteria: no real secrets committed; required secret names documented.
3. Configure Access for UI and API.
   - Acceptance criteria: unauthenticated browser access is blocked, authorized Santi access works.

Validation gate:

- Command/manual test: run `scripts/verify-cloudflare-bindings.ts` or equivalent, `pnpm wrangler deploy --dry-run` if supported, then `pnpm wrangler deploy` to dev.
- Expected evidence: deploy output, dashboard resource screenshots or IDs, and Access login screenshot.
- Pass/fail: fail if Worker deploys without required bindings or API is reachable without Access.
- Document before moving on: resource names, database ID, bucket name, queue names, Access app name, and secret names.

### Milestone 1.3 - Mailbox Identity And Provisioning

Tasks:

1. Implement `mailbox-id.ts`.
   - Acceptance criteria: same canonical address produces same `mailboxId`; aliases never expose raw email in DO name.
2. Implement D1 `domains`, `mailboxes`, `aliases`, and `routing_rules`.
   - Acceptance criteria: migrations apply locally and remotely.
3. Add API for listing/creating mailboxes and aliases.
   - Acceptance criteria: Access-authenticated user can create a mailbox and alias; invalid domains fail validation.
4. Add initial domain provisioning admin workflow via Cloudflare API.
   - Acceptance criteria: can read zone/routing status; write operations are behind explicit confirmation.

Validation gate:

- Command/manual test: apply D1 migrations, create one mailbox and alias via API, then query D1.
- Expected evidence: D1 rows for domain/mailbox/alias and stable mailbox ID generated twice.
- Pass/fail: fail if alias lookup is ambiguous or if mailbox ID changes across deploys.
- Document before moving on: mailbox ID algorithm, alias rules, and any Cloudflare API scopes used.

### Milestone 1.4 - Inbound Hot Path

Tasks:

1. Implement `email()` handler.
   - Acceptance criteria: validates recipient, computes raw SHA-256, writes raw MIME to R2, enqueues JSON metadata.
2. Implement routing decision `store | forward | reject`.
   - Acceptance criteria: unmatched recipients reject or route according to configured default; store action enqueues; forward action uses `message.forward()` only for verified destinations.
3. Implement Queue consumer.
   - Acceptance criteria: validates message schema, calls DO, updates D1, acks only after all durable writes finish.
4. Implement DLQ-safe error handling.
   - Acceptance criteria: known transient errors retry; poison messages reach DLQ.

Validation gate:

- Command/manual test: local email simulation for store, forward, reject, duplicate, and poison cases.
- Expected evidence: R2 object exists, queue payload logged, DO message row exists, D1 index row exists, duplicate count stays one, poison message reaches DLQ.
- Pass/fail: fail if raw MIME is parsed in `email()`, if ack happens before DO+D1 success, or if DLQ cannot be inspected.
- Document before moving on: example payloads, retry policy, and DLQ replay procedure.

### Milestone 1.5 - Mailbox Durable Object Core

Tasks:

1. Implement DO SQLite migrations.
   - Acceptance criteria: all tables and FTS virtual table are created idempotently.
2. Implement MIME parse and ingest.
   - Acceptance criteria: text, HTML, headers, attachments, threading, labels, and contacts are extracted from fixtures.
3. Implement idempotency.
   - Acceptance criteria: Queue redelivery and duplicate Message-ID do not duplicate messages.
4. Implement FTS search.
   - Acceptance criteria: query by sender, subject, and body text returns expected message IDs.
5. Implement mailbox-local alarms for lightweight jobs.
   - Acceptance criteria: job table and alarm can run a small pending job without Cron.

Validation gate:

- Command/manual test: Workers tests over all MIME fixtures plus local email smoke.
- Expected evidence: fixture test matrix with expected message fields, FTS query results, idempotency assertion, and parse failure behavior.
- Pass/fail: fail if parser crash drops raw email, FTS is not updated transactionally, or attachments are stored in SQLite instead of R2.
- Document before moving on: parser library version, unsupported MIME cases, and threading heuristic.

### Milestone 1.6 - HTTP API And UI

Tasks:

1. Implement Hono API endpoints for mailbox, threads, messages, search, actions, raw, and attachments.
   - Acceptance criteria: endpoints validate params with Zod and enforce mailbox access.
2. Implement TanStack Start inbox UI.
   - Acceptance criteria: mailbox list, thread list, message detail, search, labels/read/archive actions, raw view, and attachments are usable.
3. Implement hibernatable WebSocket realtime.
   - Acceptance criteria: new inbound email appears in UI without refresh.
4. Add optimistic UI only where server idempotency exists.
   - Acceptance criteria: failed action rolls back visibly.

Validation gate:

- Command/manual test: Playwright or manual browser session against local and dev deploy; run WebSocket smoke.
- Expected evidence: screenshot/video of inbox receiving a test email live, API curl samples, and WS smoke logs.
- Pass/fail: fail if UI requires refresh after ingest, Access identity is not enforced, or text overflows/overlaps in primary views.
- Document before moving on: tested browsers/viewports and known UI gaps.

### Milestone 1.7 - Outbound Sending With Human Confirmation

Tasks:

1. Implement draft create/edit.
   - Acceptance criteria: drafts are stored in DO and visible in UI.
2. Implement `request-send` and `confirm-send`.
   - Acceptance criteria: user must explicitly confirm before `env.EMAIL.send()`.
3. Implement outbound idempotency.
   - Acceptance criteria: double-click or retry cannot send the same draft twice.
4. Implement sent indexing.
   - Acceptance criteria: sent message appears in DO and D1 index with state `sent`.

Validation gate:

- Command/manual test: send to a verified destination in dev, repeat confirm request with same idempotency key, inspect recipient inbox and D1/DO records.
- Expected evidence: exactly one delivered email, one `outbound_sends` row, one sent message row, provider message ID saved.
- Pass/fail: fail if sending can happen without confirmation or duplicate sends are possible.
- Document before moving on: sender addresses, recipient restrictions, and current Email Service limits.

### Milestone 1.8 - Multi-Domain, Rules, Backup, Ops

Tasks:

1. Connect two real domains.
   - Acceptance criteria: each domain can receive mail into the intended mailbox and aliases remain isolated.
2. Implement routing rules UI/API.
   - Acceptance criteria: store, forward, and reject are configurable and tested.
3. Implement backup/export Cron.
   - Acceptance criteria: Cron creates a manifest and exports mailbox metadata/index data to R2; raw MIME already lives in R2.
4. Implement ops dashboard endpoints.
   - Acceptance criteria: DLQ, ingest failures, queue health, and last backup are visible.
5. Implement repair/reindex.
   - Acceptance criteria: D1 `message_index` can be rebuilt from DO state for one mailbox.

Validation gate:

- Command/manual test: send messages to two domains, run scheduled handler locally via `/cdn-cgi/handler/scheduled`, inspect backup R2 keys and ops events.
- Expected evidence: two isolated mailbox views, routing rule results, backup manifest, ops event rows.
- Pass/fail: fail if messages cross mailboxes, backup cannot be located, or D1 repair is not repeatable.
- Document before moving on: domain setup steps, backup retention, and reindex procedure.

## Phase 2 - Tier B Agent/MCP/RAG

Tier B starts only after Tier A is stable and usable.

### Milestone 2.1 - Workflows For Real Sagas

Tasks:

1. Add Workflow binding only for a concrete saga.
   - Acceptance criteria: `wrangler.jsonc` has one Workflow with a named owner and purpose.
2. Implement backup/export or send-approval saga.
   - Acceptance criteria: Workflow can resume after retry and exposes status.
3. Add status API/UI.
   - Acceptance criteria: user can see running/succeeded/failed state.

Validation gate:

- Command/manual test: start Workflow, force one retryable failure, inspect `wrangler workflows instances describe`.
- Expected evidence: instance ID, step status, retry evidence, final success/failure.
- Pass/fail: fail if Workflow is added without a saga that needs durable multi-step execution.
- Document before moving on: why DO Alarm or Queue was insufficient.

### Milestone 2.2 - EmailAgent Draft-Only

Tasks:

1. Implement Agents SDK email drafting.
   - Acceptance criteria: agent can draft but cannot send.
2. Add prompt-injection guard.
   - Acceptance criteria: malicious fixture cannot trigger send or policy bypass.
3. Log model inputs/outputs through AI Gateway if selected.
   - Acceptance criteria: audit trail exists without leaking secrets.

Validation gate:

- Command/manual test: run prompt-injection MIME fixture and ask for draft; attempt to coerce send.
- Expected evidence: draft created, no send call, guard log entry.
- Pass/fail: fail if agent can send directly or uses untrusted email instructions as system instructions.
- Document before moving on: model, gateway, cost, and guard limitations.

### Milestone 2.3 - MCP Endpoint

Tasks:

1. Add `/mcp` with McpAgent or equivalent.
   - Acceptance criteria: tools are scoped to authenticated mailbox access.
2. Implement read/search/draft tools.
   - Acceptance criteria: tools cannot access unauthorized mailboxes and cannot send.
3. Add OAuth 2.1 or Access decision.
   - Acceptance criteria: senior-approved auth model is documented.

Validation gate:

- Command/manual test: connect an MCP client, list tools, call search, try unauthorized mailbox.
- Expected evidence: successful authorized tool call and denied unauthorized call.
- Pass/fail: fail if `/mcp` is public or bearer-less outside Access.
- Document before moving on: auth scopes and tool list.

### Milestone 2.4 - RAG And Semantic Search

Tasks:

1. Add Vectorize index and embeddings pipeline.
   - Acceptance criteria: embeddings are generated outside inbound hot path.
2. Add semantic search API/UI.
   - Acceptance criteria: results cite mailbox/message IDs and can open exact email.
3. Add reindex job.
   - Acceptance criteria: one mailbox can be reembedded from scratch.

Validation gate:

- Command/manual test: run embedding backfill on fixture mailbox, search semantic query, compare lexical vs semantic results.
- Expected evidence: Vectorize count, query result examples, cost estimate.
- Pass/fail: fail if inbound ingest waits on embeddings or semantic search cannot trace back to exact messages.
- Document before moving on: embedding model, dimensions, index name, and rebuild procedure.

### Milestone 2.5 - AI Ops And Technical Note

Tasks:

1. Put AI calls behind AI Gateway.
   - Acceptance criteria: rate limits/caching/logging configured.
2. Add agent eval fixtures.
   - Acceptance criteria: draft quality and safety tests run in CI or manual eval script.
3. Write note: "failure modes of an email agent in production".
   - Acceptance criteria: note includes real failures observed during development.

Validation gate:

- Command/manual test: run eval script, inspect AI Gateway logs, publish note draft.
- Expected evidence: eval results, gateway log screenshot/export, note path.
- Pass/fail: fail if AI layer has no observability or the note is only theoretical.
- Document before moving on: final Tier B demo script and audit talking points.

## Tests And Fixtures Plan

### MIME Fixtures

Commit small fixtures:

- `simple-text.eml`: plain text, valid Message-ID.
- `html-only.eml`: HTML only.
- `multipart-alternative.eml`: text and HTML.
- `attachment-small.eml`: one small attachment.
- `inline-image.eml`: inline content ID.
- `missing-message-id.eml`: no Message-ID, idempotency falls back to raw hash.
- `duplicate-message-id-a.eml` and `duplicate-message-id-b.eml`: same Message-ID, different raw body; expected behavior must be senior-approved.
- `prompt-injection.eml`: malicious text for Tier B guard.

Generate, do not commit, large fixtures:

- `large-24mb.eml`: near Cloudflare inbound limit.
- `many-attachments.eml`: stress attachment handling.

### Test Types

Unit tests:

- Mailbox ID canonicalization.
- R2 key generation.
- Queue payload schema validation.
- Idempotency key generation.
- MIME parser normalization.
- Threading heuristic.

Workers tests:

- `email()` stores R2 and enqueues.
- Queue consumer validates and acks/retries correctly.
- DO ingest creates tables, message row, FTS row, attachment rows.
- D1 index write is idempotent.

E2E/local tests:

- Simulated local email via `/cdn-cgi/handler/email`.
- WebSocket smoke from client script.
- Access/auth checks on deployed dev.
- Outbound send to verified destination.

### Idempotency Tests

Required cases:

- Same fixture sent twice with same Message-ID produces one message.
- Queue message redelivered after D1 failure produces one DO message and eventually one D1 index row.
- Missing Message-ID uses raw SHA-256 and dedupes exact same raw MIME.
- Same Message-ID with different raw SHA-256 is flagged as conflict, not silently overwritten.
- Outbound `confirm-send` called twice sends exactly once.

### DLQ Test

Required poison message:

```json
{
  "schemaVersion": 999,
  "eventType": "email.received.v999",
  "traceId": "poison-test"
}
```

Test:

- Publish poison message to inbound queue in dev or inject through a test endpoint disabled in prod.
- Consumer rejects as unsupported schema.
- Message reaches DLQ after configured retries.
- Admin DLQ endpoint displays message and failure reason.

### WebSocket Smoke

Script behavior:

- Connect to `/api/mailboxes/{mailboxId}/ws`.
- Receive `hello`.
- Send `ping`.
- Receive `pong`.
- Trigger local ingest.
- Receive `message.created` with increasing `seq`.

### Access/Auth Checks

Required checks:

- Unauthenticated `GET /api/mailboxes` is blocked by Access in deployed dev.
- Authenticated Santi identity can list mailboxes.
- Service token can call only approved automation endpoints.
- User from outside allowlist is denied.
- WebSocket upgrade without Access identity is denied.
- API refuses mailbox ID not assigned to current identity.

## Deployment Checklist

Predeploy:

- [ ] `pnpm install`
- [ ] `pnpm wrangler types`
- [ ] `pnpm run build`
- [ ] `pnpm test -- --run`
- [ ] D1 migrations reviewed.
- [ ] `wrangler.jsonc` resource names match environment.
- [ ] No secrets in git.
- [ ] Access app configured before exposing custom domain.
- [ ] Email sender domains and routing domains verified.
- [ ] Queue and DLQ exist.
- [ ] R2 bucket exists.

Deploy dev:

```sh
cd ~/code/reccado
pnpm wrangler deploy --env dev
```

Postdeploy dev:

- [ ] Open UI through Access.
- [ ] `GET /api/health` returns OK after auth.
- [ ] Send local simulated email if using dev server.
- [ ] Send real inbound email to test domain.
- [ ] Confirm R2 raw key exists.
- [ ] Confirm Queue consumer processed.
- [ ] Confirm DO message exists.
- [ ] Confirm D1 index row exists.
- [ ] Confirm UI receives WebSocket realtime event.
- [ ] Confirm outbound send to verified destination.
- [ ] Force poison message and inspect DLQ.
- [ ] Run scheduled handler locally and in deployed environment if supported.

Production promotion:

- [ ] Senior signs off open questions below.
- [ ] Resource names switched to `prod`.
- [ ] D1 production migrations applied.
- [ ] Access policy reviewed.
- [ ] Sender restrictions reviewed.
- [ ] Backup retention reviewed.
- [ ] DLQ alerting configured.
- [ ] Cost expectations documented.
- [ ] Rollback plan documented.

Operational runbook:

- Queue backlog high: inspect Queues metrics, tail Worker logs, check DO errors, pause inbound routing only if data loss risk exists.
- DLQ non-empty: inspect `/api/admin/dlq`, classify poison vs transient, fix code/config, replay only after idempotency check.
- R2 write failure in `email()`: reject or temporary fail according to Email Routing behavior; do not enqueue without raw R2 key.
- D1 unavailable: allow DO ingest to remain source of truth; retry index update through Queue; run reindex after recovery.
- DO parse failure: keep message row with `parse_status='failed'`, preserve raw R2 key, expose ops event.
- Outbound send failure: keep `outbound_sends.status='failed'`, show error, require manual retry with same or new idempotency decision.
- Access misconfiguration: block public API first, then restore allow policies.
- Secret rotation: rotate Cloudflare API token normally; do not rotate `MAILBOX_ID_SECRET` without a mailbox ID migration plan.

## Open Questions Requiring Senior Decision

- Queue settings: final `max_batch_size`, `max_batch_timeout`, `max_retries`, retry delays, and whether to cap consumer concurrency.
- Mailbox model: one DO per primary address, per domain inbox, or per human owner with aliases.
- Duplicate Message-ID conflict policy: dedupe, flag conflict, or store both with suffix.
- Default route for unmatched recipients: reject, store catch-all, or forward to admin.
- Outbound policy: which sender addresses are allowed, and whether arbitrary recipients are acceptable in v0.
- License: MIT for adoption vs AGPL for anti-capture.
- Access vs OAuth for `/mcp`: Access is enough for Santi/private UI; MCP/public OSS may need OAuth 2.1 with scopes.
- Cloudflare API provisioning scope: how much domain/routing automation to allow from the app.
- D1 indexing scope: metadata only vs snippets/labels in central index.
- Retention and deletion: raw MIME retention period, attachment deletion, trash retention, export policy.
- Backup format: NDJSON plus R2 raw references vs per-mailbox SQLite export strategy.
- Workflows threshold: exact point where backup/export/send approval becomes a Workflow instead of Queue/DO Alarm.
- AI model: Workers AI vs Claude through AI Gateway for Tier B.
- Timebox: weekly budget so this side project does not displace active sales work.

## References Checked

- Wiki source: `internal planning notes (not in repo)`
- Cloudflare TanStack Start Workers guide: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
- Hono Cloudflare Workers guide: https://hono.dev/docs/getting-started/cloudflare-workers
- Durable Objects getting started: https://developers.cloudflare.com/durable-objects/get-started/
- Durable Objects SQLite storage API: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- Durable Objects WebSocket hibernation: https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- R2 Workers API and Wrangler commands: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/ and https://developers.cloudflare.com/r2/reference/wrangler-commands/
- Queues getting started, JS API, retries, DLQ: https://developers.cloudflare.com/queues/get-started/ , https://developers.cloudflare.com/queues/configuration/javascript-apis/ , https://developers.cloudflare.com/queues/configuration/batching-retries/ , https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- D1 Wrangler commands: https://developers.cloudflare.com/d1/wrangler-commands/
- Email Routing Workers API and local testing: https://developers.cloudflare.com/email-service/api/route-emails/email-handler/ and https://developers.cloudflare.com/email-service/local-development/routing/
- Email Sending Workers API, send bindings, limits: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/ , https://developers.cloudflare.com/email-service/configuration/send-bindings/ , https://developers.cloudflare.com/email-service/platform/limits/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Workers secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Cloudflare Access self-hosted apps: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/
- Workflows guide: https://developers.cloudflare.com/workflows/get-started/guide/
