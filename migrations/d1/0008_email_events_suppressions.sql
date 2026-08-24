-- Migration 0008: Add delivery event tracking and suppression mirror to D1.
-- These are rebuildable projections. The DO is authoritative.

ALTER TABLE transactional_request_log ADD COLUMN delivery_status TEXT;
ALTER TABLE transactional_request_log ADD COLUMN delivery_event_at TEXT;

CREATE TABLE IF NOT EXISTS recipient_suppressions (
  email TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('hard_bounce', 'complaint', 'manual', 'provider_rejected')),
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  PRIMARY KEY (mailbox_id, email)
);

CREATE INDEX IF NOT EXISTS idx_suppressions_mailbox ON recipient_suppressions(mailbox_id);
