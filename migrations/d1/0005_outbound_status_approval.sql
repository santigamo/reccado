-- 0005_outbound_status_approval.sql
-- Adds 'unknown' status and approval_mode column to outbound_sends.
--
-- SQLite cannot ALTER CHECK constraints, so we recreate the table.

CREATE TABLE IF NOT EXISTS outbound_sends_v2 (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'sending', 'sent', 'failed', 'cancelled', 'unknown')),
  provider_message_id TEXT,
  error_code TEXT,
  approval_mode TEXT NOT NULL DEFAULT 'human_confirmed'
    CHECK (approval_mode IN ('human_confirmed', 'telegram_confirmed', 'preauthorized_transactional')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO outbound_sends_v2
  (id, mailbox_id, draft_id, idempotency_key, status, provider_message_id, error_code, approval_mode, created_at, updated_at)
SELECT
  id, mailbox_id, draft_id, idempotency_key, status, provider_message_id, error_code,
  'human_confirmed',
  created_at, updated_at
FROM outbound_sends;

DROP TABLE outbound_sends;
ALTER TABLE outbound_sends_v2 RENAME TO outbound_sends;