# Milestone 2.3 MCP Endpoint Plan v3 - Adversarial Review

Review date: 2026-07-08

Reviewed inputs:

- Revised plan: `/tmp/reccado-mcp-plan-v3.md`
- Round 2 review: `docs/reviews/milestone-2.3-mcp-endpoint-adversarial-review-round2.md`
- v1 review fallback: `/Users/santi/orca/workspaces/inbox-mcp-cloudflare/mcp-review/docs/reviews/milestone-2.3-mcp-endpoint-adversarial-review.md`
- Repo baseline: `ded7798 feat(ui): Liquid Glass redesign for the mailbox app`
- Current official docs checked:
  - Cloudflare Agents `createMcpHandler`: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
  - Cloudflare One secure MCP servers: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/
  - Cloudflare Access Managed OAuth: https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/

Note: the task said the v1 review was copied into this worktree, but `docs/reviews/milestone-2.3-mcp-endpoint-adversarial-review.md` is still absent here. I used the sibling worktree copy, as in round 2.

## Round 2 Blocking Findings

1. `owner_email` backfill and write paths - ADDRESSED

   v3 adds the missing claim/backfill path and updates the planned write surfaces: `insertMailbox`, `POST /api/mailboxes`, dev seeding, and `setup:mailbox`. Existing `NULL` owners remain fail-closed until explicitly claimed, which preserves security. The migration/backfill test coverage is adequate for a plan.

   Implementation note: the claim script should canonicalize the owner email and should require an explicit `--owner` or confirmation when `ACCESS_ALLOWED_EMAILS` has more than one entry. That is a safety improvement for an operator script, not a blocker.

2. Hono `/mcp` middleware - ADDRESSED

   v3 explicitly corrects the v2 false assumption about inheritance from `/api/*` middleware and adds dedicated `/mcp` auth and Origin middleware. It also specifies `GET`, `POST`, and `OPTIONS` handling through `api.all(...)`, and the `requireAuth` try/catch contract is now correct for the current thrown-`Response` behavior.

   Implementation note: the prose and tests say unset `ACCESS_ALLOWED_EMAILS` returns `503`, but the pseudocode's generic `!isMcpAllowed` branch returns `403`. Follow the prose/tests and distinguish "misconfigured/unset allowlist" from "authenticated but not allowed."

3. DO draft idempotency migration - PARTIALLY-ADDRESSED

   v3 fixes the high-level migration shape: bump `MAILBOX_SCHEMA_VERSION`, run `ALTER TABLE` for existing DO SQLite instances, add a partial unique index rather than `ADD COLUMN UNIQUE`, update the fresh schema, and test v1-to-v2 migration. The partial unique index itself is valid SQLite:

   ```sql
   CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_idempotency
   ON outbound_drafts(idempotency_key)
   WHERE idempotency_key IS NOT NULL;
   ```

   The remaining blocker is the proposed insert statement: `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING` does not match a partial unique index in SQLite. I verified locally with `sqlite3`; preparing that statement fails with `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`. Use one of these instead:

   ```sql
   INSERT INTO outbound_drafts (...)
   VALUES (...)
   ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
   ```

   or use `INSERT OR IGNORE` and then query `changes()` / fetch the existing draft. Also make the migration resilient to partial failure by checking whether the column exists before `ALTER TABLE`, or by wrapping the column/index/version update in a transaction where supported.

4. Rate limiting placement - ADDRESSED

   v3 moves rate limiting into tool wrappers where the authenticated identity and tool name are known. The per-identity/tool/minute key is implementable, and the best-effort per-isolate caveat is documented clearly enough for a single-operator MCP endpoint.

5. `requireAuth` / `Response` contract - ADDRESSED

   v3 fixes the unreachable `if (auth instanceof Response)` pattern and places thrown-`Response` conversion in Hono middleware before MCP protocol handling. It also requires tests showing auth failures are HTTP responses while tool failures are MCP tool errors.

## Round 2 Minor Findings

1. `body_truncated` / `body_original_length` in `McpMessageDto` - ADDRESSED

   v3 adds both fields to the formal DTO.

2. Lower `MCP_MAX_BODY_CHARS` default - ADDRESSED

   The default is reduced to 10,000 characters. That is reasonable for the initial MCP surface and still configurable.

3. `api.all("/mcp")` method coverage - ADDRESSED

   v3 specifies `api.all("/mcp", mcpHandler)` or `api.all("/mcp/*", mcpHandler)` and tests `GET`, `POST`, and `OPTIONS`. Cloudflare's current `createMcpHandler` docs describe a Worker fetch handler with default route `/mcp`, so forwarding those methods to it is the right plan.

4. Behavioral facade tests beyond grep - ADDRESSED

   v3 keeps the source grep as a smoke check but adds behavioral tests proving send/action/raw/attachment/admin operations are unreachable through MCP tools.

## New Issues Found in v3

### MAJOR

1. The proposed SQLite upsert does not work with the proposed partial unique index.

   This is the remaining blocker. `ON CONFLICT(idempotency_key) DO NOTHING` will not prepare against a partial unique index; the conflict target must include the partial-index predicate or the implementation should use `INSERT OR IGNORE`.

### MINOR

1. The DO migration should be robust to partial reruns.

   The plan's `ALTER TABLE outbound_drafts ADD COLUMN idempotency_key TEXT` is guarded by schema version, but if a cold start fails after the `ALTER TABLE` and before writing version 2, a later retry will hit duplicate-column failure. Use the existing `columnNames` / `addColumnIfMissing` style or a transaction.

2. `setup:mcp-claim` should avoid accidental multi-user claims.

   Reading the first `ACCESS_ALLOWED_EMAILS` entry is convenient, but if more than one email is configured the script should require explicit `--owner` and print the exact D1 target before applying. This is an operator-safety concern, not an MCP auth flaw.

3. The MCP auth pseudocode has a status-code mismatch.

   The normative plan says unset `ACCESS_ALLOWED_EMAILS` is `503`; the snippet's `!isMcpAllowed` branch returns `403`. Keep `503` for unset/empty allowlist and `403` for authenticated identities outside a configured allowlist.

## Remaining Blocking Changes

- Fix the draft idempotency insert so it is valid SQLite with the partial unique index: either `ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING` or `INSERT OR IGNORE` plus `changes()` / existing-row fetch.
- Add an idempotent DO migration guard for reruns after partial failure.

CHANGES-REQUESTED
