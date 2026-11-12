CREATE UNIQUE INDEX idx_approvals_mcp_send_pending
ON approvals(kind, mailbox_id, draft_id)
WHERE origin = 'mcp' AND kind = 'send' AND consumed_at IS NULL AND decision IS NULL;
