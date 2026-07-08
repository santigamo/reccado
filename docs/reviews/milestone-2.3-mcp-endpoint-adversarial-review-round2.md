# Milestone 2.3 MCP Endpoint Plan v2 - Adversarial Review

Review date: 2026-07-08

Reviewed inputs:

- Revised plan: `/tmp/reccado-mcp-plan-v2.md`
- v1 review: `/Users/santi/orca/workspaces/inbox-mcp-cloudflare/mcp-review/docs/reviews/milestone-2.3-mcp-endpoint-adversarial-review.md`
- Repo baseline: `ded7798 feat(ui): Liquid Glass redesign for the mailbox app`
- Current official docs checked:
  - Cloudflare Agents `createMcpHandler`: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
  - Cloudflare One secure MCP servers: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

Note: the v1 review file was not present at the task's in-worktree path because this checkout has no `docs/reviews` directory. I found and read the matching v1 review from the sibling `mcp-review` worktree.

## CRITICAL Findings From v1

1. Per-mailbox authorization - PARTIALLY-ADDRESSED

   v2 adds a real ownership model (`mailboxes.owner_email`) and correctly makes MCP fail closed when `ACCESS_ALLOWED_EMAILS` is unset or empty. The per-tool policy of resolving `mailboxId` through D1 and returning generic `not_found` for missing/not-owned mailboxes is the right shape.

   The migration is not complete enough to sign off. Existing mailboxes get `owner_email = NULL` and become invisible to MCP, which is fail-closed but not a backward-compatible rollout. The plan also does not update the mailbox creation path (`insertMailbox`, `/api/mailboxes`, dev seeding/setup scripts) to populate `owner_email`, so newly created mailboxes would keep being MCP-inaccessible unless manually patched in D1. Required change: define an owner backfill/claim step for existing single-operator installs and update all mailbox write paths/tests so `owner_email` is always set for MCP-owned mailboxes.

2. No-send invariant - ADDRESSED

   The generic DO proxy has been replaced with an explicit MCP facade that only exposes list/search/read/create-draft operations. The facade omits `/request-send`, `/confirm-send`, message actions, raw downloads, attachments, debug, and admin/export paths, which is the key code-level boundary v1 required.

   The source-grep test is weak by itself because forbidden paths can be built dynamically, but v2 also calls for behavioral tests that send endpoints are unreachable. That is sufficient for the plan, as long as implementation keeps MCP code on the facade and does not expose a generic DO fetch helper.

3. Stateless `createMcpHandler` lifecycle - ADDRESSED

   v2 now creates a fresh `McpServer` and calls `createMcpHandler(server)` per request. This matches Cloudflare's current `createMcpHandler` guidance for stateless Workers with MCP SDK 1.26.0+ and removes the module-scope server leak from v1.

   The proposed two-identity concurrency test is the right regression test. I would also include a sequential two-request test because the documented failure mode includes second-request breakage, but this is not blocking.

4. JWT validation - ADDRESSED

   v2 exports/reuses the Access JWT verification path and adds issuer, required `exp`, and required `email` validation while preserving signature, `kid`, and audience checks. The proposed tests cover the v1 gaps.

   Implementation detail to watch: the current `requireAuth` throws `Response` objects. `mcpHandler` must either run behind Hono auth middleware or catch those thrown responses; the snippet's `if (auth instanceof Response)` check is not reachable with the current function contract.

5. Security middleware bypass - PARTIALLY-ADDRESSED

   Moving `/mcp` into the Hono app fixes only the global `api.use("*")` security headers automatically. It does not automatically inherit the existing auth and CSRF middleware because those are explicitly scoped to `/api/*` in `src/api/hono.ts`.

   v2 says to apply the same Origin policy with an absent-Origin exception for non-browser MCP clients, and that policy is reasonable. Required change: state explicitly that the Hono auth and Origin middleware route matchers will include `/mcp`, or register dedicated `/mcp` middleware, and test `POST /mcp` with same-origin, cross-origin, and no-Origin requests. Also register the route with method coverage that matches the transport (`GET`, `POST`, and likely `OPTIONS`), not a POST-only Hono route.

## MAJOR Findings From v1

1. `draft_reply` idempotency - PARTIALLY-ADDRESSED

   Requiring `idempotencyKey`, storing it in DO SQLite, and returning the existing draft for duplicate calls is the correct behavior.

   The schema/migration plan is incomplete. Existing Durable Object SQLite tables will not be changed by only editing `MAILBOX_SCHEMA_SQL`; the DO schema version/migration logic must be bumped and must run an `ALTER TABLE` plus a unique index. SQLite cannot add a `UNIQUE` column constraint with `ALTER TABLE ADD COLUMN`, so the migration should add a nullable column and create a unique index, likely `CREATE UNIQUE INDEX ... ON outbound_drafts(idempotency_key) WHERE idempotency_key IS NOT NULL`. The duplicate check and insert should rely on that unique constraint rather than a non-atomic check-then-insert.

2. `draft_reply` signature - ADDRESSED

   v2's required `to`, `subject`, `bodyText`, optional `threadId`, and self-recipient exclusion align with the existing draft model and avoid an underspecified reply-recipient algorithm.

3. Thread pagination/search parameters - ADDRESSED

   v2 drops cursor and `q` from `list_threads`, matching the current DO capability.

4. `read_message` DTO - ADDRESSED

   The DTO strips the sensitive internal fields called out in v1: R2 keys, hashes, raw size, parse state, idempotency keys, attachment storage fields, content IDs, and BCC.

   Minor cleanup: §5.3 adds `body_truncated` and `body_original_length`, but §4.4's DTO definition does not include them. Keep the type definition and response cap section in sync.

5. Exfiltration controls - PARTIALLY-ADDRESSED

   Audit events, per-tool limits, and body truncation are real improvements. The audit payload intentionally avoids email body content, which is good.

   The rate-limit placement is not implementable as stated. `mcpHandler` does not know the called tool before JSON-RPC dispatch unless it parses/clones the request body, and `GET`/session requests have different semantics. Rate limiting should wrap each registered tool handler, where the tool name and authenticated identity are known. Also, the in-memory limiter is best-effort per isolate and can be bypassed by isolate fanout/restarts; acceptable only as advisory for a private single-operator deployment, not as a hard security control.

6. Prompt injection - ADDRESSED

   v2 marks email bodies as untrusted in tool descriptions, separates metadata from body text, and adds a malicious fixture test. That addresses the v1 requirement.

   Do not describe the body prefix as "system-level"; MCP tool output cannot create a real system boundary. Treat it as a defense-in-depth label, and keep the no-send boundary enforced in code.

7. Direct DO proxying - ADDRESSED

   The typed facade with per-tool zod validation and output shaping fixes the direct-proxy issue.

8. Error handling - PARTIALLY-ADDRESSED

   The desired error mapping is now specified and covers the important cases without raw stack traces. The remaining gap is contract-level: current auth helpers throw Web `Response` objects, and the mcpHandler snippet does not catch them correctly. The plan should say where thrown `Response`s are converted and should include a test proving auth failures are returned as proper HTTP responses while tool failures are MCP tool errors.

9. Access URL - ADDRESSED

   v2 requires a custom domain and validates unauthenticated Access behavior at that exact endpoint. Current Cloudflare MCP Access docs show `workers.dev` examples, but this repo's `wrangler.jsonc` explicitly says Access needs a custom domain for the protected UI/dev path, so v2's stricter custom-domain requirement is acceptable.

10. Dependencies - ADDRESSED

   The dependency plan (`pnpm add agents @modelcontextprotocol/sdk`) and build/typecheck/typegen validation are sufficient. Use the repo's current verified typegen command (`pnpm wrangler types --env dev`) in the actual gate.

## NEW Issues Found in v2

### MAJOR

1. Ownership rollout is incomplete.

   `owner_email` is safe from a security perspective because NULL owners fail closed, but it leaves existing and newly created mailboxes inaccessible to MCP unless operators manually update D1. Add a migration/backfill/claim plan and update mailbox creation/seed paths to set ownership.

2. Hono mount does not inherit `/api/*` middleware.

   The plan's "mount inside Hono means it inherits auth and CSRF" statement is false for the current code because auth and CSRF middleware are path-scoped to `/api/*`. Explicit `/mcp` middleware is required.

3. DO draft idempotency migration is not executable as written.

   Editing `MAILBOX_SCHEMA_SQL` does not migrate existing DO SQLite tables, and SQLite requires a unique index rather than `ALTER TABLE ... ADD COLUMN ... UNIQUE`. This needs an explicit DO schema version bump and migration path.

4. Rate limiting is specified at the wrong layer and is only advisory.

   Per-tool limits should be enforced in the tool wrapper, not in the outer `mcpHandler` unless the handler clones/parses JSON-RPC requests itself. In-memory counters must be documented as best-effort only; if rate limiting is a security boundary, use a centralized limiter.

### MINOR

1. `/mcp` method handling needs to be explicit.

   `createMcpHandler` serves the Streamable HTTP transport, so the Hono route should forward `GET`, `POST`, and preflight/`OPTIONS` as needed. The plan should specify `api.all("/mcp", ...)` or equivalent and test MCP Inspector against the final mounted path.

2. The facade security test should not rely on source grep alone.

   Keep the grep as a smoke check, but behavioral tests should prove forbidden operations cannot be invoked through exported MCP tools.

3. The default `MCP_MAX_BODY_CHARS = 50000` is high for many agent contexts.

   It is not a direct security break, but it still permits large prompt-injection payloads and high-volume extraction. Consider a lower default with an explicit "read more" follow-up later.

4. DTO docs and response-size docs disagree.

   Add `body_truncated` and `body_original_length` to the formal `McpMessageDto` if they are returned.

## Remaining Blocking Changes

- Define and test `owner_email` backfill plus all future mailbox creation/write paths.
- Explicitly include `/mcp` in Hono auth and Origin middleware and cover `GET`/`POST`/`OPTIONS`.
- Specify a real DO SQLite migration for draft idempotency and use atomic unique-conflict handling.
- Move per-tool rate limiting/auditing into tool wrappers or otherwise prove the outer handler can safely inspect JSON-RPC calls without consuming the request body.
- Fix the `requireAuth`/`Response` contract in the MCP handler plan and test auth error mapping.

CHANGES-REQUESTED
