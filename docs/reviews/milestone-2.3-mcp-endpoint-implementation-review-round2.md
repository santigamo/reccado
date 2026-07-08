# Milestone 2.3 MCP Endpoint Implementation Review Round 2

Review date: 2026-07-08

Reviewed inputs:

- Plan: `/tmp/reccado-mcp-plan-v4.md`
- Round 1 review: `docs/reviews/milestone-2.3-mcp-endpoint-implementation-review.md`
- Implementation commit: `ca92869 WIP: MCP endpoint implementation (for review v2)`

## Round 1 Finding Status

1. MAJOR #1 audit missing on errors: FIXED

   Evidence: every tool now audits rate-limit, success, and catch/error paths. `list_mailboxes` audits internal errors at `src/mcp/tools.ts:97-103`; `list_threads` audits catch paths at `src/mcp/tools.ts:137-147`; `search_messages` at `src/mcp/tools.ts:181-191`; `read_message` at `src/mcp/tools.ts:220-230`; `draft_reply` at `src/mcp/tools.ts:269-282`. `auditMcpCall` still swallows audit write failures so a D1 outage does not double-fault tool execution (`src/mcp/tools.ts:36-60`).

   Error codes are now parseable enough for MCP tool results: `not_found:` prefixes are returned at `src/mcp/tools.ts:145`, `src/mcp/tools.ts:189`, `src/mcp/tools.ts:228`, and `src/mcp/tools.ts:277`; `validation_error:` is returned at `src/mcp/tools.ts:280`; `internal_error` is returned as the exact code string at `src/mcp/tools.ts:103`, `src/mcp/tools.ts:147`, `src/mcp/tools.ts:191`, `src/mcp/tools.ts:230`, and `src/mcp/tools.ts:282`.

2. MAJOR #2 `read_message` not_found mapping: FIXED

   Evidence: `readMessage` now types the DO response as `{ message: RawMessage | null }`, then throws `not_found` if the body has no message or no message id (`src/mcp/mailbox-facade.ts:149-151`). That covers the DO's current behavior of returning a 200 with an empty object for missing messages.

3. MAJOR #3 disabled mailboxes accessible by direct ID: FIXED

   Evidence: `getMailboxForOwner` now requires `status = 'active'` in the direct mailbox lookup (`src/db/d1.ts:104-112`), matching the active-only discovery query at `src/db/d1.ts:91-101`. Since the facade resolves all non-list mailbox operations through `getMailboxForOwner`, disabled mailboxes now fail closed as `not_found`.

4. MAJOR #4 `setup-mailbox.ts` missing `owner_email`: FIXED

   Evidence: the script accepts `--owner`, canonicalizes it, derives from a single-entry `ACCESS_ALLOWED_EMAILS`, and uses `ownerSql` in the mailbox insert (`scripts/setup-mailbox.ts:130-142`, `scripts/setup-mailbox.ts:171-173`). Dry-run evidence with `--owner owner@example.com` emitted `owner_email = 'owner@example.com'`, and dry-run evidence with one `ACCESS_ALLOWED_EMAILS` entry emitted the same.

   Minor residual: with multiple `ACCESS_ALLOWED_EMAILS` values and no `--owner`, it silently emits `owner_email = NULL` (`scripts/setup-mailbox.ts:133-141`), even though the task summary said "first ACCESS_ALLOWED_EMAILS entry." That is not a core endpoint blocker, but the script should either use the first entry as specified or fail closed and require `--owner` instead of silently creating an MCP-invisible mailbox.

5. MAJOR #5 `setup-mcp-claim` JSONC/target handling: PARTIALLY-FIXED

   Evidence fixed: `parseJsonc` strips comments before parsing `wrangler.jsonc` (`scripts/setup-mcp-claim.ts:91-99`), and `getD1DatabaseName` now uses it (`scripts/setup-mcp-claim.ts:101-110`). The update SQL also escapes single quotes in the owner email (`scripts/setup-mcp-claim.ts:175`).

   Remaining blocker: the default dry-run command still fails in this worktree. `pnpm setup:mcp-claim --env dev --owner owner@example.com` now gets past JSONC parsing, prints the target, then fails running `pnpm wrangler d1 execute inbox-mcp-index-dev --env dev --file ... --json`; direct `pnpm wrangler d1 execute inbox-mcp-index-dev --env dev --local --command "SELECT 1 AS ok" --json` succeeds. The script's non-remote path does not pass `--local` (`scripts/setup-mcp-claim.ts:118-131`), so default dry-run is not robust in the local review environment.

   Remaining blocker: dry-run and apply still do not preview the same target. The script selects local/non-remote for dry-run and remote for apply (`scripts/setup-mcp-claim.ts:154-156`, `scripts/setup-mcp-claim.ts:175-176`), while the plan required the dry-run preview to show the exact D1 target and mailboxes before applying. It also prints only `D1 database: ...` and not whether the query is local or remote (`scripts/setup-mcp-claim.ts:147-151`), which weakens the operator-safety property this script was added for.

## Minor Fix Status

6. MINOR #1 OPTIONS before auth: FIXED

   Evidence: `/mcp` auth middleware now bypasses `OPTIONS` before `requireAuth` and `requireMcpAuth` (`src/api/hono.ts:142-146`). This only allows unauthenticated preflight/probing; it does not expose tool data because POST/GET still require auth.

7. MINOR #3 self-recipient exclusion: FIXED

   Evidence: `createDraft` resolves the owned active mailbox, lowercases its `primary_address`, filters that address from `to`, and throws `validation_error` if no recipients remain (`src/mcp/mailbox-facade.ts:192-200`). The mailbox row has a required `primary_address`, so this does not break on normal rows.

8. MINOR #4 `MCP_MAX_BODY_CHARS` negative value: FIXED

   Evidence: `readMessage` now accepts the env value only when `Number.isFinite(rawMax) && rawMax > 0`, otherwise it falls back to `10_000` (`src/mcp/mailbox-facade.ts:153-156`).

## New Bugs

### CRITICAL

- None found.

### MAJOR

1. `setup:mcp-claim` is still not safe/usable enough for sign-off.

   Evidence: default dry-run fails locally unless `--local` is added to the underlying Wrangler command, and dry-run/apply still point at different local-vs-remote targets (`scripts/setup-mcp-claim.ts:113-131`, `scripts/setup-mcp-claim.ts:154-176`). This is the same operator-safety area as round 1 MAJOR #5, and the fix is incomplete.

### MINOR

1. `setup-mailbox.ts` silently emits `owner_email = NULL` when `ACCESS_ALLOWED_EMAILS` has multiple entries and `--owner` is omitted.

   Evidence: owner inference only assigns an owner when `emails.length === 1` (`scripts/setup-mailbox.ts:133-141`); dry-run with `ACCESS_ALLOWED_EMAILS='alice@example.com,bob@example.com'` emitted `owner_email` as `NULL`. This is safer than accidentally choosing the wrong multi-user owner, but it should be explicit, not silent.

2. `parseJsonc` is a narrow comment stripper, not a full JSONC parser.

   Evidence: it removes every `//.*$` sequence before parsing (`scripts/setup-mcp-claim.ts:91-98`), which is enough for the checked-in `wrangler.jsonc` but would corrupt a JSON string containing `https://...`. Use the same anchored JSONC stripping pattern from `setup-mailbox.ts` or a real JSONC parser if this grows.

3. Focused lint reports one warning in the new missing-message check.

   Evidence: `pnpm exec biome lint src/mcp src/api/hono.ts src/db/d1.ts scripts/setup-mailbox.ts scripts/setup-mcp-claim.ts` reports `src/mcp/mailbox-facade.ts:151` can use optional chaining. This is not behaviorally significant.

## Validation Commands

- `git status --short --untracked-files=all` -> existing untracked round 1 review plus this round 2 artifact.
- `git log -1 --oneline` -> `ca92869 WIP: MCP endpoint implementation (for review v2)`.
- `node -v` -> `v24.15.0`.
- `pnpm -v` -> `11.1.1`.
- `pnpm wrangler --version` -> `4.106.0`.
- `pnpm exec tsc --noEmit` -> PASS.
- `pnpm exec vitest run tests/unit/mcp-auth.test.ts tests/unit/d1-migration.test.ts tests/integration/mcp-facade-security.test.ts tests/unit/auth.test.ts` -> PASS, 45 tests.
- `MAILBOX_ID_SECRET=review-secret ACCESS_ALLOWED_EMAILS=owner@example.com pnpm setup:mailbox --domain example.com --address review2@example.com` -> PASS dry-run, emitted `owner_email = 'owner@example.com'`.
- `MAILBOX_ID_SECRET=review-secret pnpm setup:mailbox --domain example.com --address review4@example.com --owner owner@example.com` -> PASS dry-run, emitted `owner_email = 'owner@example.com'`.
- `MAILBOX_ID_SECRET=review-secret ACCESS_ALLOWED_EMAILS='alice@example.com,bob@example.com' pnpm setup:mailbox --domain example.com --address review3@example.com` -> PASS dry-run, but emitted `owner_email = NULL`.
- `pnpm setup:mcp-claim --env dev --owner owner@example.com` -> FAIL after target print; underlying non-remote `wrangler d1 execute ... --env dev --file ... --json` failed in this environment.
- `pnpm wrangler d1 execute inbox-mcp-index-dev --env dev --command "SELECT 1 AS ok" --json` -> FAIL with local workerd SQLite `SQLITE_BUSY_RECOVERY`.
- `pnpm wrangler d1 execute inbox-mcp-index-dev --env dev --local --command "SELECT 1 AS ok" --json` -> PASS, showing explicit `--local` is the reliable dry-run path here.
- `pnpm exec biome lint src/mcp src/api/hono.ts src/db/d1.ts scripts/setup-mailbox.ts scripts/setup-mcp-claim.ts` -> PASS with one non-blocking optional-chain warning.

## Blocking Changes Requested

- Fix `scripts/setup-mcp-claim.ts` so dry-run works reliably in the local path, likely by passing `--local` when `remote === false` and surfacing stderr on failure.
- Make dry-run and apply preview the same target, or make the target mode explicit and require an operator flag such as `--remote`/`--local`; the printed target must say local vs remote before listing mailboxes.

CHANGES-REQUESTED
