-- 0031_telegram_approval_notices.sql
-- Which Telegram message announced which approval request, so the notice can be
-- edited in place when the request is approved, denied or expires.
--
-- Bridge state, like telegram_links and telegram_topics: nothing outside
-- src/telegram reads it, and losing the table costs stale notices, never an
-- approval. It holds no authority at all -- the notice is link-only and approval
-- happens on /approve/:id with the owner web session -- so there is no token
-- here, only an address (chat_id, message_id) and the state last drawn there.
--
-- `state` is what the notice currently shows: pending, approved, denied,
-- expired or stale. A sync that computes the same state does nothing, which is
-- what makes a redelivered queue message harmless.
CREATE TABLE telegram_approval_notices (
  approval_id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  topic_id INTEGER,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The hourly backstop looks for notices still drawn as pending.
CREATE INDEX idx_telegram_approval_notices_state
  ON telegram_approval_notices(state, created_at);
