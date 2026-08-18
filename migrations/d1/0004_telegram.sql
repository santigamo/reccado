-- 0004_telegram.sql
-- Telegram bridge state.
--
-- telegram_links maps a message the bot posted (or the topic it posted into)
-- back to the email thread it was about. That mapping is what makes "reply in
-- Telegram" resolvable: a Telegram reply carries reply_to_message.message_id or
-- message_thread_id, and nothing else that identifies the conversation.
--
-- telegram_actions backs the inline Send/Discard buttons. callback_data is capped
-- at 64 bytes by the Bot API, which cannot hold a mailbox id plus a draft id, so
-- the button carries a short opaque token and the real target lives here.

CREATE TABLE telegram_links (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  mailbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_local_id TEXT NOT NULL,
  topic_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX idx_telegram_links_thread ON telegram_links(mailbox_id, thread_id, created_at DESC);
CREATE INDEX idx_telegram_links_topic ON telegram_links(chat_id, topic_id, created_at DESC);

CREATE TABLE telegram_actions (
  token TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('confirm_send')),
  mailbox_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_telegram_actions_expires ON telegram_actions(expires_at);
