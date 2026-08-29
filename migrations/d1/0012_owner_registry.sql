-- 0012_owner_registry.sql
-- One declaration of who owns this deployment, instead of two lists in two files.
--
-- ACCESS_ALLOWED_EMAILS and TELEGRAM_ALLOWED_USER_IDS answered the same question --
-- who is the operator -- in two formats, in two places, each needing a redeploy to
-- change. Two records of one fact diverge: the day the Telegram account moves and
-- the email does not, the bot still obeys someone the web perimeter has already
-- forgotten. They are one entity seen from two surfaces, so they are one table with
-- a facet column.
--
-- What did NOT move is the decision. Whom to trust is irreducibly human, and a
-- system that grants itself operators is a vulnerability. What moved is where the
-- declaration is written: a row a running system can add under a one-time code,
-- rather than a personal user id committed to a public repository and shipped by
-- redeploy.

CREATE TABLE owner_identities (
  -- 'email' is the web and MCP perimeter, 'telegram' is the bot. Same owner.
  kind TEXT NOT NULL CHECK (kind IN ('email', 'telegram')),
  -- Lowercased email, or the Telegram user id as text. Stored exactly as the
  -- surface presents it, so membership is a string comparison and never a parse.
  identity TEXT NOT NULL,
  -- Free-text note for the human reading this table over `wrangler d1 execute`.
  label TEXT,
  linked_at TEXT NOT NULL,
  -- How this row came to exist: 'pairing_code', 'bootstrap' or 'manual'. An
  -- identity that can send mail as the operator should carry its own provenance.
  linked_via TEXT NOT NULL,
  PRIMARY KEY (kind, identity)
);

-- The one runtime path from "a stranger" to "an owner".
--
-- Single-use and short-lived, because while it lives this row IS the authority to
-- drive the bot, which is the authority to send mail as the operator. Every mint
-- and every attempt is written to ops_events, so the escalation this table makes
-- possible is at least never silent.
--
-- The code is stored in clear on purpose. In a deployment whose authenticated UI
-- is unreachable -- no Access app over the hostname, so no JWT anyone can obtain --
-- the operator's only channel into this database is `wrangler d1 execute`, and a
-- code he cannot read is a code he cannot use. Hashing would only defend against
-- an attacker who can read D1 but not write it, and that attacker does not exist
-- here: whoever can write D1 inserts an owner_identities row directly and never
-- touches this table at all. That residual is named in the migration above and in
-- the operations notes, not hidden behind a hash that buys nothing.
CREATE TABLE owner_pairing_codes (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  -- ISO-8601 UTC, same shape as every other timestamp here, so lexicographic
  -- comparison is chronological comparison -- in SQL as well as in JS.
  expires_at TEXT NOT NULL,
  -- 'cron' when the deployment minted it for itself, 'manual' when a human did.
  issued_by TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by TEXT
);
