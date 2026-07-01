# Production Readiness - Reccado

Profile: `app/service`
Modifiers: `[agent-developed, agent-facing, stateful, integration-heavy, regulated]`
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
2. Data lifecycle is not fully automated. The repo documents retention/export/delete/restore
   limitations and the policy decisions an operator must make, but it does not yet enforce R2
   lifecycle rules or provide full mailbox export/delete/restore workflows.
3. Supply-chain automation is improved but not complete. Dependabot, CI secret scanning, and
   minimal Actions permissions are present; SBOM/provenance and repository branch-protection
   settings remain outside the committed app code.
4. Deployed smoke is historical/manual rather than continuously enforced. That is good evidence for
   the build history, but weak evidence for an ongoing production claim.
5. The repo is `agent-facing` by modifier because the product intent includes agents, but the
   actual MCP/agent product surface is not implemented. Tier B remains roadmap-only and must not
   be advertised as shipped.

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
