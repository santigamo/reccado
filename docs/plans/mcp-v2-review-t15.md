# T15 — pre-deploy security & correctness review (read-only)

Base: `feat/mcp-v2` (HEAD f7f5c2b) vs `main`. Baseline: `pnpm exec tsc --noEmit` clean; `pnpm test -- --run` 90 files / 1250 tests pass (BETTER_AUTH_SECRET unset); `pnpm run build` OK. No repo file edited (`.dev.vars` is gitignored; probe script lives in scratchpad).

## Verdict
No path found for an MCP agent to send mail or apply a control-plane change without a passkey assertion bound to `id‖payload_hash`. The core send path holds. Two things should be fixed before deploy (H1, H2); several approval-page fidelity and hardening gaps follow.

## CONFIRMED (traced through code)

### H1 — HIGH — Template approval shows only character counts, never the body
`src/lib/control-plane-kinds/templates.ts:35-40,53-58` (`bodyChange`, `renderUpsert`).
The approval page for `template_upsert` shows subject plus "cambia: sí (0 car. → 4200 car.)". The text/HTML body is hashed into the passkey challenge but the human never sees it. Plan §2.4 makes templates tier 2 precisely because a live API key then mails customers with no per-send confirmation. An agent can therefore get phishing or link content passkey-approved while the owner reviewed only a length.
Fix: render full `body_text`, the HTML source (escaped) and the list of URLs found; warn on any link/external domain; show a diff against the previous body.

### H2 — HIGH (conditional) — `mail:read:sensitive` plus an owner login address hosted on this instance defeats the passkey boundary
`src/api/better-auth.ts` `handlePasskeyStepUp` (email-OTP fallback when TOTP is off); `src/routes/consent.tsx` (one-click grant of `mail:read:sensitive`).
Chain: the maintainer's owner address (hello@imsanti.dev) is served by Reccado itself. An agent holding `mail:read:sensitive` can read the sign-in OTP, log in, read the step-up OTP ("Código para registrar una passkey…"), register its own software passkey, then approve its own intents. Blocked only if the owner has TOTP enabled. The plan says registration needs "OTP + TOTP"; the code allows email-only when TOTP is not enrolled.
Fix: (a) never expose auth mail (MAIL_FROM sender / OTP-step-up subjects) through MCP reads at all, regardless of scope; (b) require TOTP (no email fallback) for passkey registration; (c) make the consent page demand explicit extra confirmation for `mail:read:sensitive`/`admin`/`mail:send` (plan §2.3 "step-up").

### M1 — MEDIUM (deploy) — `/mcp` host allow-list hard-coded to the maintainer's domain
`src/mcp/handler.ts:42` `allowedHostnames = ["inbox.imsanti.dev","localhost",…]` (+ `*.workers.dev`).
`createMcpHandler` rejects any other Host (agents 0.33 `hostHeaderValidationResponse`). A public self-host on another domain gets every `/mcp` call refused. Check that the live dev deployment really is served from `inbox.imsanti.dev` (wrangler `workers_dev:false`).
Fix: derive from the deployment origin (runtime-config / `resolveMcpResource`) or a `MCP_ALLOWED_HOSTS` var.

### M2 — MEDIUM — Approval pages omit payload fields that execute applies
- `api_key_create` render (`control-plane-kinds/api-keys.ts:~84-108`): `senderName` and the value of `recipientPolicy` are not shown (only a warning when it is absent, so a present-but-permissive policy looks safe); `api_key_scopes` hides `templateAllowlist`.
- `domain_provision` (`domains.ts:~86-110`): `dmarc.rua` (an external address receives DMARC aggregate reports), `dmarc.alignment`, `mailbox.displayName` not shown.
Fix: render every field of the validated payload (generic fallback: print remaining keys).

### M3 — MEDIUM — Sensitive-mail classifier/redactor misses common shapes
`src/lib/sensitive-mail.ts`. Probe results (run locally):
- "Your verification code is 123 456." → not classified, returned verbatim
- "…is 123-456." → verbatim
- "Your login code: ABCDEFGH" (letters only) → verbatim
- 11-digit code → verbatim
- "Sign in: https://app.example.com/auth?t=abcdef123456…" → classified `magic_link` but link NOT redacted (`secretUrl` only knows token|code|key|sig|otp|reset params and 24+ char path segments)
Also, parse-failed or unclassified rows have no body, so `readResource` (`mailbox-facade.ts:~262`) classifies on subject/sender only and can serve raw MIME with plain `mail:read`.
Fix: group-aware code regex (digits with space/hyphen), letters-only codes near keywords, broader link param list; fail closed for `parse_status='failed'`/unclassified in `readResource`.

### M4 — MEDIUM — Control-plane intents carry no principal; audit incomplete vs plan §2.8
`src/lib/control-plane-intents.ts` (`requestControlPlaneChange` INSERT lists only token, kind, created_at, expires_at, payload_hash, origin, payload_json). `oauth_client_id`/`token_sub`/`token_jti` are never stored, so admin changes cannot be attributed to a client; `before_snapshot`/events record only the approver. Also `src/mcp/admin-tools.ts:~116-123`: the `intentId` parameter path (no MRTR state) checks only `origin='mcp'` and kind, not who created it, so any principal that learns an id (256-bit) can read its status/result.
Fix: persist client/sub/jti on the row, record them in the execute-time ops_events, and bind status reads to `token_sub`.

### M5 — MEDIUM (multi-owner only) — Admin reads and kinds are role-gated, not owner-scoped
`src/mcp/admin-reads.ts:config` (mailboxes/domains/aliases/rules global; only `mailboxDetails` is scoped), `src/lib/admin/ops.ts:listOpsPage` (`SELECT * FROM ops_events` unfiltered, `mailboxId` filter optional), domain and alias/rule kinds (`alias_add` on any registered domain; documented "owner role only"). With ≥2 owners, owner A's agent (`admin`) sees B's mailboxes, forward targets and events, and an approved alias/rule on B's domain can intercept B's mail. `approveIntent` also does not require approver == requester (send kind has no actor ownership check in `dispatchSend`). Single-owner today: not exploitable.
Fix: scope reads by `owner_email`; bind approver to the intent's creating owner; add per-domain owner.

### M6 — LOW/MEDIUM — Plan §2.5 hardening not implemented
`src/api/better-auth.ts:315` session cookie is `sameSite: "lax"` (plan: Strict). `X-Frame-Options: DENY` is set only in the Hono `/api/*` wrapper (`src/api/hono.ts:79`), so the SSR `/approve/:id` page has no `X-Frame-Options`/`frame-ancestors`. Lax already blocks cross-site framing with cookies; same-site siblings (any `*.imsanti.dev` XSS) could frame it and delegate `publickey-credentials-get`.
Fix: security headers on all HTML responses (`frame-ancestors 'none'`), consider Strict for the session cookie or a separate approval cookie.

### M7 — LOW — Plan deviations that do not break safety
`insufficientScope()` (403 + WWW-Authenticate) in `src/lib/mcp-scopes.ts:19` is unused: handlers return `isError` tool results, so clients will not re-prompt consent for missing scopes. `approveIntent` does not check `row.origin`.

### L1 — LOW — Approval fatigue
After deny/expiry, `send`/admin tools mint a fresh intent and Telegram notification each call; the rate limiters (`send-tool.ts`, `admin-tools.ts`, `tools.ts`) are per-isolate in-memory Maps (never pruned), so the real limit is far above 10/min.

### L2 — LOW — Draft tampering by agents
`facade.updateDraft`/`cancelDraft` accept any origin: an agent with `mail:draft` can rewrite the owner's own `draft`-status drafts (flipping them to sticky `mcp` origin) or cancel pending Telegram confirmations.

### L3 — LOW (perf) — `list_threads` is N+1
`mailbox-facade.ts:listThreads` fetches every thread's full message list per call (≤50) and may read R2 HTML for unclassified rows.

## PLAUSIBLE (not exercised end-to-end)

### P1 — MEDIUM — Step-up verification has no attempt limit and bypasses Better Auth's rate limiter
`handlePasskeyStepUp` returns before `auth.handler`, so Better Auth's rate-limit table does not apply; the email OTP is 6 digits for 5 minutes and TOTP goes through `auth.api.verifyTOTP` directly. A holder of a stolen session could brute force it unless the optional WAF rule exists. Fix: per-session attempt counter (invalidate the proof row after ~5 failures) and rate limit.

### P2 — LOW — Search is a presence oracle for sensitive content
`searchMessages` phrase-matches raw FTS content, so an agent without sensitive scope can test candidate codes (hit/no-hit) even though snippets are redacted. Low for 6-digit codes at 30/min/isolate; practical for short PINs.

### P3 — LOW — Pre-deploy state
- 0022 drops `telegram_actions`: old code errors between migration and deploy (Telegram Send/draft flow); run migrations immediately before deploy and expect pre-deploy Telegram buttons and drafts armed before the DO v9 upgrade to fail closed (documented).
- 0021 copies with positional `INSERT … SELECT *` from the live `account` table; if the remote table was ever altered out of band (e.g. during the 1.7.3 revert) it aborts. Use an explicit column list and dry-run it against `wrangler d1 export` of the live DB.
- 0023 is a gap (harmless to wrangler, but any later 0023 still applies out of order); 0025 ADD COLUMN … CHECK and 0028 unique index are safe with no existing `mcp` rows; 0021 is re-runnable.

### P4 — LOW — Pending-intent payload size
`approvals.payload_json` can hold 20×(100 KB text+200 KB html) template ops; D1 row limit (2 MB) → `internal_error` on large batches.

## Checked and found sound
- DO send: `origin='mcp'` is sticky, confirm requires an HMAC proof (`mcp-approval.v1`, 60 s, bound to intent/mailbox/draft/hash) and compares `expectedPayloadHash` against the stored intent and the live-rebuilt snapshot; wire fields come from the frozen snapshot; web/Telegram confirm of an mcp draft → `approval_required` (fail closed).
- `approveIntent`: WebAuthn UV, challenge `sha256(id‖payload_hash)`, stale re-check, single-winner `consumeApproval`, `confirmDraftSend` re-verifies the consumed row; at-most-once via `attemptKey=token`.
- Approve/deny routes: Origin required and equal, cookie cache off, owner session; Telegram callbacks reject non-`telegram` origin and any `kind != confirm_send`, and Telegram only notifies mcp intents.
- Control-plane: `payload_json` canonical form + hash verified at status, approve and dispatch; render and execute re-run ownership as the approver; restore consumption atomic (`restored:<id>` PK insert).
- Secrets: `redactSecret` keeps plaintext out of `result_json`; `stripSecrets` on tool output; `listKeys` projection has no hash/secret; API key reveal only in the approve HTTP response.
- MRTR: codec key = HMAC(BETTER_AUTH_SECRET,"mcp-request-state.v1"), bound to `userId\0clientId`, 600 s TTL; send tool re-checks mailbox ownership, draft and mailbox match the intent.
- CIMD gated by `MCP_CIMD_ENABLED=false`; localhost-only secret fallback.

## Suggested pre-deploy order
1. Fix/decide H1, H2 (and M1 if the host is not inbox.imsanti.dev or *.workers.dev).
2. M2 + M3 + P1 are small, high-value hardening.
3. Dry-run migrations 0021–0028 on an exported copy of the live D1; apply migrations right before `pnpm run deploy:dev`.
