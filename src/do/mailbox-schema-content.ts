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
  updated_at TEXT NOT NULL
);

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

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  subject,
  sender,
  recipients,
  snippet,
  body_text
);
`;
