-- 0020_telegram_topic_name.sql
-- A topic's name, chosen per mapping instead of borrowed from the mailbox.
--
-- 0010 named each mailbox's topic after mailboxes.display_name. That column has
-- a second, louder job: it is the From display name every reply from the
-- mailbox is signed with (src/lib/sender-identity.ts). So a topic could not be
-- called "imsanti" without the mail it answers going out as "imsanti" too, and
-- the workaround was creating topics with another bot and INSERTing mapping rows
-- by hand.
--
-- NULL keeps the old behaviour exactly -- display_name, else the address -- so
-- every existing row means what it meant before this migration and nothing is
-- backfilled. A value is written only when the operator names a topic
-- explicitly (POST /api/telegram/topics), and the self-heal path that recreates
-- a deleted topic reuses it, so a chosen name survives the topic being deleted.
--
-- The name is a label the operator wrote. It is never derived from inbound mail,
-- for the reason 0010 gives: sidebar chrome must not be writable by strangers.

ALTER TABLE telegram_topics ADD COLUMN topic_name TEXT;
