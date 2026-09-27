# Operations

Current-state operating reference for a running Reccado instance: what each binding/secret does,
how to decide a deploy is safe, what to do when something breaks, and what data exists today. For
setup/deploy steps, see the [README Deploy guide](../README.md#deploy-your-own) and
[`SKILL.md`](../SKILL.md). For the design constraints behind these procedures, see
[`ARCHITECTURE.md`](ARCHITECTURE.md).

## Operational contract

- The mailbox Durable Object is the canonical mailbox state. D1 is a rebuildable control-plane and
  cross-mailbox index, not the source of truth. This extends to transactional state: API keys,
  quotas, idempotency, and transactional request records are DO-authoritative; D1 holds only
  non-authoritative projections.
- Queue payloads stay metadata-only. Raw MIME, parsed HTML bodies that spill out of SQLite, and
  attachments live in R2.
- Inbound processing must remain idempotent across Email Routing retries, Queue retries, and any
  manual replay.
- Outbound sending from the UI, Telegram, and the MCP endpoint still requires explicit human
  confirmation through `request-send` then `confirm-send`; there is no fully automated send path on
  those surfaces. The transactional API is the one deliberate exception: an operator-created,
  mailbox-bound API key is an explicit pre-authorization, and sends made with it skip the
  per-message confirm step (see `SECURITY.md`).
- This runbook documents what exists now. Where restore, replay, retention enforcement, or alerting
  automation is not implemented, that is called out explicitly rather than implied.

## Env vars, secrets, and bindings

### Secrets and vars

| Name | Kind | Purpose | Required? |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | secret | Signs sessions and **encrypts at rest** the `jwt()` signing key (`jwks`) and enrolled TOTP secrets (`twoFactor`). Unset or shorter than 32 chars = auth fails closed (`503`). Rotating it orphans that ciphertext — see the runbook row before doing so. | **Required** |
| `OWNER_BOOTSTRAP_EMAILS` | secret | Bootstrap for the D1 owner registry (`owner_identities`); the two are unioned. Both empty = auth fails closed (`503`), never open. Registration is closed: only an address in this union is ever sent a sign-in code. | Optional once an owner is registered |
| `CLOUDFLARE_API_TOKEN` | secret | Token for admin provisioning workflows. See **Provisioning a sending domain** below for the exact permissions and what each one buys. | Optional |
| `CLOUDFLARE_ACCOUNT_ID` | secret | Account id. Event subscriptions are account-scoped, so provisioning needs it to create a feedback subscription. | Optional |
| `FEEDBACK_QUEUE_ID` | var | Queue **id** (not name) that Email Sending feedback events are delivered to. Configured explicitly rather than looked up, so the provisioning token never needs to read the account's queues. Unset = provisioning skips the subscription step and reports it. | Optional |
| `TRANSACTIONAL_API_KEY_PEPPER` | secret | HMAC-SHA256 pepper for transactional API key hashing. Without it, transactional key operations and the `/v1/.../transactional/...` send/status endpoints fail closed (`503`). Rotation invalidates every existing transactional key. | **Required** to enable the transactional API |
| `PHASE0_DEBUG_TOKEN` | secret | Gates `/api/debug/phase0/*` introspection endpoints. Unset = endpoints unreachable. | Optional |
| `MAIL_FROM_ADDRESS` | var (`wrangler.jsonc` → `vars`) | Default outbound sender; must be verified on a domain onboarded to Email Sending. | **Required** |
| `MAIL_SENDING_DOMAINS` | var | Comma-separated domains verified in Email Sending. A mailbox on a listed domain replies as itself; otherwise the reply goes out as `MAIL_FROM_ADDRESS` with `Reply-To` set to the mailbox. | Optional |
| `TELEGRAM_BOT_TOKEN` | secret | Enables the Telegram bridge. Unset = `/telegram/webhook` answers 404 and no notifications are sent. | Optional |
| `TELEGRAM_ALLOWED_USER_IDS` | var | Bootstrap only, unioned with the Telegram identities in `owner_identities`. The normal path is pairing: while no operator is linked the hourly cron mints a single-use code, you read it from D1 and send `/start <code>`. The bridge no longer refuses to start without this — it could not, since answering `/start` is how anyone gets linked. | Optional |

### Bindings (`wrangler.jsonc`)

| Binding | Type | Resource (maintainer dev example) | Purpose |
| --- | --- | --- | --- |
| `MAILBOX_DO` | Durable Object, class `MailboxDurableObject`, SQLite storage | n/a (per-mailbox instances) | Canonical mailbox state: messages, threads, FTS, drafts, outbox, idempotency, realtime sessions. |
| `MAIL_OBJECTS` | R2 bucket | `inbox-mcp-raw-dev-eu` (jurisdiction `eu`) | Raw inbound MIME, parsed HTML bodies, attachments, backup manifests. |
| `INBOUND_EMAIL_QUEUE` | Queue producer + consumer | `inbox-mcp-inbound-dev` (DLQ: `inbox-mcp-inbound-dlq-dev`) | Metadata-only inbound transport; `max_batch_size: 5`, `max_batch_timeout: 2`, `max_retries: 3`. |
| `EMAIL_EVENTS_QUEUE` | Queue producer + consumer | `inbox-mcp-email-events-dev` (DLQ: `inbox-mcp-email-events-dlq-dev`) | Cloudflare Email Sending lifecycle events (delivered/deferred/bounced/complained); `max_batch_size: 10`, `max_batch_timeout: 2`, `max_retries: 3`. |
| `NOTIFY_QUEUE` | Queue producer + consumer | `inbox-mcp-notify-dev` (DLQ: `inbox-mcp-notify-dlq-dev`) | Telegram push cards, off the ingest ack path so a Telegram outage never blocks or retries ingest; `max_batch_size: 5`, `max_batch_timeout: 1`, `max_retries: 5`. |
| `INDEX_DB` | D1 database | `inbox-mcp-index-dev-eu` (jurisdiction `eu`) | Cross-mailbox/control-plane index (see data model below). |
| `EMAIL` | Email Sending (`send_email`) | n/a | Outbound `env.EMAIL.send()`, only after `confirm-send` (UI/Telegram/MCP) or a validated transactional API-key send. |
| `triggers.crons` | Cron Trigger | `0 * * * *` (hourly, maintainer dev) | Backup sweep + stale `outbound_sends` and transactional-request reconciliation + expired Telegram action sweep + Telegram webhook reconciliation (re-registers the webhook when Telegram's registered URL has drifted from this deployment's origin). |

Replace maintainer example names with your own. The verifier and migration commands are now
parameterized; self-hosters should pass their resource names by env vars/CLI args rather than
editing the repository.

## Provisioning a sending domain

`POST /api/domains/:domain/provision` (and the **Domains** page over it) runs the whole
sequence: register the zone, enable Email Sending, publish the DMARC policy, enable
inbound routing, subscribe to delivery feedback, create the mailbox.

**Every step is idempotent.** Re-running is the normal way to finish a domain that
stopped part way, not a recovery procedure. A blocked step never aborts the steps that
do not depend on it, and the response lists a per-step outcome — `already`, `done`,
`skipped`, `blocked`, `failed` — rather than a boolean. It answers `200` even when steps
are blocked: the request was handled, and which step is stuck is the useful part.

Two orderings are load-bearing:

- **Registration first.** The DNS gate resolves the zone from the `domains` table and
  refuses a domain nobody registered. Registration is the act that grants Reccado
  authority over a zone.
- **DMARC after Email Sending.** Enabling sending is what makes Cloudflare provision
  DKIM, SPF, MX *and its own `p=reject` DMARC record*. The ramp replaces that record, so
  running it first would have the provider overwrite it moments later.

### Token permissions

| Permission | Scope | What it buys | Without it |
| --- | --- | --- | --- |
| Zone · Zone · Read | the zones you serve | Resolving a zone id by name | `register_domain` blocked |
| Zone · Email Sending · Edit | the zones you serve | Enabling the sending subdomain | `email_sending` blocked, `dmarc` and feedback skipped |
| Zone · DNS · Edit | the zones you serve | Publishing the DMARC ramp record | `dmarc` blocked |
| Zone · Email Routing · Edit | the zones you serve | Inbound routing | `email_routing` blocked |
| Account · Event Subscriptions | account | The feedback subscription | `feedback_subscription` blocked |

**Scope the token to the zones Reccado serves, not to all zones.** Only the last row is
account-scoped; it is the one permission that cannot be bounded by zone. If you would
rather not grant it, leave it off — that step reports `blocked` with its remedy and the
rest of the run still completes. Do **not** substitute Queues · Edit: it can delete the
inbound mail queue, and provisioning never needs it.

### Why DNS write is safe enough to grant

Cloudflare has no record-level token scope, so a token that can publish a DMARC record
can also rewrite the apex, the MX records, and any TXT record a third party uses for
account recovery on the same zone. The attenuation is therefore in code, in
`src/lib/dns-gate.ts`: it is the only place in `src/` that may write DNS, it takes an
intent rather than a record, it composes the record name itself, and it resolves the
zone from the registry instead of accepting one from its caller. A source-level guard
fails the build if anything else addresses the DNS API.

That bounds what Reccado's own code can do — a new endpoint, a bug, a hurried refactor.
It does **not** bound an attacker who has read the Worker's environment; they hold the
token and the gate is irrelevant to them. Scoping the token to your zones is the control
for that, and it is a separate one.

## Data residency

Message content at rest is confined to the EU. Three stores hold it and all three are pinned:

| Store | How it is pinned | Verifiable locally? |
| --- | --- | --- |
| Mailbox Durable Objects | `jurisdiction("eu")` on every resolution, via `mailboxStub()` | **No** |
| `INDEX_DB` (D1) | Database created with `--jurisdiction eu`; fixed at creation | Yes (`wrangler d1 list` shows the jurisdiction) |
| `MAIL_OBJECTS` (R2) | Bucket created with `--jurisdiction eu`; declared on the binding | Yes |

Two things an operator should know rather than discover.

**The Durable Object guarantee cannot be tested outside a deployed Worker.** `jurisdiction()` is not
implemented in workerd, so it throws in `pnpm dev` and in `vitest`. That is why the jurisdiction is
a declared variable rather than a constant: `MAILBOX_JURISDICTION` is `eu` in `wrangler.jsonc` for
deployed environments and `none` in `.dev.vars` locally. Any other value, **including unset**,
throws rather than falling back — a missing declaration is a loud failure on the first request
instead of a quiet one that serves unpinned data indefinitely. `tests/unit/mailbox-stub.test.ts`
asserts the committed config still declares `eu` for every deployable environment, because with
this contract a dropped variable is a total outage.

**Jurisdiction changes Durable Object id derivation.** Code that calls `MAILBOX_DO.getByName()`
directly resolves to a *different, empty* Durable Object — it does not throw and it does not warn,
it presents as a mailbox that lost its mail. Every resolution therefore goes through
`mailboxStub()` in `src/lib/mailbox-stub.ts`, and the same test fails if a raw `getByName`, `get()`
or `idFromName()` reappears anywhere under `src/`. If you are moving a mailbox between
jurisdictions, note that the old Durable Object is not deleted, only unreferenced.

## Transactional API (current state)

The transactional API is implemented on top of the Tier A mailbox core. It is an
explicit, operator-created pre-authorization exception to the normal human-confirmed send path;
the UI, Telegram, and MCP surfaces still require `request-send` → `confirm-send`.

### Surface

- `POST /v1/mailboxes/:mailboxId/transactional/messages` — send; body
  `{ "template": "<id>", "to": "<addr>", "variables": {...} }`; requires `Authorization: Bearer
  <api-key>` and `Idempotency-Key` (mandatory).
- `GET /v1/mailboxes/:mailboxId/transactional/messages/:requestId` — request status; key must carry
  `transactional:status`.
- `/api/mailboxes/:mailboxId/transactional/api-keys` (create/list) and
  `.../api-keys/:keyId/revoke`, `.../rotate` — session-protected with an explicit mailbox-ownership
  check (D1 `mailboxes.owner_email`).
- `/api/mailboxes/:mailboxId/transactional/templates` (create/list) and
  `.../templates/:templateId/archive` — per-mailbox templates (revised in place under the same id
  via `PUT .../templates/:templateId`, not versioned); session-protected with ownership check.
- `PUT /api/mailboxes/:mailboxId/transactional/templates` — idempotent sync of a caller-owned
  list. Body `{ "templates": [{ "id", "subject", "body_text"?, "body_html"? }], "archiveMissing"?:
  false }` (max 100, unique ids); answers `200 { ok, results: [{ id, outcome, reason? }], summary }`
  with `outcome` ∈ `created|updated|unchanged|archived`. An omitted body part counts as `null`
  (the list is the full desired state). An archived id is reported (`reason: already_archived`)
  and never revived; `archiveMissing: true` archives active templates not listed (`reason:
  missing_from_sync`). The batch is validated before any write and applied in one DO transaction;
  a bad entry answers `400 { error, index, id }` and changes nothing. Session + D1 owner gated.
- Key creation accepts an optional `senderName` (the From display phrase, same validation as the
  PATCH route) and validates `recipientPolicy`: comma-separated `@domain.tld`, exact address, or
  `*` pattern with one `@`, each optionally `!`-prefixed to deny; a malformed rule is a `400`.

### Key format and auth

**A key belongs to exactly one mailbox, so the `:mailboxId` in the path is derivable rather than a
selector.** It is kept because the route names the resource it acts on, not because a key can
address more than one mailbox. When path and key disagree the request fails closed with `403
invalid_api_key` — not `key_does_not_belong_to_mailbox`, which is the obvious answer and the wrong
one: keys live in the owning mailbox's own Durable Object storage, so from another mailbox's DO the
key simply does not exist. The explicit binding check is defence in depth behind that and is
unreachable in normal operation. A caller may fold the mailbox id into its configured endpoint URL
rather than carrying it as a separate setting.

Keys are `rck_<env>_<key-id>_<secret>` (`env` ∈ `test|live`); the plaintext secret (256-bit) is
shown once at creation. Only the keyed hash
`HMAC-SHA256(TRANSACTIONAL_API_KEY_PEPPER, keyId + ":" + secret)` is stored in the mailbox DO;
keys carry scopes, a template allowlist (null/empty = nothing sendable), a recipient policy,
optional daily quota, and optional expiry. All auth decisions are DO-authoritative — D1 is never
consulted for authorization, quota, or idempotency.

**Handing a key to a product team:** deliver the plaintext out of band (a password-manager entry),
together with the host, the mailbox id, the key's sender/display name, template allowlist,
recipient policy and quota, and point them at [`INTEGRATING.md`](INTEGRATING.md), the
integrator's contract (endpoint, idempotency, every response code, templates, suppressions).

### Guarantees and current limits

- Same `(key, Idempotency-Key)` + same payload → original result; different payload → `409`.
  The request row is inserted (and quota charged) at `pending` before the provider call.
- Test keys (`environment=test`) are rejected in the production send path with
  `test_key_not_allowed_in_production_send`. Test keys work for create/list/revoke/rotate only;
  there is no simulated/test delivery sink.
- Provider outcomes: `sent`, `permanent_failure` (definitely not delivered), `unknown`
  (ambiguous — never auto-retried), `accepted` (pending), `rejected`, `idempotency_conflict`.
  A replay returns the original outcome. Raw provider error messages are never stored.
- An `unknown` is no longer a dead end. Cloudflare mints the message id itself and rejects a
  sender-supplied `Message-ID` header, so a send that throws never learns the id of a message
  that may well have gone out, and its lifecycle events arrive unattributable. When an event's
  `provider_message_id` matches nothing, the mailbox DO looks for the **one** request that is
  `unknown`, has no provider id, matches the event's sender and recipient, and was created
  within seven days before the event. Exactly one candidate resolves it; zero or more than one
  refuses and the event rides its retries out to the DLQ for a human. The candidate set is small
  by construction — every send that returned normally recorded its id and resolves on the primary
  path — so this is narrower than it first sounds, but it is inference, not a provider
  acknowledgement, and the row records which it was.
- What a terminal event proves: `delivered`, `bounced` and `complained` all require that the
  message was transmitted, so they settle an `unknown` to `sent` and let `delivery_status` carry
  the bad news separately; `rejected` and `failed` mean the provider never handed it on, so they
  settle it to `permanent_failure`. A `deferred` event settles nothing but does claim the
  provider id, so the eventual terminal event needs no correlation at all. A resolved request
  carries `resolvedVia: "envelope_correlation"` on its status response and in the D1 projection —
  treat an inferred `sent` as weaker evidence than one the provider acknowledged at send time.
- **Resolving is not retrying.** Nothing in this path sends anything; it reads an event
  describing what already happened. The rule that an `unknown` is never automatically re-sent is
  unchanged. A replay with the original `Idempotency-Key` now returns the resolved outcome
  instead of the stored `unknown`, and still does not contact the provider.
- D1 routes these events to a mailbox but never decides them: the DO repeats the candidate search
  against its own rows and answers `409` if the projection named a different request or if it
  sees a tie the projection did not.
- HTTP status carries the outcome without the body: `200` (`sent`), `202` (`accepted`),
  `502` (`permanent_failure`), `504` (`unknown`), `409` (`idempotency_conflict`), and `401`/`400`/
  `429`/`403` for rejections. Nothing undelivered answers 2xx — an integration that throws on
  non-2xx is correct by default rather than by remembering an exception.
- `variables_json` is nulled when a request reaches a terminal state (and by the stale reconciler
  for requests that never reported back). Transactional variables carry action-capable tokens, so
  the mailbox DO does not retain them past the send; `payload_hash` and status remain for
  idempotency. D1 projections never received them in the first place.
- D1 projections (`transactional_api_keys`, `transactional_request_log`) are rebuildable and
  redact the key hash, plaintext, request body, variables, payload hash, and idempotency key.
- Cloudflare Email Sending lifecycle events are consumed through the
  `inbox-mcp-email-events` Queue. Hard bounces and complaints create a mailbox-DO suppression;
  suppressed recipients are rejected before quota reservation or provider dispatch. Soft
  bounces and deferred events update delivery state without suppressing. Cloudflare's own
  account suppression list remains upstream authoritative; the DO list is the local
  application-enforcement mirror.
- Suppression lifetime follows the kind of thing the event was. A **hard bounce expires after 90
  days**: it is a fact about a mailbox at a moment in time, and mailboxes get recreated, domains
  change hands and typos get corrected, so a permanently poisoned address would be a silent denial
  of service on a recipient who is reachable again. A **complaint never expires**: it is a
  statement of intent by a person, and intent does not lapse on a timer — only an explicit,
  owner-authorized removal lifts it. Manual and provider-rejected entries are likewise permanent.
- Events for mail a person confirmed from a mailbox (request-send → confirm-send) are handled
  too. When no transactional request matches an event's `provider_message_id`, the consumer looks
  it up in D1 `outbound_sends` (trying the id as given, bare and angle-bracketed, since the
  provider result is stored verbatim) and routes the event to that mailbox's DO. The DO accepts it
  only if the id names one of its own outbound messages and the event's sender and recipient match
  that message (To, Cc or Bcc). It records the event in the same idempotent delivery-event ledger
  (`request_id` NULL), and a hard bounce or complaint adds the recipient to the suppression mirror
  and the D1 projection exactly as for a transactional send, because suppression is about the
  recipient, not the path. Mailbox sends have no delivery-status column or API field: the ledger
  keeps the event, and nothing reads a per-message delivery status today. An event that matches
  neither table still retries and then dead-letters.
- **Every sending domain needs its own Email Sending event subscription.** Enabling Email Sending
  gives a domain the ability to send; only a subscription gives it the ability to *report*. A
  domain without one emits no events for anything, so every send from it stays
  `delivery_status: null`, no `unknown` ever resolves, and no bounce or complaint ever reaches the
  suppression mirror — silently, and identically to a healthy domain whose events have not arrived
  yet. `pnpm setup:sending` creates-or-verifies it and refuses to exit 0 without one
  (`--skip-event-subscription` opts out explicitly).
- To create one by hand — wrangler ≥ 4.127.1 exposes `email.sending` as a source (earlier versions
  did not, which is why this step used to be dashboard-only):

  ```sh
  pnpm wrangler queues subscription create inbox-mcp-email-events \
    --source email.sending --zone-id <zone-id> --domain <sending-domain> \
    --events message.delivered,message.deferred,message.bounced,message.rejected,message.complained,message.failed
  ```

  Repeat per sending domain, and for the dev queue with the dev sending domain. The equivalent
  dashboard path is **Queues → `inbox-mcp-email-events` → Subscriptions → Subscribe to events →
  Email Sending**. `pnpm wrangler queues subscription list <queue> --json` shows what exists.
  **All six event types matter**: a subscription with only `message.delivered` selected passes a
  glance while suppression stays dark. The event queue has a configured DLQ; unresolved or invalid
  events are retried rather than silently acknowledged.
- Two independent checks watch this, on purpose. `pnpm doctor --env <env> --cloud` crosses two
  *live* provider lists — enabled sending domains × subscriptions on the events queue — and fails
  on a missing subscription, a missing event type, or a destination that is not this
  environment's queue. `GET /api/health` → `dependencies.sendingFeedback` answers the different
  question of whether events actually *arrive*, from our own send log and with no Cloudflare
  credential: it names any domain that has dispatched mail older than 24h and never been answered
  (`never_observed`), or that stopped being answered (`went_dark`). Only the second catches a
  subscription pointed at the other environment's queue, a broken consumer, or a provider fault.
  `unobserved` means not enough evidence yet, and is deliberately not a fault. The read is bounded
  to the last 30 days of provider-acknowledged sends, so a domain nobody has used in a month
  simply drops out rather than staying red on stale evidence.
- **A verified Email Routing destination address never produces delivery events.** When the
  recipient is an address verified as an Email Routing destination on the same account (your own
  inbox, typically), the `send_email` binding delivers through Email Routing, and Cloudflare emits
  no Email Sending lifecycle event for it. Account analytics show such sends only as Email Routing
  `newEmail`, never under Email Sending. The mail arrives and nothing is wrong: `delivery_status`
  stays null, and feedback liveness reads `unobserved` for a domain that has sent only to such
  addresses. Liveness cannot tell these sends from others, so after 24 hours they count as silent
  and can turn the domain `never_observed` (if they are all it has sent) or `went_dark` (if one is
  its latest mature send). Check the recipients before chasing the subscription.
  `pnpm smoke:transactional --wait-delivery` reads the account's destination addresses
  (`GET /accounts/{account_id}/email/routing/addresses`, with `CLOUDFLARE_API_TOKEN` scoped to
  Account · Email Routing Addresses · Read, and `CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami` for
  the account) and, when `--to` is a verified one, prints a WARN and skips the wait instead of
  failing. Without the token it says so and waits as before. To exercise delivery events, smoke
  against a recipient that is not a destination address on the account.
- `pnpm doctor --env <env> --cloud` also crosses `MAIL_SENDING_DOMAINS` — as the deploy will
  actually ship it (tracked `wrangler.jsonc` with `wrangler.generated.<env>.json` overlaid) —
  against the live Email Sending list: an entry that is not an enabled sending domain **fails**
  (a mailbox there sends as itself and Cloudflare refuses the From); an enabled domain subscribed
  to this environment's events queue but not declared **warns** (the account may host other apps;
  a mailbox there relays through `MAIL_FROM_ADDRESS`). It then resolves `_dmarc.<name>` over
  DNS-over-HTTPS for all of those names and warns on the provider's auto-created
  `v=DMARC1; p=reject;` (enforcing, no `rua`, chosen by nobody), on `p=quarantine`/`p=reject`
  without `rua`, and on zero or multiple DMARC records.
- A support mailbox on the zone apex that replies as itself needs Email Sending on the apex:
  `pnpm setup:sending --env <env> --domain <zone> --apex --dmarc-policy <none|quarantine|reject>
  --dmarc-rua dmarc@<zone> [--apply]`. The apex DMARC governs every sender on the domain, so the
  policy is mandatory there; see [`EMAIL-DELIVERABILITY.md`](EMAIL-DELIVERABILITY.md#sending-from-the-zone-apex).
- Owner-gated suppression administration is available at
  `/api/mailboxes/:mailboxId/suppressions` and
  `/api/mailboxes/:mailboxId/suppressions/remove`. Provider-originated
  hard-bounce/complaint entries require explicit override to remove.
- The `/v1/...` routes are the only path outside the session perimeter: JSON-only, 100 KB body cap,
  `Cache-Control: no-store`, no CORS, no cookies, no query-param credentials.

## Readiness before a deploy

Treat a deployment as ready only when all of these are true:

1. `pnpm run build`, `pnpm exec tsc --noEmit`, and `pnpm test -- --run` pass on the revision you
   intend to deploy.
2. D1 migrations for the target environment have been applied successfully.
3. `pnpm verify:cf` passes against the target environment's actual Worker/resource names, or you
   have manually run the equivalent checks with the same level of evidence.
4. An unauthenticated request to `/api/*` and `/mcp` returns `401`, not a `200` and not a redirect
   to anything. A redirect means a network-level perimeter is in front of the worker again, which
   also breaks the Telegram webhook.
5. An authenticated operator can reach `/api/health` and one mailbox read path.
6. For any change touching inbound/outbound mail, you have run the relevant smoke path
   (`pnpm smoke:email:local`, `pnpm smoke:ws`, or an authenticated dev/prod smoke) and captured the
   result.

Current limitation: there is no automated readiness endpoint that proves R2, Queue, D1, Email
Sending, and Access end-to-end in one call. Readiness is still an operator checklist plus evidence.

## Deployment and rollback

### Standard deploy

1. Apply D1 migrations for the target environment.
2. Deploy with the environment-specific command:
   - `pnpm run deploy:dev`
   - `pnpm run deploy`

   Both run `scripts/deploy.ts`: build, overlay `wrangler.generated.<env>.json` onto
   `dist/server/wrangler.json` (the generated file wins for vars, the D1 id, the sender
   allow-list and a `setup:domain` route; `wrangler.jsonc` wins for every binding and queue),
   print every value applied and every structural field ignored, re-read the file and refuse to
   deploy if it does not carry them, then `wrangler deploy --config dist/server/wrangler.json`.
   Add `--dry-run` to do all of that locally and stop at `wrangler deploy --dry-run`. Do not
   deploy with raw `wrangler deploy --env <env>`: it never reads the generated file.
3. Verify Access, `/api/health`, and at least one mailbox/API path.
4. Tail logs and Cloudflare dashboards for the first inbound message and the next cron window if
   the change touched ingest, indexing, or scheduled work.

### Rollback

Use rollback when the newly deployed revision breaks availability, auth, ingest, send, or causes
unexpected data mutation.

1. Stop further exposure:
   - if the issue is auth or data safety, disable the public route / tighten Access before anything
     else;
   - if the issue is inbound processing, consider disabling or redirecting the Email Routing rule
     only if continuing to accept traffic would be worse than delaying receipt.
2. Roll the Worker back to the last known-good deployment from Cloudflare:
   - dashboard: Workers & Pages → your Worker → Deployments → promote the last known-good version;
   - CLI alternative: use Wrangler's deployment rollback/promote flow for your account's current
     version of Wrangler if you already use it operationally.
3. Re-verify Access, `/api/health`, and one mailbox/API path on the rolled-back revision.
4. If the bad deploy included D1 schema changes, do not assume schema rollback is automatic:
   - additive/widening migrations are expected to be rollback-tolerant;
   - destructive/narrowing migrations need an explicit migration plan and backup/restore evidence
     before deploy.
5. Reindex affected mailboxes from the Durable Object if the failure left D1 inconsistent:
   - `POST /api/admin/reindex`
6. Review `ops_events`, Queue backlog/DLQ, and any `outbound_sends.status='sending'` rows after the
   rollback to find work left half-finished by the failed revision.

Current limitation: there is no one-command application rollback plus data repair workflow in this
repo. Worker rollback, route changes, and any D1 repair are still operator-driven.

## SLOs, metrics, and alerting expectations

This repo does not provision alerting resources for you. Self-hosters need to wire alerts in
Cloudflare dashboards or their own observability stack. The minimum expectations for a
production-like deployment are:

### Suggested SLO targets

| Area | Target | Notes |
| --- | --- | --- |
| API availability | 99.9% successful authenticated `/api/health` and mailbox reads over 30d | Access misconfiguration that bypasses auth is a severity-1 security failure even if availability looks good. |
| Inbound ingest durability | 0 dropped accepted messages | Duplicate delivery is acceptable; silent loss is not. |
| Inbound ingest latency | 99% indexed/visible within 5 minutes of Email Routing acceptance | During D1 incidents, the Durable Object may be current before the cross-mailbox D1 index catches up. |
| Outbound send safety | 0 sends without explicit confirmation; 0 duplicate sends for one idempotency key | Review stale `sending` reconciliations manually. |
| Scheduled backup sweep | 100% of expected hourly cron runs produce either backup evidence or an investigated failure | Backup manifests are not a full mailbox restore solution by themselves. |

### Minimum metrics to watch

- Worker request errors and latency.
- Queue backlog depth, consumer failures, retry count, and DLQ message count.
- D1 errors / failed queries during ingest, reindex, and admin operations.
- R2 put/get failures for raw MIME, attachments, and backup manifests.
- Access-protected route behavior for unauthenticated and authenticated health checks.
- Count of `ops_events` for parse failures, routing rejects/forwards, backup failures, and stale
  outbound-send reconciliation.

### Minimum alerts to wire

- Queue backlog above your normal envelope for more than one retry window.
- DLQ count greater than zero.
- Any unauthenticated `200` on a protected route.
- Hourly cron/backup sweep not observed within the expected window.
- Sustained D1 or R2 write failures.
- Any unexpected rise in `parse_status='failed'` or `outbound_sends.status='failed'`.

Current limitation: the product records useful events in D1, but does not ship pager rules,
email/webhook alerts, or Cloudflare Alert Policies.

## What lives where

### R2 (`MAIL_OBJECTS`) — blob storage

- Raw inbound MIME: `raw/{env}/{mailboxId}/{yyyy}/{mm}/{dd}/{receivedAtMs}-{rawSha256}.eml`
- Parsed HTML bodies too large for SQLite: `body/{env}/{mailboxId}/{messageLocalId}/html.html`
- Attachments: `attachments/{env}/{mailboxId}/{messageLocalId}/{attachmentSha256}-{safeFilename}`
- Backup manifests: `backups/{env}/{yyyy-mm-dd}/{mailboxId}.manifest.json`
- Sent message bodies: `sent/{draftId}`
- Future/export path reserved in the implementation docs: `exports/{env}/{mailboxId}/{yyyy-mm-dd}/{exportId}.ndjson`

### Mailbox Durable Object SQLite — source of truth

Tables (see `src/do/mailbox-schema-content.ts`): `schema_migrations`, `mailbox_meta`,
`ingest_events`, `threads`, `messages`, `message_headers`, `attachments`, `labels`,
`message_labels`, `contacts`, `rules`, `outbound_drafts`, `jobs`, `realtime_events`, plus the
`message_fts` FTS5 virtual table. Transactional state also lives here: `api_keys`, `api_key_events`,
`api_key_usage` (per-minute rate and daily quota counters), `templates`, and
`transactional_requests` (with the `(key_id, client_idempotency_key)` unique idempotency index and
`mailbox_meta` send markers).

### D1 (`INDEX_DB`) — rebuildable index and ops log

- Provisioning/routing catalog: `domains`, `mailboxes`, `aliases`, `routing_rules`
- Cross-mailbox message summary: `message_index`
- Ingest audit mirror: `ingest_events`
- Outbound send audit: `outbound_sends` (UI/Telegram/MCP confirm-send ledger)
- Transactional projections: `transactional_api_keys`, `transactional_request_log` (keys/requests;
  redacted; non-authoritative)
- Operational log: `ops_events`

If D1 and the Durable Object disagree, the Durable Object wins. Repair D1 with
`POST /api/admin/reindex`.

## Data lifecycle, retention, privacy, and current limitations

### What is retained today

- Raw inbound MIME is retained in R2 until an operator deletes it or an R2 lifecycle rule removes
  it.
- Attachments and oversized HTML bodies are retained in R2 on the same basis.
- Backup manifests written by cron or `POST /api/admin/backups/run` are retained in R2 until an
  operator or lifecycle rule deletes them.
- Mailbox metadata, message rows, search index entries, drafts, and send audit rows remain in the
  mailbox Durable Object / D1 until explicit deletion logic is implemented and exercised.

### What is not automated today

- No repo-managed R2 lifecycle policy is provisioned or enforced for raw MIME, attachments, sent
  bodies, or backup manifests.
- No full mailbox restore command exists.
- No user-facing export job exists, although the architecture and implementation docs reserve an
  export format/path.
- No end-user delete workflow guarantees removal of all raw MIME, attachment blobs, D1 rows, and
  backup artifacts for a mailbox.
- No documented trash-retention timer or legal-hold model exists.

### Operator policy you need to decide explicitly

Before claiming a production-ready deployment, set and document your own values for:

- raw MIME retention window;
- attachment retention window;
- backup-manifest retention window;
- whether sent bodies in R2 follow the same or a shorter retention period;
- who can perform mailbox export and deletion, and how those requests are audited.

Recommended current posture until full deletion/export tooling exists: keep retention conservative,
apply explicit R2 lifecycle rules in your Cloudflare account, and document that mailbox deletion or
privacy erasure is currently a manual operator procedure that must include DO state, D1 rows, and
all related R2 prefixes.

### Manual delete/export/restore reality

- **Export:** there is no supported full-fidelity mailbox export command today. `export-index`
  exists only as an internal Durable Object path used for reindex/backup manifests, not as a
  customer-ready archive/export feature.
- **Restore:** there is no automated restore path from R2 backup manifests back into Durable
  Objects. Backup manifests are operational evidence and partial recovery material, not a turnkey
  disaster-recovery workflow.
- **Delete:** mailbox erasure is manual. If you perform it, you must identify and remove the DO
  state plus the corresponding D1 rows and R2 prefixes, and you should capture evidence of exactly
  what was deleted.

## Failure modes and runbook

| Symptom | Cause | Response |
| --- | --- | --- |
| Queue backlog growing | Mailbox DO errors on ingest, or D1 index writes failing | Check Queue metrics, tail Worker logs, inspect recent `ops_events`, and determine whether data is blocked in the Queue or only the D1 index is behind. |
| DLQ non-empty | Poison messages or repeated transient failures | Follow the DLQ procedure below. Do not replay blindly. |
| R2 write failure inside `email()` | Transient R2 issue while writing raw MIME | The handler must not enqueue without a successful raw R2 write. Let Email Routing retry/reject rather than creating partial state. |
| D1 unavailable | D1 outage or quota exhaustion | The mailbox Durable Object remains authoritative. Restore D1 service, then reindex affected mailboxes. |
| Durable Object parse failure | MIME parser error on malformed/unusual message | Message row remains with `parse_status='failed'` and the raw R2 key preserved. Review the failure in `ops_events`. |
| Outbound send failure | Provider rejection, size/recipient-limit violation, or crash mid-send | Inspect `outbound_sends.status`, `error_code`, and provider response context. Retry only after deciding whether the same idempotency key still represents the same logical send. |
| `outbound_sends` row stuck at `status='sending'` | Crash/interruption mid-send | The hourly cron sweep marks stale sends `unknown` with `error_code='stale_sending_timeout_needs_review'` and an `outbound_send.stale_reconciled` ops event. Treat that as manual-review-required, not proof the message did or did not send. |
| Transactional request stuck at `pending` | Crash mid-send in the transactional path | The hourly cron and the Access-protected `POST /api/mailboxes/:mailboxId/transactional/reconcile-stale` both run `reconcileStaleTransactionalRequests`, marking rows `unknown` / `stale_reconciled`. Those rows are then eligible for delivery-event correlation like any other `unknown`. |
| Transactional send returns `unknown` | Provider outcome is ambiguous (may have accepted before erroring) | Never auto-retried. Wait before acting: if the message did leave, the delivery event resolves the row on its own and a replay with the original idempotency key returns the real outcome. A row that stays `unknown` means "most likely nothing was sent" **only if that sender domain's feedback channel is live** — on a domain with no event subscription no event ever arrives for anything, so the silence says nothing at all. Check `deliveryFeedback` on the status response (or `dependencies.sendingFeedback` in `/api/health`) first: `live` means the silence is evidence, `never_observed`/`went_dark` means it is not and the row needs the provider console, not an inference. |
| A send returns `sent` but `delivery_status` stays null forever | Either the event has not arrived yet, the sender's domain has no Email Sending event subscription and never will produce one, or the recipient is a verified Email Routing destination address on the account (delivered through Email Routing, which emits no event: expected, not a fault) | These are indistinguishable from the status row alone, which is why the response carries `deliveryFeedback`. `unobserved` = wait. `never_observed` = the channel, not the message: create the subscription (`pnpm setup:sending … --apply`, or the `queues subscription create` command above) and note that events are not backfilled — sends made while the domain was dark stay null forever. `went_dark` = it used to work; check the subscription's destination queue, that the events consumer is deployed, and the DLQ. |
| `email_events.correlation_ambiguous` or `email_events.correlation_rejected` ops event | Two ambiguous sends to the same recipient from the same sender inside the same window, or a stale D1 projection disagreeing with the DO | Deliberate refusal to guess. The event goes to the DLQ; decide by hand which request it belonged to using the DO rows and the provider console. Both requests stay `unknown` until then. |
| `transactional.unknown_resolved` ops event | An ambiguous send was settled from an observed delivery event | Informational. Check `resolvedVia` on the request: `envelope_correlation` means inferred, not provider-acknowledged. |
| Perimeter misconfiguration | A route reachable without the auth perimeter enforcing it | Treat as a security incident. Verify with an unauthenticated request: `/api/*` and `/mcp` must answer 401, never 200. The perimeter is in the worker now, so it is observable from outside — which is the reason it was moved there. |
| Telegram bot token set but no cards ever arrive | The bridge is configured but not yet delivering: no chat adopted (nobody sent `/start` from an allowlisted account) and/or the worker has not observed its public origin yet, so the hourly `reconcileTelegramWebhook` skips registration | `GET /api/health` → `dependencies.telegram` reports `mode: "partial"` and `missing` names exactly which of the two it is waiting for. Load the authenticated UI once on the real hostname (the origin is only recorded from a request that cleared the auth perimeter, and the landing page does not make one — open a mailbox), send `/start` from an allowlisted account, then let the next hourly cron register the webhook. |
| Telegram webhook receives nothing | Something in front of the worker is answering `/telegram/webhook` instead of the handler | `curl -si https://<host>/telegram/webhook` must return the handler's own 401, not a redirect. A redirect means a network-level perimeter was put back in front of the worker; Telegram cannot satisfy one, so every update dies at it. Confirm with `getWebhookInfo` — `last_error_message` shows what Telegram received. |
| `telegram.topic_unavailable` in `ops_events` | `createForumTopic` was refused for this chat | Usually the bot lacks `can_manage_topics` in the supergroup. The bridge already fell back to plain messages and replies still work by quoting the notification, so this is degradation, not breakage. Grant the permission, or leave it — a plain chat is a supported mode, not a misconfiguration. |
| `telegram.topic_recreated` in `ops_events` | The mailbox's topic was deleted in Telegram | Self-healing: the stale mapping was dropped, the topic recreated and the card re-sent once. Repeated rows for the same mailbox mean someone is deleting topics faster than mail arrives. |
| `telegram.notify_failed` in `ops_events` | Telegram API error or rate limit while pushing a card | The mail is already ingested and safe — only the notification was lost. Telegram allows roughly one message per second per chat; a burst of mail is the usual cause. |
| Need to rotate a secret | Routine hygiene or suspected leak | Rotate with `wrangler secret put`. Rotating `TELEGRAM_BOT_TOKEN` also rotates the derived webhook secret, so the hourly cron re-registers the webhook on its next run; rotating `TRANSACTIONAL_API_KEY_PEPPER` invalidates every existing transactional key. **`BETTER_AUTH_SECRET` is not in this class — see the row below before touching it.** Mailbox IDs are random rows in D1 and depend on no secret. |
| `/api/*` answers `503 auth_unavailable`, reason "Failed to decrypt private key" | `BETTER_AUTH_SECRET` was rotated, orphaning what it encrypts at rest | That secret encrypts the `jwt()` signing key in `jwks` and enrolled TOTP secrets in `twoFactor`, so a rotation breaks the whole web perimeter — and silently, since nothing fails until the next sign-in. Recover by deleting the orphaned rows so a fresh keypair is minted: `wrangler d1 execute <index-db> --remote --command "DELETE FROM jwks"`. Then re-enrol every authenticator: the old TOTP secrets are unrecoverable. `pnpm setup:auth` refuses to replace an existing secret for this reason; `--rotate-secret` is the deliberate override. |
| Local large-MIME smoke fails around 1 MiB | Local Email Routing tooling limit | Expected local behavior; use a smaller fixture for local smoke and do not infer a production 25 MiB failure from it. |

## Dead-letter queues

Every queue in this Worker has a dead-letter queue, and every dead-letter queue has a consumer:
`src/cloudflare/dlq-consumer.ts` writes one `ops_events` row per dead message
(`event_type='dlq.dead_letter'`, `severity='error'`, `subject` = the queue message id, payload
`{ queue, attempts, summary }`) and acks. Before that consumer existed a message that exhausted its
retries simply expired with the Queues retention window and left no trace anywhere an operator
would look. The tombstone is the trace.

The tombstone never stores the dead message's body. `summary` is an allow-list of identifiers per
known shape, because ops events describe events, not recipients or content:

| Body | `summary` keeps |
| --- | --- |
| Email Sending lifecycle event | `kind: "email_event"`, `event_type`, `event_id`, `provider_message_id`, `to_domain` (the recipient's domain, never the address), plus `schema_valid: false` when the event failed the schema |
| Inbound envelope (`email.received.v1`) | `kind: "inbound"`, `traceId`, `mailboxId`, `rawR2Key`, `rawSha256`, `rawSize`, `recipientDomain` |
| Notification / card refresh | `kind: "notify"`, `eventType`, `mailboxId`, `messageLocalId`, `threadId`, card `status` |
| Anything else | `kind: "unrecognized"`, the body's type and its top-level key names only |

Addresses, subjects, snippets, SMTP responses and bodies are never written. Any identifier
containing `@` is dropped. The content is still where it already lived: raw MIME in R2 (use
`rawR2Key`), the conversation in the mailbox DO (use `mailboxId` plus `threadId`), the event in the
provider console (use `provider_message_id`).

Two properties are deliberate:

- **No automatic redelivery.** A DLQ consumer that re-enqueues resurrects exactly the loop the DLQ
  exists to end. Replay is a human decision, made after the cause is fixed.
- **The DLQ consumers have no DLQ of their own.** If D1 is down the tombstone write is retried
  (never acked — a death cannot be recorded in a ledger that is down), and once the retries are
  spent the message is lost. That is the honest end of the chain; another hop would only move the
  silence further away.

Duplicate tombstones are possible: if an ack is lost after the insert lands, the message is
redelivered and the row is written twice. Harmless, and not worth a read per dead message to
prevent.

### What a dead message means, per queue

| Queue | A dead message means | Replay stance |
| --- | --- | --- |
| `inbox-mcp-inbound` (→ `-dlq`) | An accepted email whose raw MIME is in R2 but which is not indexed in the DO or D1: invisible mail. The most serious of the three. | Recoverable but manual. The raw object is intact and the message carries a stable idempotency key, so a re-ingest updates rather than duplicates — but there is no replay endpoint, so it is a deliberate operator action after the cause is fixed. |
| `inbox-mcp-email-events` (→ `-dlq`) | A lost Email Sending lifecycle event: a delivery/bounce/complaint that never updated `outbound_sends` or the DO suppression list. Local state now disagrees with the provider. | Do not replay stale events blindly — a bounce replayed out of order can suppress a recipient on obsolete information. Cloudflare's account suppression list is upstream authoritative; reconcile against the provider console instead. |
| `inbox-mcp-notify` (→ `-dlq`) | A Telegram card that never arrived. The mail itself is ingested and safe; only the push was lost. | Usually no replay: a late notification about mail already visible in the UI has little value. Fix the bridge (token, allowlist, chat adoption) and let the next message prove it. |

## Replay procedure

Current limitation first: there is no implemented `POST /api/admin/dlq/replay` endpoint. Replay is
still a manual Cloudflare operation plus an operator validation pass.

1. Inspect the symptom:
   - check Queue/DLQ counts in Cloudflare;
   - query `ops_events` for `event_type='dlq.dead_letter'` (via `GET /api/admin/ops-events`) — the
     rows carry the queue, attempt count and a metadata-only summary of every dead message;
   - inspect `GET /api/admin/dlq` and recent Worker logs.
2. Classify the failure:
   - poison/schema bug;
   - transient dependency failure (D1/R2/provider);
   - auth/config error;
   - malformed but acceptable email that should remain `parse_status='failed'`.
3. Fix the underlying cause before replaying anything.
4. Confirm replay safety, using the per-queue stance above:
   - verify the affected messages already have stable idempotency keys;
   - verify a successful replay would update existing records rather than create duplicate message
     rows.
5. Replay from the Cloudflare Queue/DLQ tooling you operate with today.
6. Validate the result:
   - the message becomes visible or the intended failure state is recorded;
   - no duplicate `messages` row was created;
   - `message_index` is correct, or you run `POST /api/admin/reindex`;
   - `ops_events` reflects the recovery.

If you cannot prove replay safety, do not replay. Keep the payload for investigation and treat the
issue as unresolved.

## Operator session from the terminal

`pnpm operator` gives an operator (or an agent acting for one) an authenticated `/api/*` session
without a browser, by automating the pairing-code rescue rung:

```bash
pnpm operator login  --env dev --host <custom-host> [--email <owner>] [--ttl 10] [--label <task>]
pnpm operator whoami --host <custom-host>
pnpm operator logout --host <custom-host>
```

What `login` does, in order:

1. Generates a 256-bit hex code (`crypto.randomBytes`) and inserts it into
   `owner_pairing_codes` with `wrangler d1 execute <INDEX_DB name> --remote [--config
   wrangler.generated.<env>.json] --env <env>` (`--local` for a `localhost` host). `issued_by` is
   `cli:<label>`, the label sanitized to `[A-Za-z0-9._:-]`. The insert is guarded by
   `EXISTS (owner_identities WHERE kind='email' AND identity=<email>)`, because the pairing
   endpoint links whatever email it is handed as an owner; `--allow-new-owner` drops the guard for
   a genuine bootstrap.
2. Spends it at `POST /api/auth/pairing` with `Origin: https://<host>`, keeps only the
   `(__Secure-)better-auth.session_token` cookie, and confirms it with `GET
   /api/auth/get-session` (email must match).
3. Writes `{ host, cookie, createdAt, label, email, expiresAt }` to
   `~/.config/reccado/sessions/<host>.json` (0600; dir 0700; `$XDG_CONFIG_HOME` honoured). A
   session file with any group/other bit, or a symlink, is refused.

If anything after the insert fails, the code is force-expired (`UPDATE ... SET expires_at = now
WHERE consumed_at IS NULL`) and any session already created is signed out. `logout` calls
`POST /api/auth/sign-out` and deletes the file regardless, reporting both outcomes.

Known tradeoff: the code is passed to the wrangler child as `--command=<sql>`, so it is briefly
visible in the local process table. It is single-use, lives minutes at most, and is spent or
expired by the same command; `--file` would avoid it but loses the affected-row count the owner
guard needs.

Scripts should import `scripts/lib/operator-session.ts`: `requireSession(host)` /
`loadSession(host)`, then `operatorFetch(session, "/api/...", init)` or `operatorJson(...)`, which
add the cookie, the `Origin` header the CSRF check requires, and a JSON content-type, and throw
`OperatorAuthError` (with the login command in its message) on a 401.

## Onboarding a product

`pnpm onboard` takes one product from "has a zone" to "has a support mailbox that receives and
replies as itself, templates, and stored API keys" from a single JSON manifest. It replaces the
hand-run sequence of `setup:sending` (twice, subdomain and apex), `MAIL_SENDING_DOMAINS`, Email
Routing rules, `POST /api/domains` / `mailboxes` / `aliases`, the template sync, key creation and
the 1Password item.

```bash
pnpm operator login --env dev --host <custom-host> --email <owner>
pnpm onboard --env dev --manifest ./onboard.json [--host <custom-host>]          # dry run
pnpm onboard --env dev --manifest ./onboard.json [--host <custom-host>] --apply  # perform
pnpm operator logout --host <custom-host>
```

The manifest (validated with zod before anything runs; relative paths resolve against the
manifest's directory; placeholder example in `examples/onboard/`):

```json
{
  "zone": "example.com",
  "zoneId": "<optional; else discovered>",
  "sending": { "subdomain": "send", "apex": true, "dmarc": { "policy": "none", "rua": "dmarc@example.com" } },
  "mailbox": { "address": "support@example.com", "displayName": "Example", "aliases": ["privacy@example.com"] },
  "templates": { "file": "./templates.json", "archiveMissing": false },
  "keys": [
    { "name": "preview", "sender": "hello@send.example.com", "senderName": "Example",
      "scopes": ["transactional:send", "transactional:templates:use", "transactional:status"],
      "templates": "all", "recipientPolicy": "me@example.org,@example.com", "quotaMax": 50,
      "store": { "onePassword": { "vault": "Private", "title": "Example Reccado API key (preview)" } } }
  ]
}
```

Rules checked up front: mailbox and aliases are on the zone; each key's `sender` is on a name
the manifest provisions (`send.<zone>`, or the apex when `apex` is true); `recipientPolicy`
passes `validateRecipientPolicy`; `templates: "all"` means every id in the templates file, an
explicit list must be ids from it; each key body is run through the create route's own schema.
`sending.subdomain: false` provisions the apex only. `dmarc.policy` is required, because the
apex has no safe default.

**Dry run by default.** Each step reads current state and reports `already`, `would do: <exact
action>` or `blocked: <reason>` plus a remedy. A dry run reads only: `wrangler` list/get
commands, public DNS over DoH (so no token is needed to verify SPF/DKIM/MX/DMARC), `GET`s on the
control plane, and `op item list` / `op item get --fields` for the `key id` and
`RECCADO_ENDPOINT` fields (never the credential). It writes nothing — no Cloudflare mutation, no
API write, no generated-config write, no 1Password write. `--apply` performs the missing steps and
reports `already | done | skipped | blocked | failed` (the vocabulary of `src/lib/provision.ts`);
a step that cannot run skips only its dependents. Exit status is non-zero when anything is
blocked, failed or skipped.

| Step | Checks | `--apply` does | Depends on |
| --- | --- | --- | --- |
| `sending:<name>` | Email Sending enabled; SPF, provider DKIM + MX and DMARC published exactly as `setup:sending` would leave them; all 6 lifecycle events reach the events queue | runs `pnpm setup:sending … --apply` (the one owner of those upserts), then re-verifies | — |
| `config:MAIL_SENDING_DOMAINS` | a deploy would ship every provisioned name | writes `wrangler.generated.<env>.json` through `scripts/lib/sending-config.ts` (same union / default-sender / allow-list rules as `setup:sending`) | `sending:*` |
| `deployed:MAIL_SENDING_DOMAINS` | the live version of the Worker carries them | nothing: **onboard never deploys**; blocked with the `deploy:dev --dry-run` command | `config` |
| `routing:enable` | Email Routing enabled and `ready` on the zone | `wrangler email routing enable` | — |
| `routing:<address>` | an enabled literal `to:<address>` → `worker:<env worker>` rule, for the mailbox and each alias | creates only missing rules; a rule with the same matcher and another action (or disabled) is **blocked, never overwritten**; the catch-all is never touched | `routing:enable` |
| `domain` | registered, active, and its `zone_id` matches the zone | `POST /api/domains` | — |
| `mailbox` | exists, active, owned by the signed-in owner, primary alias, display name | `POST /api/mailboxes` / `PATCH` display name | `domain` |
| `alias:<address>` | routes to this mailbox and is active | `POST /api/aliases` | `mailbox` |
| `templates` | the active templates equal the file | `PUT …/transactional/templates` (an id archived on the server is reported blocked, never revived) | `mailbox` |
| `key:<name>` | see below | mint + store, or fix `senderName` / the stored endpoint | `mailbox`, `templates`, the sender's `sending:` step |

**Keys are idempotent through the store.** Keys have no name server-side, so the 1Password item
is the idempotency key: an item (exact title, in the vault) whose `key id` is `active` on this
mailbox and whose fixed fields (sender, scopes, allowlist, policy, quota) match the manifest is
`already`. No item: `--apply` mints exactly one key, re-checking the vault immediately before, and
writes the item JSON to a 0600 file in a fresh 0700 temp dir for `op item create --template
<file> --vault <v>`, deleting it in `finally` (the secret never goes in argv; `op`'s stdin mode is
not used because `op` ignores a non-FIFO stdin and would create an empty item). The item is API_CREDENTIAL with `credential` (concealed), `RECCADO_ENDPOINT`, `key id` and notes.
If storing fails the new key is revoked on the spot. An item whose key is revoked or missing, an
item with no `key id`, two items with the same title, or a live key whose fixed fields differ from
the manifest are all `blocked` with the remedy (delete the item and re-run, or revoke and re-mint)
— a second key is never minted silently. A key with no `store` is refused: its plaintext is shown
once, and a key that cannot be stored is a lost key. The plaintext is never printed.

**Tokens.** `wrangler login` covers every read and the Routing/Sending/subscription writes. DNS
writes happen inside `setup:sending` and need `CLOUDFLARE_API_TOKEN` (Zone · DNS · Edit); a
sending step with anything DNS-shaped missing is `blocked` without it rather than enabling a
name whose provider-created `p=reject` DMARC nobody chose. The zone id for `POST /api/domains`
comes from the manifest, else from an existing `email.sending` event subscription in the zone,
else from the Cloudflare API with the token.

**After it runs.** The summary prints each step, the `RECCADO_ENDPOINT`
(`https://<host>/v1/mailboxes/<id>/transactional/messages`) and where each key is stored. When
the generated config changed (or the live Worker lacks a name), it says a deploy is required and
prints `pnpm run deploy:dev --dry-run` then `pnpm run deploy:dev`. The integrator-facing side —
what the product does with the key — is in [`docs/INTEGRATING.md`](INTEGRATING.md).

## Transactional smoke test

`pnpm smoke:transactional` exercises the transactional API on a deployed environment through the
same HTTP surface people use: the operator session (`pnpm operator login`) for `/api/*` key and
template admin, and a Bearer key for the integrator's `/v1/*` calls. It exists because the unit
and integration suites call the mailbox Durable Object directly and so could not see the create-
key 500, the missing From display name, or the wildcard policy bug.

```bash
pnpm operator login --env dev --host <custom-host>
pnpm smoke:transactional --env dev --host <custom-host> --mailbox <mbx_...> \
  --sender <address on a verified sending domain> --to <recipient> \
  [--sender-name "Reccado smoke"] [--send] [--wait-delivery <seconds>]
pnpm operator logout --host <custom-host>
```

Without `--send` it checks the session (`get-session`) and that the mailbox answers
`GET .../transactional/api-keys`, prints the plan, and exits; nothing is created or sent. With
`--send`, each step prints `PASS`/`FAIL`/`WARN` with its evidence:

1. `POST .../templates` a throwaway `smoke-<ms>` template (unique token in the subject, `{{token}}`
   in both bodies).
2. `POST .../api-keys` a LIVE key: scopes `send`, `templates:use`, `status`; allowlist = that
   template; `recipientPolicy` = exactly `--to`; `quotaMax` 5; `expiresAt` now + 1h. Asserts 201,
   a `plaintextKey` in the body, and that `GET .../api-keys` lists it active.
3. `PATCH .../api-keys/:keyId { senderName }`; asserts both the PATCH and a re-read report it.
4. `POST /v1/.../messages` to `--to`; asserts 200 `sent` with a `providerMessageId`.
5. The identical request with the same `Idempotency-Key`; asserts the same `requestId` and
   `providerMessageId` (a real second send always gets a fresh `requestId`).
6. Same key, new `Idempotency-Key`, `to` = `smoke-reject@example.invalid`; asserts 403
   `not_allowed_by_policy` with no request reserved.
7. `GET /v1/.../messages/:requestId`; prints `status`, `deliveryStatus` and `deliveryFeedback`.
   With `--wait-delivery N` it polls every 5 s for a terminal delivery event. `delivered` passes,
   `bounced`/`complained`/`rejected`/`failed` fail, and **no event is a `FAIL` only when
   `deliveryFeedback.state` is `live`**; otherwise it is a `WARN` naming the liveness state,
   because silence on a domain without a working feedback channel says nothing about the message.
8. Always, even after a failure: revoke the key and archive the template. If either fails it
   prints the ids and `curl` commands (reading the cookie from the session file) to finish by hand.

It exits non-zero if any step failed. The plaintext key lives only in memory and is redacted from
every error. What it cannot check: the From display name and SPF/DKIM/DMARC are only visible in
the delivered message, so it ends with the `providerMessageId` and a reminder to confirm those in
the recipient's mailbox. Each `--send` run sends exactly one real message and leaves a revoked key
and an archived template in the mailbox's history.

## Admin/ops endpoints

All require an authenticated, authorized Access identity:

- `GET /api/admin/ops-events` — recent operational events (rejections, forwards, conflicts,
  backups, reindexes, stale-send reconciliations, transactional request outcomes).
- `GET /api/admin/dlq` — recent ingest failures recorded in D1. This is not a direct Cloudflare
  DLQ browser.
- `POST /api/admin/reindex` — rebuild a mailbox's `message_index` rows in D1 from Durable Object
  state.
- `POST /api/admin/backups/run` — trigger the same backup-manifest export path used by the hourly
  cron sweep.

Transactional key management (create/list/revoke/rotate) and template CRUD are
`/api/mailboxes/:mailboxId/transactional/*` routes behind the same Access perimeter plus a
`mailboxes.owner_email` ownership check; the external send/status endpoints are
`/v1/mailboxes/:mailboxId/transactional/*` and use API-key auth instead.

## Evidence expectations for ops changes

When you change deployment, alerting, retention, auth, routing, DLQ handling, or backup behavior,
record at least:

- exact commands run;
- Worker name / URL / route tested;
- D1/R2/Queue/DLQ resource names and IDs touched;
- authenticated and unauthenticated health-check results;
- any mailbox IDs or test addresses used;
- queue backlog/DLQ before and after, if relevant;
- reindex/backup event evidence from `ops_events`, if relevant;
- explicit `PASS` or `FAIL`, with blockers called out exactly.
