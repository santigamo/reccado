CREATE TABLE approvals (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mailbox_id TEXT,
  draft_id TEXT,
  telegram_user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  payload_hash TEXT,
  consumed_at TEXT,
  origin TEXT NOT NULL DEFAULT 'telegram' CHECK (origin IN ('telegram', 'web', 'mcp'))
);

INSERT INTO approvals (token, kind, mailbox_id, draft_id, telegram_user_id, created_at, expires_at)
SELECT token, kind, mailbox_id, draft_id, telegram_user_id, created_at, expires_at FROM telegram_actions;
DROP TABLE telegram_actions;
CREATE INDEX idx_approvals_expires ON approvals(expires_at);
