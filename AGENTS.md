# Agent Operating Guide

This repository is being implemented from `docs/IMPLEMENTATION.md` under senior-gated phases. Do not spend context rediscovering facts already validated here.

## Current Baseline

- Current safe checkpoint: latest committed `main`.
- Phase 0 is senior-approved.
- Evidence lives in `docs/PHASE0_VALIDATION.md` and `docs/PHASE1_VALIDATION.md`.
- Do not re-run the whole preflight unless the assigned task touches Cloudflare resources or auth.
- Do not advance beyond the assigned spike/milestone. Validation gates are blocking.

Known dev Cloudflare resources:

- Account: `<your-cloudflare-account-id>`.
- Dev Worker: `reccado-dev`.
- Dev URL: `https://reccado-dev.<your-subdomain>.workers.dev`.
- R2 bucket: `inbox-mcp-raw-dev`.
- Queue: `inbox-mcp-inbound-dev`.
- DLQ: `inbox-mcp-inbound-dlq-dev`.
- D1 database: `inbox-mcp-index-dev`, id `ca3b5109-17bf-4a6e-9943-9892c4e04dbc`.
- Email Routing rule: `test@example.com -> reccado-dev`.
- Test mailbox mapping: `test@example.com` maps to mailbox id `mbx_test`.

Known caveats:

- Cloudflare Access is not configured for this product yet. Current debug endpoints use `PHASE0_DEBUG_TOKEN`.
- The Workers Vitest harness is configured in `vitest.config.ts`; do not remove it or fall back to loading `vite.config.ts` for tests.
- D1 exists and is bound but is not yet in the hot path.

## Fast Preflight

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

Do not list every Cloudflare service on every task. Do not browse Cloudflare docs unless the assigned gate explicitly requires verifying a current limit, API shape, or Access behavior.

## Implementation Rules

- Read only the assigned section of `docs/IMPLEMENTATION.md` plus nearby definitions needed for that section.
- Read `docs/ARCHITECTURE.md` only for architecture decisions relevant to the assigned work.
- Prefer existing local patterns in `src/server.ts`, `src/do/mailbox-do.ts`, `src/cloudflare/*`, and `src/lib/*`.
- Use `rg` for search. Avoid broad full-repo reading unless the task requires it.
- Use `apply_patch` or normal editor tooling for source edits; do not generate files with ad hoc shell heredocs unless the file is temporary evidence outside the repo.
- Do not commit unless the supervisor explicitly asks or the current instruction says to create a checkpoint commit.
- Do not copy source from `mailflare`, `agentic-inbox`, or any external inbox implementation into this product. External repos may be read only for behavior and attribution notes.
- Do not modify production resources. Use only dev/disposable Cloudflare resources, and document every resource created.
- Delete disposable Cloudflare resources before finishing unless the validation evidence requires keeping them and the supervisor explicitly approves.

## Validation Evidence

Every gate result must include:

- Assigned spike/milestone and explicit `PASS` or `FAIL`.
- Commands run and meaningful output snippets.
- Files changed.
- Cloudflare resource names/IDs touched.
- URLs tested.
- Example payloads where the gate involves email, queues, APIs, WebSockets, or scheduled handlers.
- Logs or screenshots when the gate calls for them.
- Duplicate/idempotency result when relevant.
- Known failures and whether they are blocking.

Do not write "works" or "seems fine" without evidence. If a gate cannot be validated, stop and report `FAIL` with the exact blocker.

## Current Verified Commands

These are expected to pass before checkpointing foundation changes:

```sh
pnpm wrangler types --env dev
pnpm run build
pnpm exec tsc --noEmit
pnpm test -- --run
pnpm smoke:ws wss://reccado-dev.<your-subdomain>.workers.dev/api/mailboxes/mbx_test/ws
pnpm smoke:email:local http://localhost:3001 fixtures/mime/simple-text.eml
```

The local smoke commands require a running dev server. If port `3000` is occupied, Vite may bind to `3001`; use the port printed by `pnpm dev`.

## Spike 0.4 Note

For `agentic-inbox` exploration:

- Clone only to `/tmp` or another disposable path.
- Do not import its code into this repo.
- Deploy only with a disposable Worker name.
- Real Cloudflare Access at the edge is required for `PASS`; app-level "Access not configured" responses are not enough.
- If Wrangler has no Access command, use Cloudflare Zero Trust API only if credentials/scopes are available and document the exact API calls. Otherwise stop with `FAIL`.

## Supervisor Handoff Format

End every agent run with:

```text
RESULT: PASS|FAIL
SCOPE: Phase X.Y / Milestone X.Y
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
- recommended next gate, not implementation beyond scope
```
