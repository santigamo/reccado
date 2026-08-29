-- 0010_telegram_topics.sql
-- One Telegram forum topic per mailbox, never per email thread.
--
-- The previous mapping (a topic per email thread, named with the email's subject)
-- let anyone who can send mail to a mailbox write the permanent labels in the
-- operator's Telegram sidebar: attacker-controlled text creating persistent UI
-- structure. It also tied topic creation to unbounded inbound volume -- hundreds
-- of threads, hundreds of topics -- and spent an extra createForumTopic call per
-- new thread on a path Telegram rate-limits to roughly one message per second.
--
-- Mailboxes are the opposite: a bounded, stable namespace the operator curated
-- himself (rows in `mailboxes`, with the display_name he chose). That is the
-- right cardinality for UI structure, so the topic name comes from there and the
-- mapping is keyed by mailbox rather than by thread.
--
-- Keyed by chat as well as mailbox because a topic id is only meaningful inside
-- the chat that owns it: re-adopting a different chat must not inherit topic ids
-- that never existed there.
--
-- No backfill on purpose. Topics created by the old per-thread mapping are left
-- orphaned in place, because deleting someone's Telegram history is not a
-- migration's job. New mail simply flows into the mailbox topic from here on.

CREATE TABLE telegram_topics (
  chat_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, mailbox_id)
);
