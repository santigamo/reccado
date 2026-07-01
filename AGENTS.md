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

- **An agent (or any automated caller) may draft and summarize mail, but must never send without
  explicit human confirmation.** The `request-send` → `confirm-send` flow with an idempotency key
  is the only sending path; there is no shortcut. This is a security boundary, not a UX
  preference — see `docs/ARCHITECTURE.md` ("Authentication and Security Model") and `SKILL.md`
  ("Hard invariant"). Repeated `confirm-send` calls with the same idempotency key must send at
  most once.

### Legal / provenance

- Do not copy source, schema, text, or file structure from `mailflare`, `agentic-inbox`, or any
  other external inbox implementation into this product. External repos may be read only for
  behavior/pattern understanding and attribution notes — reimplement from first principles.
- If evaluating an external reference implementation (clone it to verify behavior, deploy it to
  compare), clone only to a disposable path (e.g. `/tmp`), never import its code, deploy only
  under a disposable Worker name, and treat real Cloudflare Access edge enforcement (an
  unauthenticated request must `302` to your team's `cloudflareaccess.com` login) as the only
  acceptable evidence that auth actually works — an app-level "Access not configured" message is
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
  record. Phase 2 (Tier B: Workflows, EmailAgent, MCP endpoint, RAG) has not started.
- A security-hardening pass on top of Phase 1 is current/recent work: debug endpoints fail closed
  by default, attachment/raw downloads get hardened response headers, dev-data seeding requires
  explicit opt-in, an optional `ACCESS_ALLOWED_EMAILS` owner allowlist exists, inbound size is
  capped, and mutating `/api/*` routes get an Origin-check CSRF defense. See `SECURITY.md` for the
  current posture and `CHANGELOG.md` for what's landed.
- Cloudflare Access **is** configured for the maintainer's dev environment (`ACCESS_JWT_AUDIENCE`
  / `ACCESS_TEAM_DOMAIN` secrets set); auth fails closed outside `localhost` when those are unset.
- D1 **is** in the inbound/outbound hot path as the cross-mailbox index (`message_index`,
  `ingest_events`, `outbound_sends`, `ops_events` are written on every ingest/send) — it is not
  authoritative (the mailbox Durable Object is), but it is no longer merely "bound and unused."
- Do not re-run a full Cloudflare-resource preflight unless the assigned task actually touches
  Cloudflare resources or auth. Do not advance beyond the assigned spike/milestone/task —
  validation gates are blocking.

### Known dev Cloudflare resources (maintainer's environment — placeholders, fill in your own)

- Account: `<your-cloudflare-account-id>`.
- Dev Worker: `reccado-dev`.
- Dev URL: `https://reccado-dev.<your-subdomain>.workers.dev`.
- R2 bucket: `inbox-mcp-raw-dev`.
- Queue: `inbox-mcp-inbound-dev`.
- DLQ: `inbox-mcp-inbound-dlq-dev`.
- D1 database: `inbox-mcp-index-dev`, id `<your-d1-database-id>`.
- Email Routing rule: `test@example.com -> reccado-dev`.
- Dev test mailbox: `test@example.com` resolves to a mailbox ID **deterministically derived** as
  `HMAC-SHA256(MAILBOX_ID_SECRET, "test@example.com")` (see `src/lib/mailbox-id.ts` and
  `pnpm seed:dev-id`) — it is not a fixed literal. The literal `mbx_test` you'll see in some smoke
  commands (e.g. `pnpm smoke:ws .../mailboxes/mbx_test/ws`) is just an arbitrary Durable Object
  name used for WebSocket echo testing and is unrelated to D1-routed mailbox identity.

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
assigned gate explicitly requires verifying a current limit, API shape, or Access behavior.

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
