# Milestone 2.3 — MCP Endpoint Plan (Revised v4)

Addresses all remaining blocking findings from round 3 review. All findings ADDRESSED in v3 remain unchanged; this document only amends the 2 remaining blocking items.

Changes from v3 are marked **[v4 CHANGE]**.

## 1. Auth: Hardened Access facade (CRITICAL #1, #4, #5)

### 1.1 Fail-closed for MCP (unchanged from v2)

The MCP endpoint has a **stricter auth policy** than the UI:

- If `ACCESS_ALLOWED_EMAILS` is **unset or empty**, the MCP endpoint returns `503` and refuses to serve any tool call.
- If `ACCESS_ALLOWED_EMAILS` is set, the authenticated user's email must be in the allowlist.

### 1.2 Per-mailbox ownership (CRITICAL #1) — [v3 CHANGE: backfill + write paths]

Add `owner_email TEXT` column to the D1 `mailboxes` table via migration `migrations/d1/0003_mailbox_owner.sql`:

```sql
ALTER TABLE mailboxes ADD COLUMN owner_email TEXT;
CREATE INDEX idx_mailboxes_owner ON mailboxes(owner_email);
```

**[v3 CHANGE — Backfill for existing mailboxes]**

Existing mailboxes get `owner_email = NULL`. The MCP endpoint treats NULL as "not owned by anyone" and returns `not_found` — fail-closed. But for a single-operator install, the operator must be able to claim existing mailboxes. The plan includes:

1. **`pnpm setup:mcp-claim` script** (`scripts/setup-mcp-claim.ts`): prompts for the owner email (or reads `ACCESS_ALLOWED_EMAILS` first entry), runs `UPDATE mailboxes SET owner_email = ? WHERE owner_email IS NULL` against the target D1 database. Idempotent — safe to run multiple times. Only claims NULL-owned mailboxes. Prints a summary of claimed mailboxes.

   **[v4 CHANGE — operator safety]**: If `ACCESS_ALLOWED_EMAILS` has more than one entry, the script requires an explicit `--owner <email>` flag and refuses to run without it (prevents accidental multi-user claims). The script canonicalizes the owner email (lowercase, trim) before writing. It prints the exact D1 target (database name, account) and the mailboxes to be claimed before applying, requiring `--apply` to confirm (dry-run by default).

2. **Mailbox creation paths updated**: `insertMailbox` in `src/db/d1.ts` and the dev seeding script (`scripts/seed-dev-d1.ts`) are updated to accept and set `owner_email`. The `POST /api/mailboxes` route (`src/api/mailbox-routes.ts`) passes `auth.email` as `owner_email`. New mailboxes are always owned by their creator.

3. **`setup:mailbox` script** (`scripts/setup-mailbox.ts`) updated to accept `--owner <email>` (default: first entry in `ACCESS_ALLOWED_EMAILS`).

4. **Migration test**: `tests/unit/d1-migration.test.ts` verifies that after applying `0003_mailbox_owner.sql`, the `owner_email` column exists, the index exists, existing rows have NULL (fail-closed), and the backfill script claims them correctly.

### 1.3 Hardened JWT validation (unchanged from v2)

Export a single hardened auth function from `src/api/auth.ts` used by both `/api/*` and `/mcp`:

- Export `verifyAccessJwt` (currently private).
- Add issuer validation: verify `payload.iss` matches `https://<team_domain>.cloudflareaccess.com`.
- Require `exp`: reject tokens without `exp` or with expired `exp`.
- Require `email`: reject tokens without a usable `email` claim.
- Keep: signature verification, `kid` matching, audience check.

Tests in `tests/unit/auth.test.ts`: missing `iss`, wrong `iss`, missing `exp`, expired `exp`, missing `email`, wrong audience, unknown `kid`, valid token.

### 1.4 Security middleware for /mcp (CRITICAL #5) — [v3 CHANGE: explicit /mcp middleware]

**[v3 CHANGE]** — The v2 plan said mounting `/mcp` inside Hono "inherits all middleware." This is **false**: the existing auth and CSRF middleware in `src/api/hono.ts` are path-scoped to `/api/*` (using `api.use("/api/*", ...)`), so `/mcp` does NOT automatically inherit them.

The revised approach:

1. **Register dedicated `/mcp` middleware** in `src/api/hono.ts`, explicitly:

```ts
// Security headers for /mcp (same as /api/*)
api.use("/mcp/*", securityHeadersMiddleware);

// Auth for /mcp — same requireAuth, but with MCP fail-closed policy
api.use("/mcp/*", mcpAuthMiddleware);

// CSRF Origin-check for state-changing MCP requests
// POST /mcp is state-changing (tool calls). Apply Origin check,
// but allow absent Origin (non-browser MCP clients).
api.use("/mcp/*", mcpOriginMiddleware);
```

2. **`mcpAuthMiddleware`**: calls `requireAuth(request, env)`. If `requireAuth` throws a `Response` (current behavior for 401/403/503), catch it and return it directly — Hono middleware can handle thrown Responses. Additionally, enforce the MCP-specific fail-closed policy: if `ACCESS_ALLOWED_EMAILS` is unset or empty, return **503** (misconfigured, not the caller's fault). If the allowlist is set but the authenticated email is not in it, return **403** (forbidden). The authenticated identity is stored in `c.set("auth", auth)`.

```ts
async function mcpAuthMiddleware(c, next) {
  try {
    const auth = await requireAuth(c.req.raw, c.env);
    c.set("auth", auth);
    // [v4 CHANGE] Distinguish "misconfigured" (503) from "not allowed" (403).
    const allowlist = parseAllowedEmails(c.env);
    if (!allowlist) {
      // Unset/empty allowlist = MCP misconfigured, not caller's fault.
      return c.json({ error: "mcp_not_configured", reason: "ACCESS_ALLOWED_EMAILS is not set" }, 503);
    }
    if (!allowlist.includes(auth.email.trim().toLowerCase())) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  } catch (error) {
    if (error instanceof Response) {
      return error; // 401/403/503 from requireAuth
    }
    throw error;
  }
}
```
   - If `Origin` header is **absent**: allow (non-browser MCP client like Claude Desktop, MCP Inspector, mcp-remote proxy).
   - If `Origin` header is **present**: validate against the same allowed origins as `/api/*` (the Worker's own origin). If mismatched, return 403.
   - For `GET /mcp` (session/stream): no Origin check (read-only).
   - For `OPTIONS /mcp` (preflight): handled by `createMcpHandler` or a CORS wrapper — no Origin check, return 204.

4. **Route registration**: use `api.all("/mcp", mcpHandler)` or `api.all("/mcp/*", mcpHandler)` to ensure `GET`, `POST`, and `OPTIONS` are all forwarded to `createMcpHandler`. The `createMcpHandler` from the Agents SDK handles method routing internally.

5. **Tests** (`tests/integration/mcp-security.test.ts`):
   - `POST /mcp` with same-origin `Origin` → passes to MCP handler.
   - `POST /mcp` with cross-origin `Origin` → 403.
   - `POST /mcp` with no `Origin` → passes (MCP client).
   - `GET /mcp` with no `Origin` → passes.
   - `OPTIONS /mcp` → 204 or passes to handler.
   - No JWT → 401.
   - `ACCESS_ALLOWED_EMAILS` unset → 503.
   - JWT with wrong audience → 401.

6. **`requireAuth` / Response contract** — [v3 CHANGE]: The v2 plan's `if (auth instanceof Response)` check is unreachable because `requireAuth` **throws** Response objects (it doesn't return them). The `mcpAuthMiddleware` must use `try/catch`:

```ts
async function mcpAuthMiddleware(c, next) {
  try {
    const auth = await requireAuth(c.req.raw, c.env);
    c.set("auth", auth);
    // MCP fail-closed: require allowlist
    if (!isMcpAllowed(auth, c.env)) {
      return c.json({ error: "forbidden" }, 403);
    }
    await next();
  } catch (error) {
    if (error instanceof Response) {
      return error; // 401/403/503 from requireAuth
    }
    throw error;
  }
}
```

Test: auth failures (no JWT, wrong audience, unset allowlist) are returned as proper HTTP responses, not MCP tool errors. Tool failures (not_found, validation_error) are returned as MCP tool error results, not HTTP responses.

## 2. MCP server lifecycle (unchanged from v2)

Per-request `McpServer` instantiation — fresh server per request, no module-level singleton. Concurrency test for cross-client isolation. Also add a sequential two-request test (second-request breakage regression).

## 3. MCP mailbox facade (unchanged from v2)

Closed operation allowlist — `McpMailboxFacade` with explicit methods only. No send/action/raw/attachment/admin paths. Source-grep test + behavioral tests proving forbidden operations are unreachable.

## 4. Tool definitions

### 4.1 Tool list (unchanged from v2, except rate limiting — see §5.2)

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `list_mailboxes` | — | `McpMailbox[]` | Filters by `owner_email = auth.email`. Hides disabled. |
| `list_threads` | `mailboxId`, `limit?` (max 50, default 25), `state?` | `McpThread[]` | No `cursor`/`q`. |
| `search_messages` | `mailboxId`, `q`, `limit?` (max 50, default 25) | `McpSearchResult[]` | Phrase search (FTS5). Documented. |
| `read_message` | `mailboxId`, `messageId` | `McpMessageDto` | Strips internal fields. Body marked untrusted. |
| `draft_reply` | `mailboxId`, `to: string[]`, `subject: string`, `bodyText: string`, `threadId?`, `idempotencyKey: string` | `McpDraftResult` | Idempotent. No send. |

### 4.2 draft_reply idempotency (MAJOR #1) — [v3 CHANGE: real DO migration]

**[v3 CHANGE]** — The v2 plan said "add `idempotency_key` column to `outbound_drafts` in `mailbox-schema-content.ts`." This is insufficient because:

1. Editing `MAILBOX_SCHEMA_SQL` only affects **new** DO instances. Existing DO instances with already-created SQLite tables won't get the new column.
2. SQLite `ALTER TABLE ADD COLUMN` cannot add a `UNIQUE` constraint inline.

The revised approach:

1. **Bump `MAILBOX_SCHEMA_VERSION`** in `src/do/mailbox-do.ts` from `1` to `2`.

2. **Add migration logic** in the DO constructor (where `MAILBOX_SCHEMA_VERSION` is checked) — [v4 CHANGE: idempotent column check]:

```ts
// In the DO constructor migration block:
if (currentVersion < 2) {
  // [v4 CHANGE] Guard ALTER TABLE against partial-failure reruns:
  // check if the column already exists before adding it.
  const columns = this.ctx.storage.sql.exec(`PRAGMA table_info(outbound_drafts)`).toArray();
  const hasIdempotencyKey = columns.some((row) => row.name === "idempotency_key");
  if (!hasIdempotencyKey) {
    this.ctx.storage.sql.exec(
      `ALTER TABLE outbound_drafts ADD COLUMN idempotency_key TEXT`
    );
  }
  // CREATE UNIQUE INDEX IF NOT EXISTS is inherently idempotent.
  this.ctx.storage.sql.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_idempotency
     ON outbound_drafts(idempotency_key)
     WHERE idempotency_key IS NOT NULL`
  );
  // Update schema_migrations version (idempotent via INSERT OR REPLACE).
  this.ctx.storage.sql.exec(
    `INSERT OR REPLACE INTO schema_migrations (version, applied_at) VALUES (2, ?)`,
    new Date().toISOString()
  );
}
```

   **[v4 CHANGE]** — The migration is now resilient to partial failure: if a cold start fails after `ALTER TABLE` but before writing the version, a later retry checks `PRAGMA table_info` before attempting `ALTER TABLE` (avoids duplicate-column error), `CREATE UNIQUE INDEX IF NOT EXISTS` is inherently idempotent, and `INSERT OR REPLACE` for the version is idempotent. This follows the same defensive pattern as the existing `addColumnIfMissing` style.

3. **Update `MAILBOX_SCHEMA_SQL`** in `mailbox-schema-content.ts` to include the `idempotency_key` column and unique index for **new** DO instances (fresh installs get the full schema).

4. **Atomic idempotency check** — [v4 CHANGE]: `createDraft` in the DO uses `INSERT OR IGNORE` and checks `changes() === 0` to detect duplicates. If no rows were inserted (duplicate), fetch and return the existing draft by `idempotency_key`. This is atomic — no check-then-insert race condition.

   **[v4 CHANGE]** — The v3 plan proposed `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING`, but this does **not** work with a partial unique index in SQLite (the conflict target must include the partial-index predicate). The revised approach uses `INSERT OR IGNORE`, which works with any unique index including partial indexes:

```ts
// Atomic idempotent insert in createDraft:
const result = this.ctx.storage.sql.exec(
  `INSERT OR IGNORE INTO outbound_drafts (id, thread_id, to_json, cc_json, bcc_json, subject, body_text, body_html, status, created_by, created_at, updated_at, idempotency_key)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
  draftId, threadId, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, bodyText, bodyHtml, createdBy, now, now, idempotencyKey
);
if (result.rowsWritten === 0) {
  // Duplicate — fetch and return the existing draft
  const existing = this.ctx.storage.sql.exec(
    `SELECT * FROM outbound_drafts WHERE idempotency_key = ?`,
    idempotencyKey
  ).one();
  return { draftId: existing.id, status: "draft", duplicate: true };
}
return { draftId, status: "draft", duplicate: false };
```

   `INSERT OR IGNORE` silently skips the insert if the unique constraint (partial index `WHERE idempotency_key IS NOT NULL`) is violated, and `rowsWritten === 0` signals the duplicate case. This is valid SQLite for partial unique indexes.

5. **Test** (`tests/unit/ingest.test.ts` or new `tests/unit/draft-idempotency.test.ts`):
   - Two `createDraft` calls with the same `idempotency_key` → same `draft_id`, second call returns `duplicate: true`.
   - Two calls with different `idempotency_key` → different `draft_id`.
   - Null `idempotency_key` → no dedup (column is nullable, unique index has `WHERE idempotency_key IS NOT NULL`).
   - DO schema migration from v1 → v2 adds the column and index to an existing instance.

### 4.3 draft_reply signature (unchanged from v2)

`to` (required `string[]`), `subject` (required), `bodyText` (required), `threadId` (optional), `idempotencyKey` (required). Self-recipient exclusion. LLM explicitly specifies recipients.

### 4.4 read_message DTO — [v3 CHANGE: add truncation fields]

**[v3 CHANGE]** — Add `body_truncated` and `body_original_length` to the formal DTO (v2 had them in §5.3 but not in the type definition):

```ts
type McpMessageDto = {
  message_id: string;
  thread_id: string;
  direction: "inbound" | "outbound";
  from_addr: string;
  to: string[];
  cc: string[];
  subject: string | null;
  date: string | null;
  received_at: string;
  is_read: boolean;
  has_attachments: boolean;
  attachments: Array<{ filename: string | null; content_type: string | null; size: number }>;
  body_text: string;
  body_truncated: boolean;        // [v3 CHANGE]
  body_original_length: number;  // [v3 CHANGE]
};
```

**Stripped**: `raw_r2_key`, `raw_sha256`, `raw_size`, `body_html_r2_key`, `idempotency_key`, `parse_status`, attachment `r2_key`, `sha256`, `content_id`, `bcc`.

### 4.5 Prompt injection (unchanged from v2, with clarification)

Tool description marks body text as untrusted. Metadata separated from body. Test with `prompt-injection.eml` fixture. **[v3 clarification]**: The body prefix is a defense-in-depth label, not a "system-level boundary." The real boundary is the code-level no-send enforcement in the facade.

### 4.6 Validation and error handling — [v3 CHANGE: contract clarification]

**[v3 CHANGE]** — Explicitly state where thrown `Response` objects are converted:

- **Auth layer** (`mcpAuthMiddleware`): catches thrown `Response` from `requireAuth` and returns them as HTTP responses (401/403/503). These are NOT MCP tool errors — they're HTTP-level rejections before MCP protocol kicks in.
- **Tool handlers**: never throw `Response`. All errors are caught and returned as MCP tool error results with structured error codes: `not_found`, `validation_error`, `internal_error`. No stack traces, no raw exception strings.

Test: auth failures return HTTP responses; tool failures return MCP errors. No `Response` objects leak into MCP tool output.

## 5. Exfiltration controls (MAJOR #5) — [v3 CHANGE: rate limit placement]

### 5.1 Audit events (unchanged from v2)

Every MCP tool call writes an `ops_events` row to D1 with identity, tool name, mailbox ID, result count, latency, denied flag.

### 5.2 Rate limits — [v3 CHANGE: moved to tool wrappers]

**[v3 CHANGE]** — The v2 plan placed rate limiting in `mcpHandler` (outer handler), but the outer handler doesn't know which tool is being called until after JSON-RPC dispatch. The revised approach:

Rate limiting is enforced in **tool handler wrappers**, not in the outer `mcpHandler`:

```ts
// In tools.ts, each tool is wrapped:
function withRateLimit(toolName: string, limit: number, handler: ToolHandler): ToolHandler {
  return async (params, extra) => {
    const auth = extra.auth; // injected per-request
    const key = `${auth.email}:${toolName}:${Math.floor(Date.now() / 60000)}`;
    if (rateCounter.get(key, 0) >= limit) {
      await auditMcpCall(auth, toolName, params, { denied: true, reason: "rate_limited" });
      return { content: [{ type: "text", text: "Rate limit exceeded. Try again in a minute." }], isError: true };
    }
    rateCounter.increment(key);
    return handler(params, extra);
  };
}
```

- `list_mailboxes`: 10/min, `list_threads`: 30/min, `search_messages`: 30/min, `read_message`: 60/min, `draft_reply`: 10/min.
- In-memory counter keyed by `auth.email + toolName + minute-window` in the Worker isolate.
- **Documented as best-effort/advisory only** — per-isolate, not distributed. Sufficient for a single-operator MCP endpoint. If rate limiting becomes a hard security requirement, use a centralized limiter (KV or Durable Object counter).
- Denied calls (rate-limited) also write audit events.

### 5.3 Response size cap — [v3 CHANGE: lower default]

**[v3 CHANGE]** — Default `MCP_MAX_BODY_CHARS` lowered from 50000 to **10000** (round 2 noted 50000 is high for agent contexts and permits large prompt-injection payloads). Configurable via env var. If truncated, response includes `body_truncated: true` and `body_original_length`. A future "read more" follow-up tool can fetch the rest.

## 6. Deployment and dependencies (unchanged from v2)

- `pnpm add agents @modelcontextprotocol/sdk`
- `pnpm wrangler types --env dev` — typegen.
- `pnpm run build` — Vite + Cloudflare plugin.
- `pnpm exec tsc --noEmit` — typecheck.
- MCP endpoint on **custom domain** (not `workers.dev`).
- Access config: MCP server app, Managed OAuth, AUD tag → `ACCESS_JWT_AUDIENCE`.

### 6.1 Code structure (unchanged from v2)

```
src/mcp/
  handler.ts          — mcpHandler: per-request McpServer + createMcpHandler + auth + audit
  mailbox-facade.ts   — closed operation allowlist, typed methods, DTO shaping
  tools.ts            — tool registration (zod schemas + descriptions + handlers + rate limit wrappers)
  types.ts            — McpMessageDto (with body_truncated, body_original_length), McpThread, etc.
  errors.ts           — MCP error mapping
```

Changes to existing files:
- `src/api/auth.ts` — export `verifyAccessJwt`, add `iss`/`exp`/`email` requirements, add `isMcpAllowed`.
- `src/api/hono.ts` — register `/mcp` middleware (security headers, auth with fail-closed, Origin check with absent-Origin exception) + `api.all("/mcp", mcpHandler)`.
- `src/server.ts` — widen `if (url.pathname.startsWith("/api/"))` to `if (url.pathname.startsWith("/api/") || url.pathname === "/mcp")`.
- `src/do/mailbox-do.ts` — bump `MAILBOX_SCHEMA_VERSION` to 2, add migration for `idempotency_key` column + unique index, update `createDraft` to use atomic upsert.
- `src/do/mailbox-schema-content.ts` — add `idempotency_key` column + index to `MAILBOX_SCHEMA_SQL` for fresh installs.
- `src/db/d1.ts` — update `insertMailbox` to accept and set `owner_email`.
- `scripts/seed-dev-d1.ts` — set `owner_email` on seeded mailboxes.
- `scripts/setup-mailbox.ts` — accept `--owner <email>`.
- `scripts/setup-mcp-claim.ts` — **new** — backfill `owner_email` for existing mailboxes.
- `migrations/d1/0003_mailbox_owner.sql` — add `owner_email` column + index.

## 7. Test plan (updated from v2)

### Unit tests
- `tests/unit/mcp-tools.test.ts` — zod schemas for each tool.
- `tests/unit/auth.test.ts` — hardened JWT validation (iss, exp, email, audience, kid).
- `tests/unit/d1-migration.test.ts` — `0003_mailbox_owner.sql` adds column + index, NULL owners fail-closed, backfill claims correctly.
- `tests/unit/draft-idempotency.test.ts` — DO schema v1→v2 migration, atomic upsert, duplicate detection, null key handling.

### Integration tests
- `tests/integration/mcp-facade-security.test.ts` — source-grep for forbidden paths + behavioral tests proving send/action/raw/attachment/admin unreachable.
- `tests/integration/mcp-isolation.test.ts` — two concurrent clients (distinct identities) + two sequential requests (second-request breakage regression).
- `tests/integration/mcp-tool-calls.test.ts` — full tool flow: `list_mailboxes` (owner filter), `list_threads`, `search_messages`, `read_message` (DTO + truncation), `draft_reply` (idempotency).
- `tests/integration/mcp-security.test.ts` — no JWT → 401, wrong allowlist → 403, unset allowlist → 503, wrong owner → `not_found`, cross-origin POST → 403, no-Origin POST → passes, prompt-injection body as data, rate limit → 429/error.

### Smoke tests
- MCP Inspector → dev deploy on custom domain.
- List tools, call `search_messages`, `read_message`.
- Access login flow.
- Unauthenticated `/mcp` → Access 302 (not 200).

## 8. Validation gate (unchanged from v2)

- Connect MCP client, list tools, call `search_messages` → authorized.
- `read_message` → shaped DTO, no internal fields, body truncated at 10k.
- `draft_reply` twice same `idempotencyKey` → same `draft_id`, `duplicate: true`.
- Unauthorized mailbox → `not_found`.
- No JWT → 401. Unset allowlist → 503. Cross-origin POST → 403.
- `ops_events` has audit rows.
- Rate limit triggers after threshold.
- Prompt-injection body returned as data.

## 9. What does NOT change (unchanged from v2)

- Mailbox Durable Object is the only source of truth.
- D1 is rebuildable index.
- `request-send` → `confirm-send` with idempotency key is the only sending path.
- MCP tools cannot send. Facade has no send method.
- Raw MIME and attachments in R2. MCP never exposes R2 keys.
- Tier B builds on Tier A without redefining its data model.
