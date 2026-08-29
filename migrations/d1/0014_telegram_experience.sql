-- 0014_telegram_experience.sql
-- Four things the bridge could not do: correct a draft, retrieve old mail,
-- shut a sender up, and survive a public catch-all overnight.

-- Which draft a preview message is showing.
--
-- Deliberately NOT extra columns on telegram_actions. That table exists to hold
-- the *authority* to send: its token is bound to the account the button was shown
-- to and derived from the message that produced it, so a Telegram retry mints the
-- same button instead of a second send. Editing a draft answers a different
-- question -- "which draft is this preview about?" -- needs no token at all (the
-- update already carries reply_to_message.message_id), and its guard is the
-- operator allowlist, exactly like the card verbs. Folding both into one row would
-- make every future change to either have to argue about the other's threat model.
--
-- The rows are still short-lived, and the expiry sweep is the one in the cron
-- (see docs/plans/telegram-roadmap.md) -- which is also why this table carries its
-- own expires_at rather than borrowing the action's.
--
-- Keyed by the preview because that is what a correction quotes. source_message_id
-- is indexed for the other direction: editing your own Telegram message arrives as
-- edited_message, which names the message you typed, not the preview it produced.
CREATE TABLE telegram_drafts (
  chat_id TEXT NOT NULL,
  preview_message_id INTEGER NOT NULL,
  source_message_id INTEGER NOT NULL,
  mailbox_id TEXT NOT NULL,
  draft_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  -- What the preview's "v2" badge counts. Starts at 1; a correction bumps it, so
  -- the operator can see that the edit landed on the draft and not beside it.
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, preview_message_id)
);

CREATE INDEX idx_telegram_drafts_source
  ON telegram_drafts(chat_id, source_message_id, created_at DESC);
CREATE INDEX idx_telegram_drafts_expires ON telegram_drafts(expires_at);

-- Senders whose mail is stored but not announced.
--
-- Not per mailbox: a newsletter that reached one address of a public catch-all
-- will reach the next one too, and asking the operator to silence the same sender
-- once per address is how the bridge gets muted wholesale instead.
CREATE TABLE telegram_muted_senders (
  sender TEXT PRIMARY KEY,
  muted_at TEXT NOT NULL,
  muted_by TEXT NOT NULL
);

-- Quiet hours, as one row.
--
-- Not runtime_config: that key set is a closed union in db/runtime-config.ts, and
-- a window is three numbers that must change together -- half-applying an offset
-- to yesterday's window is exactly the kind of state a single row prevents.
-- Minutes-from-midnight rather than "23:00" so comparison is arithmetic, and the
-- offset is stored because the operator states the window in his own clock while
-- the worker only ever knows UTC.
CREATE TABLE telegram_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  quiet_start_minutes INTEGER,
  quiet_end_minutes INTEGER,
  utc_offset_minutes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

-- Mail that arrived during quiet hours and has not been announced yet.
--
-- Only the address of the email is kept, never its text: the digest re-reads
-- subject and sender from message_index the same way a card refresh does, so a
-- retained notification cannot go stale or become a second copy of the mail in a
-- second place.
--
-- digest_at is the flush marker AND the reason rows outlive their digest: the
-- numbered buttons under the summary carry this row's id, so deleting on flush
-- would break every button the moment it was drawn.
CREATE TABLE telegram_retained (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  mailbox_address TEXT NOT NULL,
  message_local_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  retained_at TEXT NOT NULL,
  digest_at TEXT
);

CREATE INDEX idx_telegram_retained_pending
  ON telegram_retained(chat_id, digest_at, retained_at);
CREATE INDEX idx_telegram_retained_retained ON telegram_retained(retained_at);

-- "Is this the first time this address writes to us?"
--
-- The DO's contacts table already counts this, but it answers only inside one
-- mailbox and only through a round trip the notification path does not otherwise
-- need. message_index spans every mailbox, which is the right scope for a badge
-- that means "nobody here has heard from this person before" -- and without this
-- index the question would scan a table that grows by one row per email received.
--
-- NOCASE for the reason idx_messages_rfc_message_id_nocase exists: the local part
-- of an address is case-sensitive by spec and case-insensitive in practice, and a
-- plain index cannot serve the comparison the badge actually wants.
CREATE INDEX idx_message_index_from_addr
  ON message_index(from_addr COLLATE NOCASE, received_at DESC);
