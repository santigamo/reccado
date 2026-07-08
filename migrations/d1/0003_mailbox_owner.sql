-- 0003_mailbox_owner.sql
-- Adds per-mailbox ownership for MCP access control.
-- Existing mailboxes get owner_email = NULL (fail-closed for MCP until claimed
-- via `pnpm setup:mcp-claim`). The UI's global allowlist behavior is unchanged.

ALTER TABLE mailboxes ADD COLUMN owner_email TEXT;
CREATE INDEX IF NOT EXISTS idx_mailboxes_owner ON mailboxes(owner_email);
