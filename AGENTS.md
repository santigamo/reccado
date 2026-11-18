# Agent Operating Guide

This is the operating guide for AI coding agents working **in** this repository. For
self-hosting Reccado into a Cloudflare account (deployment, not code changes), see
[`SKILL.md`](SKILL.md). For human contributor setup and PR expectations, see
[`CONTRIBUTING.md`](CONTRIBUTING.md). Start with [`README.md`](README.md) for the product
overview.

This repository was implemented from `docs/IMPLEMENTATION.md` under senior-gated phases — do not
spend context rediscovering facts already validated in `docs/validation/PHASE0_VALIDATION.md` and
`docs/validation/PHASE1_VALIDATION.md`. Those two files are a **historical build-validation log**, not
current operating docs; treat their concrete IDs/URLs as examples from a past run, not live
state.

## Durable Invariants

These hold regardless of which task or phase you're on. Do not weaken them without an explicit,
informed decision from the user/supervisor.

### Data ownership and architecture

- The **mailbox Durable Object is the only component allowed to decide canonical mailbox state**.
  D1 is a rebuildable cross-mailbox/control-plane index, never the source of truth — see
  `docs/ARCHITECTURE.md` ("Why Not D1 as Trunk").
- Queue payloads are **metadata only**. Never put raw MIME, parsed HTML/text bodies, or attachment
  content into a Queue message.
- Raw MIME and attachments live in **R2**, never as Durable Object SQLite blobs.
- MIME parsing happens in the Durable Object (or its ingest path), never in the `email()` handler
  itself — the handler's only job is validate → write raw bytes to R2 → enqueue metadata.
- Ingest must be idempotent across Email Routing retries, Queue retries, and DLQ replay. A
  duplicate delivery (same Message-ID or same raw SHA-256) must never create a second message row.
  A reused Message-ID with a *different* raw body is a conflict to flag, not a silent overwrite.
- Parser failures must never drop the email: keep a message row with `parse_status='failed'` and
  the raw R2 key preserved, and surface an ops event.

### Outbound sending

- **An agent may read, draft and act on mailbox content, but every outbound send it initiates over
  MCP requires the owner's approval, bound to the exact payload (`payload_hash`), given only with
  the owner web session on this origin, through `POST /api/approvals/:id/approve` (same-Origin
  required, session re-read with the cookie cache off): from `/approve/:id` or from the inbox
  approvals pane (`/inbox`, the reading pane). Kinds that reveal a secret are approved only on
  `/approve/:id`. The URL returned to the agent is always `/approve/:id` and is never
  pre-authenticated. Never from Telegram (it sends a notice with that link for critical requests —
  no ✅/❌ buttons), never by an agent: the agent can never approve.** The same approval gates a short list of irreversible /
  exfiltrating control-plane kinds, for any token: `api_key_create`, `api_key_rotate`,
  `api_key_scopes` (they issue a secret), `suppression_remove`, `domain_add`, `domain_provision`,
  `domain_disable`, `address_route` (creates a Cloudflare Email Routing rule), and an alias or forward/routing rule whose destination is outside the owner's
  domains. **Every other control-plane write applies directly with its scope** (templates,
  `api_key_templates`, `api_key_revoke`, mailbox kinds, internal aliases/rules, `domain_update`,
  `restore`, `reconcile_stale`, `update_messages`): it keeps an `admin.before_snapshot` + ops event
  and returns the result to the agent, and `restore` can undo it. There is no omnibus `admin`
  scope and no delegation policy; direct vs approval is decided per kind
  (`src/lib/control-plane-kinds/*`), never per client. Secrets are never returned to the agent
  (shown once on the approval page). The `request-send` → `confirm-send` flow with an idempotency
  key remains the only sending path; there is no shortcut. **The agent can never send; an
  agent-initiated send needs the hash-bound approval; the owner may send an agent-written draft
  directly with the owner web session, bound to the content they were shown; never from
  Telegram.** A draft created over MCP has `origin='mcp'` while it is the agent's, and the mailbox
  DO sends it only with either (a) the HMAC approval proof (`mcp-approval.v1`) minted by that
  approval, or (b) the HMAC owner-send proof (`owner-web-send.v1`) minted only by the web
  `POST /api/mailboxes/:id/drafts/:draftId/confirm-send` route — owner session re-read with the
  cookie cache off, Origin present and equal — and bound to `draftFingerprint`, the draft's
  `content_fingerprint` as the browser loaded it; the DO compares it with the frozen send snapshot
  atomically and answers `draft_changed` (nothing sent) on mismatch. Without either proof (Telegram
  confirm, a web confirm without fingerprint) it refuses (`approval_required`). No MCP path can
  mint either proof. The owner saving an agent draft from the web (the web draft PATCH) takes it
  over: `origin` becomes `web`, the agent's `save_draft`/`cancel_draft`/`send` on it answer
  `draft_not_agent_owned` (checked in the DO, atomically with the write), and any pending approval
  for it is superseded (consumed without a decision, reads `stale`). A direct owner send supersedes
  the pending approval the same way. Repeated `confirm-send` calls with the same idempotency key
  must send at most once, and a draft is sent at most once whichever path reaches it first. This is a security boundary, not a UX preference — see `docs/ARCHITECTURE.md`
  ("Authentication and Security Model"), `SECURITY.md` ("MCP") and `SKILL.md` ("Hard invariant").
  The owner registry is never reachable over MCP.

### Legal / provenance

- Do not copy source, schema, text, or file structure from `mailflare`, `agentic-inbox`, or any
  other external inbox implementation into this product. External repos may be read only for
  behavior/pattern understanding and attribution notes — reimplement from first principles.
- If evaluating an external reference implementation (clone it to verify behavior, deploy it to
  compare), clone only to a disposable path (e.g. `/tmp`), never import its code, deploy only
  under a disposable Worker name, and treat real edge-auth enforcement (an
  unauthenticated request must `302` to the provider's login page) as the only
  acceptable evidence that auth actually works — an app-level "not configured" message is
  not sufficient.

### Cloudflare resource safety

- Do not modify production Cloudflare resources. Use only dev/disposable resources for
  exploration and validation.
- Document every Cloudflare resource you create (name, ID, URL) in your validation evidence.
- Delete disposable Cloudflare resources before finishing a task, unless the validation evidence
  needs to persist and the supervisor explicitly approves keeping it.

### Tooling

- The Workers Vitest harness is configured in `vitest.config.ts` (via
  `@cloudflare/vitest-pool-workers`, reading `wrangler.jsonc` `env.dev`). Do not remove it or fall
  back to loading `vite.config.ts` for tests.
- Use `rg` for search. Avoid broad full-repo reads unless the task genuinely requires it.
- Use normal editor tooling (`apply_patch` or equivalent) for source edits; do not generate
  repository files via ad hoc shell heredocs, except for temporary evidence files kept outside
  the repo.
- Do not commit unless the user/supervisor explicitly asks, or the current instruction says to
  create a checkpoint commit.

### Evidence and reporting discipline

- Never write "works" or "seems fine" without evidence. If something cannot be validated, stop
  and report `FAIL` with the exact blocker — don't guess.
- Every validation/gate result should include: explicit `PASS`/`FAIL`, the commands run and
  meaningful output snippets, files changed, Cloudflare resource names/IDs touched, URLs tested,
  example payloads (for email/queue/API/WebSocket/scheduled-handler work), logs or screenshots
  when relevant, the duplicate/idempotency result when relevant, and known failures with whether
  they're blocking.
- End an agent run that did implementation work with a handoff in this shape:

  ```text
  RESULT: PASS|FAIL
  SCOPE: <phase/milestone or task>
  FILES CHANGED:
  - path
  COMMANDS:
  - command -> key output
  RESOURCES:
  - name/id/url
  EVIDENCE:
  - concise bullets
  BLOCKERS:
  - none, or exact blocker
  NEXT:
  - recommended next step, not implementation beyond scope
  ```

## Build/Process Notes

This section is current-state choreography — how to start a session and what's true *right now*.
Unlike the invariants above, these are expected to go stale; if you notice a mismatch with the
actual repo state, fix this section rather than trusting it blindly.

### Current baseline

- Phase 1 (Tier A inbox) is senior-validated; see `docs/validation/PHASE1_VALIDATION.md` for the historical
  record. The transactional API (Phases 2–4 of `docs/plans/transactional-api.md` — HMAC/pepper API
  keys, auth + owner-gated key/template admin, `POST/GET /v1/.../transactional/...` with Bearer
  auth, mandatory `Idempotency-Key`, scopes, quotas, limits, test-key rejection for sending,
  `unknown` → no auto-retry, redacted logs, non-authoritative D1 projections) is implemented in
  `src/lib/transactional-*`, `src/do/transactional-*`, D1 migrations `0006`/`0007`, and covered by
  `tests/unit/transactional-*.test.ts` + `tests/integration/transactional-*.test.ts`. The
  MCP endpoint (`/mcp`, Better Auth OAuth + owner registry; plan `docs/plans/mcp-v2.md`, final
  permission model in its "2026-11-14 final permission model" section) is no longer read/draft-only:
  `src/mcp/*` registers `list_mailboxes`, `list_threads`, `read_thread`, `read_message`,
  `search_messages`, `save_draft`, `cancel_draft`, `update_messages`, `send`, `get_health`,
  `list_ops`, `list_config`, `manage_mailbox`, `manage_domain`, `manage_routing`,
  `manage_template`, `manage_api_key`, `remove_suppression`, `restore` and `reconcile_stale`
  (one operation per call, no batches). Scopes are `resource:action` with no `admin`:
  `mail:read`, `mail:read:sensitive`, `mail:draft`, `mail:send`, `config:read`, `mailboxes:write`,
  `templates:write`, `routing:write`, `domains:write`, `keys:write`, `suppressions:write`
  (`src/lib/mcp-scopes.ts`). `tools/list` shows only the tools whose scope was granted; a call
  missing a scope gets the spec `insufficient_scope` signal naming it. `send` and the critical
  control-plane kinds only create an *approval* (table `approvals`, frozen payload +
  `payload_hash`, 10 min, single use) that the owner approves with the owner web session on
  `/approve/:id` or in the inbox approvals pane (secret-revealing kinds on `/approve/:id` only;
  both use `POST /api/approvals/:id/approve` with the `payload_hash`) (Telegram carries a notice with the link, no buttons; passkeys/WebAuthn were removed
  — the `0024` passkey table stays, unused). Besides approving, the owner may open an agent draft
  in the web composer and send it directly (fingerprint-bound `owner-web-send.v1` proof, see
  "Outbound sending"; `draft_changed` if the agent edited it meanwhile) or edit it, which takes it
  over from the agent; either supersedes the pending approval. Telegram still cannot send an agent
  draft. All other writes apply directly and are undoable via `restore`. Delegation policies (`mcp_client_policies`, `pnpm operator mcp policy`, auto-apply,
  Telegram undo) were removed in `0030`. Connection is one URL + browser login: OAuth 2.1 + PRM,
  CIMD on (`MCP_CIMD_ENABLED`, `@better-auth/cimd`) as the preferred client registration, open
  DCR kept as compatibility fallback; the owner revokes clients under `/settings/agent-access` "Connected
  agents". Control-plane kinds live in `src/lib/control-plane-kinds/*`. Better
  Auth/`@better-auth/mcp` is 1.7.20; migrations run through `0030` (`0021` Better Auth 1.7.20,
  `0022` approvals, `0024` passkey (unused), `0025`–`0028` audit/approval metadata, intent payload,
  pending uniqueness, `0029` `mcp_client_policies` + `approvals.approved_via`/`auto_refused`,
  `0030` drops `mcp_client_policies`; `0023` does not exist). Tier B proper (Workflows, EmailAgent drafting, RAG/Vectorize, AI
  Gateway) has not started — do not claim it. Cloudflare Email Sending lifecycle events are
  consumed by the `inbox-mcp-email-events` Queue and hard-bounce/complaint suppressions are
  enforced in the mailbox DO. The per-domain Email Sending event subscription is now created and
  verified by `pnpm setup:sending` (wrangler ≥ 4.127.1 exposes `--source email.sending`), checked
  against the live provider lists by `pnpm doctor --cloud`, and its actual liveness is reported
  per sending domain in `/api/health` → `dependencies.sendingFeedback` and on each transactional
  status response as `deliveryFeedback`. A domain with no subscription produces no events at all,
  so **never read the absence of a delivery event as evidence about a message without checking
  that domain's feedback liveness first** — see `src/lib/feedback-liveness.ts`.
- Deploys go through `scripts/deploy.ts` (`pnpm run deploy:dev` / `pnpm run deploy`, `--dry-run`
  to preview): build, then overlay the gitignored `wrangler.generated.<env>.json` onto
  `dist/server/wrangler.json`. The generated file wins only for the fields it owns (vars, D1 id,
  sender allow-list, a `setup:domain` route) — `scripts/lib/deploy-config.ts`; `setup:domain`
  and `setup:cloud` use the same overlay. Never deploy with raw `wrangler deploy --env <env>`.
- Transactional API current gap: no simulated delivery sink for test keys; test keys are rejected
  by the production send path. `reconcileStaleTransactionalRequests` is wired into the hourly
  cron and an auth-protected operator endpoint, and unknown outcomes remain manual-review-only.
- A security-hardening pass on top of Phase 1 is current/recent work: debug endpoints fail closed
  by default, attachment/raw downloads get hardened response headers, dev-data seeding requires
  explicit opt-in, an optional `OWNER_BOOTSTRAP_EMAILS` owner bootstrap exists, inbound size is
  capped, and mutating `/api/*` routes get an Origin-check CSRF defense. See `SECURITY.md` for the
  current posture and `CHANGELOG.md` for what's landed.
- The web perimeter is **Better Auth inside the worker** (Better Auth 1.7.20): `/login` with e-mail
  OTP (registration closed to the owner registry ∪ `OWNER_BOOTSTRAP_EMAILS`), pairing-code rescue
  via `wrangler d1 execute`, `/mcp` over OAuth + `jwt()`, session cookie cache (5 min) with a
  confirm-send bypass, and migrations `0016`–`0019`. `BETTER_AUTH_SECRET` is set for the
  maintainer's dev environment; auth fails closed outside `localhost` when it is unset.
  `pnpm setup:auth` machine-generates and uploads the secret and offers the WAF rate-limit rule
  for `/api/auth/*`; `scripts/setup-access.ts` and `scripts/smoke-access.ts` are deleted.
- D1 **is** in the inbound/outbound hot path as the cross-mailbox index (`message_index`,
  `ingest_events`, `outbound_sends`, `ops_events` are written on every ingest/send; transactional
  key/request projections are written on admin ops and send outcomes) — it is not authoritative
  (the mailbox Durable Object is), but it is no longer merely "bound and unused."
- For control-plane `/api/*` access from the terminal (creating domains, mailboxes, aliases,
  templates, API keys), use `pnpm operator login --env <env> --host <host> --email <owner>` and
  the session helpers in `scripts/lib/operator-session.ts` — not a browser, and not hand-minted
  pairing codes plus `curl`. Run `pnpm operator logout --host <host>` when done.
- To onboard a whole product (sending names, routing rules, domain/mailbox/aliases, templates,
  keys into 1Password), use `pnpm onboard --env <env> --manifest <file>` — dry-run by default,
  `--apply` to perform; see `docs/OPERATIONS.md` ("Onboarding a product"). It never deploys.
- For the Telegram bridge (bot identity, rebinding the chat, forum topics per mailbox, delivery
  checks) use `pnpm operator telegram status|rebind|topic|topics` and `pnpm smoke:telegram` —
  never raw D1 on `runtime_config` / `telegram_topics`; see `docs/OPERATIONS.md` ("Moving the
  Telegram bridge to a forum").
- Do not re-run a full Cloudflare-resource preflight unless the assigned task actually touches
  Cloudflare resources or auth. Do not advance beyond the assigned spike/milestone/task —
  validation gates are blocking.

### Known dev Cloudflare resources (maintainer's environment — placeholders, fill in your own)

- Account: `<your-cloudflare-account-id>`.
- Dev Worker: `reccado-dev`.
- Dev URL: `https://reccado-dev.<your-subdomain>.workers.dev`.
- R2 bucket: `inbox-mcp-raw-dev-eu` (created with `--jurisdiction eu`).
- Queue: `inbox-mcp-inbound-dev`.
- DLQ: `inbox-mcp-inbound-dlq-dev`.
- D1 database: `inbox-mcp-index-dev-eu` (created with `--jurisdiction eu`), id `<your-d1-database-id>`.
- Email Routing rule: `test@example.com -> reccado-dev`.
- Dev test mailbox: `test@example.com` resolves to the fixed dev-fixture id
  `DEV_TEST_MAILBOX_ID` (`src/db/seed-dev.ts`, seeded by `pnpm seed:dev-id`), so the dev server,
  the debug endpoint and the smoke scripts all agree without talking to each other. Real mailbox
  IDs are **random**, assigned by the `INSERT` that creates the row, with D1 as the only source of
  truth (`src/lib/mailbox-id.ts`) — nothing derives them from a secret. The literal `mbx_test`
  you'll see in some smoke commands (e.g. `pnpm smoke:ws .../mailboxes/mbx_test/ws`) is just an
  arbitrary Durable Object name used for WebSocket echo testing and is unrelated to D1-routed
  mailbox identity.

### Fast preflight

Run only this baseline preflight at the start of a task:

```sh
git status --short --untracked-files=all
git log -1 --oneline
node -v
pnpm -v
pnpm wrangler --version
```

If the task touches Cloudflare resources, add:

```sh
pnpm wrangler whoami
pnpm wrangler deployments list --name reccado-dev
pnpm wrangler r2 bucket list
pnpm wrangler queues list
pnpm wrangler d1 list
```

Do not list every Cloudflare service on every task. Do not browse Cloudflare docs unless the
assigned gate explicitly requires verifying a current limit or API shape.

### Current verified commands

These are expected to pass before checkpointing foundation changes:

```sh
pnpm wrangler types --env dev
pnpm run build
pnpm exec tsc --noEmit
pnpm test -- --run
pnpm smoke:ws wss://reccado-dev.<your-subdomain>.workers.dev/api/mailboxes/mbx_test/ws
pnpm smoke:email:local http://localhost:3001 fixtures/mime/simple-text.eml
```

The local smoke commands require a running dev server. If port `3000` is occupied, Vite may bind
to `3001` (or another port); use the port printed by `pnpm dev`.

### Implementation reading discipline

- Read only the assigned section of `docs/IMPLEMENTATION.md` plus nearby definitions needed for
  that section, and `docs/ARCHITECTURE.md` only for the architecture decisions relevant to the
  assigned work.
- Prefer existing local patterns in `src/server.ts`, `src/do/mailbox-do.ts`, `src/cloudflare/*`,
  and `src/lib/*` over inventing new conventions.
