-- Delegated MCP clients: an OAuth client whose token cannot read mail may apply a
-- narrow set of low-risk control-plane changes without a human approval, scoped by
-- this per-client policy. The kind ceiling (AUTO_ELIGIBLE) is hard-coded in
-- src/lib/mcp-client-policy.ts; auto_kinds_json can only narrow it.
CREATE TABLE mcp_client_policies (
  client_id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  mailbox_ids_json TEXT NOT NULL DEFAULT '[]',
  auto_kinds_json TEXT NOT NULL DEFAULT '[]',
  link_domains_json TEXT NOT NULL DEFAULT '[]',
  allow_variable_links INTEGER NOT NULL DEFAULT 0,
  max_auto_per_hour INTEGER NOT NULL DEFAULT 20,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- How an intent was decided: NULL for the human flows, 'auto' for a policy apply.
ALTER TABLE approvals ADD COLUMN approved_via TEXT;
-- Why a delegated client's change was not applied automatically (shown with the pending request).
ALTER TABLE approvals ADD COLUMN auto_refused TEXT;
