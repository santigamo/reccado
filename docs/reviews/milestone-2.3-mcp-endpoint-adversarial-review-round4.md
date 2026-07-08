# Milestone 2.3 MCP Endpoint Plan v4 - Adversarial Review

Review date: 2026-07-08

Reviewed inputs:

- Revised plan: `/tmp/reccado-mcp-plan-v4.md`
- Round 3 review: `docs/reviews/milestone-2.3-mcp-endpoint-adversarial-review-round3.md`
- Repo baseline: `ded7798 feat(ui): Liquid Glass redesign for the mailbox app`

Verification notes:

- Local SQLite probe confirmed `INSERT OR IGNORE` works with a partial unique index on `idempotency_key WHERE idempotency_key IS NOT NULL`: first non-null key inserts, duplicate non-null key writes zero rows, and `NULL` keys are not deduped.
- Generated Workers types in `worker-configuration.d.ts` expose `SqlStorageCursor.rowsWritten`, so the v4 duplicate detection mechanism is implementable in the Durable Object.

## Round 3 Blocking Findings

1. SQLite upsert with partial unique index - ADDRESSED

   v4 replaces the invalid `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING` form with `INSERT OR IGNORE` plus a `rowsWritten === 0` duplicate check. That works with the planned partial unique index:

   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_idempotency
   ON outbound_drafts(idempotency_key)
   WHERE idempotency_key IS NOT NULL;
   ```

   Fetching the existing draft by `idempotency_key` after a zero-row write is the right fallback for duplicate MCP draft retries. There is no check-then-insert race because uniqueness is enforced by SQLite during the insert. Implementation should still handle an unexpected zero-row write with no matching existing draft as `internal_error`, but with validated inputs and generated UUID draft IDs that is defensive cleanup, not a plan blocker.

2. Idempotent DO migration guard - ADDRESSED

   v4 adds a `PRAGMA table_info(outbound_drafts)` column check before `ALTER TABLE`, uses `CREATE UNIQUE INDEX IF NOT EXISTS`, and writes the schema version with `INSERT OR REPLACE`. That is resilient to the important partial-failure rerun cases: failure after the column add, after the index create, or before the version write.

   The fresh-install path is also covered by updating `MAILBOX_SCHEMA_SQL` to include the column and index. Existing rows will have `NULL` idempotency keys, so index creation should not fail due to duplicates.

## Round 3 Minor Findings

1. Status code mismatch - ADDRESSED

   v4 explicitly distinguishes unset/empty `ACCESS_ALLOWED_EMAILS` as `503 mcp_not_configured` from configured allowlist misses as `403 forbidden`.

   Non-blocking cleanup: the document still includes an older v3 snippet later in §1.4.6 using `if (!isMcpAllowed(...)) return 403`. The new v4 snippet and tests are clear enough to govern implementation, but remove the stale snippet to avoid copy/paste drift.

2. `setup:mcp-claim` safety - ADDRESSED

   v4 requires explicit `--owner` when `ACCESS_ALLOWED_EMAILS` has multiple entries, canonicalizes the owner email, prints the exact D1 target and affected mailboxes, and keeps dry-run as the default. That addresses the accidental multi-user claim concern.

## New Issues Found in v4

### CRITICAL

- None.

### MAJOR

- None.

### MINOR

1. `INSERT OR IGNORE` can ignore constraints other than idempotency.

   This is acceptable for the plan because tool validation controls required fields and draft IDs are generated UUIDs. The implementation should still treat `rowsWritten === 0` plus no existing row for the idempotency key as an internal error rather than returning a malformed duplicate result.

2. Remove stale auth pseudocode from the plan before implementation.

   The v4 auth behavior is correct, but the older snippet that maps all `!isMcpAllowed` cases to `403` remains later in the document. Keep only the v4 503-vs-403 branch.

SIGN-OFF
