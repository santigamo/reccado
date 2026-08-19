-- 0007_transactional_requests.sql
-- Adds transactional request projections to D1 for rebuildable audit/search.

CREATE TABLE IF NOT EXISTS transactional_request_log (
  request_id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'duplicate', 'rejected', 'failed', 'unknown')),
  to_addr TEXT NOT NULL,
  template_id TEXT,
  sender TEXT NOT NULL,
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trl_key_id ON transactional_request_log(key_id);
CREATE INDEX IF NOT EXISTS idx_trl_mailbox ON transactional_request_log(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_trl_status ON transactional_request_log(status, created_at);