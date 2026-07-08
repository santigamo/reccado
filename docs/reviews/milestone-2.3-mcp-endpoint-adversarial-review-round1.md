# Milestone 2.3 MCP Endpoint Plan - Adversarial Review

Review date: 2026-07-08

Reviewed repo baseline:

- `git log -1 --oneline`: `ded7798 feat(ui): Liquid Glass redesign for the mailbox app`
- `node -v`: `v24.15.0`
- `pnpm -v`: `11.1.1`
- `pnpm wrangler --version`: `4.106.0`

External primary docs checked:

- Cloudflare Agents `createMcpHandler`: https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/
- Cloudflare One "Secure MCP servers": https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

## CRITICAL

1. The plan has no real per-mailbox authorization; `mailboxId` is fully user-controlled.

   The plan says tools "list mailboxes for authenticated user" and then `assertMailboxAccess`, but the repo has no user-to-mailbox ownership model. `assertMailboxAccess` explicitly ignores the mailbox ID: [src/api/auth.ts:234](../../src/api/auth.ts:234) documents "TODO: per-mailbox ACL", and [src/api/auth.ts:236](../../src/api/auth.ts:236) names the parameter `_mailboxId`. `listMailboxes` returns every mailbox in D1 with no identity predicate at [src/db/d1.ts:83](../../src/db/d1.ts:83), and the D1 mailbox table has no owner/principal column at [migrations/d1/0001_initial.sql:10](../../migrations/d1/0001_initial.sql:10). The mailbox routes then call `MAILBOX_DO.getByName(mailboxId)` after only that global allowlist check, for example [src/api/mailbox-routes.ts:49](../../src/api/mailbox-routes.ts:49) through [src/api/mailbox-routes.ts:60](../../src/api/mailbox-routes.ts:60) and [src/api/mailbox-routes.ts:176](../../src/api/mailbox-routes.ts:176) through [src/api/mailbox-routes.ts:182](../../src/api/mailbox-routes.ts:182).

   Impact: if the Access app policy allows more than one person, or if `ACCESS_ALLOWED_EMAILS` is unset, any authenticated Access identity can enumerate, search, read, and draft in every mailbox. The current code even treats unset `ACCESS_ALLOWED_EMAILS` as open single-operator mode at [src/api/auth.ts:187](../../src/api/auth.ts:187) through [src/api/auth.ts:195](../../src/api/auth.ts:195). That is tolerable only for a documented single-user install, not for an MCP endpoint exposed through "allow emails ending in domain" Access policies.

   Required fix: add a real mailbox ownership/ACL mapping or explicitly make the MCP endpoint single-owner-only and fail closed unless `ACCESS_ALLOWED_EMAILS` contains exactly the authenticated owner. Do not accept caller-supplied `mailboxId` without resolving it from an identity-scoped list.

2. The "no send" invariant is currently a convention, not a code-level boundary.

   The Durable Object exposes `/drafts/:id/request-send` and `/drafts/:id/confirm-send` internally at [src/do/mailbox-do.ts:600](../../src/do/mailbox-do.ts:600) through [src/do/mailbox-do.ts:609](../../src/do/mailbox-do.ts:609). `confirmSendDraft` calls the Cloudflare Email binding at [src/do/mailbox-do.ts:347](../../src/do/mailbox-do.ts:347) through [src/do/mailbox-do.ts:355](../../src/do/mailbox-do.ts:355). The public API route wraps confirmation with D1 idempotency and indexing at [src/api/mailbox-routes.ts:212](../../src/api/mailbox-routes.ts:212) through [src/api/mailbox-routes.ts:318](../../src/api/mailbox-routes.ts:318), but the plan says MCP tools will proxy directly to the DO by name. A future MCP helper, a bad refactor, or a generic "proxy route" helper could call the send endpoints and bypass the API-level saga.

   Impact: the hard invariant "agents may draft but never send without explicit human confirmation" is not enforced by an MCP-specific capability boundary. The current DO trusts internal callers; it does not know whether the caller is UI, queue, scheduled job, admin, or MCP.

   Required fix: build an explicit MCP mailbox facade with a closed allowlist of exact operations, not arbitrary DO URL proxying. Add code/tests proving `/request-send`, `/confirm-send`, message actions, raw download, attachment download, admin routes, debug routes, and any future mutating route are unreachable from MCP. Consider passing a non-forgeable internal purpose header from the API for send paths and rejecting direct DO send calls without it.

3. The stateless `createMcpHandler` plan is unsafe or broken if `McpServer` is defined globally.

   Cloudflare's current `createMcpHandler` docs say SDK 1.26.0+ requires stateless servers to create a new `McpServer` per request because a global instance can leak responses between clients and will fail on a second request. The plan's proposed `src/mcp/server.ts - McpServer definition + createMcpHandler at /mcp` reads like a module-level `McpServer` and module-level handler. That is exactly the anti-pattern Cloudflare documents.

   Impact: this can become a cross-client data leak for inbox data, not just a reliability issue.

   Required fix: make `mcpHandler(request, env, ctx)` instantiate a fresh `McpServer`, register tools, and call `createMcpHandler(server)(request, env, ctx)` per request, or use a stateful `McpAgent` with a correctly scoped transport. Add a concurrency test with two simulated clients and distinct tool outputs.

4. Reusing `verifyAccessJwt` as stated is impossible and incomplete.

   `verifyAccessJwt` is not exported at [src/api/auth.ts:76](../../src/api/auth.ts:76), so `src/mcp/auth.ts` cannot "reuse" it without changing API auth or copying it. More importantly, the existing payload type only models `sub`, `email`, `aud`, and `exp` at [src/api/auth.ts:13](../../src/api/auth.ts:13) through [src/api/auth.ts:18](../../src/api/auth.ts:18); verification checks signature, optional `exp`, and `aud` at [src/api/auth.ts:103](../../src/api/auth.ts:103) through [src/api/auth.ts:122](../../src/api/auth.ts:122). Cloudflare's Access MCP guidance says the server should validate the Access JWT signature plus issuer and audience. The current code does not validate issuer, does not require `exp`, and does not require a usable email claim before producing an identity at [src/api/auth.ts:143](../../src/api/auth.ts:143) through [src/api/auth.ts:145](../../src/api/auth.ts:145).

   Impact: the MCP endpoint is a new high-value data exfiltration surface. "Good enough for the UI" auth should not be copied into a remote agent interface without tightening the claims contract.

   Required fix: export a single hardened `requireAuth`-style function used by both `/api/*` and `/mcp`, validate `iss`, require `exp`, require `email` for allowlist matching, and add tests for missing `iss`, wrong `iss`, missing `exp`, missing `email`, wrong audience, and unknown `kid`.

5. `/mcp` would bypass the existing Hono security middleware and CSRF defense.

   The global security headers, CSRF Origin check, and `/api/*` auth middleware live inside `createApiApp`: headers at [src/api/hono.ts:86](../../src/api/hono.ts:86) through [src/api/hono.ts:100](../../src/api/hono.ts:100), CSRF at [src/api/hono.ts:102](../../src/api/hono.ts:102) through [src/api/hono.ts:116](../../src/api/hono.ts:116), auth at [src/api/hono.ts:118](../../src/api/hono.ts:118) through [src/api/hono.ts:132](../../src/api/hono.ts:132). `src/server.ts` only dispatches `/api/*` to Hono at [src/server.ts:126](../../src/server.ts:126) through [src/server.ts:128](../../src/server.ts:128), then sends everything else to TanStack at [src/server.ts:129](../../src/server.ts:129) through [src/server.ts:130](../../src/server.ts:130). Adding a sibling `/mcp` route before the fallback inherits none of those protections.

   Impact: `draft_reply` is state-changing. If Cloudflare Access authenticates browser-origin requests with cookies, a cross-site POST can potentially create drafts unless `/mcp` implements its own Origin policy. It will also miss the baseline response headers and consistent auth error behavior.

   Required fix: wrap `/mcp` with the same auth, security-header, and state-changing Origin policy, adjusted for MCP clients. If non-browser MCP clients omit `Origin`, keep that behavior explicit and tested.

## MAJOR

1. `draft_reply` is not idempotent.

   `createDraft` always generates a new UUID at [src/do/mailbox-do.ts:217](../../src/do/mailbox-do.ts:217) through [src/do/mailbox-do.ts:236](../../src/do/mailbox-do.ts:236). The `outbound_drafts` table has no idempotency column or uniqueness constraint at [src/do/mailbox-schema-content.ts:122](../../src/do/mailbox-schema-content.ts:122) through [src/do/mailbox-schema-content.ts:135](../../src/do/mailbox-schema-content.ts:135). The API schema likewise has no idempotency key at [src/api/schemas.ts:33](../../src/api/schemas.ts:33) through [src/api/schemas.ts:41](../../src/api/schemas.ts:41).

   MCP clients retry. Network retries, client reconnects, and model self-correction loops will create duplicate drafts. Add `clientRequestId` or `idempotencyKey`, store it in DO SQLite with a unique constraint scoped to mailbox/tool/user, and return the existing draft for repeats.

2. The proposed `draft_reply` signature cannot create the repo's current draft model.

   The plan lists `mailboxId`, `threadId`, `bodyText`, and optional `subject`, but `createDraftSchema` requires `to: email[]` and `subject` at [src/api/schemas.ts:33](../../src/api/schemas.ts:33) through [src/api/schemas.ts:41](../../src/api/schemas.ts:41). The UI has to build a recipient list and explicitly blocks empty recipients at [src/components/mail/ComposeModal.tsx:86](../../src/components/mail/ComposeModal.tsx:86) through [src/components/mail/ComposeModal.tsx:117](../../src/components/mail/ComposeModal.tsx:117). If the MCP tool derives recipients from a thread, the plan needs a real reply-recipient algorithm: reply versus reply-all, exclude self aliases, preserve or drop cc, handle malformed From, handle multiple inbound messages, and verify the thread exists.

3. Thread pagination and search parameters in the plan are fictional.

   `threadListQuerySchema` parses `cursor` and `q` at [src/api/schemas.ts:55](../../src/api/schemas.ts:55) through [src/api/schemas.ts:59](../../src/api/schemas.ts:59), but the route only forwards `limit` and optional `state` to the DO at [src/api/mailbox-routes.ts:61](../../src/api/mailbox-routes.ts:61) through [src/api/mailbox-routes.ts:66](../../src/api/mailbox-routes.ts:66). The DO list implementation only accepts `limit` and `state`, with no cursor and no query at [src/do/mailbox-do.ts:127](../../src/do/mailbox-do.ts:127) through [src/do/mailbox-do.ts:160](../../src/do/mailbox-do.ts:160). Do not advertise cursor or `q` in MCP until it exists, or clients will silently get incomplete/wrong results.

4. `read_message` must not return the raw DO/API payload.

   `getMessage` returns `SELECT * FROM messages` plus `SELECT * FROM attachments` at [src/do/mailbox-do.ts:172](../../src/do/mailbox-do.ts:172) through [src/do/mailbox-do.ts:178](../../src/do/mailbox-do.ts:178), and the API proxies that directly at [src/api/mailbox-routes.ts:77](../../src/api/mailbox-routes.ts:77) through [src/api/mailbox-routes.ts:82](../../src/api/mailbox-routes.ts:82). That payload includes internal storage fields such as `raw_r2_key`, `raw_sha256`, `body_html_r2_key`, attachment `r2_key`, and address JSON. MCP output should be a shaped DTO that strips internal R2 keys, raw object locations, BCC unless explicitly justified, and any fields not needed by the agent.

5. The plan has no exfiltration controls.

   A five-tool MCP surface can still drain an inbox by calling `list_mailboxes`, `list_threads`, `search_messages`, and `read_message` in loops. There is no rate limit, no per-tool quota, no maximum body size for MCP responses, no audit record, and no anomaly logging. D1 has an `ops_events` table at [migrations/d1/0002_message_index.sql:52](../../migrations/d1/0002_message_index.sql:52) through [migrations/d1/0002_message_index.sql:59](../../migrations/d1/0002_message_index.sql:59), but the plan does not write MCP events to it.

   Required fix: add structured audit events for every MCP tool call with identity, mailbox ID, tool name, result count, latency, and denial reason. Add conservative per-identity/tool limits before exposing body reads.

6. Prompt injection is untreated.

   `read_message` returns email body text to an agent. Email body content is attacker-controlled. The plan does not say tool descriptions or returned content will mark message bodies as untrusted, does not separate metadata from body text, and does not include any guidance to prevent "ignore previous instructions" content in emails from influencing subsequent tool calls. This is a remote agent interface over adversarial input; treating message text as normal tool output is not acceptable.

7. Direct DO proxying skips API validation and response hardening unless each tool reimplements it.

   The API route validates `searchQuerySchema` before forwarding to the DO at [src/api/mailbox-routes.ts:144](../../src/api/mailbox-routes.ts:144) through [src/api/mailbox-routes.ts:157](../../src/api/mailbox-routes.ts:157), but the DO itself accepts `Number(url.searchParams.get("limit") ?? "25")` without clamping at [src/do/mailbox-do.ts:550](../../src/do/mailbox-do.ts:550) through [src/do/mailbox-do.ts:559](../../src/do/mailbox-do.ts:559). The API validates drafts before forwarding at [src/api/mailbox-routes.ts:176](../../src/api/mailbox-routes.ts:176) through [src/api/mailbox-routes.ts:186](../../src/api/mailbox-routes.ts:186), while the DO blindly inserts JSON-derived fields at [src/do/mailbox-do.ts:217](../../src/do/mailbox-do.ts:217) through [src/do/mailbox-do.ts:236](../../src/do/mailbox-do.ts:236). If MCP bypasses the API, every tool needs its own zod validation and output shaping, not just a generic DO fetch.

8. MCP error handling is underspecified.

   `assertMailboxAccess` throws a `Response` at [src/api/auth.ts:236](../../src/api/auth.ts:236) through [src/api/auth.ts:242](../../src/api/auth.ts:242). Hono knows how to return that in middleware. MCP tool handlers generally need MCP protocol errors, not thrown Web `Response` objects. The plan needs a strict mapping for unauthenticated, forbidden, not found, validation failure, Access cert timeout, and DO failure, with tests showing no stack traces, no raw exception strings, and no accidental 200-with-error JSON.

9. The Access URL assumption conflicts with this repo's current deployment notes.

   The plan says clients connect to `https://reccado-dev.<subdomain>.workers.dev/mcp` and Access forces login. But `wrangler.jsonc` says dev keeps `workers.dev` available for smoke tests and that Cloudflare Access still needs a custom domain at [wrangler.jsonc:78](../../wrangler.jsonc:78) through [wrangler.jsonc:82](../../wrangler.jsonc:82). Cloudflare's current MCP Access docs do show `workers.dev` examples, so this may be fixable, but the plan must not assume edge enforcement. The gate should prove unauthenticated access to the exact MCP URL gets Cloudflare Access behavior and that authenticated requests receive a valid `Cf-Access-Jwt-Assertion`.

10. The dependency and build plan is incomplete.

    `package.json` currently has no `agents` or `@modelcontextprotocol/sdk` dependency at [package.json:73](../../package.json:73) through [package.json:92](../../package.json:92). `wrangler.jsonc` already has `nodejs_compat`, `main = "src/server.ts"`, and the existing bindings at [wrangler.jsonc:8](../../wrangler.jsonc:8) through [wrangler.jsonc:10](../../wrangler.jsonc:10) and [wrangler.jsonc:29](../../wrangler.jsonc:29) through [wrangler.jsonc:76](../../wrangler.jsonc:76), so "no wrangler changes" may be true for stateless MCP, but the plan still needs `pnpm add`, lockfile changes, typegen validation, and a compatibility check with the TanStack/Cloudflare Vite plugin pipeline in [vite.config.ts:10](../../vite.config.ts:10) through [vite.config.ts:15](../../vite.config.ts:15).

## MINOR

1. `/mcp` path matching should handle method expectations and CORS deliberately.

   `if (url.pathname === "/mcp")` before the TanStack fallback is the right rough location, since `/api/*` is handled first at [src/server.ts:126](../../src/server.ts:126) through [src/server.ts:130](../../src/server.ts:130). But MCP Streamable HTTP may involve `POST`, `GET`, and preflight behavior depending on client/proxy. The plan should say whether `OPTIONS` is handled by `createMcpHandler` or by a wrapper, and should test MCP Inspector plus the intended production client.

2. `list_mailboxes` should hide disabled mailboxes unless explicitly requested.

   `listMailboxes` currently returns every mailbox regardless of status at [src/db/d1.ts:83](../../src/db/d1.ts:83) through [src/db/d1.ts:87](../../src/db/d1.ts:87). MCP should default to active mailboxes only.

3. Search semantics should be documented.

   `searchMessages` wraps the query in quotes after escaping `"` at [src/do/mailbox-ingest.ts:481](../../src/do/mailbox-ingest.ts:481) through [src/do/mailbox-ingest.ts:493](../../src/do/mailbox-ingest.ts:493), which behaves more like phrase search than general mailbox search. If the MCP tool is named `search_messages`, document that or improve search syntax.

4. The test plan is too shallow.

   Add tests for cross-client MCP isolation, no global server reuse, no send endpoint reachability, duplicate `draft_reply`, prompt-injection fixture content, huge message body truncation, missing/expired/wrong-issuer JWT, wrong mailbox ID, disabled mailbox, Access misconfiguration, and direct unauthenticated deployed URL behavior.

## VERDICT

REVISE before implementation.

The overall idea - Cloudflare Access protected MCP endpoint with stateless read/draft tools - is viable, but this plan is not safe enough to implement as written. The blocking issues are authorization granularity, lack of an MCP-specific no-send capability boundary, likely incorrect `createMcpHandler` lifecycle, incomplete JWT validation reuse, and bypassing the existing `/api/*` security middleware. Do not proceed until the plan defines a hardened auth facade, per-request MCP server construction, exact tool operation allowlists, idempotent draft creation, audit/rate limits, and deployed Access proof for the exact endpoint.
