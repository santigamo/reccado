-- 0006_transactional_api_keys.sql
-- Adds transactional API key projections to D1 for rebuildable audit/search.

CREATE TABLE IF NOT EXISTS transactional_api_keys (
  key_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  display_suffix TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  template_allowlist_json TEXT,
  recipient_policy TEXT,
  quota_max INTEGER,
  quota_used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tak_mailbox ON transactional_api_keys(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_tak_status ON transactional_api_keys(status);