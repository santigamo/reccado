<div align="center">

![Reccado — the agent-native inbox, self-hosted on Cloudflare](docs/assets/banner.jpg)

<h3>The agent-native inbox — self-hosted email on Cloudflare</h3>

<p>Receive, store, thread, search and send email from your own domains, running <strong>entirely on Cloudflare</strong> (Workers · Durable Objects · R2 · D1 · Queues) — with an <strong>MCP layer</strong> on the roadmap so agents can read, triage and draft your mail.</p>

[![CI](https://github.com/santigamo/reccado/actions/workflows/ci.yml/badge.svg)](https://github.com/santigamo/reccado/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-F38020.svg)](./LICENSE)
[![Edge: Cloudflare Workers](https://img.shields.io/badge/edge-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Built with Hono](https://img.shields.io/badge/built%20with-Hono-E36002?logo=hono&logoColor=white)](https://hono.dev)
[![Status: Phase 1 complete](https://img.shields.io/badge/status-Phase%201%20complete-F38020)](docs/PHASE1_VALIDATION.md)

</div>

---

**Reccado** is a self-hosted, Cloudflare-maximalist inbox for your app domains — the Tier A email
core today, with a Tier B agent / MCP / RAG layer on the roadmap.

Start here:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — accepted architecture and tradeoffs.
- [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) — executable runbook with validation gates after every spike and milestone.

## Status

**Phase 1 (Tier A inbox) complete and senior-validated** — inbound hot path (Email Routing → R2 → Queue → Durable Object), DO mailbox store with threading + full-text search, HTTP API + UI, hibernatable WebSocket realtime, human-confirmed outbound sending, multi-domain routing, backup and ops. Validated end-to-end against real Cloudflare resources in the `dev` environment.

Next: **Phase 2 (Tier B)** — Workflows, EmailAgent, the MCP endpoint, and RAG / semantic search.

Current validation evidence lives in [`docs/PHASE0_VALIDATION.md`](docs/PHASE0_VALIDATION.md) and [`docs/PHASE1_VALIDATION.md`](docs/PHASE1_VALIDATION.md). Brand and asset guidelines live in [`docs/BRAND.md`](docs/BRAND.md).

## Local development

```bash
pnpm install
pnpm dev
```

Other commands:

```bash
pnpm run build          # production build
pnpm wrangler types     # regenerate worker-configuration.d.ts
pnpm test               # vitest
```

Health check (use the port Vite prints, default 3000):

```bash
curl http://localhost:3000/api/health
```

## Deploying your own

The repo ships with placeholder identity so it's safe to fork. Before deploying to your own
Cloudflare account, replace:

- **Sender** — set `MAIL_FROM_ADDRESS` in `wrangler.jsonc` (`vars`) to a verified sender on your domain.
- **Domains** — the dev seed and fixtures use `example.com` / `mail.example.com`; point them at your zones.
- **Account / Access** — fill `<your-cloudflare-account-id>`, `<your-subdomain>.workers.dev`, and `<your-team>.cloudflareaccess.com` placeholders in `AGENTS.md` / `.dev.vars`, and provide real secrets via `.dev.vars` (see `.dev.vars.example`).
- **Resources** — the Worker is named `reccado` / `reccado-dev`, but the backing R2 bucket, D1 database, and queues keep their original `inbox-mcp-*-dev` names (and the maintainer's `database_id`) so the existing dev environment keeps working. Create your own and update `wrangler.jsonc` + the `d1:migrate` scripts in `package.json`.
