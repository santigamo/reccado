# Sending streams and the auth perimeter

Two changes to Reccado, planned together because they were designed together and
touch adjacent config: split the outbound identity that machines burn from the one
humans build, and move the web perimeter from Cloudflare Access into the worker.

## The assumption this plan is built on

**Reccado is not yet a critical service.** No one else depends on it, there is no
uptime obligation, and a broken hour costs nothing but the operator's afternoon.

That assumption is what licenses everything absent here: no soak periods between
deploys, no dual-read fallbacks, no coexistence of old and new mechanisms, no legacy
paths kept alive for clients that do not exist. Each phase cuts over. If the service
ever acquires real dependents, re-read this file before following it — the sequencing
would need to grow back the scaffolding that was deliberately left out.

Two things survive the aggression, and neither is caution:

- **Migrations land before the deploy that needs them.** `CREATE TABLE` is inert to
  the running code; the reverse order gives you a worker querying tables that do not
  exist. This is ordering, not prudence.
- **`wrangler d1 execute` stays a way back in.** Owner identities, pairing codes and
  sessions all live in D1. If a deploy locks the operator out of the web perimeter,
  the fix must not require the web perimeter. This already exists and costs nothing
  to keep.

---

## Phase 0 — Restore the Telegram bridge

**Blocking today. No code, no deploy.**

Attaching `inbox.imsanti.dev` put Access in front of `/telegram/webhook`. Telegram
cannot present an Access JWT, so every update gets a 302 to the login page. Cards
still arrive — that is the worker calling out — but replies, buttons and commands do
nothing.

Add the Access **Bypass** policy for `/telegram/webhook`, which is the step already
documented in the README and skipped when the domain was attached. Webhook auth does
not change: it stays the secret derived from the bot token, which is why this route
lives outside `/api/*` in the first place.

This is worth doing even though Phase 2 deletes Access entirely, because Phase 2 is
days away and the bridge is broken now.

**Done when:** `curl -si https://inbox.imsanti.dev/telegram/webhook` returns the
handler's own answer (401 without the secret) instead of a redirect to
`cloudflareaccess.com`, and a card button responds.

---

## Phase 1 — Sending streams

### The problem

`src/do/mailbox-do.ts:1128` (transactional) and `:482` (conversational) call the same
`resolveSenderIdentity`. There is no value of `MAIL_FROM_ADDRESS` and
`MAIL_SENDING_DOMAINS` that separates reputation: either the transactional API sends
as the human's mailbox, or the human's replies send as the machine's address. The
config was not filled in wrong — the model has nowhere to write the right answer.

### The model

A stream is not stored and never asked at runtime: **the entry point already answers
it.** `confirmSendDraft` is only reachable after a human confirmed; the transactional
route is only reachable with an API key. `outbound_sends.approval_mode` already carries
the vocabulary (`human_confirmed`, `telegram_confirmed`, `preauthorized_transactional`).

What is stored is the identity of each (domain × stream), and it is observed, not
declared. New table:

```sql
CREATE TABLE domain_sending (
  domain_id           TEXT NOT NULL REFERENCES domains(id),
  stream              TEXT NOT NULL CHECK (stream IN ('conversational','transactional')),
  sending_domain      TEXT NOT NULL,
  from_mode           TEXT NOT NULL DEFAULT 'subdomain'
                      CHECK (from_mode IN ('mailbox','subdomain')),
  probe_evidence_json TEXT,
  verified_at         TEXT,
  last_send_ok_at     TEXT,
  last_send_error     TEXT,
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (domain_id, stream)
);
```

> **Gap, noted 2026-09-01:** this table records whether a (domain × stream) can send,
> but nothing about whether its *feedback channel* comes back. Those are different
> planes and they fail independently: Email Sending event subscriptions are per sending
> domain, so a domain can be verified, aligned and sending happily while its bounces and
> complaints are published to nobody — the state that looks healthiest and is worst,
> because the suppression list silently stops growing. `src/lib/feedback-liveness.ts`
> already classifies this at runtime; the durable half belongs here, alongside
> `last_send_ok_at`, as an observed fact rather than a declared one.

Roles are fixed by convention, overridable by flag, never asked:
`mail.<domain>` is conversational, `send.<domain>` is transactional. This diverges
from the table currently in `docs/EMAIL-DELIVERABILITY.md`, which should be updated:
the conversational fallback From should read as human as possible, and the live
deployment already uses `send.` as its machine sender.

Resolution:

- **Conversational** — `from_mode='mailbox'`: From is the alias the mail arrived at
  (`hello@`, `shop@`), no Reply-To. `from_mode='subdomain'`: From is
  `<alias-local-part>@mail.<domain>` with Reply-To to the alias. The degraded case
  keeps the human local-part, so `hello@mail.imsanti.dev` still reads as a person.
- **Transactional** — always `<local>@send.<domain>` with Reply-To to the mailbox.
  Local part defaults to the mailbox's; a template may declare its own
  (`receipts@`, `billing@`), which is a legitimate identity declaration.

**No `noreply@` anywhere.** An agentic inbox that declares itself uncontactable is a
gratuitous lie; replies come back through Reply-To and get triaged.

### What ships in this phase

One migration, then one deploy. No dual read — the variables die in the same change
that stops needing them.

1. Migration for `domain_sending`.
2. `setup:sending --observe`: reads `wrangler email sending list <zone>`, `dns get`
   and `dig _dmarc.*`, and writes rows. Machine transcription of an observable fact.
   For the live deployment this registers `mail.` and `send.` as they already exist.
3. Identity resolution becomes a pure function of (row, alias). `resolveDeliveredAlias`
   stops asking `MAIL_SENDING_DOMAINS` what is "ours" and asks the `domains` table —
   that was always an inbound fact wearing a sending variable's clothes.
4. The transactional path uses its own row.
5. Delete `MAIL_FROM_ADDRESS`, `MAIL_SENDING_DOMAINS` and `DEFAULT_FROM_ADDRESS`
   (which would have sent real mail as `noreply@mail.example.com` — a failure dressed
   as robustness), plus the var patching in `wrangler.generated.<env>.json`. With no
   row, sending fails by name with `sending_identity_unconfigured` and the exact
   command to fix it. Regenerate `worker-configuration.d.ts`.

### The apex question

Whether Cloudflare accepts `From: hello@imsanti.dev` signed by a subdomain is
unresolved. Cloudflare Email Sending signs per dedicated subdomain, not per apex, but
relaxed DMARC alignment should accept it since the organizational domain matches.

The system can probe this itself: send from the apex to its own inbox, let Cloudflare's
inbound MX add `Authentication-Results`, and read the verdict. But the probe's two
outcomes are **not symmetric**:

- **A rejection or a failed check demotes automatically.** Pinning `from_mode='subdomain'`
  costs nothing, so no consent is needed.
- **A pass only unlocks the offer.** `from_mode='mailbox'` requires external evidence
  (a Gmail or Outlook seed, "show original", `dmarc=pass`) plus an explicit
  `setup:sending --confirm-apex-from`. An intra-Cloudflare loop is not proof of what
  Gmail will do, and the punishment for being wrong is replies quietly landing in spam.

The general rule, worth keeping past this plan: **observation may demote on its own;
promotion needs external evidence and consent.** Asymmetric cost is the criterion.

**Done when:** a transactional test send arrives from `@send.imsanti.dev` with the
right Reply-To; a reply from Telegram arrives from the conversational identity;
`grep -r MAIL_FROM_ADDRESS src/` is empty; `pnpm check` green.

---

## Phase 2 — Better Auth

### Why, and it is not the webhook

`ACCESS_JWT_AUDIENCE` and `ACCESS_TEAM_DOMAIN` are exactly the class this project has
been eliminating: human transcriptions of dashboard state. Worse, `src/api/auth.ts`
documents the perimeter as **unobservable from inside** — the worker cannot tell
whether Access is actually in front of it. A perimeter the system cannot verify is
the root of the failure class that has now bitten twice (MCP over workers.dev, and
the Telegram webhook). Moving it inward makes it observable, testable, and forkable
without Zero Trust as a prerequisite for a public repo.

### What changes, and what pointedly does not

**Authorization does not migrate.** `owner_identities` and `isOwner` stay exactly as
they are. Better Auth becomes the issuer of an authenticated email identity; the owner
registry still decides whether that identity is the operator. A bug in the new issuer
yields at most an authenticated stranger the registry rejects. This is the seam that
makes the whole migration small.

**No passwords.** Email OTP only, sent by Reccado itself over the transactional stream
from Phase 1. There is no credential to steal and no stuffing to attempt; brute force
reduces to guessing six digits with a short TTL, three attempts, and a WAF rule on
`/api/auth/*`. Registration is closed: only an address already in the owner registry
can complete an OTP; anyone else never receives a code.

**Transactional API keys stay untouched.** The `rck_` system authenticates *machines
against a mailbox's transactional API*, with quotas, template allowlists and recipient
policy. Better Auth authenticates *the operator*. They are layers, not duplicates.
`@better-auth/api-key` does not enter.

### What ships

One migration, one deploy, one dashboard action. No dual issuer, no legacy MCP path.

1. **Spike first**, half a day, on `reccado-dev.<account>.workers.dev` — which is not
   behind Access and is therefore a free end-to-end test bed. Verify Better Auth on the
   D1 binding before building on the claim.
2. Migration with Better Auth's schema, generated by its migrator and committed as SQL
   under the repo's existing migration regime.
3. `getAuthContext` swaps issuer: session cookie → `AuthContext{email}`. The Access
   validator, `getAccessConfigStatus`, `ACCESS_JWT_AUDIENCE` and `ACCESS_TEAM_DOMAIN`
   are deleted in the same change. `ACCESS_ALLOWED_EMAILS` is renamed
   `OWNER_BOOTSTRAP_EMAILS`, keeping its role as the master key into the registry.
4. **Session cookie cache enabled** — Better Auth verifies a short-lived signed cookie
   without touching the database, which removes a D1 read per request now that every
   request reaches the worker. Bypass the cache on confirm-send, where a revoked
   session must take effect immediately.
5. `@better-auth/mcp` becomes the OAuth provider for `/mcp` (with `jwt()` alongside for
   stable signing keys and `/jwks`). Our own `requireMcpAuth` is renamed
   `requireMcpOwner` to hand the name to the plugin; the owner gate still applies after
   the token. Reconnect your own MCP clients — with a single operator, that is the
   entire migration.
6. `/login` route, 401 → login redirect in the UI.
7. `setup:access` becomes `setup:auth`: generates `BETTER_AUTH_SECRET` by machine and
   uploads it as a secret (entropy no human transcribes), derives the base URL from
   `deployment.origin`, and creates the WAF rate-limit rule. There is no
   `BETTER_AUTH_URL`.
8. **Delete the Access application** in the dashboard.

### The rescue path, which is the only safety net kept

`owner_pairing_codes` extends to the web: a code minted through `wrangler d1 execute`
creates a session directly at `/login`. One rescue concept for Telegram and web, and it
also solves a forker's first login before mail sending is configured.

Rehearse it **once, for real, before deleting the Access app.** Not as a soak period —
as a single command that proves the ladder exists before kicking the chair away.

### Two perimeters, still independent

The web perimeter and Telegram's derived secret fail separately. A broken web perimeter
never costs the ability to read and answer mail. This is not something the plan adds;
it is a property worth not breaking.

### `recordDeploymentOrigin`

It stays where it is, in the middleware after a successful `requireAuth` — only the
issuer that satisfies it changes. The invariant to preserve is that **the origin is
learned only from a request an owner authenticated**, which is what stops a forged Host
header from redirecting the Telegram webhook. The login page and `/api/auth/*` must not
record it: there is no authenticated owner yet. Add a test that fixes both halves.

**Done when:** a clean browser with no Access cookie reaches the mailbox through the
new login; an MCP client completes the OAuth flow and its tools respond; `grep -r
"cloudflareaccess" src scripts` is empty; the documented path for a forker contains no
Zero Trust step.

**Config balance:** three variables out, one machine-generated secret in.

---

## Phase 3 — DMARC ramp

Independent of both phases above and additive; do it when the parser is worth building.

The move that makes it possible: point `rua` at `dmarc@<domain>`, an alias the system
itself controls. **Reccado is a mail server and DMARC reports are mail — let it send
them to itself.** Aggregates parse into a `dmarc_observations` table, marked as a system
stream so a report never produces a Telegram card.

Decompose the ramp into three roles:

- **Sensor** — machine, entirely. Parsing aggregate XML inside zip or gzip within a
  Worker is the unglamorous cost of this phase and carries the whole thing. Size it
  before starting.
- **Judge** — machine, and this is the part that looks irreducible and is not. On a
  dedicated subdomain that Reccado provisioned, the question that normally makes DMARC
  judgement human — *are there other legitimate senders?* — has a known answer: no. So
  the gates are computable: N days at the current policy, M messages observed, 100%
  aligned DKIM, zero aligned failures.
- **Actuator** — writing DNS needs authority the worker does not have. **The irreducible
  part of the ramp is not the judgement, it is the credential.** Default: no DNS token
  in the worker (a compromised worker with Zone·DNS·Edit is a hijacked zone). The
  actuator stays `setup:sending`, and the human is reduced to consent-and-paste, given
  the evidence and the exact command. If the operator ever declares a DNS token as a
  worker secret — itself a legitimate declaration of trust — the ramp runs autonomously
  on its own subdomains.

  > **Amended 2026-09-01 — that branch has been taken.** The operator's requirement was
  > no consent-and-paste step anywhere, which forces the DNS write into the Worker; the
  > paragraph above already named this as the legitimate alternative rather than a
  > departure from the plan, so this is the plan's own second branch and not a
  > deviation from it.
  >
  > What changed in the reasoning: the original default leaned partly on the Worker
  > being a bad place for a credential *because it parses untrusted MIME*. That argument
  > is weaker than it reads. A Worker is a V8 isolate, and input-driven RCE is the
  > threat that model is strongest against; the realistic compromise vectors are a
  > dependency or a logic bug that exposes the environment, and a separate provisioning
  > Worker built from this same repo, with the same dependencies and the same deploy
  > pipeline, would share both. The isolation it appeared to buy was mostly against the
  > vector that barely exists.
  >
  > So the attenuation went into code instead, in `src/lib/dns-gate.ts`: one function
  > that takes an intent rather than a record, composes the name itself, resolves the
  > zone from the `domains` registry rather than from its caller, and has no parameter
  > through which a name, type or content can be supplied. A source-level guard fails
  > the build if any other file in `src/` addresses the DNS API. **The hard rule below —
  > the apex is never acted on — is now enforced structurally rather than by
  > convention**, which is the property that made this trade acceptable.
  >
  > What this does NOT do, recorded so it is not mistaken for more: if the Worker's
  > environment leaks, the attacker holds the token and the gate is irrelevant to them.
  > The gate bounds what our own code can do. The token being scoped to Reccado's zones
  > is the separate, and smaller, control on that.

Three hard rules: **the apex is never acted on**, only read and reported, because there
the system genuinely cannot enumerate legitimate senders. **The ramp's state is the DNS
record itself** — observable, with no state variable to drift. And **rollback
(reject → none) is human**: the failures visible in a dedicated subdomain's reports are
mostly spoofers, and auto-relaxing policy because spoofers exist is backwards.

---

## Not doing

- Replacing the `rck_` transactional key system.
- Passwords, social providers, `@better-auth/api-key`, multi-user or organizations.
- A DNS token in the worker.
- Auto-promoting `from_mode` to `mailbox` on an internal probe alone.
- Touching the draft → confirm → send flow.

## Later, in rough order of value

Passkeys as an access path that needs no mail; `oauthDeviceAuthorization` for CLIs;
an automated external seed for the apex question; autonomous ramp actuation under a
declared DNS token; per-mailbox ACLs (the TODO already sitting in
`assertMailboxAccess`).
