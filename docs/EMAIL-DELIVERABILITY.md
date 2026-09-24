# Email Deliverability And Domain Strategy

Reccado can receive and send mail for your domain, but the Worker is only one part of
deliverability. The harder problem is reputation isolation: choosing which domains and subdomains
carry transactional mail, experiments, bulk mail, and inbound aliases so a mistake in one stream
does not poison everything else.

This page is the recommended baseline for self-hosters wiring a real domain.

## Core rules

- Use **different subdomains for different outbound streams**.
- **Never** run bulk mail, cold outreach, or experiments from your apex domain.
- Keep **inbound identity** and **outbound reputation** separated unless you have a very small,
  tightly controlled setup.

## Recommended domain layout

Example for `example.com`:

| Use | Recommendation | Why |
| --- | --- | --- |
| Product/site | `example.com` | Keep the apex clean for your brand and core DNS. |
| Human inbound mail | `inbox@example.com`, `support@example.com` | Stable addresses people reply to. |
| Transactional outbound | `tx.example.com` or `mail.example.com` | Isolates receipts, login mail, and product notifications from marketing risk. |
| Marketing / newsletters | `news.example.com` | Lets you pause or damage-control this stream without hurting transactional mail. |
| Experiments / bulk / cold traffic | `lab.example.com` or another disposable subdomain | Keeps risky tests away from your brand and core sender reputation. |

The exact labels do not matter. The separation does.

## Inbound vs outbound

Inbound routing answers "where should mail for this address land?" Outbound reputation answers
"how much should receivers trust mail signed from this sender domain?"

Do not collapse those into one decision unless the volume is tiny.

- Reccado's inbound side can happily receive mail for your primary addresses.
- Your outbound side should use a **verified sending subdomain** in Cloudflare Email Sending.
- Set `MAIL_FROM_ADDRESS` to an address on that sending subdomain once it is verified.

Practical default:

- receive at `example.com`
- send transactional mail from `send.example.com` or `mail.example.com`
- send marketing from `news.example.com`

That way a newsletter mistake does not drag down password resets or human replies.

## Scripted Sending Setup

Use `pnpm setup:sending` before you deploy real replies:

```bash
pnpm setup:sending --env dev --domain example.com
pnpm setup:sending --env dev --domain example.com --dmarc-rua you@example.com --apply
```

Defaults:

- sending domain: `send.example.com`
- sender address: `hello@send.example.com`
- DMARC policy: `p=none` (monitor mode) with relaxed alignment (`adkim=r; aspf=r`) — the start of
  the ramp described below, not the end state

Every run also prints a **Workers Paid** preflight: Email Sending on a free plan can only send to
verified destination addresses, and this script cannot detect your plan for you.

The script enables Cloudflare Email Sending for the sending subdomain, writes
`MAIL_FROM_ADDRESS` (kept if already set, unless `--set-default-from`) and the
`MAIL_SENDING_DOMAINS` union into `wrangler.generated.<env>.json`, adds the sender to
`send_email[].allowed_sender_addresses` only with `--restrict-senders` (or an existing list), and upserts SPF (always) and DMARC (per the ramp) when
`CLOUDFLARE_API_TOKEN` has DNS edit access — the two records it keeps under its own control. That
token only needs **Zone · DNS · Edit** (plus **Zone · Read** to resolve the zone); it does *not*
need account or Email Sending scope, because the `wrangler email sending` calls authenticate with
your `wrangler login` session, not the token — the script strips the token from wrangler's env so
the two never collide.

With that same token, it also **auto-adds the provider-generated DKIM TXT + MX records**, parsed
from `wrangler email sending dns get <sending-domain>` (there's no `--json` mode for this open-beta
command, so the script parses its plain-text output). Pass `--skip-provider-records` to opt out and
manage those two by hand instead. Enabling Email Sending also makes Cloudflare **provision its own
DMARC record** for the sending subdomain (typically `p=reject`). Two DMARC records at one name are
invalid — RFC 7489 then treats the policy as absent — so the script reconciles DMARC to exactly one
record (its own ramp record below), deleting Cloudflare's rather than leaving a broken pair. Review
what Cloudflare says after enabling the sending domain:

```bash
pnpm wrangler email sending dns get send.example.com
pnpm wrangler email sending settings send.example.com
```

After `setup:sending`, ship it — nothing it writes reaches the running Worker until a deploy
overlays `wrangler.generated.<env>.json` onto the build:

```bash
pnpm run deploy:dev --dry-run   # build + overlay for real, prints every value applied, uploads nothing
pnpm run deploy:dev             # or `pnpm run deploy` for the top-level (production) config
pnpm doctor --env dev --cloud   # deployed MAIL_SENDING_DOMAINS vs Email Sending, and each _dmarc
```

The generated file wins for the fields it owns (vars, D1 id, sender allow-list, custom-domain
route); `wrangler.jsonc` wins for every binding and queue. Raw `wrangler deploy` reads only the
tracked config and ships none of it.

### Sending from the zone apex

A mailbox on the organizational domain itself (`support@example.com`) that should reply as itself
needs Email Sending on `example.com`, not on a subdomain:

```bash
pnpm setup:sending --env dev --domain example.com --apex --from-local-part support \
  --dmarc-policy none --dmarc-rua dmarc@example.com            # dry run; add --apply
```

Everything else is identical to a subdomain (SPF/DKIM/MX on `cf-bounce.example.com` /
`cf-bounce._domainkey.example.com`, the 6-event subscription, the `MAIL_SENDING_DOMAINS` union), but
`_dmarc.example.com` governs **every** sender using `@example.com` — your personal mail, other
SaaS, and any subdomain without its own record. So for the apex:

- `--dmarc-policy` is **required**; there is no default.
- The current apex record is resolved and printed next to the planned one *before* Email Sending is
  enabled (enabling it auto-creates `v=DMARC1; p=reject;`), and a `rua` the new record would drop is
  called out — pass `--dmarc-rua` to keep reports flowing.
- The Worker's own DMARC ramp (`src/lib/dns-gate.ts`) still never acts on an apex; this is a human
  declaration at the CLI.

`pnpm doctor --cloud` resolves `_dmarc.<name>` for every deployed `MAIL_SENDING_DOMAINS` entry and
every sending domain subscribed to the events queue, and warns on the provider's
`v=DMARC1; p=reject;` signature (enforcing, no `rua`, chosen by nobody) and on any
`p=quarantine`/`p=reject` without `rua`.

## Reputation isolation by stream

Reputation is earned per sender pattern, not per app feature.

Split streams when any of these differ:

- recipient intent
- volume
- complaint risk
- bounce risk
- content style

Typical split:

1. `mail.example.com` or `tx.example.com` for transactional mail only
2. `news.example.com` for opted-in broadcast mail
3. `lab.example.com` for experiments, QA, seed lists, and anything you would be comfortable
   burning down and rebuilding

Do not send cold outreach, list imports, or warm-up traffic from the same subdomain that carries
login codes, receipts, or support replies.

## DMARC ramp

Do not jump straight to strict enforcement on a fresh setup. `pnpm setup:sending` defaults to
`p=none` for exactly this reason, and reconciles DMARC to a single record so Cloudflare's own
auto-provisioned `p=reject` record can't sit alongside it and either override the ramp or break
DMARC entirely (see above).

Recommended ramp, driven by `setup:sending`'s flags:

1. Start at `p=none` (the default — `--dmarc-policy none`, or just omit the flag) with relaxed
   alignment (`adkim=r; aspf=r`, the default). Pass `--dmarc-rua you@example.com` so you actually
   receive aggregate reports — without an `rua` address, monitor mode gives you no visibility into
   DKIM/SPF alignment, and the script warns loudly if you skip it.
2. Confirm SPF, DKIM, alignment, and real-world pass rates from those reports.
3. Move to `--dmarc-policy quarantine`.
4. Move to `--dmarc-policy reject` only after the stream is stable.

Tighten alignment with `--dmarc-alignment strict` once you're confident DKIM/SPF consistently
align — relaxed is the safe default for a subdomain that hasn't been observed yet.

Use DMARC aggregate reports while ramping. The goal is to learn what is actually sending as your
domain before you tell receivers to reject failures aggressively.

## Warm-up

New sending subdomains need gradual volume and clean list hygiene.

- Start with low-volume, high-engagement traffic
- Prefer real transactional mail first
- Avoid sudden bursts
- Keep bounce and complaint rates low
- Do not mix QA blasts or experiments into the same warm-up pool

If a sender subdomain gets a bad reputation, move the risky workload off that stream. Do not drag
your clean transactional traffic down with it.

## Minimal launch checklist

Before you declare a domain ready:

1. Pick sender subdomains before verifying Email Sending.
2. Keep apex, transactional, marketing, and experiment traffic separated.
3. Verify SPF, DKIM, and DMARC for each sending stream you actually use.
4. Start DMARC at `p=none`, then ratchet up.
5. Warm up new sender subdomains gradually.

This is deliberately conservative. Recovering from a bad sender reputation is slower than taking
an extra hour to separate domains correctly at the start.
