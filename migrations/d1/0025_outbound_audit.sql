ALTER TABLE outbound_sends ADD COLUMN approval_channel TEXT CHECK (approval_channel IN ('web', 'telegram', 'mcp_approval'));
ALTER TABLE outbound_sends ADD COLUMN intent_id TEXT;
ALTER TABLE outbound_sends ADD COLUMN payload_hash TEXT;
ALTER TABLE outbound_sends ADD COLUMN oauth_client_id TEXT;
ALTER TABLE outbound_sends ADD COLUMN token_sub TEXT;
ALTER TABLE outbound_sends ADD COLUMN token_jti TEXT;
