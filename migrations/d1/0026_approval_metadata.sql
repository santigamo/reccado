-- OAuth attribution and the approve/deny decision live on the intent row.
-- The send audit columns are 0025; these are what the approval service reads
-- back when it fills them. Nullable so Telegram rows from 0022 stay valid.
ALTER TABLE approvals ADD COLUMN oauth_client_id TEXT;
ALTER TABLE approvals ADD COLUMN token_sub TEXT;
ALTER TABLE approvals ADD COLUMN token_jti TEXT;
ALTER TABLE approvals ADD COLUMN decision TEXT;
