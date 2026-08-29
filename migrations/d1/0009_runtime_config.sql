-- 0009_runtime_config.sql
-- Configuration the system observes about itself, instead of asking a human.
--
-- A value that only changes when someone edits wrangler.jsonc and redeploys is a
-- value that silently diverges between the repo and production: the Telegram
-- bridge sat dead for days because TELEGRAM_CHAT_ID lived in a working tree that
-- was never shipped, and nothing could tell. Anything the worker can learn at
-- runtime belongs here, where it is written once by the machine that observed it
-- and read back on every request.
--
-- Secrets deliberately do NOT live here. What guards the ability to send mail
-- must not sit in the same store as the mail it guards -- see deriveWebhookSecret
-- in src/telegram/api.ts for the value this table pointedly does not hold.

CREATE TABLE runtime_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
