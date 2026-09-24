# Integrating a product with Reccado's transactional API

This guide is for the engineer whose product **sends** mail through a Reccado deployment:
verification links, password resets, receipts, invitations. It is a reference for the
contract as the code implements it. It is not the operator's runbook. Setting up domains, keys
and pepper secrets is in [`OPERATIONS.md`](OPERATIONS.md#transactional-api-current-state).

Source references (`file:line`) point at the implementation, so when this page and the code
disagree, the code wins. Please report the mismatch.

## 1. Who owns what

| The operator provisions and owns | You own |
| --- | --- |
| The Reccado deployment and its host (`https://<host>`) | The code that calls `/v1/...` |
| The **mailbox** (`mbx_...`), which is where replies land. Mailboxes live on the zone, e.g. `hola@example.com` | Choosing *when* to send and to *whom* |
| The **sending identity** bound to your key: an address on the sending subdomain, e.g. `hola@send.example.com`, plus an optional display name (`Transcribo <hola@send.example.com>`) | Your idempotency keys and retry logic |
| The **API keys**, created once and handed to you out of band (a password manager entry, for example). The plaintext is shown exactly once at creation | Storing the key as a secret. Never ship it to a browser |
| Template storage, the recipient policy, quota and expiry on each key | Template **content**, if you keep it in your repo and have it synced (§6) |
| Suppression list administration (§8) | Reacting to `recipient_suppressed` in your UX |

A mailbox cannot live on the sending subdomain. Provisioning enables Email Routing for the
**zone** (`src/lib/provision.ts:305-314`). The sending subdomain only gets Email Sending
records, and its bounce MX sits on `cf-bounce.send.<zone>` (`scripts/lib/sending-plan.ts:16,82`).
So nothing routes inbound mail for `hola@send.example.com` to a mailbox. Use the zone address
for replies and the `send.` address as the From.

The key's sender is an exact address, fixed when the key is created (`src/api/schemas.ts:218`).
The address is not checked against the verified sending domains when the key is created. A key
bound to an address Cloudflare will not send from fails at send time (§4, "provider refused").

## 2. One endpoint per mailbox

```text
POST https://<host>/v1/mailboxes/<mailboxId>/transactional/messages
GET  https://<host>/v1/mailboxes/<mailboxId>/transactional/messages/<requestId>
```

Both are defined in `src/server.ts:209-282`. They are the only routes outside the operator's
session perimeter, and the Bearer key is the only authentication.

- **Preview and production use the same URL with different keys.** Nothing in the URL selects an
  environment. Each key is bound to one mailbox and one sender, and carries its own template
  allowlist, recipient policy and quota. A "preview" key is simply a narrower live key, for
  example one limited to `@yourcompany.com` with a small daily quota.
- **`rck_test_` keys cannot send.** A send with a test key answers
  `403 {"status":"rejected","error":"test_key_not_allowed_in_production_send"}`
  (`src/do/transactional-send-ops.ts:119-127`). No simulated delivery sink exists. So preview
  environments that need to send real mail need an `rck_live_` key with a restrictive policy.
- A key only exists inside the mailbox that owns it. Calling another mailbox's URL with it
  answers `403 invalid_api_key` (`docs/OPERATIONS.md` "Key format and auth"). You can fold the
  mailbox id into a single configured endpoint URL.
- Transport rules: POST needs `Content-Type: application/json` (otherwise `415`). The body is
  capped at 100 000 bytes (otherwise `413`). Responses carry `Cache-Control: no-store`. CORS,
  cookies and credentials in the query string are not supported.

## 3. The send request

```http
POST /v1/mailboxes/mbx_.../transactional/messages
Authorization: Bearer rck_live_<32-hex-keyId>_<secret>
Idempotency-Key: signup-verify:user_8412:v1
Content-Type: application/json

{"template":"verify-email","to":"ada@example.org","variables":{"name":"Ada","link":"https://..."}}
```

**Headers**

- `Authorization: Bearer <key>`. The key format is `rck_<test|live>_<keyId>_<secret>`
  (`src/lib/transactional-keys.ts:186-210`).
- `Idempotency-Key` is **mandatory**. It is trimmed and must be 1–255 characters, with no charset
  restriction. A missing or empty key answers `400 idempotency_key_required`. A key over 255
  characters answers `403 idempotency_key_too_long` (`transactional-send-ops.ts:139-156`).
  Derive the key from the business event (`<purpose>:<entity>:<version>`), never from a random
  value generated per attempt.

**Body** (`src/lib/transactional-send.ts:4-23`)

| Field | Rule |
| --- | --- |
| `template` | string, 1–120 characters, must be on the key's allowlist and active in the mailbox |
| `to` | one email address. There is no CC, BCC, list, attachment or custom header |
| `variables` | optional object of **string → string**. At most 50 entries, each value at most 10 000 characters. Numbers and booleans are rejected, so stringify them first |

A body that fails the schema answers `403 invalid_request_body`. A body that is not JSON answers
`400 {"error":"invalid_json"}`.

**Idempotency** (`transactional-send-ops.ts:224-255`, `transactional-send.ts:338-352`)

- Idempotency is scoped to **(key id, Idempotency-Key)**. The payload hash covers `template`,
  `to` and `variables`. The code shows no expiry on this record.
- **Same key and same payload** replays the stored outcome with the original `requestId`, and
  Reccado does not contact the provider again. A replay answers with the original status, not
  `duplicate`. A replay of a request that is still in flight answers `202 accepted`.
- **Same key and a different payload** answers `409 idempotency_conflict` with error
  `idempotency_key_already_used_with_different_payload` and the original `requestId`.
- Two things the hash does that you might not expect:
  - The hash is taken over `JSON.stringify(variables)`, so **key order matters**. Retrying
    with `{b, a}` after `{a, b}` is a `409`. Retry with the exact bytes you first sent.
  - The whole canonical string is lower-cased before hashing. Two payloads that differ only in
    letter case count as the *same* payload and replay the first result. Don't reuse an
    idempotency key for a different message.
- A replay still has to pass the gates that run before the idempotency lookup (§4): auth,
  scope, template allowlist, template active, variables, recipient policy and suppression. For
  example, a replay after the template was archived answers `template_not_found`, not the
  original result.
- Rejections reserve nothing and charge no quota. After fixing the cause, you can retry a
  rejected request with the same idempotency key.

## 4. Responses

Every JSON response from the send route has this shape (`transactional-send.ts:38-44`):

```json
{ "status": "sent|accepted|rejected|idempotency_conflict|permanent_failure|unknown",
  "requestId": "…", "keyId": "…", "providerMessageId": "…", "error": "…" }
```

A rejection carries `requestId: ""`. The HTTP status is derived from `status` and `error` by
`httpStatusForTransactionalResult` (`transactional-send.ts:70-100`).

> **Branch on `error`, not on `status` alone.** Every refusal has `status: "rejected"`, and
> the reason is only in `error`. One integration checked `body.status === "recipient_suppressed"`.
> Reccado answers `403 {"status":"rejected","error":"recipient_suppressed"}`, so that check
> never matched. A suppressed recipient then fell through to the generic 403 branch and was
> reported as a broken configuration. Match on `error`, and treat unknown `error` values as
> "rejected, do not retry".

| HTTP | `status` / `error` | Meaning | What you do |
| --- | --- | --- | --- |
| 200 | `sent` | The provider accepted the message. This is not proof of delivery (see §5) | Store `requestId` and `providerMessageId` |
| 202 | `accepted` | A replay of a request that is still in flight | Poll status, or replay the same key later |
| 504 | `unknown` / `ambiguous` | The provider call failed ambiguously, so the mail may or may not have gone out | **Never resend with a new key.** Replaying the same key is safe and returns the current outcome, which a delivery event can later settle to `sent`/`permanent_failure`. Show the user "sending", poll status, and escalate to the operator if it stays `unknown` |
| 502 | `permanent_failure` | The provider definitively refused. Nothing was sent | Don't loop. Page the operator (usually a sender or domain setup problem). Once it is fixed, a **new** idempotency key is safe |
| 409 | `idempotency_conflict` | Idempotency key reused with a different payload | A bug in your code. Don't retry |
| 401 | `missing_authorization` | No `Bearer` header | Configuration bug |
| 403 | `invalid_api_key` | Malformed, unknown, wrong mailbox, wrong secret, **revoked or expired** | Page the operator for a new key. Revoked and expired keys surface here: the `key_revoked`/`key_expired` codes at `transactional-send-ops.ts:129-137` are unreachable because `verifyApiKey` refuses them first (`transactional-keys.ts:231-234`) |
| 403 | `insufficient_scope` | The key lacks `transactional:send` or `transactional:templates:use` | Page the operator |
| 403 | `test_key_not_allowed_in_production_send` | An `rck_test_` key was used to send | Use a live key |
| 400 / 403 | `idempotency_key_required` / `idempotency_key_too_long` | Header missing or longer than 255 characters | Fix your client |
| 403 | `invalid_request_body` | The body failed the schema in §3 | Fix your client |
| 403 | `template_not_allowed` | The template is not on this key's allowlist | Ask the operator to widen the allowlist |
| 403 | `template_not_found` | The template doesn't exist **or is archived** in this mailbox | Sync templates (§6) or fix the id |
| 403 | `missing_variables`, `unknown_variables`, or both comma-joined | The variable set is not exactly the template's placeholders. Names are not listed | Fix the caller or the template (§6) |
| 403 | `template_interpolation_failed` | A variable put CR/LF into the subject | Sanitize that value |
| 403 | `not_allowed_by_policy` | The recipient matched no allow rule | Surface it to your user, or ask for a policy change |
| 403 | `denied_by_policy` | The recipient matched a `!` deny rule | Same as `not_allowed_by_policy` |
| 403 | `recipient_suppressed` | The address previously hard-bounced or complained (§8) | **Don't retry.** Tell the user the address can't receive mail and ask for another |
| 429 | `quota_exceeded` | Either the per-key limit of 60 requests per UTC minute or the key's daily quota per UTC day. The response doesn't say which | Back off. The minute window resets at the next UTC minute and the daily one at 00:00 UTC. If it persists, ask the operator for a higher quota |
| 403 | `internal_error` | A reservation race the code could not resolve (`transactional-send-ops.ts:315`) | Replay the same key |
| 400 | `{"error":"invalid_json"}` | The body was not JSON | Fix your client |
| 415 / 413 | plain text | Wrong Content-Type, or body over 100 000 bytes | Fix your client |
| 404 / 405 | plain text | Wrong path or method | Fix the URL |
| 503 | `{"error":"transactional_api_not_configured"}` | The deployment has no key pepper | Page the operator |
| 500 | not the JSON contract | See the known issue below | Treat like `unknown`: replay the same key and don't resend |

Rules of thumb: 2xx means the provider accepted the message. `502`/`504` must never be
reported as sent. `429` means back off. Every other `4xx` needs a person: yours for client bugs
and policy or suppression decisions, the operator's for keys and templates.

**Known issue: a definite provider refusal does not produce a 502 today.** After a refusal, the
send path stores the status `permanent_failure` (`transactional-send-ops.ts:346-353`). The
`transactional_requests` table only allows `pending|sent|duplicate|rejected|failed|unknown`
(`src/do/mailbox-schema-content.ts:241`), so that update throws and the request errors out as a
5xx instead of the documented `502`. The row stays `pending`, a replay answers `202 accepted`,
and the hourly reconciler moves the row to `unknown` (`error_code: stale_reconciled`) after 30
minutes (`src/do/mailbox-do.ts:1322-1325`). The provider is never contacted twice. Until this is
fixed, handle a non-JSON 5xx like `unknown`.

## 5. Status: `GET .../messages/:requestId`

This needs a key with `transactional:status`, and returns only requests made **by that same
key id** (`transactional-send-ops.ts:1089-1146`, route at `src/do/mailbox-do.ts:1330-1372`).
Errors: `401 missing_authorization`, `403 invalid_api_key | key_revoked | insufficient_scope`,
`404 not_found`.

```json
{ "requestId": "…", "status": "sent", "providerMessageId": "…", "createdAt": "…",
  "errorCode": null, "deliveryStatus": "delivered", "deliveryEventAt": "…",
  "resolvedVia": null, "deliveryFeedback": { "state": "live", "reason": null } }
```

- `status` uses the **stored** vocabulary, `pending | sent | failed | unknown`, which differs
  from the send response (`accepted`, `permanent_failure`). `errorCode` is one of `ambiguous`,
  `permanent_failure`, `stale_reconciled` or `null`.
- `deliveryStatus` comes from Cloudflare lifecycle events: `delivered`, `deferred`, `bounced`,
  `rejected`, `complained` or `failed` (`src/cloudflare/email-events.ts:160-219`). It is `null`
  until an event arrives.
- `resolvedVia: "envelope_correlation"` means an `unknown` was settled by *inferring* which
  request an event belonged to, rather than from a provider acknowledgement. Treat that as weaker
  evidence.
- `deliveryFeedback.state` (`src/lib/feedback-liveness.ts:67-116`) tells you whether events
  arrive at all for this sender's domain:
  - `live`: events arrive, so a missing event is meaningful.
  - `unobserved`: too early or too few sends to tell.
  - `never_observed`: sends older than 24 hours exist and not one event has ever arrived. The
    domain most likely has no event subscription.
  - `went_dark`: events arrived before and have stopped.

**A missing delivery event is evidence only when `deliveryFeedback.state` is `live`.** A domain
with no event subscription produces no events for any message. In that case
`deliveryStatus: null` describes the channel, not your message. It also means no `unknown` will
ever resolve and no bounce will ever create a suppression. Never mark a message undelivered, or
alert on silence, unless the state is `live`. For any other state, ask the operator to fix the
feedback channel.

Status is scoped to the key id. After a rotation or revocation, the old key answers
`403 key_revoked`, and the new key cannot see the old key's requests. Keep what you need from
the status before rotating.

## 6. Templates

**Syntax.** A placeholder is `{{name}}` where `name` matches `\w+` (letters, digits, `_`),
with no spaces. `{{ name }}` is not a placeholder and ships literally
(`transactional-send.ts:102`). Placeholders are read from the subject, `body_text` and
`body_html`.

**The variable set must match exactly** (`transactional-send.ts:131-146`). Every placeholder
needs a value, and every value needs a placeholder. Both a missing and an extra variable are
rejected. So **adding or removing a variable is a coordinated change**:

1. Ship caller code that can send both variable sets, or put the new template under a new id.
2. Sync the template.
3. Switch the caller over.

An in-place edit that adds `{{plan}}` breaks every caller that doesn't send `plan` yet, from
the moment of the sync.

**Escaping** (`transactional-send.ts:156-200`)

- In `body_html`, values are HTML-escaped (`& < > " '`), so a value cannot inject markup.
  Put markup in the template. A URL value is safe inside a quoted `href`.
- `body_text` and the subject are inserted raw. The subject is truncated to 998 characters and
  rejected if a value introduces CR/LF. Bodies are truncated to 100 000 characters.
- Only subject and bodies are interpolated. Headers never are.

**Owning templates in your repo.** Keep `templates.json` (or similar) next to your code and
have it synced with:

```http
PUT https://<host>/api/mailboxes/<mailboxId>/transactional/templates
{ "templates": [ { "id": "verify-email", "subject": "Confirm your address",
                   "body_text": "Hi {{name}}: {{link}}", "body_html": "<p>Hi {{name}}…</p>" } ],
  "archiveMissing": false }
```

- **Who can call it:** only an operator session, meaning a Better Auth web session whose email
  is a deployment owner **and** the mailbox's `owner_email` (`src/api/mailbox-routes.ts:524-537`).
  Mutating `/api/*` calls also pass the Origin check. No API-key route exists for templates, so
  your Bearer key cannot sync. Either the operator runs the sync, or your CI holds an operator
  session (`pnpm operator login`, see OPERATIONS.md "Operator session from the terminal").
- The call is idempotent. Run it on every deploy. It takes at most 100 templates with unique ids
  (`transactional-send-ops.ts:726-809`). An omitted body part counts as `null`, because the list
  is the full desired state for each listed id.
- The response is `200 {ok, results:[{id, outcome, reason?}], summary}`, where `outcome` is one
  of:
  - `created`
  - `updated` (changed in place, same id)
  - `unchanged`
  - `archived` with `reason: already_archived`: an archived id is **never revived**, so pick a
    new id.
  - `archived` with `reason: missing_from_sync`: only when `archiveMissing: true`, which archives
    every active template not in the list. Leave it `false` if other products share the mailbox.
- The whole batch is validated before anything is written, and applied in one transaction. A bad
  batch changes nothing, and is refused at one of two layers:
  - Shape problems (an empty id or subject, more than 100 entries, a duplicate id) answer
    `400 {"error":"validation_error","issues":…}` at the API layer.
  - Per-template rules answer `400 {error, index, id}`, with `error` one of
    `invalid_template_id` (contains `..`, `/` or `\`), `subject_contains_newline`,
    `body_text_too_long` or `body_html_too_long` (over 100 000 characters).
- A template must also be on your key's allowlist before you can send it. Adding a template
  means a sync **plus** an allowlist change by the operator.

## 7. Keys

Keys are defined in `src/lib/transactional-keys.ts` and created through
`createTransactionalApiKeySchema` at `src/api/schemas.ts:215-240`.

- **Scopes:**
  - `transactional:send` requires `transactional:templates:use` and a non-empty template
    allowlist. Creation refuses a key without them.
  - `transactional:status` covers the GET in §5.
- **Template allowlist:** the exact template ids this key may send. An empty or null allowlist
  permits nothing.
- **Recipient policy**, validated at creation (`transactional-send.ts:272-306`) so a typo
  answers `400` instead of silently rejecting everyone. The policy is a comma-separated list of
  rules:
  - `@example.com`: any address at exactly that domain (subdomains don't match, wildcards
    aren't allowed).
  - `ada@example.com`: exactly that address.
  - `qa+*@example.com`, `*@example.com`: `*` matches any run of characters. The rule must
    contain exactly one `@`.
  - A `!` prefix denies. Deny rules win. A deny-only policy means "everyone except these".

  Matching is case-insensitive. With no policy, every recipient is allowed
  (`transactional-send.ts:210-245`).
- **Daily quota:** `quotaMax` is optional and counts sends per UTC day. The **rate limit** is
  hard-coded at 60 per key per UTC minute (`transactional-send-ops.ts:482-513`). Both are charged
  when a request is reserved. That includes requests that later fail. It excludes rejections and
  replays.
- **Sender name:** the From display phrase, set per key. It must be printable ASCII of at most
  64 characters, with no `<`, `>` or `"` (`transactional-keys.ts:148-153`). The operator can
  change it with `PATCH .../api-keys/:keyId` without reissuing the secret.
- **Expiry:** `expiresAt` is optional. After it passes, the key answers `invalid_api_key`.
- **Rotation** (`src/do/transactional-key-ops.ts:311`) creates a new key id with the same
  properties and **revokes the old one immediately**, in the same transaction. There is no
  overlap window. A request that already passed authentication finishes. The next request with
  the old key gets `403 invalid_api_key`. Two consequences:
  - Deploy the new secret right after rotating.
  - **Idempotency does not carry across rotation**, because it is scoped to the key id. Replaying
    an old idempotency key under the new key is a *new send*. Don't replay pre-rotation keys
    blindly, and check the old request's status first.
- **Revocation** is immediate and has the same effect on requests in flight.
- Rotating the deployment's pepper invalidates every key (README "Transactional API").

## 8. Suppressions

The rules live in `src/do/mailbox-suppressions.ts` and `src/cloudflare/email-events.ts:160-219`.

- A **hard bounce** event adds a suppression that **expires after 90 days**
  (`mailbox-suppressions.ts:367-375`).
- A **complaint** (spam report) adds a **permanent** suppression.
- Soft bounces, deferrals, rejections and failures never suppress.
- Suppressions belong to the **mailbox**, so every key on that mailbox shares them, preview keys
  included. They are only created if the sending domain's feedback channel is live (§5).
- A suppressed recipient is refused before quota or idempotency reservation with
  `403 recipient_suppressed`. Nothing is sent and nothing is charged.
- **What you do:** treat it as a property of the address, not an outage. Don't retry, don't
  alert. Ask the user for another address, or show "we can't email this address". Don't
  work around it by sending from another mailbox.
- **Who can clear one:** only an operator session that owns the mailbox, through
  `POST /api/mailboxes/:id/suppressions/remove`. Hard-bounce and complaint entries also need
  `allowProviderRemoval: true` (`mailbox-suppressions.ts:59-76`,
  `src/api/mailbox-routes.ts:583-605`). Clearing a complaint means overriding a person's "this
  is spam", so expect the operator to push back.

## 9. Checklist

- [ ] You have the host, the `mbx_` mailbox id, and one `rck_live_` key per environment, stored
      as secrets and never sent to a client.
- [ ] You know each key's sender, display name, template allowlist, recipient policy and quota.
      The preview key is restricted to internal recipients.
- [ ] One endpoint URL in config. The environment comes only from which key is loaded.
- [ ] Every send carries an `Idempotency-Key` derived from the business event. Retries resend
      the exact same body bytes.
- [ ] Response handling switches on `error` for `rejected`, handles `429` with backoff, and never
      reports `502`, `504` or a non-JSON `5xx` as sent.
- [ ] `unknown` is replayed with the same key or polled, never resent under a new key.
- [ ] `recipient_suppressed`, `not_allowed_by_policy` and `denied_by_policy` reach your UX as
      "this address can't receive mail", not as an outage.
- [ ] Templates live in your repo and are synced on deploy. Variable changes ship as a
      coordinated change (§6).
- [ ] Delivery alerts only fire when `deliveryFeedback.state` is `live`.
- [ ] You have a rotation runbook: rotate, deploy the new secret, and don't replay old
      idempotency keys.

## 10. Common mistakes

1. **Expecting different URLs for preview and production.** There is one URL per mailbox. The
   key decides everything else. Test keys can't send.
2. **Putting the mailbox on the sending subdomain** (`hola@send.example.com`). Mailboxes live on
   the zone (`hola@example.com`). The `send.` subdomain is only the From identity.
3. **Branching on `status` instead of `error`.** `recipient_suppressed` is an `error` under
   `status: "rejected"`. Checking `status === "recipient_suppressed"` reports a bad address as a
   broken integration.
4. **Generating a fresh `Idempotency-Key` per retry.** This turns an `unknown` into a possible
   double send. It is the one mistake the idempotency design can't protect you from.
5. **Adding a template variable in place** while callers are live. Missing and unknown variables
   both reject.
6. **Reading a null `deliveryStatus` as "not delivered"** on a domain whose feedback isn't `live`.

Operator-side onboarding of a new product (mailbox, sending domain, keys, templates) is covered in
[`OPERATIONS.md`](OPERATIONS.md).
