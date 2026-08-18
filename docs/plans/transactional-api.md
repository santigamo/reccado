# Transactional Email API

## Goal

Allow an external application to send transactional email through Reccado using a
pre-authorized API key, without weakening the human-confirmation boundary for the UI,
Telegram, MCP, or agents.

## Decisions

- API-key sending is an explicit, human-created pre-authorization exception.
- API keys are never exposed as MCP capabilities and are not available to agents through
  existing MCP tools.
- The first version is template-only, mailbox-bound, sender-bound, one-recipient, and has
  no CC, BCC, arbitrary headers, or attachments.
- `Idempotency-Key` is mandatory for every transactional request.
- The mailbox Durable Object is authoritative for key authorization, policy, quotas,
  idempotency, and canonical outbound state. D1 is a rebuildable projection and audit index.
- API keys use a bearer header, are shown only once, and are stored as a keyed hash with a
  Worker secret; plaintext keys never enter logs or persistent storage.
- The proposed key format is `rck_test_<key-id>_<random-secret>` or
  `rck_live_<key-id>_<random-secret>`, with a versioned HMAC pepper so rotation does not
  require storing plaintext secrets.
- Initial scopes are separate rather than a generic `send`: `transactional:send`,
  `transactional:status`, and, if needed, `transactional:templates:use`.
- Administrative key creation, rotation, and revocation remain behind Cloudflare Access.
- The transactional endpoint must use the shared outbound engine and must never call
  `EMAIL.send()` from a second path.
- A provider error with an uncertain delivery outcome is `unknown`, not `failed`, and must
  not be retried automatically with the same or a newly generated key.
- The system cannot reliably distinguish an application from a script or agent holding the
  key; possession of the pre-authorized credential is therefore the security boundary.
- The initial API accepts JSON only, does not use cookies or CORS by default, never accepts
  credentials in query parameters, and does not permit caller-controlled SMTP headers.

## Phase 1 — outbound hardening prerequisite

Before adding API-key routes:

1. Use one idempotency namespace consistently in D1 and the Durable Object.
2. Prevent two concurrent confirmations with different attempt keys from sending one draft
   twice; the Durable Object must provide an atomic per-draft send gate.
3. Classify outbound failures into stable categories, including `unknown_send_outcome`.
4. Preserve the sending reservation for ambiguous provider failures and make reconciliation
   require an explicit decision.
5. Record outbound provenance and approval mode (`human_confirmed`, `telegram_confirmed`, or
   future `preauthorized_transactional`), including the confirming actor, while
   keeping the current human-confirmed web and Telegram flows intact.
6. Verify that MCP exposes no send or cancel operation and cannot reach the send path.

## Phase 2 — credentials and policy

Add mailbox-owned Durable Object state for:

- key identifier, keyed secret hash, hash version, display suffix, status, timestamps;
- mailbox and exact sender binding;
- scopes, template allowlist, recipient policy, quotas, and expiry;
- transactional request records containing payload hash, idempotency key, state,
  provider identifier, and provenance.

Add Access-protected administrative routes for create, list, revoke, and rotate. Add only
rebuildable D1 projections and audit records. The next D1 migration must follow the current
local `0004_telegram.sql` migration and therefore use `0005_*`.

The key secret is never accepted from or returned to D1. Key operations must be mailbox-owned
DO operations; D1 stores only searchable metadata and audit projections such as key ID,
mailbox, status, timestamps, and usage counters.

## Phase 3 — restricted transactional endpoint

Proposed endpoint:

```text
POST /v1/mailboxes/:mailboxId/transactional/messages
Authorization: Bearer <api-key>
Idempotency-Key: <client-generated-key>
```

Initial request shape:

```json
{
  "template": "welcome",
  "to": "user@example.com",
  "variables": {}
}
```

The request must authenticate the key, enforce its mailbox/sender/policy binding, reserve
idempotency and quota atomically in the DO, send through the shared engine, and return a
stable request/status representation. Same key plus the same payload returns the original
result; same key plus a different payload returns `409 idempotency_conflict`.

The endpoint must not rely on Cloudflare Access for caller authentication. If Access is
bypassed, the bypass must be limited to this exact transactional path or a separate API
hostname; UI, `/api/*`, administration, and `/mcp` remain protected.

The first response contract should distinguish accepted/sent, duplicate, policy denial,
idempotency conflict, permanent failure, transient failure, and unknown outcome. Provider
exactly-once delivery cannot be claimed unless the provider supplies a compatible idempotency
or reconciliation mechanism; Reccado must expose this limitation rather than hiding it behind
automatic retries.

## Phase 4 — operational hardening

Add per-key and per-mailbox rate limits in the DO, revocation and rotation tests, alerts for
abuse and unknown outcomes, stale-send reconciliation, and explicit handling for bounces,
complaints, and suppression lists before increasing volume or allowing arbitrary content.

## Acceptance criteria

- Concurrent requests with different idempotency keys cannot deliver one draft twice.
- Same idempotency key and payload produces one effective provider send.
- Same idempotency key with a different payload returns `409`.
- Permanent, transient, and unknown provider outcomes are distinguishable and documented.
- Unknown outcomes are not automatically retried.
- Every successful outbound record has provenance and approval mode.
- Revoked or expired keys fail immediately.
- A key cannot address another mailbox or override its sender policy.
- Quotas remain correct under concurrency.
- MCP runtime tools contain no send or cancel capability.
- Authorization headers, plaintext keys, and message bodies are absent from logs.
- D1 outages cannot change the DO's canonical authorization or idempotency decision.
- Access bypass, if required, covers only the transactional endpoint and never administration,
  UI, `/api/*`, or `/mcp`.
- A single effective provider delivery is demonstrated, not merely duplicate HTTP responses.
- Tests, typecheck, build, lint, and diff checks pass without touching production resources.

## Current implementation gate

Do not implement API-key routes until Phase 1 is complete and independently reviewed.
The existing Telegram/threading work is committed separately in `34132ed`; the unrelated
deletion of `untitled.md` remains outside that commit.
