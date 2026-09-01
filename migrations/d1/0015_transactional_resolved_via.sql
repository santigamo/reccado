-- Migration 0015: Record how a transactional request reached its status.
--
-- An ambiguous send ('unknown') can now be settled from an observed Email Sending
-- delivery event correlated on the envelope, because Cloudflare mints the message
-- id itself and will not accept a sender-chosen one. A status reached that way is
-- inferred rather than acknowledged by the provider, and an operator must be able
-- to tell the two apart, so the row carries where its status came from.
--
-- NULL = the provider call said so. 'envelope_correlation' = inferred from an event.
-- This is a rebuildable projection; the mailbox DO remains authoritative.

-- The candidate scan narrows on (status, created_at), which idx_trl_status from
-- migration 0007 already covers.
ALTER TABLE transactional_request_log ADD COLUMN resolved_via TEXT;
