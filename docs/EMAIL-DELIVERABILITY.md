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
- Treat `MAILBOX_ID_SECRET` as a **root key** for mailbox identity: protect it, do not rotate it
  casually, and make sure your first mailbox seed succeeds while you still have the value.

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
`MAIL_FROM_ADDRESS` into `wrangler.generated.<env>.json`, adds the sender to
`send_email[].allowed_sender_addresses`, and upserts SPF (always) and DMARC (per the ramp) when
`CLOUDFLARE_API_TOKEN` has DNS edit access — the two records it keeps under its own control.

With that same token, it also **auto-adds the provider-generated DKIM TXT + MX records**, parsed
from `wrangler email sending dns get <sending-domain>` (there's no `--json` mode for this open-beta
command, so the script parses its plain-text output). Pass `--skip-provider-records` to opt out and
manage those two by hand instead. Cloudflare's own DKIM/MX output includes a suggested DMARC record
too (typically `p=reject`) — this script never applies it, so DMARC always stays owned by the ramp
below, not by whatever Cloudflare suggests. Review what Cloudflare says after enabling the sending
domain:

```bash
pnpm wrangler email sending dns get send.example.com
pnpm wrangler email sending settings send.example.com
```

After `setup:sending`, deploy through a setup script that builds and patches
`dist/server/wrangler.json` from the generated config, for example:

```bash
pnpm setup:domain --env dev --hostname inbox.example.com --apply
```

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
`p=none` for exactly this reason and never lets it be overridden by Cloudflare's own suggested
DMARC record (see above).

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

## `MAILBOX_ID_SECRET` Is A Root Key

`MAILBOX_ID_SECRET` is not part of SPF, DKIM, or DMARC, but it is still a root key for the install.
Reccado derives mailbox IDs from it, and Cloudflare makes it write-only once stored as a Worker
secret.

Operational consequences:

- seed the first mailbox in the same run that generates the secret, or keep the original value
  available until `pnpm setup:mailbox` succeeds
- do not rotate it casually; rotation changes mailbox identity
- if a first-run seed fails and you lose the secret value, treat the environment as tainted and
  recreate or intentionally rotate it before real mail goes live

## Minimal launch checklist

Before you declare a domain ready:

1. Pick sender subdomains before verifying Email Sending.
2. Keep apex, transactional, marketing, and experiment traffic separated.
3. Verify SPF, DKIM, and DMARC for each sending stream you actually use.
4. Start DMARC at `p=none`, then ratchet up.
5. Warm up new sender subdomains gradually.
6. Protect `MAILBOX_ID_SECRET` and finish mailbox seeding while the value is still known.

This is deliberately conservative. Recovering from a bad sender reputation is slower than taking
an extra hour to separate domains correctly at the start.
