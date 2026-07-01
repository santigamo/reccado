# Production Readiness - Reccado

Profile: `app/service`
Modifiers: `[agent-developed, agent-facing, stateful, integration-heavy, privacy-sensitive, regulated, product-ui]`
Production claim: self-hostable Cloudflare Tier A inbox for a single operator, running on Workers,
Durable Objects, R2, D1, Queues, Email Routing, Email Sending, Cron, and Cloudflare Access.
Audited: 2026-07-01
Verdict: `READY-WITH-CAVEATS`

This audit is intentionally narrow about what is in scope today:

- In scope production claim: the shipped Tier A inbox described in `README.md`,
  `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, and `SECURITY.md`.
- Out of scope from the claim: Tier B roadmap items such as MCP endpoint, agent tools, RAG,
  Vectorize, Workers AI, AI Gateway, and Workflow-based long sagas. Those surfaces are mentioned
  in docs as roadmap only and are not implemented product contracts today.
- Primary consumers today: a human operator self-hosting their own mailbox system behind
  Cloudflare Access. Agent maintainers are also consumers of the repo because the codebase is
  explicitly `agent-developed`.

## Surface audited

- Web UI and Hono API served from the Worker (`src/server.ts`, `src/api/*`).
- Inbound path: Email Routing -> R2 -> Queue -> mailbox Durable Object -> D1 summary index.
- Outbound path: draft -> `request-send` -> `confirm-send` -> Email Sending binding.
- Realtime mailbox updates over WebSockets.
- Scheduled backup/stale-send reconciliation path.
- Control-plane/admin endpoints documented in `docs/OPERATIONS.md`.

## Gate summary

| Gate | Applies | Status | Evidence | Owner | Gap |
| ---- | ------- | ------ | -------- | ----- | --- |
| 0. Scope & production claim | Required | pass | `README.md`; `docs/ARCHITECTURE.md`; this file narrows the claim to Tier A self-hosting | maintainer | - |
| 1. Public face & onboarding | Required | pass | `README.md` includes quickstart, deploy guide, config, compatibility, troubleshooting, and expected outputs | maintainer | - |
| 2. Documentation & decisions | Required | pass | `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, `SECURITY.md`, `CHANGELOG.md`, `AGENTS.md`; this file records the production claim and caveats | maintainer | - |
| 3. Public contract & interface | Required | partial | `README.md` and `docs/IMPLEMENTATION.md` document major routes/flows; `src/api/*` and `src/do/mailbox-do.ts` define the current surface | maintainer | no dedicated API contract doc or versioning/deprecation policy beyond current repo docs |
| 4. Packaging contract | N/A | - | private app/service (`package.json` has `"private": true`) | - | - |
| 5. Deployment contract | Required | partial | `wrangler.jsonc`; `README.md#deploy-your-own`; `docs/OPERATIONS.md`; configurable `pnpm verify:cf`; historical remote validation in `docs/PHASE1_VALIDATION.md` | maintainer | deploy smoke exists as manual evidence, not current automated post-deploy smoke in CI/prod |
| 6. Code architecture | Required | pass | authoritative DO model and data ownership documented in `docs/ARCHITECTURE.md`; boundaries reflected in `src/cloudflare/*`, `src/do/*`, `src/db/d1.ts` | maintainer | - |
| 7. Agent surfaces | Required | partial | `AGENTS.md`; `SKILL.md`; human-confirmed send invariant documented in `AGENTS.md` and `SECURITY.md` | maintainer | repo is agent-developed, but product-side agent/MCP interfaces are not implemented yet; no shipped tool schemas/examples |
| 8. Security & supply chain | Required | partial | `SECURITY.md`; Access auth in `src/api/auth.ts`; CI in `.github/workflows/ci.yml`; `.github/dependabot.yml`; CI secret scan | maintainer | no SBOM/provenance output; branch protection and GitHub secret-scanning settings remain repository policy outside code |
| 9. Config & secrets | Required | pass | `.dev.vars.example`; `README.md#configuration`; `docs/OPERATIONS.md`; `src/lib/runtime-config.ts`; auth fail-closed behavior documented in `SECURITY.md` | maintainer | - |
| 10. Testing & verification | Required | partial | `pnpm test`, `pnpm run build`, `pnpm typecheck`, `pnpm lint`; CI local HTTP smoke; historical local/remote validation in `docs/PHASE1_VALIDATION.md` | maintainer | no continuously enforced deployed smoke against a live environment; historical evidence is not the same as current release automation |
| 11. Integration & resilience | Required | partial | Queue + DLQ + idempotent ingest documented in `docs/ARCHITECTURE.md`, `docs/OPERATIONS.md`, and validated historically in `docs/PHASE1_VALIDATION.md`; explicit timeouts added for Access cert and Cloudflare API fetches | maintainer | replay runbook exists, but no operator-facing DLQ replay endpoint and no provisioned alert automation for backlog/DLQ conditions |
| 12. Operational readiness | Required | partial | dependency-aware `/api/health` in `src/api/hono.ts`; runbook/SLO/alerting expectations in `docs/OPERATIONS.md`; Wrangler observability enabled in `wrangler.jsonc` | maintainer | alerting/error-sink resources are documented as required operator setup, not provisioned by this repo; no automated prod smoke after deploy |
| 13. Data lifecycle | Required | partial | ownership/source-of-truth rules are clear in `docs/ARCHITECTURE.md`; retention/export/delete/restore limitations documented in `docs/OPERATIONS.md`; backups exist in `src/cloudflare/scheduled.ts` | maintainer | lifecycle/deletion/restore are documented but not automated or enforced by repo-managed resources |
| 14. Privacy & compliance | Required | partial | PII/inbox-data model and admin-access controls in `SECURITY.md` (`ACCESS_ALLOWED_EMAILS` owner allowlist, Access-only admin routes, reliance on Cloudflare platform encryption at rest); retention/export/delete policy and its current gaps spelled out in `docs/OPERATIONS.md:176-224` ("Data lifecycle, retention, privacy, and current limitations" and "Manual delete/export/restore reality"); only Cloudflare-native services (R2, D1, DO, Email Routing/Sending) are in the data path per `docs/ARCHITECTURE.md` | maintainer | `docs/OPERATIONS.md:193-197` states plainly there is "no user-facing export job," "no end-user delete workflow [that] guarantees removal of all raw MIME, attachment blobs, D1 rows," and "no documented trash-retention timer or legal-hold model"; export/delete are manual, unverified-by-fixture procedures (`docs/OPERATIONS.md:214-224`), not automated or tested — required for `regulated`'s formal compliance bar |
| 15. Automation, release & change control | Required | partial | `.github/workflows/ci.yml` runs separated lint/format-check/typecheck/test/build/local-HTTP-smoke steps plus `wrangler deploy --dry-run --outdir .wrangler/dry-run`, a generated-artifact drift check, and a `secret-scan` job (`gitleaks/gitleaks-action@v2`); Node matrix pins the `engines` floor and current (`22.12.0`, `24`); `pnpm install --frozen-lockfile` and `packageManager: pnpm@11.1.1` pin the install; `.github/dependabot.yml` schedules weekly `npm` and `github-actions` updates | maintainer | CI has no deploy/promotion job — `pnpm run deploy`/`deploy:dev` are manual local scripts with no CI environment gate, protected-environment approval, or rollback automation; branch protection and required-checks enforcement are GitHub repo settings, not verifiable from committed code |
| 16. Public credibility & repository hygiene | Required | partial | root layout is legible (`src/`, `docs/`, `tests/`, `migrations/`, `scripts/`, `fixtures/`); `package.json` scripts follow the expected `dev`/`build`/`test`/`typecheck`/`lint`/`format`/`deploy`/`smoke:*` naming; `README.md` badges are live (CI workflow badge, MIT license, edge/runtime, "Status: Phase 1 complete"); `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT) all present; `SECURITY.md`'s "Supported versions" section states the maintenance posture honestly (pre-1.0, `main`-only, no LTS branch, best-effort response) | maintainer | `CONTRIBUTING.md` invites external contributions but there are no GitHub issue/PR templates, labels, or `CODEOWNERS` in `.github/` (only `dependabot.yml` and `workflows/ci.yml` exist); no `CODE_OF_CONDUCT.md` |
| 17. Product UI quality | Required | partial | `src/routes/mailboxes/index.tsx:16-50` implements explicit loading/empty/error states (`error` state rendered, empty-mailbox-list message) for the mailbox list view; compose flow (`src/routes/mailboxes/$mailboxId/compose.tsx:86,94`) disables send actions until a draft exists | maintainer | the primary mailbox/thread view (`src/routes/mailboxes/$mailboxId/index.tsx`) has no loading or error state around its `threads`/`messages`/search `fetch` calls (lines 40-62) — a failed fetch just leaves empty lists with no user-visible signal; accessibility attributes (`aria-*`, `role=`) appear only 3 times across all of `src/components` and `src/routes`; there is no Playwright, visual-regression, or a11y test anywhere in the repo (`tests/` is exclusively Vitest unit/integration specs) and CI runs no UI/browser checks |

## Why the verdict is `READY-WITH-CAVEATS`

The repo clears the bar for a serious self-hostable Tier A service in several core areas:

- The deployed shape is documented and reproducible.
- The data model has a clear authority boundary: mailbox Durable Object first, D1 rebuildable.
- Security posture is documented and mostly fail-closed for auth, debug routes, and outbound send.
- The critical email ingest/send paths have historical validation evidence, including idempotency.

It does not earn an unqualified production-ready claim yet because several required service gates
are still incomplete:

1. Ops/alerting still requires operator setup. The repo now documents SLOs, metrics, alerting
   expectations, and exposes dependency-aware health state, but it does not provision Cloudflare
   Alert Policies, an error sink, or pager/webhook notifications.
2. Data lifecycle and privacy/compliance are not fully automated. The repo is `privacy-sensitive`
   (and `regulated`) and documents retention/export/delete/restore limitations and the policy
   decisions an operator must make (`docs/OPERATIONS.md:176-224`), but it does not yet enforce R2
   lifecycle rules or provide full, fixture-verified mailbox export/delete/restore workflows —
   the gap spans both Gate 13 (Data lifecycle) and Gate 14 (Privacy & compliance).
3. Supply-chain automation is improved but not complete. Dependabot, CI secret scanning, and
   minimal Actions permissions are present; SBOM/provenance and repository branch-protection
   settings remain outside the committed app code.
4. Deployed smoke is historical/manual rather than continuously enforced. That is good evidence for
   the build history, but weak evidence for an ongoing production claim.
5. The repo is `agent-facing` by modifier because the product intent includes agents, but the
   actual MCP/agent product surface is not implemented. Tier B remains roadmap-only and must not
   be advertised as shipped.
6. CI (`.github/workflows/ci.yml`) verifies build/test/typecheck/lint/dry-run-deploy but has no
   deploy/promotion/rollback job; deploy remains a manual local script (Gate 15).
7. The repo is `product-ui` by modifier because it ships a TanStack Start web UI, but UI quality
   evidence is thin: the primary mailbox/thread view has no loading/error state around its data
   fetches, accessibility attributes are sparse, and there are no Playwright/visual/a11y tests
   (Gate 17).

## Recommended claim to use right now

Use this narrower production claim in repo-facing docs and audits:

> Reccado is a self-hostable, single-operator Tier A inbox for Cloudflare. It supports inbound
> email, mailbox storage/search, realtime UI, and human-confirmed outbound send. Agent/MCP/RAG
> capabilities are planned but not implemented in the current repo.

## Highest-priority gaps

1. Turn the documented retention/deletion policy into enforceable R2 lifecycle rules and mailbox
   export/delete/restore workflows.
2. Provision concrete ops alerting and incident visibility for queue backlog, DLQ growth,
   ingest/send failures, and cron backup failures.
3. Add automated deployed smoke for the dev/prod worker path, not only local and historical
   validation.
4. Add SBOM/provenance or an explicitly waived alternative proportional to a public, regulated,
   self-hosted service.
5. Keep Tier B claims explicitly roadmap-only until MCP/agent surfaces ship with tool contracts,
   auth scopes, and validation evidence.
6. Add a loading/error state to the primary mailbox/thread view (`src/routes/mailboxes/$mailboxId/index.tsx`)
   and at least a minimal Playwright/a11y smoke, proportional to the newly declared `product-ui`
   modifier (Gate 17).
