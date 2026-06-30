# Contributing to Reccado

Thanks for considering a contribution. Reccado is a self-hosted product, not a published package
— the practical bar for a change is "does it work for someone running their own instance,"
not "does it preserve a public API."

## Dev setup

Requires Node `>=22.12.0` (`engines.node` in `package.json`) and pnpm `11.1.1`
(`packageManager` in `package.json` — use Corepack or install that version directly).

```bash
pnpm install
pnpm dev
```

This starts the app locally via `@cloudflare/vite-plugin`'s local Workers emulation — no
Cloudflare account or deployed resources are required to develop or run the test suite. See the
[README Quickstart](README.md#quickstart-prove-it-locally-in-5-min) for the expected output of a
working local setup, and [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) for the full
implementation spec if your change touches the data model, bindings, or the inbound/outbound
pipeline.

## Before opening a PR

Run the same checks CI runs (`.github/workflows/ci.yml`):

```bash
pnpm run typecheck   # tsc --noEmit
pnpm run lint         # biome lint .
pnpm test             # vitest run, via @cloudflare/vitest-pool-workers (Workers runtime)
pnpm run build        # production build (client + SSR)
```

Or run the bundled shortcut for typecheck + lint + test: `pnpm run check`. Format with
`pnpm run format` (writes) or check formatting without writing via `pnpm run format:check` —
both run Biome (`biome.json`). TypeScript strictness (`tsconfig.json`: `strict`, `noUnusedLocals`,
`noUnusedParameters`, `noFallthroughCasesInSwitch`) is enforced on top of lint/format.

CI also validates the Worker bundle with `wrangler deploy --dry-run` and checks that generated
artifacts (`worker-configuration.d.ts` via `pnpm cf-typegen`, `src/routeTree.gen.ts` via
`pnpm generate-routes`) are up to date and committed — regenerate and commit both if your change
touches bindings or routes.

If your change touches `migrations/d1/`, also run the migration locally before opening the PR:

```bash
pnpm d1:migrate:local
```

## PR expectations

- Keep PRs scoped to one concern. Architecture-level changes should reference or update
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) rather than silently diverging from it.
- New D1 migrations are additive and forward-only; never edit an already-applied migration file
  in `migrations/d1/`. Self-hosters run `wrangler d1 migrations apply` against real mailboxes —
  treat every migration as something that has to run cleanly on someone else's data.
- Don't reintroduce dev-only conveniences (debug endpoints, dev-data seeding) into a path that
  runs in production without an explicit opt-in and a fail-closed default — see `SECURITY.md` for
  the current security posture and what "fail closed" means here.
- If your change affects self-hosters (new required secret/binding, new migration, changed
  default, breaking API/route change), add an entry under `## [Unreleased]` in `CHANGELOG.md`.
- Describe what you tested and how in the PR description (commands run, not just "works").

## AI-assisted contributions

If you're using an AI coding agent to work on this repo, point it at [`AGENTS.md`](AGENTS.md)
first — it documents the durable invariants (data ownership, idempotency rules, the
human-confirmation requirement on outbound sending) that must not be silently violated, plus the
evidence-based reporting format expected from agent-driven changes. [`SKILL.md`](SKILL.md) is the
runbook for self-hosting Reccado and the (currently stubbed) MCP/agent layer, useful if your
agent's task is deployment rather than code changes.

## Reporting issues

Open a GitHub issue with: what you ran, what you expected, what happened, and your environment
(Node version, `pnpm wrangler --version`, whether you're running local dev or a deployed
instance). For security issues, see [`SECURITY.md`](SECURITY.md) instead of opening a public
issue.
