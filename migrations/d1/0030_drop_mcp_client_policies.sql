-- Delegation policies were removed: direct vs approval is now decided per kind, never per client.
-- The approvals.approved_via / auto_refused columns from 0029 stay (SQLite DROP COLUMN is not worth the risk).
DROP TABLE IF EXISTS mcp_client_policies;
