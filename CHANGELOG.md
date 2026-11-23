# Changelog

All notable changes to Reccado are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project
does not yet follow Semantic Versioning strictly (pre-1.0, self-hosted, no published package) —
version numbers here track meaningful release checkpoints of the self-hosted app, not an npm
package.

## [Unreleased]

### Added

- **The owner can send an agent's draft directly (2026-11-18).** The agent prepared a draft and
  the web refused to send it (`approval_required`, "Approval expired") — a dead end. The rule is
  now: the agent can never send; an agent-initiated send needs the hash-bound approval; the owner
  may send an agent-written draft directly with the owner web session, bound to the content they
  were shown; never from Telegram. *Direct send.* `GET /drafts/:id` serves a `content_fingerprint`
  (SHA-256 over the draft's recipients, subject, text and HTML bodies, files and thread/parent);
  the composer sends an untouched agent draft as it is with `draftFingerprint` on `confirm-send`.
  Only that web route mints the new `owner-web-send.v1` HMAC proof (Origin present and equal,
  session re-read with the cookie cache off); the mailbox DO compares the fingerprint with the
  frozen send snapshot atomically and answers `draft_changed` (nothing sent) when the agent edited
  it in between — the composer then reloads it with "The agent changed this draft after you opened
  it". Without a fingerprint (or from Telegram) an agent draft is still refused. *Takeover.* Saving
  an agent draft from the web (or adding a file to it) makes it the owner's (`origin` `web`): the
  agent's `save_draft` / `cancel_draft` / `send` on it answer `draft_not_agent_owned`, checked in
  the DO with the write; a replayed `save_draft` key no longer re-claims a draft. A takeover or a
  direct send consumes any pending approval for the draft (it reads `stale`); a draft still sends
  at most once whichever path gets there first. Ops events `send.owner_direct_agent_draft`,
  `draft.owner_takeover`, `approval.superseded`; `send.confirmed` records the channel. The "Written
  by the agent" pill stays; the "Approval expired" pill and the "can only be sent through your
  approval link" copy are gone.

- **Delete forever and Empty trash (2026-11-16).** The first permanent deletion in the mail client,
  and only from the Trash. *Web.* In Trash, "Delete forever" replaces Delete for the selected
  conversations, a row and the open conversation (`#` too), and an "Empty trash" bar/menu item acts
  on the scope (one mailbox, or every mailbox). Both ask first, with the count, the scope and "This
  can't be undone."; no Undo toast; an open conversation that was deleted closes, list and counts
  refresh, a large Trash shows progress. *API* (owner web session only, Origin-checked; no MCP tool or
  control-plane kind): `POST /api/mailboxes/:id/purge` with `threadIds` (their trashed messages),
  `messageIds` (refused with 409 `not_in_trash` unless every one is in the Trash) or `emptyTrash`,
  and `GET /api/mailboxes/:id/purge/:operationId`. *Mailbox DO* (schema v14, `do/mailbox-purge.ts`):
  an operation queues its message ids (`purge_queue`, `purge_operations`) and deletes in batches of
  250 — the first in the request, the rest from the alarm — re-checking `state = 'trash'` each time
  (a message restored meanwhile stays). Each batch removes, in one transaction, the message, its
  attachment, header, label and search rows, scrubs the subject/sender from its live-update history,
  empties the draft a sent copy came from (the send markers stay, so a replayed confirm-send still
  sends nothing), recounts or removes its conversation, and queues a `purge_message_objects` job
  for the R2 objects (raw MIME, HTML body, attachments) and the D1 rows (`message_index`,
  `telegram_links`, `telegram_retained`); the job retries every 5 minutes until done. An R2 object is
  deleted only when no surviving message, attachment or draft file points at it (forwarded
  attachments, sent copies re-using upload keys, duplicate deliveries sharing a raw key); new
  indexes make those checks lookups. The ingest ledger keeps its row, marked `purged`, so a
  re-delivered copy of a deleted email stays a duplicate (its new raw object is deleted) instead of
  coming back. One `mailbox.messages_purged` ops event per finished operation (mailbox, scope,
  counts). A draft that forwarded an attachment of a message deleted forever now deletes that object
  when it drops the file or is purged after a discard. Not included: automatic emptying of the Trash
  after N days.

- **Attachments when composing and forwarding (2026-11-16).** *Compose.* A paperclip, drag-and-drop
  onto the dialog and pasted files attach to the draft; chips show name, size, upload progress,
  errors and remove; a running total ("3 files · 4.2 MB of 17 MB"); Send waits while uploads are in
  flight; a draft row in a conversation shows a paperclip. *Limits* (`src/lib/attachment-limits.ts`):
  17 MiB per file and in total, 20 files — Cloudflare Email Sending caps the whole message at 25 MiB
  after base64. *Storage.* Bytes go from the request straight to R2 under
  `drafts/<env>/<mailbox>/<draft>/<attachment>-<name>`; the mailbox DO keeps metadata only in a new
  `draft_attachments` table (schema v13). Owner-session routes: `POST|GET|DELETE
  /api/mailboxes/:id/drafts/:draftId/attachments[/:attachmentId]` (raw body, `?filename=`) and
  `POST …/attachments/from-message`. Names are sanitised (no path, no control characters, NFC,
  bounded), types reduced to `type/subtype`; downloads are always `attachment`, nosniff, sandboxed.
  Agent (`mcp`) drafts never take files. *Send.* The frozen send intent lists the files (id, name,
  type, size, sha256, R2 key, in order), so `payload_hash` covers them and adding or removing one
  makes an armed intent stale; a draft without files freezes `attachments: []` exactly as before, so
  existing hashes and approvals are unchanged. Confirm-send reads the files back from R2, checks each
  sha256 and hands them to Email Sending, which composes the multipart/mixed message; a missing or
  changed file sends nothing and frees the attempt. The sent copy lists the files in the ordinary
  `attachments` table on the same R2 objects (download works like received mail) and the D1 index
  gets `has_attachments`. The web request-send now replaces a stale intent, so Send works again after
  an edit. *Forward.* The original's files are offered checked and removable, attached by reference to
  its R2 objects (no bytes through the browser); inline images go as regular files and the dialog
  says so. *Lifecycle.* Removing a file deletes its upload; sending hands the objects to the sent
  copy; discarding keeps them for 24 h so Undo restores the draft whole, then a mailbox alarm job
  deletes the uploads of a draft still discarded (forwarded originals are never deleted).

- **Mail-client conventions in the web inbox (2026-11-16).** *Who.* Your own messages say
  "me" / the mailbox display name instead of the mailbox local part; mail stored before names
  were kept gets its sender name (and Reply-To) from its own raw headers in R2 the first time
  its conversation is opened — inbound rows of that thread only, newest 20, first 64 KB of each,
  sanitised with `display-name.ts`, written once (`src/do/mailbox-web.ts`). *Reply.* Reply
  answers the newest inbound message's Reply-To (else its sender); Reply all (button, menu, `a`)
  adds its other To/Cc minus every mailbox address and alias; one `Re:` / `Fwd:`, never doubled;
  Reply / Reply all / Forward / Mark as unread per message from its menu (`src/lib/reply.ts`).
  *Lists.* Row checkboxes (hover, or tap the avatar), select all in view, shift-click ranges, a
  selection bar with archive / delete / move to inbox / read / unread; an "Unread" filter
  (`?unread=true`) and "Mark all as read" for the folder in scope; "load older" + infinite scroll
  that pages each mailbox by keyset cursor and merges them without ever placing older mail above
  newer unloaded mail (`src/lib/thread-paging.ts`); scroll position kept when coming back from a
  conversation, the open row kept in view; selecting text in a row no longer opens it;
  full timestamp on hover. *Undo.* Archive, delete, move to inbox, mark unread, mark all read
  and discarding your own draft show a toast with Undo that replays exactly the messages that
  changed; failed actions roll back and say so. *Browser.* "(3) Inbox — Reccado" tab title and an
  unread dot on the favicon. *Search.* Empty results say where it searched and offer "Search all
  mail in every mailbox"; `/` focuses search. *Compose.* Invalid addresses are named before
  sending; empty subject/body asks first; ⌘/Ctrl+Enter sends; Esc/close keeps your changes as a
  draft (or asks when there is no recipient to save one for); discarding an unsaved message asks;
  "Message sent · View message" toast; a full-screen toggle (remembered for the session; phones
  are always full screen). *Reading.* Remote images are blocked by default (`img-src 'self'
  data:`) with "Show images" / "Always from <sender>" (this browser), quoted history in HTML
  replies folded behind "···", a details expander (From, Reply-To, To, Cc, date, subject), and
  Print. *Layout.* The mailbox column folds into a rail of mailbox dots (`[`), the list folds while
  a conversation is open (`]`), "Read wider" folds both; remembered per browser. *Keyboard.* `a`,
  `c`, `/`, `x`, `?` (shortcuts sheet), Shift+I / Shift+U, list j/k/e/# when no conversation is
  open. Backend: mailbox DO schema v12 adds nullable `messages.reply_to_json` (stored at ingest);
  `GET …/threads` takes `cursor` and `unread=true`; new `POST /api/mailboxes/:id/bulk-actions`
  (threads, messages, or a folder's unread → reports what each message was) and
  `POST …/drafts/:id/restore` (your own discarded drafts only, never an agent's);
  `…/messages/:id/html?images=1` opts into remote content.

- **DMARC aggregate reports kept out of the web inbox; read state you can see (2026-11-16).**
  *Reports.* Inbound mail is classified at ingest (`src/lib/automated-mail.ts`) as
  `automated_kind = 'dmarc_report'` only on structural signals: the RFC 7489 subject
  (`Report Domain: … Submitter: … Report-ID: …`, any case/spacing) or that subject without the
  Report-ID plus a report file, or only `receiver!domain!begin!end[!id].{xml,xml.gz,gz,zip}`
  attachments with a report-ish subject from an automated mailbox; never a reply/forward
  (In-Reply-To, References, `Re:`/`Fwd:`…), never a parse failure. Reports are stored like any mail
  but arrive read, do not un-archive a conversation, and the web's `/threads`, `/search` and
  `/counts` leave them out (a conversation of only reports disappears; a person's conversation
  holding one stays). They are listed under More → "DMARC reports" (`?folder=reports`,
  `reports=only`), with no badge. MCP talks to the DO without the filter and still sees them;
  Telegram notices are unchanged. Mailbox DO schema v11: nullable `messages.automated_kind`,
  partial covering indexes `idx_messages_web_counts` / `idx_messages_reports`, and a backfill of
  stored mail from subject/headers/attachment metadata (no R2 read) that also marks found reports
  read. *Read state.* Unread rows are white with an 8px navy dot in a fixed slot and semibold ink
  sender/subject/time; read rows sit on a quiet grey (`--color-row-read`) in regular weight and
  secondary/muted text; the open row is a blue-grey with a wider mailbox stripe; collapsed messages
  in a thread and the mailbox column follow the same language. Opening a conversation and mark
  read/unread update rows and unread figures at once, and the guess holds until a reload that
  started after the write has landed (no flicker back). The dropdown menu is now anchored to the
  viewport, so "More" is no longer clipped by the scrolling toolbar.

- **Gmail-style mail client: conversation order, rich text, threads (2026-11-16).**
  *Order.* Every folder lists conversations by their newest message outside the trash (Trash: the
  newest trashed one), your own replies included, so replying moves a thread to the top; ties break
  on thread id, so merged multi-mailbox lists and search results are stable. `threads.last_message_at`
  only moves forward (a late or replayed older mail no longer pulls a thread down). An open
  conversation lands on its newest message: older read messages are one-line rows and a run of them
  folds into "N older messages". *Reading.* Message HTML is served with `X-Frame-Options:
  SAMEORIGIN` (matching its CSP `frame-ancestors 'self'`) instead of the global `DENY` that
  conflicted with it; every other response, and `/approve`, `/login`, `/consent`, keep `DENY` /
  `frame-ancestors 'none'`. Links in mail get `target=_blank rel="noopener noreferrer"`, `cid:`
  inline images resolve to the message's own attachments, and a frame that cannot load falls back to
  the text part. Plain-text mail keeps line breaks, wraps long lines, links URLs/addresses (React
  nodes, never HTML) and folds a trailing quoted reply behind "···". *Writing.* Compose is a
  dependency-free rich text editor (bold, italic, underline, links, lists, quote, clear formatting;
  ⌘B/I/U/K, ⌘⇧7/8/9, ⌘\\), with sanitised paste, autosave into one draft, replies that quote the
  original under an attribution line and set `parentMessageId`, and forwards with the original
  header block. `POST/PATCH /api/mailboxes/:id/drafts` now sanitise `bodyHtml` server-side
  (`src/lib/html-sanitize.ts`, HTMLRewriter allowlist: no scripts, handlers, images, iframes,
  external styles, `url()`/`javascript:`; max 1 MB) and derive `bodyText` from the clean HTML, so
  the multipart/alternative parts agree and the approval `payload_hash` covers the clean markup.
  Text-only drafts, Telegram and MCP drafts are unchanged. *Threads.* Thread rows (`GET
  /threads`, MCP `list_threads`) gain additive `participants` (senders oldest first, owner as
  `me`), `latest_to_json` and `latest_recipient_names_json`; `message_count` and `unread_count` are
  now computed per folder view (non-trash / trash) from the messages — `unread_count` was a counter
  that only went up — and `?unread=` filters on it. Rows read "Rico, me · 2"; outbound-only rows
  say "To: <recipients>" from the real recipients instead of the mailbox's own address; a
  conversation is bold while any message is unread. Archive / restore of a conversation keep your
  sent messages in Sent (outbound messages are never moved to Inbox/Archive), and a new inbound
  reply moves the conversation's archived messages back to the inbox. Reply drafts show inline at
  the bottom of their thread, and Reply resumes an existing draft instead of starting a second one.
  Keyboard: `j`/`k` next/previous, `e` archive, `#` trash, `r` reply, `f` forward, `Esc`/`u` back.
  No schema or D1 migration; deploy is code-only.
- **Sender display names and real folder counts (2026-11-16).** Mailbox DO schema **v10**
  (automatic on first DO start, additive): nullable `messages.from_name` and
  `messages.recipient_names_json`, filled at ingest from the parsed From/To/Cc headers through one
  sanitiser (`src/lib/display-name.ts`: control/bidi/zero-width/tag characters stripped, 80 code
  points max, a name that is the address or names a *different* address is dropped). Sent copies
  store the From phrase they went out with. No backfill: older rows keep the address-derived name.
  Exposed additively as `latest_from_name` on thread rows, `from_name`/`recipient_names_json` on
  message rows, and `from_name`/`latest_from_name` on MCP `list_threads`, `search_messages`,
  `read_message`/`read_thread`; the FTS sender column includes the name. The web UI shows the name
  and always keeps the real address visible (header line, `title`). New owner-session endpoint
  `GET /api/mailboxes/:mailboxId/counts` → `{ mailbox_id, counts: { inbox|sent|archive|trash|all:
  { threads, unread, messages }, drafts } }`, computed by the DO from the new covering index
  `idx_messages_folder_counts (state, thread_id, is_read)`; the inbox header, folder badges, mailbox
  unread counts and "1 of N" use it instead of counting loaded rows (no more "+" lower bounds).
  No D1 migration.
- **Standard MCP connection (2026-11-14).** `claude mcp add --transport http reccado https://<host>/mcp`
  (and claude.ai custom connectors, Cursor, …) now works with no operator step: unauthenticated
  RFC 7591 client registration is open on `/api/auth/oauth2/register`, hardened by a D1-backed
  per-IP limit (10/hour), https-or-loopback `redirect_uris`, sanitized/capped `client_name`, an hourly
  sweep of never-consented clients older than 24 h, and an `mcp.client_registered` ops event. Nothing
  is granted before owner login + consent. The consent page shows client name, redirect host and a
  "Cliente nuevo" note; the first consent of a client sends a Telegram "Nueva app conectada" notice.
  `/.well-known/oauth-authorization-server` is served at the root as well as the issuer-suffixed path.
  `pnpm operator mcp register` stays as an optional fallback.
- **Final MCP permission model (2026-11-14).** Supersedes the earlier same-day Telegram-button and
  delegated-auto-apply entries. Scopes are fine-grained `resource:action` with no omnibus `admin`:
  `mail:read`, `mail:read:sensitive`, `mail:draft`, `mail:send`, `config:read`, `mailboxes:write`,
  `templates:write`, `routing:write`, `domains:write`, `keys:write`, `suppressions:write`.
  `tools/list` shows only tools whose scope was granted; a call missing a scope gets the spec
  `insufficient_scope` signal naming it. Owner approval (only on `/approve/:id` with the owner web
  session; Telegram sends a notice with the link, no ✅/❌ buttons) is now required only for `send`,
  aliases/forward rules to destinations outside the owner's domains, `api_key_create|rotate|scopes`,
  `suppression_remove` and `domain_add|provision|disable`. Every other write (templates,
  `api_key_templates`, `api_key_revoke`, mailbox kinds, internal aliases/rules, `domain_update`,
  `restore`, `reconcile_stale`, `update_messages`) applies directly with its scope, keeps
  `before_snapshot` + ops events and is undoable with `restore`. CIMD is on (`MCP_CIMD_ENABLED=true`),
  open DCR stays as fallback.
- **Removed (2026-11-14):** delegation policies (table `mcp_client_policies`, `pnpm operator mcp
  policy`, the `/security` policy editor, auto-apply, template link checker, Telegram
  auto-applied/undo), Telegram ✅/❌ approval for MCP intents, and batch intents (one operation per
  call). Migration `0030` drops `mcp_client_policies` (`0029` was already applied) — **apply `0030`
  before deploying**. Existing tokens with the old `admin` scope match no tool: reconnect and
  re-consent.
- **MCP v2 (`/mcp`).** A stateless SDK-v2 server (spec 2026-07-28 with a legacy 2025 path) with 20
  tools: reads (`list_mailboxes`, `list_threads`, `read_thread`, `read_message`, `search_messages`,
  `get_health`, `list_ops`, `list_config`), tier-1 mailbox-content actions (`save_draft`,
  `cancel_draft`, `update_messages`) and tools gated by scope and, for irreversible kinds, approval (`send`, `manage_mailbox`,
  `manage_domain`, `manage_routing`, `manage_template`, `manage_api_key`, `remove_suppression`,
  `restore`, `reconcile_stale`). Scopes: see the final permission model entry above. OTP/reset/magic-link mail is flagged at ingest and redacted
  without `mail:read:sensitive`; attachments and raw MIME are MCP resources.
- **Approvals and passkeys.** *(Passkeys superseded 2026-11-14, see above.)* `telegram_actions` became `approvals`; sends and control-plane changes
  requested over MCP are approved at `/approve/:id` with a passkey bound to the intent and payload
  hash (frozen snapshot, 10 min, single use, `intent_stale` on edit). MCP-origin drafts are sticky
  and only send with an HMAC approval proof; Telegram notifies but cannot approve them. Passkey
  registration needs a TOTP/e-mail-OTP step-up. API-key secrets are revealed once on the approval
  page, never to the agent. Batch intents (≤ 20), soft deletes with `restore`.
- **Client onboarding.** `pnpm operator mcp register|clients|revoke`; opt-in CIMD
  (`MCP_CIMD_ENABLED`, default off) on a Workers-native guarded transport.
- D1 migrations `0021` (Better Auth 1.7.20), `0022`, `0024`–`0028`; **apply them remotely before
  deploying** (see `docs/OPERATIONS.md`).
- **No Telegram notice for DMARC aggregate reports (2026-11-16).** The mailbox DO returns its
  classification in the ingest result (`MailboxIngestResult.automatedKind`, additive); the inbound
  consumer stores and indexes the report as before but enqueues no `NOTIFY_QUEUE` message for it,
  so it is never retained for the quiet-hours digest either. Muted senders, ordinary mail and a
  person writing about DMARC are unchanged (`tests/integration/dmarc-notify.test.ts`).
- **Agents can ask to route an address, behind owner approval (2026-11-16).** New approval-gated
  control-plane kind `address_route`, exposed as `manage_routing` `route_address`
  (`{domain, address}`, scope `routing:write`). Over MCP it only creates an approval (no
  Cloudflare call); on the owner's approval it runs the same `routeAddress` as the web "Route it"
  (one literal `to:<address> -> <this Worker>` rule, never overwrites a rule or touches the
  catch-all). Unknown address / unregistered or inactive domain / another owner's mailbox are
  refused at request time (`refused: <reason>`); Cloudflare-side refusals (conflict, routing
  disabled, token missing or without permission, timeout, API error) end as a failed execution
  whose `result.items[0].detail` carries `reason`, `message`, `remedy` (and `cli` / `conflict`).
  The approval page shows "Route <address> to this Reccado" with the zone and the rule to create,
  and, once decided, the outcome. No migration.

### Removed

- Passkeys, WebAuthn, passkey step-up and the Reflect polyfill. The `0024` passkey table stays,
  unused. Auth mail isolation (OTP mail hidden from MCP) is unchanged.

### Changed

- **Faster thread lists and searches on large mailboxes.** A list page no longer counts the messages
  of every conversation in the mailbox before sorting (about a third of the rows read per
  conversation); counts are computed for the page's rows. `GET /api/approvals` reads each pending
  send's frozen snapshot once instead of three times. Search fetches its hits a few at a time and
  no longer triggers or waits on the sender-name/Reply-To backfill (`GET …/threads/:id?backfill=0`);
  opening the conversation still runs it.
- **Approval boundary documented as it is.** The owner approves with the owner web session on
  `/approve/:id` or in the inbox approvals pane (same endpoint, same payload-hash binding;
  secret-revealing kinds only on `/approve/:id`). AGENTS.md, SECURITY.md, SKILL.md and
  docs/ARCHITECTURE.md now say so.
- `better-auth`/`@better-auth/mcp` 1.7.20 (session JWTs are no longer accepted at `/mcp`);
  `agents` 0.33 and `@modelcontextprotocol/server` 2.4.0. Existing MCP tokens need re-consent for
  the new scopes; Telegram pending sends created before `0022` must be re-drafted.
- The AGENTS.md/SECURITY.md sending invariant now covers control-plane changes; the transactional
  plan's "keys never exposed via MCP" is superseded (`docs/plans/mcp-v2.md`).
- **The auth perimeter moved from Cloudflare Access into the worker.** The issuer is now
  **Better Auth 1.7.2** running inside the Worker — observable in the worker's own code and logs,
  with no unverifiable edge perimeter to take on faith. `/login` opens a web session via e-mail
  OTP with **registration closed at the issuer**: an OTP is only ever sent to an address the owner
  registry (`owner_identities`) vouches for, bootstrapped by the renamed secret
  `OWNER_BOOTSTRAP_EMAILS` (formerly `ACCESS_ALLOWED_EMAILS`). The Access validator,
  `getAccessConfigStatus`, `ACCESS_JWT_AUDIENCE` and `ACCESS_TEAM_DOMAIN` are gone. The Telegram
  bridge keeps its derived-secret perimeter, so the two perimeters still fail independently.
- **The pairing-code rescue now covers the web.** The same single-use, expiring
  `owner_pairing_codes` ladder Telegram uses can open a session at `/login` when the code is
  minted through `wrangler d1 execute` — the only safety net for a first login before mail sending
  is configured or when the registry is empty.
- **`/mcp` authenticates with OAuth** through `@better-auth/mcp` (plus `jwt()` for stable signing
  keys and `/jwks`); the owner gate still applies after the token. MCP clients need to reconnect.
- **Session cookie cache enabled** (5-minute signed cookie, one fewer D1 read per request). The
  confirm-send path deliberately bypasses the cache so a revoked session takes effect the moment a
  send is about to happen. Better Auth's database-backed rate limiter covers `/api/auth/*`, with an
  optional outer WAF rate-limiting rule.
- D1 migrations `0016`–`0018` carry the Better Auth schema (auth core, MCP plugin, FK fix).
- `pnpm setup:access` and its smoke script are deleted; **`pnpm setup:auth`** replaces them:
  machine-generated `BETTER_AUTH_SECRET` uploaded as a Worker secret (dry-run by default,
  `--apply` to upload), base-URL and first-login/rescue guidance, and the WAF rate-limit rule for
  `/api/auth/*` created via the zone rulesets API when a zone-scoped `CLOUDFLARE_API_TOKEN` is
  present — or the exact dashboard steps and curl shape printed when it is not. The script never
  fails on a missing token.
- **Recipient policies are validated when a key is created.** A policy is a comma-separated list
  of `@domain`, exact-address or `*`-pattern rules (each optionally `!`-negated); a malformed rule
  (empty entry, whitespace inside a rule, bare `!`, `@nodot`, `foo`) used to be stored and then
  silently reject every recipient. It now answers `400 validation_error` naming the offending
  rule, and no key is created. Deny-only policies remain valid. Nothing is normalized.
- The template create route's per-template checks moved into a shared `templateInputProblem`
  (same error codes), used by both create and the new sync route.

Security hardening and public-readiness pass on top of the Phase 1 Tier A inbox, plus the
transactional API (Phases 2–4 of the `docs/plans/transactional-api.md` plan) and the MCP
read/search/draft endpoint.

### Security

- **Opening a message with images off makes no request to anyone else (2026-11-16).** A sender's
  `<meta http-equiv="refresh">` navigated the message body to any URL when the body was opened
  outside the inbox frame (Chrome's sandbox stopped it inside the frame; other browsers may not),
  a `<video poster>` was fetched in Chrome despite the body's CSP, and `<meta name="referrer"
  content="unsafe-url">` made those requests carry the message URL (mailbox and message ids).
  The served body now drops, in both modes, meta refresh, referrer overrides (`<meta
  name=referrer>`, `referrerpolicy`, `ping`), the sender's `<base>`, every `<link>` (DNS prefetch,
  preconnect, prefetch, stylesheets) and script/object/embed/iframe/frame elements; with images
  off it also moves every remote source aside (`src`, `srcset`, `background`, `poster`, SVG `href`,
  …) and neutralises remote CSS `url()`, `image-set()` and `@import` in style attributes and
  blocks (`src/lib/email-html.ts`). Every app page now sends `frame-src 'self'`, so the message
  frame cannot be navigated off this origin at all, and `/inbox` pages send
  `Referrer-Policy: no-referrer` like `/approve/:id`, since a thread-less approval opens as
  `/inbox?folder=approvals&approval=<id>`. A body the HTML parser refuses now answers 422 (the
  inbox shows the text part) instead of a 500.
- **"Route it" enforces the same ownership as the agent's `address_route`.** The web endpoint
  `POST /api/cloudflare/domains/:domain/routing` now refuses (403 `forbidden`) an address whose
  mailbox, or whose alias's mailbox, has another owner; an empty or non-JSON body answers the
  documented `400 { ok: false, reason: "invalid_address" }` instead of `{ error: "invalid_json" }`.
- **The transactional status route verifies the key secret.** `GET
  /v1/.../transactional/messages/:requestId` checked the key id, revocation and scope but never
  the secret, and ignored expiry — and key ids are public (every send response carries one). Send
  and status now share one authentication path (peppered constant-time secret check, then mailbox
  binding, revocation, expiry, scope). Nothing about a key's state is disclosed before its secret
  verifies.
- **Dead-letter tombstones no longer copy the message body into `ops_events`.** The DLQ consumer
  stored the whole dead message as `payload_json.body`, so a dead-lettered Email Sending event
  wrote the recipient's full address and the rendered subject into the ops log (observed on a
  live row), and a dead inbound or notification message would have written sender, recipient,
  subject and snippet. The payload is now `{ queue, attempts, summary }`, where `summary` is an
  allow-list of identifiers per known shape: event type, event id, provider message id and
  recipient *domain* for email events; trace id, mailbox id, R2 key, hash and size for inbound;
  mailbox, message and thread ids for notifications; key names only for anything unrecognised.
  Identifiers containing `@` are dropped. Existing `dlq.dead_letter` rows written before this
  change still hold the full body and should be purged by hand.

### Fixed

- **Conversation actions leave the other folder's messages alone (2026-11-16).** Archiving, moving
  to Inbox or marking read/unread a conversation from Inbox, Archive or Sent also moved its trashed
  messages (a conversation deleted, then a reply arrived: archiving the reply pulled the old
  messages out of the Trash), and restoring from Trash moved the conversation's live messages too.
  Thread actions now reach only the messages the folder shows: never the trashed ones outside the
  Trash, only those in it, everything in All mail (`POST …/bulk-actions` takes `scope` with
  `threadIds`; absent means outside the Trash). The open conversation's toolbar, Mark unread and
  mark-read-on-open follow the same rule. MCP `update_messages` acts on explicit message ids only and
  was not affected.
- **"Edit as my draft" keeps the HTML body and can no longer leave a duplicate.** The owner's copy
  of an agent's send now carries its HTML body (sanitised by the server like any owner HTML), and
  the agent's request is denied *before* the copy is made: a failed deny makes no copy (the request
  stays waiting), a request already decided elsewhere gets none, and a failed copy after the deny
  leaves the agent's (now unapprovable) draft in Drafts and says so. The agent's attachments are
  not copied; the owner is told.
- **"Delete forever" counts a conversation once.** A conversation whose trashed messages took more
  than one batch was counted once per batch in the operation status and the
  `mailbox.messages_purged` event. Conversations are now counted once per operation (mailbox schema
  v15, `purge_operation_threads`).

- **Sent messages no longer show "(no text content)".** The send path stored the sent copy
  without its body, so the viewer had nothing to render even though the mail went out intact.
  Confirming a draft now stores the draft's text on the copy, and its HTML body in R2 under the
  same key shape an inbound message uses, so the existing sandboxed `/html` route serves it. If the
  R2 write fails the copy keeps its text and the send still counts as sent. Mailbox schema v7
  fills in the text of sent copies that already exist, once per mailbox, by following the
  `sent/<draftId>` key back to the draft. It only touches outbound rows with no body, skips a draft
  that was edited after it was sent, and leaves inbound mail alone. The HTML body of older sent
  copies is not backfilled, because that needs an R2 write the Durable Object constructor cannot
  await.
- **Delivery events for mailbox sends no longer end in the DLQ.** The email-events consumer only
  correlated against `transactional_request_log`, so every lifecycle event for mail confirmed
  from a mailbox (request-send → confirm-send) was logged four times as
  `email_events.unresolved` and dead-lettered. It now falls back to D1 `outbound_sends` by
  provider message id (bare or angle-bracketed) and hands the event to a new internal DO route,
  `/outbound/delivery-event`. The DO checks the id, sender and recipient against its own outbound
  message row, records the event in the idempotent delivery-event ledger, and applies hard-bounce
  and complaint suppressions to the DO mirror and the D1 projection exactly as for transactional
  sends. Events that match nothing still retry and dead-letter as before.
- **`smoke:transactional --wait-delivery` no longer waits for an event that cannot come.** A
  recipient that is a verified Email Routing destination address on the account is delivered
  through Email Routing, which emits no Email Sending lifecycle event, so the wait could only time
  out (and FAIL on a live domain). The smoke now reads the account's destination addresses
  (`CLOUDFLARE_API_TOKEN`) and, for such a `--to`, prints a WARN and skips the wait.
  `INTEGRATING.md` §5 and `OPERATIONS.md` document why feedback liveness can read `unobserved`
  (or, after 24 h, `never_observed`/`went_dark`) for those sends without anything being wrong.
- **A definite provider refusal answers `502`.** The send path wrote `permanent_failure` into a
  column whose CHECK only allows `failed`, so the request errored as a `500`, stayed `pending`
  with its variables, replayed as `202` and was later reconciled to `unknown`. It is now stored
  as `failed` / `errorCode: "permanent_failure"`, variables dropped, and a replay answers `502`.
- **Idempotency no longer depends on variable key order or folds case.** The payload hash is
  now `v2:` over key-sorted variables, case-folding only the recipient. `{b, a}` after `{a, b}`
  replays instead of `409`; a reused key with a token differing only in case is a `409` instead
  of silently replaying the first send. Rows stored with the legacy hash are still compared with
  it, so pre-upgrade retries keep replaying.
- **`key_revoked` / `key_expired` are returned** (after the secret verifies) instead of being
  unreachable behind `invalid_api_key`. Docs no longer list a `duplicate` outcome, which the API
  never returns — a replay answers with the original outcome.
- **Template routes require the mailbox to be yours.** Create, list, revise and archive
  (`/api/mailboxes/:id/transactional/templates[/:templateId[/archive]]`) checked only that the
  caller was an owner of the deployment, while the key routes — and the docs, for both — also
  require the mailbox's `owner_email` to be the caller. Templates decide what a live key sends, so
  they now get the same gate (403 otherwise).
- **`senderName` is accepted when creating an API key.** The create schema had no such field, so
  zod stripped it: the dashboard form's sender name was silently dropped and operators had to
  create then PATCH. It now takes an optional (nullable) `senderName` with the PATCH route's
  header-injection-safe validation and returns it in the response; a bad name answers `400`, not
  `500`.
- **`pnpm run deploy:dev` ships what `setup:sending` wrote.** It ran `wrangler deploy --env dev`
  against the tracked `wrangler.jsonc` and never read `wrangler.generated.<env>.json`, so
  `MAIL_SENDING_DOMAINS` written there never reached the Worker — for any domain — and
  `setup:sending`'s closing text pointed at a different deploy path (`setup:domain`). Both
  `deploy` and `deploy:dev` now run `scripts/deploy.ts`: build, overlay the generated file onto
  `dist/server/wrangler.json`, print every value applied, re-read the file and refuse to deploy if
  it does not carry them, then `wrangler deploy --config dist/server/wrangler.json`. `--dry-run`
  stops at `wrangler deploy --dry-run`. **Precedence:** the generated file wins for the fields it
  owns (`vars` per variable, D1 `database_id`, `send_email[].allowed_sender_addresses`, and
  `routes` + `workers_dev` when `setup:domain` wrote routes); `wrangler.jsonc` wins for everything
  structural, and disagreements there are printed as ignored.
- **`setup:domain` and `setup:cloud` no longer deploy a stale snapshot's bindings.** Their patch
  step copied queues, Durable Objects, migrations and vars wholesale from the generated file — a
  snapshot of `wrangler.jsonc` taken whenever it was first rendered. The live dev one still had a
  single queue producer, so the next `setup:domain --apply` would have deployed without
  `EMAIL_EVENTS_QUEUE` and `NOTIFY_QUEUE` and reopened workers.dev. They now use the same overlay
  as `deploy`, and `setup:cloud` updates the D1 id in an existing generated file instead of
  re-snapshotting over what `setup:sending`/`setup:domain` wrote.
- **Creating an API key through the API no longer loses the key.** The key routes read the
  Durable Object's JSON to project it into D1 and then returned the already-read Response, so every
  successful create answered `500` after the key was stored — the one-time plaintext secret was
  gone and the key had to be revoked. Revoke, rotate and the sender-name PATCH had the same shape.
  The D1 projection was also built from snake_case fields the DO never sends, so it was never
  written by these routes. Covered end to end through the router in
  `tests/integration/transactional-api-key-routes.test.ts`.
- **Transactional mail now carries the key's From display name.** The send path loaded the key
  through a mapper that dropped `sender_name`, so every key sent as a bare address whatever name it
  was configured with (`Eccos <…>` and `Transcribo <…>` went out as the address alone).
- **Wildcard recipient policies match.** `*@example.com` compiled to `\.*@example\.com` — the
  escape ran after the `*` → `.*` substitution and escaped its dot — so a wildcard rule matched no
  real address and an allow-list written that way rejected everyone. `@example.com` was unaffected.
- **Signed-out pages send you to `/login`** instead of a "Failed to load mailboxes: HTTP 401" card
  with no way forward and no session to sign out of.
- **Reccado no longer reads "no delivery event" as evidence about a message.** Delivery outcomes
  arrive through Cloudflare Email Sending event subscriptions, and a sending domain without one
  produces no events for anything — so `delivery_status` stays null forever, an `unknown` never
  resolves, and no bounce or complaint reaches the suppression mirror. Three features consumed that
  silence as evidence, including a runbook row that inferred "no event ever arrived, so most likely
  nothing was sent"; on a domain whose feedback channel was never live, that inference inverts.
  The live account had four enabled sending domains and one subscription. The system now has a
  concept of **feedback liveness per sending domain**: `pnpm setup:sending` creates-or-verifies the
  subscription and exits non-zero rather than reporting success on a domain incapable of its
  documented feature set; `pnpm doctor --cloud` crosses two live provider lists (enabled sending
  domains × subscriptions on the events queue) and checks all three of existence, full event-type
  coverage and destination queue, because existence alone is a false pass; `/api/health` →
  `dependencies.sendingFeedback` and each transactional status response's new `deliveryFeedback`
  field answer the question no config check can — whether events actually arrive — from our own
  send log, with no Cloudflare credential. `unobserved` stays healthy on purpose: too early to tell
  is an absence of evidence, and calling it a fault would repeat the original error backwards.

- **`pnpm doctor --cloud` ran no cloud checks at all.** It crashed on a TDZ `ReferenceError`
  before the first one, so every `--cloud` invocation died with a stack trace instead of a report —
  including the checks that would have passed. The opt-in block now runs below the declarations it
  reads.

- **A failed transactional send no longer answers `200`.** `permanent_failure` and `unknown` were
  returned with HTTP 200 and the failure only in the JSON body, so the obvious integration — throw
  on non-2xx — reported an undelivered message as sent. Nothing undelivered is 2xx any more:
  `permanent_failure` → `502`, `unknown` → `504` (distinguishable without parsing the body, because
  they call for different handling), `accepted` → `202`, and `quota_exceeded` → `429` rather than a
  `403` that gave the caller no reason to retry. The mapping lives in one tested function,
  `httpStatusForTransactionalResult`, instead of a conditional at the response site. **Breaking for
  any existing client**, of which there are none — the transactional API has never been called in
  production.

- **Transactional variables are no longer retained after the send.** `variables_json` was written to
  the mailbox Durable Object before the provider call and never removed, so every verification link,
  password reset and invitation URL a caller passed accumulated indefinitely as live credentials.
  Terminal states now null the column, as does the stale-request reconciler; `payload_hash` and
  status remain, so idempotent replay and conflict detection are unaffected. D1 projections never
  carried the values.

- **Suppressions expire when the reason does.** `addSuppression` always wrote `expires_at` as
  `null`, so the column existed and was honoured at read time but was never populated — a hard
  bounce poisoned an address permanently, with an owner-gated removal as the only way back. Hard
  bounces now expire after 90 days; complaints, manual and provider-rejected entries stay permanent.
  The distinction is the point: a hard bounce is a fact about a mailbox at a moment in time and
  mailboxes come back, while a complaint is a statement of intent by a person and intent does not
  lapse on a schedule.

### Added

- **`pnpm doctor --cloud` compares the tg-hq topic registry with D1 (`cloud.telegram-topics`).**
  For the bound chat, each `telegram_topics` mapping is checked against the thread ids the owner's
  `tg-hq` registry (1Password) records: match, missing from the registry, or thread id mismatch.
  Mailbox-looking registry entries that no D1 row delivers to get a warning. The check is
  read-only and never calls Telegram, and it prints only an info line when `op` is unavailable or
  the bridge is bound to a different chat.
- **Operator control of the Telegram bridge — no raw D1, no second bot.** Four owner-session
  routes under `/api/telegram/*` that use the worker's own (write-only) bot token, and the
  commands that drive them:
  - `GET /api/telegram/status` / `pnpm operator telegram status`: the bot's id and @username
    (`getMe`), the bound chat as stored and as Telegram sees it, the bot's status and
    `can_manage_topics` there, the tracked webhook state, and each active mailbox's topic.
    Read-only toward Telegram; topics are reported unverified, because the only probe
    (`editForumTopic`) renames.
  - `POST /api/telegram/rebind` / `pnpm operator telegram rebind --chat <id> [--apply]`: the
    audited override of the sticky `/start` adoption. Checks the chat and the bot's rights first,
    writes `telegram.chat_id`, `telegram.chat_is_forum` and a `telegram.rebound` ops_event in one
    D1 batch, keeps the old chat's topic mappings.
  - `GET|POST /api/telegram/topics` / `pnpm operator telegram topic <mailbox> (--name … |
    --adopt <threadId>) [--replace] [--apply]`: create a named topic or adopt an existing thread,
    idempotently, 409 on a different mapping unless `--replace`.
  - `POST /api/telegram/test` / `pnpm smoke:telegram [--mailbox …]`: one labelled test message per
    mailbox through the real card send path, reporting `delivered_to_topic |
    fell_back_to_general | delivered_to_chat | failed` from the `message_thread_id` Telegram
    returns. Creates no reply link and no topic.
- **Topic names independent of the mailbox display name** (migration
  `0020_telegram_topic_name.sql`, nullable `telegram_topics.topic_name`). A stored name wins over
  `display_name` — the From name of the mailbox's replies — and survives the self-heal that
  recreates a deleted topic; NULL keeps the previous behaviour. **Apply the migration before
  deploying**: the card path reads the column.
- **`pnpm onboard` maps the mailbox's forum topic** with an optional
  `telegram: { topicName?, adoptThreadId? }` manifest block and a `telegram:topic` step
  (idempotent; blocked with a remedy when no forum is bound; never replaces a mapping).
- **`docs/INTEGRATING.md` — the integrator's guide to the transactional API.** Written from the
  code for a product team sending through Reccado: who provisions what (mailbox on the zone,
  sending identity on `send.`), one endpoint per mailbox with the key selecting the environment,
  the mandatory `Idempotency-Key` and its replay/conflict rules, a table of every `status`/`error`
  with its HTTP code and the right reaction (branch on `error`, never on `status` alone), the
  status endpoint and `deliveryFeedback`, template syntax/escaping/exact variable sets and repo
  sync, key scopes/policy/quota/rotation, and suppressions. Linked from the README and
  `OPERATIONS.md`.
- **`pnpm onboard` — onboard a product from one JSON manifest.** Replaces the ~12 hand-run steps
  (setup:sending for `send.<zone>` and the apex, `MAIL_SENDING_DOMAINS`, Email Routing rules,
  domain / mailbox / aliases, template sync, API keys, the 1Password item) with
  `pnpm onboard --env <env> --manifest <file> [--host <host>] [--apply]`. The manifest is
  validated with zod up front (addresses on the zone, key senders on a provisioned name, recipient
  policies through `validateRecipientPolicy`, key bodies through the create route's own schema;
  `templates: "all"` = every id in the templates file). **Dry-run by default**: every step reads
  current state (wrangler reads, public DNS over DoH, control-plane GETs, only the `key id` /
  `RECCADO_ENDPOINT` fields of 1Password items) and reports `already` / `would do: <action>` /
  `blocked: <reason>` with a remedy, writing nothing. `--apply` performs the missing steps in
  dependency order with provision.ts's `already | done | skipped | blocked | failed`; a step that
  cannot run skips only its dependents, and a second run is all `already`. Email Sending is
  applied through `setup:sending --apply`; routing only creates missing literal rules and reports a
  same-matcher/different-action rule as blocked (the catch-all is never touched); keys are
  idempotent through the stored `key id` — a revoked/missing stored key is blocked, never a silent
  second mint, a key without a `store` is refused, the plaintext reaches `op item create --template` through a
  0600 temp file deleted in `finally` (never argv) and is never printed, and a key whose storage fails is revoked. Onboard never deploys: when the
  generated config changed or the live Worker lacks a sending name, the report says a deploy is
  required and prints `pnpm run deploy:dev --dry-run`. Placeholder manifest in
  `examples/onboard/`; see docs/OPERATIONS.md "Onboarding a product".
- Shared pieces factored out of the setup scripts for it, behaviour unchanged:
  `scripts/lib/sending-config.ts` (the generated-config write `setup:sending` performs),
  `scripts/lib/wrangler-cli.ts` (its token-stripping wrangler subprocess), and
  `scripts/lib/routing.ts` (the literal-rule argv `setup:routing` uses, plus parsers for
  `wrangler email routing rules list` / `settings`).

- **`pnpm smoke:transactional` — an end-to-end smoke test against a deployed environment.** The
  four transactional bugs fixed above shipped with every unit/integration test green because those
  tests call the mailbox Durable Object directly; this drives the real HTTP surface instead, as
  the operator (`pnpm operator` session, `/api/*`) and as an integrator (Bearer key, `/v1/*`).
  Without `--send` it only checks the session and that the mailbox answers, and prints the plan.
  With `--send` it creates a throwaway template and a narrow LIVE key (recipient policy = exactly
  `--to`, quota 5, expires in 1h), asserts 201 + `plaintextKey` + listed, sets `senderName` via
  PATCH, sends one real message, replays it with the same `Idempotency-Key` (same `requestId` and
  `providerMessageId`), proves an off-policy recipient is refused `not_allowed_by_policy`, reads
  status and `deliveryFeedback` (optionally polling with `--wait-delivery N`; silence is only a
  failure when feedback liveness is `live`), and always revokes the key and archives the template,
  printing hand-cleanup commands if that fails. The plaintext key is never printed. Pure logic in
  `scripts/lib/smoke-transactional-core.ts`, tested in `tests/unit/smoke-transactional.test.ts`.

- **`pnpm operator login|whoami|logout` — control-plane sessions from the terminal.** Automates
  the pairing-code rescue: mints a single-use 256-bit code into `owner_pairing_codes` via
  `wrangler d1 execute` (only if the email is already in `owner_identities`, unless
  `--allow-new-owner`), spends it at `/api/auth/pairing`, verifies it with `get-session`, and
  stores only the Better Auth session cookie in `~/.config/reccado/sessions/<host>.json` (0600 in
  a 0700 dir). A failure after minting force-expires the code. `logout` signs out server-side and
  deletes the file even if that fails. The reusable API (`login`, `loadSession`, `logout`,
  `operatorFetch`, `operatorJson`, typed `OperatorAuthError` on 401) lives in
  `scripts/lib/operator-session.ts` for later operator scripts. Neither the code nor the cookie is
  ever printed.
- **Idempotent template sync: `PUT /api/mailboxes/:id/transactional/templates`.** A product that
  owns its templates in a file sends `{ templates: [{ id, subject, body_text?, body_html? }],
  archiveMissing? }` on every deploy and gets per-id outcomes — `created`, `unchanged`, `updated`
  (in place), or `archived`. An archived id in the list is reported (`already_archived`) and left
  alone rather than revived; `archiveMissing: true` archives active templates not in the list
  (`missing_from_sync`), the default never archives. The whole batch (max 100, no duplicate ids,
  the create route's per-template rules) is validated before any write, and the writes run in one
  DO transaction, so a bad entry changes nothing. Session + D1 owner gated like the key routes.
- **Router-level coverage of the From display name** —
  `tests/integration/transactional-send-route.test.ts` sends through `/v1/.../messages` and
  asserts the provider received `from: { name, email }`.
- **`setup:sending --apex`** (or `--subdomain @`) provisions Email Sending on the zone apex, for a
  mailbox on the organizational domain that replies as itself — previously rejected and done by
  hand. Same enable / SPF / DKIM / MX / 6-event subscription / `MAIL_SENDING_DOMAINS` steps; the
  apex DMARC governs every sender on the domain, so `--dmarc-policy` is required there, the
  current record is printed next to the planned one before Email Sending auto-creates its
  `p=reject`, and a `rua` the new record would drop is called out. Dry-run stays the default.
- **`pnpm doctor --cloud` checks the deployed `MAIL_SENDING_DOMAINS` against Email Sending**
  (fail: an entry not enabled in the account; warn: an enabled domain subscribed to the events
  queue but not declared) **and each `_dmarc.<name>`** over DNS-over-HTTPS (warn on the provider's
  auto-created `v=DMARC1; p=reject;`, on `quarantine`/`reject` without `rua`, and on zero or
  multiple records). Offline `pnpm doctor` gains `config.deploy-overlay`, which shows what the
  generated file overrides at deploy time.
- **Telegram: one forum topic per mailbox, not per email thread.** When the bound chat is a
  supergroup with forum mode, each mailbox gets a topic named after the mailbox. Previously a
  topic was created per email thread, named with the email's subject — which let anyone who sent
  mail write the permanent labels in the operator's Telegram sidebar, and tied topic creation to
  unbounded inbound volume. Forum support is now detected via `getChat` at `/start` and cached in
  `runtime_config`, replacing the `TELEGRAM_TOPICS` flag (removed). Replies resolve only through
  `reply_to_message`: a topic now holds many conversations, so "the newest card in this topic"
  would answer the wrong email. A deleted topic self-heals — the stale mapping is dropped, the
  topic recreated, and the card re-sent once.

- **Control-plane API reaches parity with the CLI.** `PATCH` and `DELETE` on mailboxes, domains,
  aliases and routing rules, and `POST /api/mailboxes` now creates the alias for its own primary
  address when the domain is registered. Delete is soft where other rows or stored data depend on
  the identity (mailboxes, domains) and hard where the row is pure configuration (aliases, routing
  rules). See `docs/IMPLEMENTATION.md` for the reasoning.

- **A disabled mailbox stops receiving mail.** `resolveRoutingForRecipient` now treats a mailbox's
  own status as authoritative over the alias and routing rows that point at it, rejecting with
  `mailbox_disabled`. Previously a disabled mailbox kept accepting mail, which would have made
  `DELETE /api/mailboxes/:id` a lie, and a fall-through to the domain catch-all would have quietly
  diverted someone's mail into a different mailbox.

- **Cloudflare Email Sending lifecycle integration.** Email Sending event subscriptions feed the
  `inbox-mcp-email-events` Queue. Delivery, deferred, bounce, rejection, complaint, and failure
  events update canonical transactional delivery state; hard bounces and complaints create
  mailbox-DO suppressions that block future sends. Events are idempotent and unresolved/poison
  messages retry to the configured DLQ.

- **Transactional API (Phase 2 — MVP).** External REST API at `/v1/mailboxes/:id/transactional/messages`
  for programmatic outbound sending with:
  - HMAC-authenticated API keys (`rck_<env>_<id>_<secret>`) with scopes
    (`transactional:send`, `transactional:status`, `transactional:templates:use`),
    per-key quotas and rate limits, template allowlists, and recipient policies.
  - API key management (create, list, revoke, rotate) via the DO's internal routes.
  - DO-authoritative auth and state — D1 is only a rebuildable projection.
  - Atomic idempotency via `(key_id, client_idempotency_key)` with payload hash verification.
    Same payload returns original result; different payload returns `409 Conflict`.
    Request record is inserted BEFORE the provider call at status `pending`.
  - Template CRUD (create, list, archive) per mailbox, with variable interpolation
    (HTML-escaped for `body_html`, literal for text), variable validation (missing/unknown),
    and subject CR/LF rejection.
  - Provider outcome classification: `sent`, `permanent_failure` (definitely not delivered),
    `unknown` (ambiguous — preserved for human review, never auto-retried).
  - Status endpoint (`GET /v1/mailboxes/:id/transactional/messages/:requestId`)
    scoped to `transactional:status`.
  - Quota enforcement with atomic per-key minute and daily counters in the DO
    (no D1 dependency for quota decisions).
  - Rejection: missing/invalid auth, expired/revoked keys, wrong mailbox, insufficient scope,
    missing template, template not allowlisted, missing/unknown variables, CR/LF in subject,
    quota exceeded, recipient policy deny, test keys in production send path.
  - Security: `Cache-Control: no-store` on all responses, JSON-only content-type check,
    body size limit (100 KB), no CORS, no Access dependency, no Reply-To/headers from client.
  - `TRANSACTIONAL_API_KEY_PEPPER` secret required to enable transactional features.
  - Test keys (`environment=test`) are rejected in the production send path — they must not
    silently send real email without a test/simulation sink.
  - Provider error messages are NEVER stored; only stable error categories
    (`ambiguous`, `permanent_failure`) are persisted.

### Added

- **Telegram bridge (optional, off by default).** Inbound mail is pushed to a Telegram chat as a
  preview card (sender, subject, snippet — never the full body, which would put 2FA codes into a
  cloud chat), and replying to that card drafts an email reply. The reply still goes through the
  existing draft → request-send → confirm-send flow, now surfaced as inline ✅/✖️ buttons, and
  through the same send path as the web UI. Threading resolves via `reply_to_message`, or via one
  forum topic per email thread when `TELEGRAM_TOPICS=1`. The webhook lives outside the `/api/*`
  perimeter (Telegram can present neither an Access JWT nor an `Origin` header) and authenticates
  with a constant-time secret-token check plus a Telegram user allowlist; the bridge refuses to
  start half-configured. See the README for the Cloudflare Access bypass this requires.
- `MAIL_SENDING_DOMAINS`: mailboxes on a domain verified in Cloudflare Email Sending now reply as
  themselves instead of as the single global `MAIL_FROM_ADDRESS`.
- The Telegram webhook registers itself: the hourly cron (`reconcileTelegramWebhook`) compares
  what Telegram believes against this deployment's origin and re-registers on drift. The worker
  learns that origin by observing a request that already cleared Cloudflare Access, and the
  webhook secret is an HMAC of the bot token, so no URL and no secret is ever configured by hand.
- The bot adopts its chat on the first `/start` from an allowlisted user and stores it in D1
  (`runtime_config`), first writer wins. `/start` now also answers *unauthorized* users with
  their own user id, so a first-time operator can learn the id they need for
  `TELEGRAM_ALLOWED_USER_IDS` instead of getting silence.
- **MCP endpoint (`/mcp`) — read/search/draft only.** Access-authenticated (requires
  `ACCESS_ALLOWED_EMAILS`, fails closed with `503` when unset). Exposes `list_mailboxes`,
  `list_threads`, `search_messages`, `read_message`, and `draft_reply`; there is deliberately no
  send/cancel tool (`src/mcp/*`, with a closed-operation `McpMailboxFacade` and a security test
  asserting no send path is reachable). `pnpm setup:mcp-claim` backfills `mailboxes.owner_email`
  for pre-existing mailboxes so MCP can serve them.

### Known limitations

- Telegram replies go to the original sender only (no reply-all) and are sent from the mailbox's
  primary address even when the mail arrived at an alias.
- Attachments cannot be sent from Telegram.
- `request-send` now refuses to move a `sent` or `cancelled` draft back to `pending_confirmation`,
  so a retried Telegram update can no longer resurrect mail that already went out.

### Known limitations (transactional API)

- Cloudflare Email Sending event subscriptions must be configured separately for each sending
  domain; Wrangler queue bindings alone do not create the subscription. Cloudflare's account
  suppression list remains upstream authoritative; Reccado's DO suppression list is a local
  enforcement mirror and does not automatically unsuppress recipients.
- Test keys (`environment=test`) are rejected in the production send path. A simulated/test sink
  for test-mode delivery does not exist yet; test keys only work for creation/listing/revocation
  operations.
- Stale transactional-request reconciliation remains manual-review-oriented: it flips stuck
  `pending`/`sending` rows to `unknown` and never retries delivery automatically.

### Removed

Configuration surface that the system can decide for itself, deleted rather than deprecated. Every
one of these was a value a human had to invent, store and keep in sync, and every one of them had a
failure mode where the deployment looked configured and silently did nothing.

- **`MAILBOX_ID_SECRET` (worker secret).** Mailbox ids are no longer an HMAC of the primary
  address: they are 16 random bytes assigned by the `INSERT` that creates the row
  (`INSERT ... ON CONFLICT(primary_address) DO NOTHING` + re-read), with D1 as the only source of
  truth. Nothing at runtime ever recomputed an id — ingest resolves the mailbox by D1 lookup — so
  the secret only bought offline recomputation at the price of making one write-only value part of
  the identity of every mailbox. The id format (`mbx_` + 26 base32url chars) is unchanged, so
  existing rows, R2 keys and Durable Object names stay valid and no migration is required. Gone
  with it: `wrangler secret put MAILBOX_ID_SECRET`, `setup:cloud --reset-secret`,
  `setup:mailbox --secret`, the `mailboxSecretFingerprint` field in `.reccado/setup.<env>.json`
  (the manifest keeps every other field), the `devvars.mailbox-secret`, `cloud.secret.mailbox` and
  `cloud.mailbox-secret-recovery` doctor checks, and the whole "orphaned secret" / "rotating the
  secret invalidates every derived mailbox id" class of failure, which can no longer occur.
- **`TELEGRAM_WEBHOOK_SECRET` (worker secret).** Derived instead of configured:
  `HMAC-SHA256(TELEGRAM_BOT_TOKEN, "reccado:telegram:webhook-secret:v1")` (`deriveWebhookSecret`,
  `src/telegram/api.ts`). The only two parties that need this value are the worker and Telegram,
  so asking a human to invent one, store it as a secret and re-supply it to a script was three
  manual steps for a number with no human meaning — and the step everyone forgot, which is how the
  bridge stayed dead in production without a word. It is deliberately not persisted in D1: it is
  what stops a forged update from sending mail, and the allowlist such an update must satisfy is
  itself a D1 row. Rotating the bot token now rotates it automatically.
- **`TELEGRAM_CHAT_ID` (var).** Auto-adopted instead of declared: the first `/start` from an
  allowlisted user writes the chat to `runtime_config` in D1, first writer wins — a later `/start`
  from another chat does not move the binding, and the bot says so. The value always arrived inside
  the update, so the old flow had the bot print the chat id and ask the human to copy it into a
  config file and redeploy: the system observing a value, telling a human, and asking that human to
  tell it back.
- **`scripts/setup-telegram.ts` / `pnpm setup:telegram`.** Replaced by the hourly cron
  reconciliation (`reconcileTelegramWebhook`, `src/telegram/registration.ts`). Telegram onboarding
  is now: create the bot and set `TELEGRAM_BOT_TOKEN`, put your user id in
  `TELEGRAM_ALLOWED_USER_IDS`, deploy, load the authenticated UI once (that is how the worker
  learns its own public origin — only ever from a request that cleared Access, because the `Host`
  header is forgeable and that value decides where Telegram delivers), then send `/start`.
  `GET /api/health` reports `dependencies.telegram` with `mode: off | partial | on` and a `missing`
  list, so a bridge that is not yet delivering says what it is waiting for.

The allowlist (`TELEGRAM_ALLOWED_USER_IDS`) stays configuration on purpose: declaring whom you
trust is not derivable, and whoever can drive the bot can send mail as the operator.

### Fixed

- **Outbound replies now thread.** `confirm-send` sent no `In-Reply-To`/`References`, so a reply
  appeared as a loose message in the recipient's client; and it minted a fresh thread id per send,
  so the reply also detached from its own conversation inside Reccado. Replies now reuse the
  draft's thread, carry the RFC 5322 reply headers, and upsert the thread row instead of inserting
  a duplicate.
- Sent messages now store the `Message-ID` Cloudflare assigned (it is a platform-controlled
  header — a caller-supplied one is rejected as restricted) in the mailbox and the D1 index.
  Without it, the answer to a reply matched nothing in `resolveThreadId` and forked a new thread on
  every round trip.
- Outbound thread subjects are normalized with `normalizeSubject` rather than a raw `toLowerCase`,
  so `Re:`-prefixed replies no longer defeat subject-based thread matching.
- A reply sent from a mailbox on an unverified domain now sets `Reply-To` to the mailbox address,
  so responses come back to the address the human wrote to.

### Security

- Debug endpoints (`/api/debug/phase0/*`) now fail closed: they are unreachable unless
  `PHASE0_DEBUG_TOKEN` is explicitly configured, and requests are compared against it in
  constant time. Previously, an unset token left these endpoints open.
- Attachment and raw-message downloads are now served with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, and a sandboxing Content-Security-Policy, preventing stored
  attachment content (including inbound HTML/script content) from executing in the browser
  origin.
- `seedDevData` (the dev-only `test@example.com` mailbox/domain/alias scaffolding) is no longer
  invoked implicitly from the production inbound email path; seeding now requires an explicit
  opt-in and is a no-op by default.
- Added an optional `ACCESS_ALLOWED_EMAILS` owner allowlist, enforced on top of Cloudflare
  Access, so a shared Access org doesn't implicitly grant every authenticated identity full
  mailbox access.
- Added an inbound email size cap (~25 MiB, matching Cloudflare's Email Routing inbound limit)
  enforced before the raw message is buffered/stored.
- Added baseline security response headers (`X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy`) and an Origin-check CSRF defense on mutating
  `/api/*` routes.
- Added stale outbound-send reconciliation in the scheduled (Cron) handler: `outbound_sends` rows
  stuck in `sending` past a timeout are flipped to `unknown` with
  `error_code='stale_sending_timeout_needs_review'` and a clear `ops_events` trail instead of
  blocking idempotent retries indefinitely (manual review required).

### Tooling & docs

- Pinned wrangler moved 4.106.0 → 4.127.1, which is the version that first exposes
  `--source email.sending` on `queues subscription create` (plus `--zone-id`/`--domain`) and a
  `--json` mode on `queues subscription list`. That turns the per-domain Email Sending event
  subscription from a dashboard-only step into something the setup scripts can create and verify.
  `pnpm setup:sending` still probes the CLI's own `--help` before shelling out, so an older
  wrangler yields "unresolved, here is the exact command" rather than an opaque failure.
- Added `PRODUCTION-READINESS.md` to declare the current production claim honestly and record the
  remaining gaps that still keep Reccado at `READY-WITH-CAVEATS` rather than an unqualified
  production-ready status.
- Updated `docs/ARCHITECTURE.md` status language so it reflects the current repo state: Tier A and
  the minimal MCP read/search/draft endpoint are implemented, while the rest of Tier B
  (Workflows, EmailAgent drafting, RAG/Vectorize, AI Gateway) remains roadmap-only.
- Docs now reflect the actual state of the transactional API (Phases 2–4 of
  `docs/plans/transactional-api.md`): HMAC/pepper API keys, Access+owner-gated admin routes,
  versioned template CRUD, `POST/GET /v1/.../transactional/...` with Bearer +
  `Idempotency-Key` + scopes/limits/quota, test-key rejection for sending, `unknown` → no
  auto-retry, non-authoritative D1 projections, log redaction, no CORS/query/cookies, and the
  Cloudflare Email Sending event subscription setup and no simulated delivery sink for test keys.
  `SECURITY.md`, `README.md`, `docs/OPERATIONS.md`, `AGENTS.md`, and
  `PRODUCTION-READINESS.md` were updated; the MCP/UI/Telegram human-confirm gate is unchanged and
  Tier B (Workflows, EmailAgent, RAG) is not claimed as implemented.
- Added Biome for linting/formatting (`pnpm lint`, `pnpm format`, `pnpm format:check`) and a
  combined `pnpm check` (typecheck + lint + test) script; wired into CI alongside a Worker
  bundle dry-run deploy check and a check that generated artifacts
  (`worker-configuration.d.ts`, `src/routeTree.gen.ts`) are committed and up to date.
- Pinned a minimum Node engine (`>=22.12.0`) in `package.json`.
- Added a `d1:migrate:prod` script and split production D1/R2/Queue resource names from the `dev`
  environment's; the default (production) environment now sets `workers_dev: false` so it isn't
  reachable on the shared `*.workers.dev` subdomain.
- Restructured `README.md` into a full product README (features, architecture diagram,
  quickstart, deploy guide, configuration reference, compatibility, troubleshooting).
- Added `SECURITY.md`, `CONTRIBUTING.md`, `SKILL.md`, `CHANGELOG.md`, and `docs/OPERATIONS.md`.
- Split `AGENTS.md` into durable invariants vs. one-time build/process notes, and scrubbed
  maintainer-specific Cloudflare resource literals (D1 database ID, account/worker URLs) in favor
  of placeholders.
- Marked `docs/validation/PHASE0_VALIDATION.md` and `docs/validation/PHASE1_VALIDATION.md` as historical
  build-validation logs rather than current operating docs.
- Fixed a stale "Inbox MCP" UI string (the product was renamed to Reccado).

### Self-host setup hardening

- `setup:cloud` now checks the inbound queue's consumer before deploying and aborts with the exact
  `wrangler queues consumer remove <queue> <old-worker>` fix if a different Worker (e.g. left over
  from a rename) is still registered as its consumer, instead of letting deploy fail with a
  generic error.
- `setup:mailbox` resolves the domain row by name and reuses it instead of assuming a fresh insert,
  so reseeding an env with pre-existing (including foreign-key-owning) domain rows is idempotent
  rather than failing.
- `setup:routing` adds `--catch-all`, which configures `*@<domain> -> Worker` via Cloudflare's
  Email Routing REST API (`PUT .../rules/catch_all`) because Wrangler currently rejects that rule
  shape client-side even though the platform endpoint supports it.
- Added `setup:domain`: attaches a custom domain to a Worker env through a generated, gitignored
  Wrangler config (never edits the tracked `wrangler.jsonc`). Idempotent for the same Worker;
  refuses to reattach a hostname already claimed by a **different** Worker, checked up front via
  the Workers Custom Domains API when `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are available,
  falling back to an error-string guard around `wrangler deploy` otherwise.
- Added `setup:sending`: provisions a dedicated Cloudflare Email Sending subdomain (`send.<domain>`
  by default) and writes `MAIL_FROM_ADDRESS` + `allowed_sender_addresses` into the generated
  config. Prints a prominent Workers Paid preflight (arbitrary-recipient sending needs a paid plan;
  free-plan accounts are limited to verified destinations). DMARC defaults to `p=none` (monitor
  mode, relaxed alignment) as the start of a documented none → quarantine → reject ramp
  (`--dmarc-policy`, `--dmarc-alignment relaxed|strict`, `--dmarc-rua`). With
  `CLOUDFLARE_API_TOKEN` it also auto-adds the provider-generated DKIM + MX records (parsed from
  `wrangler email sending dns get`, an open-beta command with no `--json` mode) unless
  `--skip-provider-records` is passed; SPF and DMARC remain exclusively script-owned, so the
  provider's own suggested DMARC record (typically `p=reject`) is never applied.
- Aligned the `workers.dev` vs. custom-domain narrative across `doctor`, `setup:domain`, and
  `setup:access`: the `dev` environment keeps `workers_dev: true` only for local-to-cloud smoke
  tests, and Access verification is only ever treated as valid against a custom domain.

## [0.1.0] — Phase 1: Tier A inbox complete

Initial senior-validated milestone: a usable self-hosted inbox without any AI/agent layer.

### Added

- **Inbound hot path**: Cloudflare Email Routing → R2 (raw MIME) → Queue (metadata-only,
  &lt;128 KiB) → mailbox Durable Object, with idempotent ingest (Message-ID + raw-hash dedupe),
  Message-ID conflict detection, and a Dead Letter Queue for poison messages.
- **Mailbox Durable Object store**: one Durable Object (SQLite storage) per mailbox owns
  messages, threads, labels, contacts, drafts, outbox, idempotency records, and a SQLite FTS5
  full-text search index.
- **HTTP API + UI**: Hono API under `/api/*` and a TanStack Start inbox UI (mailbox list, thread
  view, message detail, search, raw view, attachments, compose).
- **Realtime**: hibernatable WebSocket connections (`/api/mailboxes/{mailboxId}/ws`) push new
  mail and state changes into open UI sessions without polling.
- **Human-confirmed outbound sending**: drafts go through an explicit
  `request-send` → `confirm-send` flow with an idempotency key before `env.EMAIL.send()` is
  called; sent messages are indexed and audited in D1 (`outbound_sends`).
- **Multi-domain routing**: per-domain store/forward/reject routing rules, with isolated
  mailboxes per address; validated against two real Cloudflare-managed domains.
- **Backup and ops**: scheduled (Cron) backup sweep writing per-mailbox manifests to R2, plus
  admin endpoints for ops events, DLQ inspection, and D1 reindexing from Durable Object state.
- **D1 control-plane index**: `domains`, `mailboxes`, `aliases`, `routing_rules`, `message_index`,
  `ingest_events`, `outbound_sends`, and `ops_events` — a rebuildable cross-mailbox index, not the
  source of truth (the mailbox Durable Object is).
- D1 migrations `migrations/d1/0001_initial.sql` and `migrations/d1/0002_message_index.sql`.

### Notes for self-hosters

- Schema/migration changes in this and future releases matter for anyone running their own
  instance: always run the `wrangler d1 migrations apply` step (`d1:migrate:local` /
  `d1:migrate:dev` package scripts) after pulling a release that touches `migrations/d1/`, and
  review new migrations before applying them to a database with real mail in it.
- Validated end-to-end against real Cloudflare resources in a `dev` environment; see
  `docs/validation/PHASE0_VALIDATION.md` and `docs/validation/PHASE1_VALIDATION.md` for the historical validation
  record (debug tokens, deployment names, and account identifiers in those files are the
  maintainer's own and have since been redacted/placeholder'd where they leaked into current
  docs).

[Unreleased]: https://github.com/santigamo/reccado/compare/main...HEAD
[0.1.0]: https://github.com/santigamo/reccado/releases/tag/v0.1.0
