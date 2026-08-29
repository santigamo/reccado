-- Migration 0013: find the card that announced a given email.
--
-- telegram_links was only ever read forwards -- "which email is this Telegram
-- message about?" -- which the primary key (chat_id, message_id) answers. Keeping
-- a card honest when the email is archived somewhere else needs the inverse, and
-- without an index that lookup scans a table that grows by one row per email
-- delivered, on the path of every archive.
--
-- Mirrors idx_telegram_links_thread, which already serves the thread-shaped half
-- of the same question (a reply confirmed on the web knows its conversation, not
-- which card announced it).

CREATE INDEX IF NOT EXISTS idx_telegram_links_message
  ON telegram_links(mailbox_id, message_local_id, created_at DESC);
