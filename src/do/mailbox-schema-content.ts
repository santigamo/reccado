export const MAILBOX_SCHEMA_SQL = `
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
  thread_id TEXT NOT NULL,
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

CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_rfc_message_id ON messages(rfc_message_id);

CREATE TABLE IF NOT EXISTS message_headers (
  message_id TEXT NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
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
  message_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
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
  thread_id TEXT,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_confirmation', 'sent', 'cancelled')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  idempotency_key TEXT
);

-- NOTE: idx_drafts_idempotency (the partial unique index on
-- outbound_drafts.idempotency_key) is deliberately NOT created here. This SQL
-- runs on every DO cold start, but DOs created before schema v2 have an
-- outbound_drafts table WITHOUT the idempotency_key column (CREATE TABLE IF NOT
-- EXISTS is a no-op for them). Referencing that column in an index here would
-- throw "no such column: idempotency_key" in the constructor and brick the DO
-- before migrateDraftIdempotency() can ALTER TABLE ADD COLUMN. The index is
-- created by migrateDraftIdempotency() instead, AFTER the column is guaranteed.

-- Reserved, currently unused: scaffolding for the planned "mailbox-local DO alarm
-- jobs" milestone (see docs/IMPLEMENTATION.md). Nothing inserts rows into this
-- table yet; mailbox-do.ts's runPendingJobs()/alarm() poll it defensively but are
-- effectively no-ops until a feature starts enqueueing jobs here.
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

CREATE TABLE IF NOT EXISTS api_keys (
  key_id TEXT PRIMARY KEY,
  hash_version INTEGER NOT NULL DEFAULT 1,
  key_hash TEXT NOT NULL,
  display_suffix TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  mailbox_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  template_allowlist_json TEXT,
  recipient_policy TEXT,
  quota_max INTEGER,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_mailbox ON api_keys(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_status ON api_keys(status);

CREATE TABLE IF NOT EXISTS api_key_events (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'revoked', 'rotated')),
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ake_key ON api_key_events(key_id);

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id TEXT NOT NULL,
  window_key TEXT NOT NULL,
  value INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (key_id, window_key)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_text TEXT,
  body_html TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_templates_mailbox ON templates(mailbox_id, status);

CREATE TABLE IF NOT EXISTS transactional_requests (
  request_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  client_idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'duplicate', 'rejected', 'failed', 'unknown')),
  to_addr TEXT NOT NULL,
  template_id TEXT,
  variables_json TEXT,
  sender TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  delivery_status TEXT,
  delivery_event_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_idempotency ON transactional_requests(key_id, client_idempotency_key);
CREATE INDEX IF NOT EXISTS idx_txn_status ON transactional_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_key_lookup ON transactional_requests(key_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  subject,
  sender,
  recipients,
  snippet,
  body_text
);

-- Suppression list: local mirror of Cloudflare account-level suppression.
-- The DO is authoritative for send decisions; D1 indexes are projections.
CREATE TABLE IF NOT EXISTS recipient_suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual', 'provider_rejected')),
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_suppressions_created ON recipient_suppressions(created_at);

-- Delivery event log from Email Sending lifecycle events.
-- Rows are inserted idempotently by event_id.
CREATE TABLE IF NOT EXISTS transactional_delivery_events (
  event_id TEXT PRIMARY KEY,
  request_id TEXT,
  provider_message_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  event_type TEXT NOT NULL,
  terminal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tde_provider_message ON transactional_delivery_events(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_tde_request ON transactional_delivery_events(request_id);
`;
