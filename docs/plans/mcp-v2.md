# MCP v2 — a full-capability, spec-native MCP server

Status: **in progress** (integration branch `feat/mcp-v2`) · Owner: Santi · Created: 2026-11-11 · Last updated: 2026-11-14

Test env note: the Vitest pool reads the gitignored `.dev.vars`. Canonical test values:
`PHASE0_DEBUG_TOKEN`, `MAILBOX_JURISDICTION=none`, a fake `TRANSACTIONAL_API_KEY_PEPPER`, and
`BETTER_AUTH_SECRET` **unset** (with it set, ~90 route tests fail on the base too).
Baseline on fc22f6a: 66 files / 1132 tests green. After P0a+P0b+P2+P3-base+P4a merge (02b05cc): 77 files / 1162 tests green.

DEPLOYED 2026-11-12 to reccado-dev (version bf593a2d): remote migrations 0021, 0022, 0024–0028 applied after a rehearsal on an export of the live D1 (all OK, row counts unchanged, integrity + FK check clean; telegram_actions was empty, so no pending sends lost). First deploy attempt failed validation (tsyringe needs Reflect metadata, not caught by vitest) → fixed with `src/lib/reflect-polyfill.ts` (608c6b6). Live smoke: /api/health all ok, /mcp 401 + resource metadata with 5 scopes, AS metadata 200, frame headers present. Remaining: live e2e with the owner (§5). P0a–P5 + P6 + T16 fixes merged; 95 files / 1291 tests green.

This is the living plan for turning `/mcp` from a 5-tool read/draft endpoint that no client can
currently connect to into the primary agent surface for Reccado: reading, drafting, **sending**,
and **administration** (mailboxes, domains, aliases, routing, templates, API keys, health/ops).

Update this file as work lands: tick the checklists, fill in the verification log, and record
any decision change in [Decision log](#decision-log) rather than silently editing a decision.

---

## 1. Why

State on 2026-11-11 (verified live against `https://inbox.imsanti.dev`):

- `/mcp` answers `401` with a correct `WWW-Authenticate: Bearer resource_metadata=…`, and both
  discovery documents (`/.well-known/oauth-protected-resource/mcp`,
  `/.well-known/oauth-authorization-server/api/auth`) are served correctly.
- **No client can connect.** Dynamic client registration requires a logged-in web session
  (`POST /api/auth/oauth2/register` → `401 Authentication required for client registration`)
  and D1 holds zero OAuth clients.
- Only 5 tools exist (`list_mailboxes`, `list_threads`, `search_messages`, `read_message`,
  `draft_reply`), no admin, no send.
- Dependencies are far behind: `agents` 0.17.3 (latest 0.33.0), `@modelcontextprotocol/sdk`
  1.29.0 (latest 1.32.2; v2 is `@modelcontextprotocol/server` 2.4.0), `better-auth` /
  `@better-auth/mcp` 1.7.2 (latest 1.7.20 — includes the fix that stops `requireMcpAuth`
  accepting session JWTs that share issuer/audience, which applies to us because we run
  `jwt()` + `mcp()` together).

What changed in the protocol (MCP spec **2026-07-28**, verified in the spec changelog):

- Protocol sessions and `Mcp-Session-Id` are removed; list results no longer vary per
  connection (SEP-2567/2575).
- **Multi Round-Trip Requests (MRTR)** replace server-pushed `elicitation/create`: a tool
  returns `resultType:"input_required"` with `inputRequests` and an opaque `requestState`; the
  client retries with `inputResponses` (SEP-2322). `requestState` is attacker-controlled and
  must be integrity-protected.
- **Dynamic Client Registration is deprecated** in favour of **Client ID Metadata Documents
  (CIMD)**. Client preference order: pre-registered → CIMD → DCR.
- Elicitation: form mode must not carry secrets or transaction authorizations; **URL mode**
  must verify the identity of whoever opens the URL and must not be pre-authenticated.

Consequence: the earlier idea of moving to a stateful `McpAgent` Durable Object is **rejected**
— `McpAgent` is the frozen SDK-v1 path; the current path is SDK v2 +
`createMcpHandler` from `agents/mcp/server`, stateless, with MRTR.

This design was produced by a three-round debate between two Opus agents (2026-11-11); the
rounds' conclusions are folded in below.

---

## 2. Target architecture

### 2.1 Transport and protocol
- `@modelcontextprotocol/server` v2 `McpServer` factory, served by `createMcpHandler` from
  `agents/mcp/server`. Stateless: a fresh server per request, no DO, no session storage.
- Human input uses MRTR `inputRequired` with **URL-mode** elicitation only (never form mode).
  `requestState` is signed with `createRequestStateCodec` (HMAC-SHA256; signed, not encrypted —
  never put anything secret in it). Single-use and authorization are enforced server-side, never
  inferred from `requestState`.
- Legacy (2025-era) clients: `legacy: "stateless"`. Branch on the **negotiated protocol
  version**, not on advertised elicitation capability (a 2025 client can advertise elicitation
  and still not receive it on a stateless transport). Legacy clients get
  `{status:"pending", intentId, confirmUrl}` and re-call the same tool with `intentId` to read
  the status — one code path for old and new clients.
- Deterministic `tools/list` order.

### 2.2 Auth and connectivity
- Stay on **Better Auth** (it already owns web login: OTP + TOTP 2FA). Do not move to
  `@cloudflare/workers-oauth-provider`.
- Connectivity, in order of arrival:
  1. **Now:** `pnpm operator mcp register` — pre-registers an OAuth client with the operator
     session and prints the exact `claude mcp add --transport http reccado https://<host>/mcp
     --client-id … --callback-port …` command.
  2. **Then:** `@better-auth/cimd` (`metadataProfile: "mcp-2026-07-28"`). Workers fetch
     transport: `redirect: "manual"`, `global_fetch_strictly_public` compatibility flag, the
     plugin's size/timeout limits. **No hard allowlist**; a warn-only list of known client hosts;
     every first-seen `client_id` logged to `ops_events`.
  3. **DCR closed** once CIMD is verified. `operator mcp register` stays as documented plan B.
- Consent page (`/consent`) shows the CIMD `client_id` **host**, `client_name` and the
  redirect-URI host prominently, plus the requested scopes.
- Short-lived access tokens, rotating refresh tokens; DPoP binding if the clients support it.
- Owner gate (`requireMcpOwner`) unchanged.

### 2.3 Scopes
| Scope | Grants | Default consent |
|---|---|---|
| `mail:read` | list/search/read (sensitive content redacted) | ✅ |
| `mail:draft` | create/update/cancel drafts, tier-1 mailbox actions | ✅ |
| `mail:send` | request a send (still needs approval) | ❌ step-up |
| `mail:read:sensitive` | un-redacted OTP/reset content | ❌ never by default |
| `admin` | read control plane; request tier-2 changes (still need approval) | ❌ step-up |

Scopes are checked **inside each handler**. Missing scope → `403 insufficient_scope` with
`WWW-Authenticate: Bearer … scope="…"`, which makes the client re-prompt consent. The tool list
is the same for every token (`cacheScope: "private"`).

### 2.4 The two tiers
The line is **mailbox content vs control plane**, not "reversible vs irreversible" (disabling an
alias is reversible, but mail bounced meanwhile is lost forever).

- **Tier 1 — no confirmation:** changes confined to mailbox content: mark read/unread, labels,
  archive, trash (recoverable), drafts (create/update/cancel).
- **Tier 2 — approval page + passkey:** **every** control-plane write and every outbound send:
  send/reply; create/update/disable mailboxes, domains, aliases, routing rules; template
  create/edit/archive (templates mail customers with no per-send confirmation); display
  name / From changes; API key create/rotate/revoke/scope change; suppression removal; `restore`
  and any purge. **Batch intents** (one approval covers N items) keep onboarding usable.
- **Never over MCP:** owner-registry changes (`owner_identities`, bootstrap emails, pairing).
  CLI and web only.

"Deletes" are soft: reuse existing `status='disabled'` (domains, mailboxes, aliases) /
`revoked` (keys) plus a "before" snapshot in `ops_events` as the undo log. One `restore` tool
(itself tier 2). No new soft-delete columns.

### 2.5 Approvals (one table, two authorities, one surface)

> **Superseded in part 2026-11-14:** passkey approval/step-up was removed; see "2026-11-14 decision" before the decision log.
- **Send authority stays in the mailbox DO**: the intent is the existing `request-send` state.
  The DO stores a **frozen snapshot** of the message (recipients, headers, body, attachments by
  content hash) and its `payload_hash`. Sending uses the snapshot, never the live draft, and
  checks `hash(snapshot) == payload_hash`. Editing the draft invalidates the intent.
- **One token table:** rename `telegram_actions` → `approvals`, add `kind`, `payload_hash`,
  `consumed_at` (+ `origin`: `mcp` | `telegram` | `web`). Control-plane intents live here too; no
  separate `admin_intents` table. Shared shape: `{kind, id, payloadHash, expiresAt, status}`.
- **One approval surface:** `https://<host>/approve/:id`
  - Better Auth owner session required; URL is never pre-authenticated.
  - Shows **only server-rendered content** — no agent-authored text. The elicitation message is
    just "Review on <host>". Highlights external / never-seen recipients, Reply-To mismatch,
    forwarding destinations, flagged sensitive tokens in outgoing mail.
  - POST, `SameSite=Strict`, existing Origin check, no autofocused button, single use,
    ~10 min expiry.
  - **Passkey (WebAuthn, user verification) per approval**, challenge =
    `H(intentId ‖ payload_hash)`. No "recently verified" window. No passkey registered → the
    page refuses and links to passkey registration (which itself needs OTP + TOTP). **No weaker
    fallback.**
- **Origin matters:**
  - Agent-originated intents (`origin = mcp`) → always the approval page + passkey.
  - Human-authored sends (reply typed by the owner in Telegram, composed in the web UI) keep
    today's flow (Telegram ✅ Enviar / web confirm). The passkey protects against the agent, not
    against the owner.
  - For `mcp` intents Telegram only **notifies** and links to the approval page; it never
    approves them directly (otherwise Telegram would bypass the passkey).

### 2.6 Read-side protection
- At ingest, flag OTP / password-reset / magic-link mail (sender + pattern rules).
- `read_message` / `read_thread` redact codes and links in flagged mail unless the token holds
  `mail:read:sensitive`.
- Email bodies stay labelled as untrusted content in tool descriptions and results.

### 2.7 Code layout
- **Service layer `src/lib/admin/*`**: the logic now inline in `src/api/hono.ts` and
  `src/api/mailbox-routes.ts` moves into services consumed by REST, CLI and MCP alike (one
  validation, one ownership check).
- `src/mcp/*`: tool definitions only — thin adapters over services, with annotations,
  `outputSchema` + `structuredContent`, `resource_link` for attachments and raw MIME.
- Replace the in-memory per-isolate rate limiter with a durable one (DO or D1 counter) when
  touched.

### 2.8 Audit
`outbound_sends` and `ops_events` record: OAuth `client_id` (CIMD URL), token `sub`/`jti`,
`intentId`, origin and approval channel (`web` | `telegram` | `mcp_approval`), payload hash.

---

## 3. Tool catalogue (~20)

Annotations: **R** = `readOnlyHint`, **D** = `destructiveHint`, **I** = `idempotentHint`.
Tier 2 tools return `input_required` (URL) on 2026 clients, `pending` + `confirmUrl` on legacy.

| Tool | Scope | Tier | Notes |
|---|---|---|---|
| `list_mailboxes` | mail:read | R | |
| `list_threads` | mail:read | R | state/unread filters |
| `read_thread` | mail:read | R | redaction applies |
| `read_message` | mail:read | R | redaction; attachments as `resource_link` |
| `search_messages` | mail:read | R | single mailbox or all |
| `update_messages` | mail:draft | 1 · I | read/unread, labels, archive, trash (batch) |
| `save_draft` | mail:draft | 1 · I | create or update; reply mode keeps threading |
| `cancel_draft` | mail:draft | 1 | |
| `send` | mail:send | 2 | from a draft id; re-call with `intentId` for status; returns delivery state with feedback liveness ("no telemetry" ≠ delivered) |
| `get_health` | admin | R | `/api/health` incl. sending feedback liveness |
| `list_ops` | admin | R | ops events, DLQ, suppressions |
| `list_config` | admin | R | domains (+status), aliases, routing rules, templates, API keys (no secrets) |
| `manage_mailbox` | admin | 2 · D | create / update / disable |
| `manage_domain` | admin | 2 · D | add / provision / update / disable |
| `manage_routing` | admin | 2 · D | aliases + routing rules |
| `manage_template` | admin | 2 · D | upsert / sync / archive; preview render is R |
| `manage_api_key` | admin | 2 · D | create / rotate / revoke / scopes; secret shown only on the approval page, never returned to the agent |
| `remove_suppression` | admin | 2 · D | |
| `restore` | admin | 2 | undo a soft delete from the `ops_events` snapshot |
| `reconcile_stale` | admin | 2 | transactional `unknown` review |

(Exact grouping may shift during P3/P5; keep destructive operations in tools carrying `D`.)

---

## 4. Phases

Each phase ends with the AGENTS.md handoff block, evidence against `reccado-dev`
(`https://inbox.imsanti.dev`), and green `pnpm exec tsc --noEmit`, `pnpm test -- --run`,
`pnpm run build`. Deploy only via `pnpm run deploy:dev`.

### P0a — Usable today
- [x] Bump `better-auth` + `@better-auth/mcp` to 1.7.20; regression-test login (OTP, TOTP),
      session, `/mcp` 401 + discovery. (T1, merged e61fb89)
- [x] D1 migration `0021_better_auth_1_7_20.sql` (account table rebuild: `issuer` nullable).
      Live schema checked read-only: column order matches, no extra indexes.
      **Must be applied remotely BEFORE deploying 1.7.20**, or login breaks.
- [x] Confirm a session JWT is now rejected at `/mcp` (regression test).
- [x] `pnpm operator mcp register` + `pnpm operator mcp clients` (uses operator session; prints
      `claude mcp add …`; default redirect `http://localhost:33418/callback`).
      **Revoke omitted:** better-auth 1.7.20's schema has no `ON DELETE CASCADE` on
      `oauthConsent/oauthAccessToken/oauthRefreshToken.clientId`, so deleting an authorized
      client 500s, and there is no owner endpoint to enumerate refresh tokens. Issued access
      JWTs live 3600 s.
- [x] Revoke implemented (T11, merged 19a5e43): `POST /api/oauth-clients/:clientId/revoke` (owner,
      Origin-checked) deletes access tokens → refresh tokens → consent → client in one D1 batch;
      `pnpm operator mcp revoke <client_id>`; unknown/foreign → 404 `client_not_found`. Issued
      access JWTs stay valid ≤ 3600 s. Gap: CIMD URL client ids don't fit one path segment —
      accept the id in the body when CIMD is enabled.
- [ ] Deploy: **owner decided 2026-11-11 to deploy once, after everything is done** (not per phase).
      Order: remote D1 migrations 0021 → 0022 → (0024 passkey) → `pnpm run deploy:dev` → re-register
      MCP client (old tokens lack the new scopes and need re-consent) → re-draft any pre-0022
      Telegram pending sends.
- [ ] Connect Claude Code end-to-end; call the existing 5 tools.
- [ ] Check whether Codex supports pre-registered clients and which protocol it negotiates.

**Done when:** Claude Code lists and calls the 5 tools against the live deployment.

### P0b — SDK v2 port
- [x] `agents` → 0.33, add `@modelcontextprotocol/server` 2.4.0; SDK v1 no longer a direct dep. (T3, merged)
- [x] Port the 5 tools to a v2 factory on `agents/mcp/server` `createMcpHandler`;
      `legacy: "stateless"`; Host/Origin protection for the custom domain.
- [x] Add annotations, `outputSchema`, `structuredContent`, deterministic order.
- [x] Both protocol eras verified in the Workers test pool (2026-07-28 `server/discover`; 2025-06-18 `initialize`). Live client check pending deploy.

### P1 — CIMD
- [x] `@better-auth/cimd` 1.7.20 with a Workers-native guarded transport, **opt-in** via
      `MCP_CIMD_ENABLED` (default false); `global_fetch_strictly_public` NOT enabled (see decision
      log). (T7, merged 83350bd)
- [x] Host-rejection test hang investigated: stale test hostname, not a guard bug. Now deterministic
      with a fetch spy: 10 private/numeric/local variants rejected with zero fetches. CIMD stays
      disabled until verified live.
- [ ] Record which `client_id` URLs Claude Code and claude.ai present.
- [x] Consent page: client host, `client_name`, redirect host, scopes (Spanish copy);
      warn-only known hosts; first-seen client → `ops_events`.
- [x] Default consent = `mail:read mail:draft`; scopes defined; `src/lib/mcp-scopes.ts`
      (`scopesFromClaims`, `requireScope`, `insufficientScope`). Wiring into tools: T8.
- [x] Unauthenticated DCR refused (tested); session-backed registration kept as the
      pre-registration path (`operator mcp register`).

### P2 — Service layer
- [x] Extract mailbox/domain/alias/routing/template/key/suppression/ops logic into
      `src/lib/admin/*` (services take the trusted `AuthContext`; `AdminError` → same HTTP). (T2, merged)
- [x] REST routes switch to services with existing tests unchanged and green.

### P3 — Read, draft, tier 1, admin reads
- [x] Read tools incl. `read_thread`, cross-mailbox search (active owned mailboxes only). (T8, merged
      0745986; finished by Grok after Codex quota ran out.) Attachments and raw MIME are **MCP
      resources** (`reccado://mailboxes/{id}/messages/{id}/attachments/{id}`, `…/raw`) served by
      `resources/read` with the same OAuth token — ownership + scope re-checked per read, 5 MB cap
      (`too_large`), every read audited. Not session-authenticated HTTP links.
- [x] Scopes enforced in every tool (`scopesFromClaims`; empty set grants nothing; missing →
      `insufficient_scope: <scope>`).
- [x] Sensitive-mail flag at ingest + redaction helper (T4, merged 43c630c): `src/lib/sensitive-mail.ts`,
      DO schema v8 `messages.sensitive_kind` + `sensitive_classified` (0 = legacy/unclassified,
      1 = classified), legacy fallback `sensitiveKindForRead` (pass fetched HTML for HTML-only rows).
- [x] Redaction + `mail:read:sensitive` in read tools; raw MIME / attachments of sensitive mail need
      the scope.
- [x] `update_messages`, `save_draft`, `cancel_draft`. Drafts saved via MCP always `origin='mcp'`
      (web confirm → `approval_required`, tested). Atomic DO preconditions (`allowedStatuses`):
      update only `draft`; cancel `draft|pending_confirmation`; else 409 `draft_not_editable`.
- [x] `get_health`, `list_ops`, `list_config` (control plane is **read-only** until P4).
- [x] Follow-up done (T10): `update_messages` via MCP now refreshes Telegram cards like the HTTP actions
      route does; labels are not a message action today (dropped from the tool).

### P4 — Approvals, passkey, send

> **Superseded in part 2026-11-14:** passkey approval/step-up was removed; see "2026-11-14 decision" before the decision log.
- [x] Migration `0022_approvals.sql`: `telegram_actions` → `approvals` (+ `kind`,
      `payload_hash`, `consumed_at`, `origin`); Telegram flows unchanged. (T5, merged)
      Deploy note: Telegram Send buttons / pending sends created before 0022 have no hash and
      **fail closed** — the owner must re-draft those replies.
- [x] Frozen snapshot + `payload_hash` in the mailbox DO `request-send` (identity resolved
      server-side from D1 and frozen); confirm sends the snapshot; edit after request →
      `intent_stale`; at-most-once under concurrent/repeated confirms (tested).
      Telegram corrections mint a new token bound to the new hash and supersede the old button.
      `confirmDraftSend(expectedPayloadHash)` is optional for web for now; **mandatory for every
      approvals-table path (incl. MCP)**.
- [x] Foundation (T6a, merged 9946194): sticky draft `origin` in the DO (`mcp` is permanent;
      `mcp` drafts → `approval_required` on web/Telegram confirm, fail closed), passkey plugin +
      `0024_passkey.sql`, `0025_outbound_audit.sql` (approval_channel, intent_id, payload_hash,
      oauth_client_id, token_sub, token_jti), mcp approvals retained 30 d after expiry/consumption,
      Telegram URL-button helper; Telegram callbacks cannot approve mcp intents.
- [x] `@better-auth/passkey` on Workers incl. **assertion verification** (only option generation
      proven so far); registration step-up: TOTP (or fresh email OTP) proof bound to session,
      single use, 5 min, both registration endpoints; passkey add/remove → ops_events + Telegram.
      (T6b, merged 31eeb7d; Grok.) Proven with a software authenticator + @simplewebauthn/server
      13.3.3. Step-up proof in better-auth `verification` table, header `x-passkey-stepup`, via
      `POST /api/auth/passkey/step-up`. Migration `0026_approval_metadata.sql`.
- [x] `/approve/:id` page per §2.5 + Passkeys section on `/security`; challenge
      `base64url(sha256(id + payloadHash))`; approve/deny `POST /api/approvals/:id/*` (Origin must
      equal request origin, cookie cache off). DO sends an `mcp` draft only with an HMAC approval
      proof (`mcp-approval.v1`, 60 s) signed with `BETTER_AUTH_SECRET`.
- [x] (T12, merged 2026-11-12) `send` tool with MRTR URL elicitation + legacy pending path; Telegram notify-with-link
      for `mcp` intents; shared `src/mcp/intent-flow.ts`. (T12 `mcp-send`, in flight)
- [x] Audit fields per §2.8 (approval_channel=mcp_approval, intent_id, payload_hash,
      oauth_client_id, token_sub, token_jti).
- [ ] Tests: single use under concurrent retries; draft edited after intent → refused;
      tampered `requestState` → refused; no passkey → refused; Telegram cannot approve an
      `mcp` intent.

### P5 — Tier-2 admin
- [x] `manage_*`, `remove_suppression`, `restore`, `reconcile_stale` through approvals, with
      batch intents (≤20). (T13c `src/mcp/admin-tools.ts`; T13b-kinds
      `src/lib/control-plane-kinds/*`, registry `src/lib/control-plane-registry.ts`.)
- [x] API key secret reveal on the approval page only: kinds' `redact()` splits the execute
      result; only the redacted part is stored in `result_json`; the secret is returned once in
      the owner's approve response; tool results also strip `secret|token|plaintext`.
- Known limits (T13b): `api_key_scopes` issues a replacement key and revokes the old one (no DO
  scope-patch route); archived templates are not restorable (`restore_unsupported`); domains and
  mailbox-less rules gated by owner role only (no per-row owner); `restore` consumption is
  atomic via an `ops_events` row `restored:<snapshotId>`; reconcile count is the approximate D1
  projection and never resends.
- [x] Soft delete via `disabled` + `ops_events` `admin.before_snapshot` (T13a, mailboxes).
- [x] Framework (T13a): `src/lib/control-plane-intents.ts` registry (`validate/render/execute`),
      canonical `payload_json` hashed into the passkey challenge, `result_json` per item, batch
      stops at first failure (`executed`/`<code>`/`not_run`), mailbox kinds
      `mailbox_create|update|disable`, `requestControlPlaneChange`. Migration 0027.
      Known gap: worker interruption mid-batch leaves intent approved without final report;
      no auto-retry → operator reconciliation.

### P6 — Docs and invariant
- [x] Update AGENTS.md invariant, SECURITY.md, README, OPERATIONS.md (see §6). (T14, also SKILL.md, ARCHITECTURE.md, CHANGELOG.md)
- [x] Mark `docs/plans/transactional-api.md` decision "API keys are never exposed as MCP
      capabilities" as superseded by this plan.

---

## 5. Verification log

Things the design depends on that are not yet proven live. Fill in with date + evidence.

| Item | Status | Evidence |
|---|---|---|
| better-auth 1.7.20 rejects session JWTs at `/mcp` | ⏳ | |
| Claude Code connects with a pre-registered client | ⏳ | |
| Codex: pre-registered clients / negotiated protocol | ⏳ | |
| `client_id` presented by Claude Code / claude.ai (CIMD) | ⏳ | |
| `@better-auth/cimd` works on Workers with safe fetch | ⏳ | |
| `@better-auth/passkey` works on Workers | ⏳ | |
| URL elicitation UX in Claude Code, claude.ai web, claude.ai mobile | ⏳ | |
| Legacy client path (`pending` + re-call) works on stateless handler | ⏳ | |
| DPoP support in clients | ⏳ | |

---

## 6. Security posture (to be written into SECURITY.md in P6)

Invariant, reworded: **an agent may read, draft and act on mailbox content, but every outbound
send and every control-plane change it initiates requires the owner's approval on a
server-rendered page, bound to the exact payload by a passkey with user verification.**

Accepted residual risk:
- The model can leak mail it legitimately read (non-sensitive) through other tools or servers.
- Native clients' localhost OAuth redirect can be intercepted by a local process.
- Compromise of the owner's device **and** authenticator defeats approval.
- Tier-1 actions (e.g. trash) are unconfirmed, though recoverable.

---

## 2026-11-14 decision: passkey → Telegram, delegated auto-apply

The owner removed passkey approval. This **supersedes** the passkey parts below (§2.4/§2.5
approval authority, P4's passkey/step-up work and the 2026-11-11 "Passkey per approval" and
"Passkey guards against the agent" rows); the original text is kept as history.

- Approval is now the ✅/❌ Telegram button (intent id + hash prefix, full hash re-checked; bound
  chat + operator allow-list) or `/approve/:id` with the owner web session (Origin check, payload
  hash posted back). The agent can never approve. API-key create/rotate/scopes are web-only.
- Delegated clients (token with `admin`, without `mail:read`/`mail:read:sensitive`) with a policy
  auto-apply template_upsert, template_archive, api_key_templates, api_key_revoke,
  suppression_remove and restore on allowed mailboxes, rate-limited, link-checked, with before
  snapshots and an undo notice. Sends are never auto. Rationale: the prompt-injection boundary is
  the mail-reading token.
- `manage_api_key` gains action `templates` (in-place allow-list edit). Migration `0029`; the
  `0024` passkey table stays unused. Threat model: Telegram takeover or web-session theft can
  approve (recommend Telegram 2FA). See `SECURITY.md` ("MCP").

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-11-11 | Stateless SDK v2 + MRTR; no `McpAgent` DO | Spec 2026-07-28 removed sessions; `McpAgent` is the frozen v1 path |
| 2026-11-11 | Stay on Better Auth; add CIMD; close DCR; register cmd as plan B | Better Auth already owns web login; CIMD is spec-preferred |
| 2026-11-11 | Owner chose "confirm in the MCP client"; implemented as URL-mode approval page | Form-mode accept is not proof of a human (hooks / auto-answer) |
| 2026-11-11 | ~~Passkey per approval, challenge bound to intent + payload hash, no fallback~~ **Superseded 2026-11-14** (Telegram button / web session) | Only step a browser-driving agent cannot complete |
| 2026-11-11 | Tiers = mailbox content vs control plane | Reversible ≠ harmless (bounced mail, template sends, impersonation) |
| 2026-11-11 | One `approvals` table (renamed `telegram_actions`); send authority stays in DO | Fewest concepts while respecting the DO-is-authoritative invariant |
| 2026-11-11 | Human-authored Telegram/web sends keep current flow | Approval guards against the agent, not the owner |
| 2026-11-11 | Owner registry never exposed over MCP | Privilege-escalation target with no agent use case |
| 2026-11-11 | CIMD on a Workers-native fetch transport (https only, no IP literals / local names / own zone, no redirects, size+timeout limits), **no** `global_fetch_strictly_public`, gated by `MCP_CIMD_ENABLED` (default false) until verified live | `@better-auth/cimd` demands exact-once DNS + address pinning, which Workers fetch cannot provide; Workers egress has no private network behind it and refuses raw-IP fetches. Deliberate, documented deviation; pre-registration remains the default path |
| 2026-11-11 | Supersedes transactional-api.md "keys never exposed via MCP" (from P5) | Owner requested key admin over MCP; secret never reaches the agent |
| 2026-11-14 | Passkey removed; Telegram button + web-session approval; delegated clients may auto-apply bounded low-risk kinds (never sends) | Owner decision; mail-reading tokens are the injection boundary |
