# Telegram bridge — deferred work

Two items deliberately left for a later session, captured with enough reasoning that
nobody has to re-derive the design. Everything else from the same exploration either
shipped or was rejected on purpose (see "Rejected" at the bottom).

## F2 — The MCP → Telegram confirmation loop

**The gap.** Reccado calls itself an agentic inbox, but the agent and the human cannot
see each other. `draft_reply` in `src/mcp/tools.ts` says outright that its drafts "must
be reviewed and sent by a human via the UI" — and the human is on Telegram, holding a
phone, while the draft waits in a web app they have to go open.

**What it should feel like.** You ask Claude, from your phone, to answer the three
threads still open today. Claude calls `draft_reply` three times. Three previews appear
in Telegram — the same `renderDraftPreview` a Telegram-authored reply produces, plus a
line saying it was drafted by Claude over MCP — each with the usual `[Send] [Discard]`.
Three taps and the day is done.

**Why it is cheap.** Every piece already exists. `request-send` → `pending_confirmation`
→ inline button → `confirmDraftSend` is the exact path a Telegram reply already takes,
and the ledger already records `approval_mode`. What is missing is one edge: when a
draft is created or armed by a non-Telegram surface, enqueue a notification on the
notify queue (`src/cloudflare/notify-consumer.ts`) whose consumer renders the preview
and mints the `telegram_actions` row, instead of only doing that for inbound mail.

**The invariant it must not touch.** Nothing leaves without a human finger. The agent
drafts; it never sends. That is what makes it tolerable for an LLM to compose mail in
the operator's name at all.

## F11 — A Telegram Mini App

**The gap.** Several smaller frustrations share one root cause: a chat is not a mail
reader and not an editor. The card carries a 700-character snippet by design (the
privacy reasoning in `src/telegram/format.ts` is sound — password resets and 2FA codes
should not be transcribed into a non-E2E cloud chat), attachments cannot be composed,
and there is no real To/Cc/Subject editor.

**What it should feel like.** A `web_app` button on the card opens Reccado inside
Telegram: the full message rendered, the thread, attachment previews, a real draft
editor. The operator never leaves the app they are already in.

**Why the auth is elegant rather than scary.** A Mini App's `initData` arrives HMAC-signed
with the bot token — the same trust anchor that already authenticates the webhook via
`deriveWebhookSecret`. So this does not require punching a hole in Cloudflare Access:
it is a second, narrower perimeter (read plus draft editing), and sending still leaves
only through the chat's confirmation button.

**Why it is expensive.** It is a second UI and a second authentication path in a mail
server, and it deserves the same rigor as the Access perimeter — including the CSP-sanitized
HTML pipeline that `/messages/:id/html` already implements. Do not start this one casually.

## F7b — Attachments, upward

**The gap.** The download half shipped: a card names each file (`contrato.pdf (240 KB)`)
and a `📎 Adjuntos` button pushes them into the chat as documents (`src/telegram/attachments.ts`).
Sending one *out* is still impossible, so a reply that needs a file still has to be
written somewhere else.

**Why it was cut rather than half-built.** `outbound_drafts` has no attachment model at
all — no table, no column, nothing the MIME composer could read. Accepting a file in
Telegram therefore means three changes that only make sense together: a schema addition
in the mailbox Durable Object, a multipart branch in the outbound composer, and a preview
that can show "3 archivos" and let one be removed before sending. Shipping any one of them
alone produces a draft that claims to carry a file it will not send.

**What it would take.** `getFile` + a download from `api.telegram.org/file/bot<token>/<path>`,
straight into R2 under the draft's own prefix; an `outbound_draft_attachments` table keyed by
draft id; the composer reading it; and the preview rendering it. The 20 MB Bot API download
limit is the natural cap, and it is well under what the send path already accepts.

**The invariant it must not touch.** Nothing leaves without a human finger — an attachment
added by a message is part of what the Send button confirms, never a reason to skip it.

## Cron integration for the bridge sweep

`sweepTelegramBridge` (`src/telegram/sweep.ts`) is the hourly heartbeat the noise policy
needs: it releases the night's digest when quiet hours are over, and prunes expired
preview→draft mappings and spent digest rows. It is written but **not yet called**, because
`src/cloudflare/scheduled.ts` was out of scope for the session that added it. One line,
next to `reconcileTelegramWebhook`:

```ts
const telegramSweep = await sweepTelegramBridge(env);
```

plus the import, and `telegramSweep` folded into the `cron.backup_sweep` ops payload.

Until that line exists the digest still goes out — `deliverInboundNotification` flushes it
on the first email that arrives after the window closes — but a morning with no new mail
will not get one, and the two short-lived tables are never pruned.

## Rejected, and why

Kept here so the ideas do not get re-proposed:

- **Sending without human confirmation** in any form (trusted senders, a `!` prefix, a
  "yolo mode"). The allowlist already means "can sign as the operator"; that surface stays
  minimal and gains no shortcuts.
- **One forum topic per email thread.** Topic names are permanent UI and email subjects are
  attacker-controlled text. Topics map to mailboxes, which the operator curates.
- **Full message body in the card by default.** See the privacy note above; full reading
  stays an explicit act.
- **Administration from the chat** — API keys, routing rules, mailbox provisioning. The blast
  radius of a compromised Telegram account must stay at "can send mail", never escalate to
  "can rewire routing or mint credentials".
- **A trash button beside archive.** Archive is free to undo; an inadvertent trash on a phone
  screen is not.
- **Inline mode and multi-operator.** Inline mode leaks mailbox content into arbitrary chats
  by design, and multi-user is a different product — single-operator is a feature here,
  because it simplifies every security decision above.
- **Folding the preview→draft mapping into `telegram_actions`.** That table holds the
  authority to send: its token is bound to the account the button was shown to and derived
  from the message that produced it, so a Telegram retry mints the same button rather than a
  second send. "Which draft is this preview about?" needs no token at all and is guarded by
  the operator allowlist, like the card verbs. See `telegram_drafts` in
  `migrations/d1/0014_telegram_experience.sql`.
- **Deleting the previous page's cards when paginating a search.** They are cards with
  telegram_links rows — archivable, quotable, real. Sweeping them away to keep the chat tidy
  would throw away the objects the feature exists to produce.
