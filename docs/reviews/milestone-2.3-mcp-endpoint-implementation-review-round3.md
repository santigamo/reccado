# Milestone 2.3 MCP Endpoint Implementation Review Round 3

Review date: 2026-07-08

Reviewed inputs:

- Round 2 review: `docs/reviews/milestone-2.3-mcp-endpoint-implementation-review-round2.md`
- Implementation commit: `422ca5a WIP: MCP endpoint implementation (for review v3)`

## Round 2 Blocking Finding Status

1. MAJOR #1 `setup:mcp-claim` dry-run/apply target mismatch: FIXED

   Evidence: `parseArgs` now accepts `--remote` and returns a single `remote` boolean used by the rest of the script (`scripts/setup-mcp-claim.ts:35-48`). `d1Execute` now always appends either `--remote` or `--local`, so Wrangler no longer relies on an ambiguous default target (`scripts/setup-mcp-claim.ts:115-133`).

   Evidence: dry-run preview and apply use the same target selector. The preview query uses `d1Execute(envName, databaseName, findSql, remote)` (`scripts/setup-mcp-claim.ts:160-163`), and the apply update uses `d1Execute(envName, databaseName, updateSql, remote)` (`scripts/setup-mcp-claim.ts:181-182`).

   Evidence: the script prints the target before querying: `Target: LOCAL` or `Target: REMOTE` is derived at `scripts/setup-mcp-claim.ts:148-150` and printed at `scripts/setup-mcp-claim.ts:152-157`. The header comment documents local dry-run, local apply, and remote apply usage at `scripts/setup-mcp-claim.ts:13-17`.

   Validation: `pnpm setup:mcp-claim --env dev --owner owner@example.com` now runs successfully against the dev local D1 target after applying dev local migrations, printing `Target: LOCAL` and `No mailboxes with NULL owner_email found. Nothing to claim.`

## New Bugs

### CRITICAL

- None.

### MAJOR

- None.

### MINOR

- None introduced by the round 3 fix. The script remains an operator tool, and the remaining behavior is acceptable for this milestone.

## Validation Commands

- `git status --short --untracked-files=all` -> pre-existing untracked round 1/round 2 review artifacts plus this new round 3 artifact.
- `git log -1 --oneline` -> `422ca5a WIP: MCP endpoint implementation (for review v3)`.
- `node -v` -> `v24.15.0`.
- `pnpm -v` -> `11.1.1`.
- `pnpm wrangler --version` -> `4.106.0`.
- `pnpm exec tsc --noEmit` -> PASS.
- `pnpm exec biome lint scripts/setup-mcp-claim.ts src/mcp/mailbox-facade.ts` -> PASS.
- `pnpm wrangler d1 migrations apply inbox-mcp-index-dev --local --env dev` -> PASS; applied local dev D1 migrations needed for a schema-correct dry-run target.
- `pnpm setup:mcp-claim --env dev --owner owner@example.com` -> PASS; printed `Target: LOCAL` and completed dry-run without mutation.

SIGN-OFF
