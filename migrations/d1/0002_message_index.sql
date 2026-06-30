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

CREATE INDEX idx_ops_events_created ON ops_events(created_at DESC);
