# Resend email — sending domain and DNS

Resend sends transactional auth mail (magic link, invite, password reset). This
file records the DNS records needed to send **from your own domain** instead of
the shared `onboarding@resend.dev` sandbox address.

## Why not just use support@securevoiceai.me

`support@securevoiceai.me` is an existing **mailbox**. Resend cannot send from
it. Sending requires a domain Resend can verify in DNS and attach SPF/DKIM to.

Two separate concepts, frequently confused:

| Concept              | What it is                                   | Where it lives               |
| -------------------- | -------------------------------------------- | ---------------------------- |
| **Sending domain**   | The domain Resend is authorised to send _as_ | Cloudflare DNS records below |
| **Reply-to address** | Where replies and bounces go                 | `resend_[REDACTED]` env var  |

So the target setup is:

- **Send from** `no-reply@securevoiceai.me` (once the domain is verified)
- **Reply to** `support@securevoiceai.me` (your existing inbox)

Both are config, not code. Until the domain is verified, keep
`resend_[REDACTED]="SecureVoice AI <onboarding@resend.dev>"` — it works with
only an API key, but Resend restricts it to your own account's address until
you verify a domain.

## Recommended: use a subdomain

Verify `mail.securevoiceai.me` (or `send.securevoiceai.me`) rather than the root
domain. Reasons, in order of importance here:

- **Reputation isolation.** Auth mail is the mail you least want quarantined. A
  marketing blast that burns the root domain's reputation should not be able to
  cost you sign-in links.
- **No MX conflict.** Enabling inbound on the root domain means Resend's MX
  competes with your existing mailbox, and a recipient of `support@` starts
  routing to the wrong server. A subdomain cannot do that to your root.
- **Reversibility.** If the subdomain is ever compromised or burned, you stop
  sending and your corporate mail is untouched.

## Add the domain to Resend first

1. Resend dashboard → **Domains** → **Add Domain**.
2. Enter the subdomain, e.g. `mail.securevoiceai.me`.
3. Leave "Receiving" **off** unless you want inbound mail on that subdomain.
   Inbound makes Resend receive _everything_ addressed to it.
4. Resend shows the exact record values. Copy them from there — the DKIM value
   is a public key unique to your account and cannot be derived.

## Cloudflare records

Resend shows 4 records. Add each under **Cloudflare → DNS → Records**. Cloudflare
proxies everything by default; **every one of these must be DNS Only (grey
cloud)** or verification silently fails (Cloudflare error 1004).

| Type | Name                | Content / Target                        | Proxy        | TTL  |
| ---- | ------------------- | --------------------------------------- | ------------ | ---- |
| MX   | `send`              | `feedback-smtp.us-east-1.amazonses.com` | **DNS only** | Auto |
| TXT  | `send`              | `"v=spf1 include:amazonses.com ~all"`   | **DNS only** | Auto |
| TXT  | `resend._domainkey` | `p=<your DKIM public key from Resend>`  | **DNS only** | Auto |
| TXT  | `dmarc` (optional)  | see below                               | **DNS only** | Auto |

**The single most common failure:** leaving the orange proxy cloud on. Cloudflare
will not proxy MX/TXT-for-DKIM correctly, and Resend reports verification failed
with no useful detail. Check this first.

**Value gotchas:**

- **Omit your domain from the values.** Cloudflare appends it. Paste `send`, not
  `send.mail.securevoiceai.me`. Same for `resend._domainkey` — paste that, not
  the full FQDN.
- **MX priority 10.** If `10` is taken on that name, use `20` or `30`.
- **SPF goes in TXT, not MX.** Modern SPF is a TXT record. An SPF value in an MX
  field is not SPF and will not verify.
- Only one SPF record per domain. If you already have one, **merge** the Resend
  `include:` into it rather than adding a second — two SPF records is a
  permanent error and breaks delivery for everything.

## DMARC

Start in monitoring mode. Only tighten to `p=quarantine` or `p=reject` once you
have confirmed legitimate mail passes — a `p=reject` policy on a domain with a
misconfigured SPF will silently discard real messages.

```
# _dmarc.securevoiceai.me, TXT
"v=DMARC1; p=none; rua=mailto:dmarc@securevoiceai.me; fo=1"
```

Add `adkim=r` / `aspf=r` only if you send from a subdomain that is not aligned
with the visible From domain (DKIM alignment), otherwise the default relaxed
alignment passes.

## Verify

Back in Resend → **Verify DNS Records**. Usually a few minutes; can take up to 72
hours if propagation is slow. Resend shows each record's status — a red row names
which one to fix.

## Flip the app over

Once verified, change two env vars. No code change, no redeploy of logic:

```bash
resend_[REDACTED]="SecureVoice AI <no-reply@mail.securevoiceai.me>"
resend_[REDACTED]="support@securevoiceai.me"
```

Both are read at send time by `src/lib/email/resend.ts`. `resend_[REDACTED]`
already falls back to `NEXT_PUBLIC_SUPPORT_EMAIL` if unset, so you may only need
the first line.

## Troubleshooting

| Symptom                             | Cause                                                           |
| ----------------------------------- | --------------------------------------------------------------- |
| Cloudflare error 1004               | Orange proxy cloud on — set DNS Only                            |
| Verification stuck pending          | Values include your domain, or a second SPF record exists       |
| Sending returns 403 domain mismatch | `resend_[REDACTED]` domain is not the verified one              |
| Delivered but not received          | Recipient's filter — check DMARC reports via the `rua=` address |
| Mail in spam                        | No DMARC, or SPF/DKIM not aligned with the visible From domain  |

## Status

`securevoiceai.me` is **verified in Resend** (confirmed 2026-10-11), so the
from-address is the real one: `RESEND_FROM_EMAIL="SecureVoice AI <support@securevoiceai.me>"`
and `RESEND_REPLY_TO="support@securevoiceai.me"`. The shared
`onboarding@resend.dev` sender is no longer used anywhere except as a
last-resort fallback for a laptop with no `.env`.

## Receiving mail — the webhook, and which events to subscribe to

Resend dashboard -> Webhooks -> Add endpoint:

    URL:    https://<your-host>/api/email/inbound
    Events: email.received          <-- inbound mail
            email.bounced           <-- delivery signal (marks the row DEAD)
            email.complained        <-- delivery signal (marks the row DEAD)
            email.delivery_delayed  <-- delivery signal (recorded, state kept)
            email.delivered         <-- delivery signal (clears the error)

Copy the endpoint signing secret (`whsec_...`) into `RESEND_WEBHOOK_SECRET`.
Without it the endpoint answers 503 and stores nothing (fail closed).

`email.received` alone gives you the console inbox. The other four are optional
but recommended: without them a hard bounce is invisible, the address stays
queued, and the retry ladder keeps mailing an address that does not exist —
which is how a sending domain loses its reputation.

### What each delivery signal does

| Event                    | Effect on the `EmailOutbox` row                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email.bounced`          | **DEAD**, `lastError` = `bounced: <reason>` — terminal, never retried                                                                                            |
| `email.complained`       | **DEAD** — a human said "stop"; sending again gets a domain blocklisted                                                                                          |
| `email.delivery_delayed` | `lastError` recorded, state **unchanged** — a delay is not a failure, and flipping a SENT row back to PENDING would re-send a link that may already have arrived |
| `email.delivered`        | `lastError` cleared, state unchanged — `SENT` already means "provider accepted it"                                                                               |

Matching is by `providerMessageId`, written to the row at send time (both send
paths: the synchronous one in `src/lib/email/queue.ts` and the drain worker in
`src/lib/email/outbox.ts`). A signal whose id matches no row answers
`{ok:true, matched:false, reason:"unknown_message_id"}` and is logged — it is
never silently dropped, because an unmatched bounce means an address is still
being retried.

Rows written before that column existed, and sends where the provider echoed no
id, answer `reason:"no_provider_message_id"`. Re-send those to populate it.

Deliberately NOT handled: `email.sent` (duplicates the send-time API response)
and `email.opened` / `email.clicked` (marketing telemetry — recording them would
put a tracking signal on a credential-bearing sign-in message).

## What production DNS actually says — measured 2026-10-18

Resolved over DNS-over-HTTPS against 1.1.1.1, plus Resend's own `/domains` endpoint
queried _from the box_, so no key value left the deployment or entered this document.

| Name                    | Type             | Live value                                                                                                                    | Against this document                                                                                                                                               |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `securevoiceai.me`      | NS               | `eloise.ns.cloudflare.com`, `maciej.ns.cloudflare.com`                                                                        | DNS is on Cloudflare, so every row below is owner-editable where this doc says to edit it                                                                           |
| `securevoiceai.me`      | A                | `57.130.80.158`                                                                                                               | grey-cloud (DNS only, no proxy). Abuse reports about the _site_ therefore land on the origin host, not behind Cloudflare                                            |
| `securevoiceai.me`      | TXT              | `"v=spf1 include:spf.privateemail.com ~all"`                                                                                  | this is the **mailbox** provider's SPF, not a sending one                                                                                                           |
| `securevoiceai.me`      | MX               | `mx1/mx2.privateemail.com`                                                                                                    | Namecheap Private Email receives this domain's mail — including any DMARC report                                                                                    |
| `resend._domainkey`     | TXT              | present, RSA-1024 `p=MIGf…`                                                                                                   | matches the DKIM row above ✓                                                                                                                                        |
| `send.securevoiceai.me` | CNAME + MX + TXT | → `send.forge.rmta.net`; MX `feedback.forge.rmta.net`; `"v=spf1 ip4:52.3.252.119 ip4:44.222.39.36 ip4:199.249.231.0/24 ~all"` | **a different ESP entirely.** This document reserves `send` for Resend's `feedback-smtp.us-east-1.amazonses.com` + `include:amazonses.com` pair. Neither is present |
| `_dmarc`                | TXT              | `"v=DMARC1; p=none; rua=mailto:<hash>@dmarc-reports.cloudflare.net,mailto:founder@securevoiceai.me"`                          | monitoring mode as recommended, and two report targets — but not the `dmarc@` mailbox this doc names, and `fo=1` is missing                                         |
| (Resend side)           | —                | `securevoiceai.me` reported **`status=verified`**, region `eu-west-1`                                                         | Resend is authorised to send as this domain ✓                                                                                                                       |

### Three conclusions, one of which kills the hypothesis I arrived with

**1. Mail authentication is not why the domain keeps getting reported.** The assumption on
arrival was an unauthenticated sender: the apex SPF authorises only `spf.privateemail.com`,
so anything Resend sent would SPF-fail. Measured, that does not hold. Resend verifies the
domain, publishes DKIM at `resend._domainkey`, and DMARC needs **one aligned mechanism, not
both** — an aligned DKIM signature is enough on its own, and unaligned `Return-Path` is
normal for a hosted sender. The apex SPF pointing at the mailbox provider is therefore
correct for a domain that _receives_ on Namecheap and _sends_ through a hosted service.
What is still unproven is what a real message looks like: `OPEN` — send one and read
`Authentication-Results`, which is the only evidence that settles it rather than inference.

**2. Two ESPs are configured against one domain and only one is documented.** `send` is
delegated to a SparkPost-lineaged service (`rmta.net`) with its own hard-coded IP allow-list,
while the code sends through Resend (`src/lib/email/resend.ts:101`, `RESEND_FROM_EMAIL` =
`SecureVoice AI <support@securevoiceai.me>`, measured in the deployment env). Two possible
readings, and they need different fixes: either `send` is a retired provider whose DNS was
never cleaned up — dead records on a live domain, which a reviewer reads as an abandoned
sending path — or something _is_ still sending through it, in which case there is an
undocumented processor in `docs/ROPA.md` §3.1 and an Article 24 contract nobody signed.
**Owner question, one sentence to answer:** is anything still using Forge on this domain?

**3. `p=none` is the part that actively invites reports.** It publishes "this domain does not
ask for its name to be protected". Anyone can send as `support@securevoiceai.me`, the
recipient's mailbox can do nothing about it, and the forgery trains the internet to treat the
domain as a spammer's — after which the _real_ domain gets reported too, because reputation
attaches to the string, not to the sender. A bank's fraud team that sees a spoofed
`securevoiceai.me` notice is also the audience this product cannot afford to alarm.

### The ladder, in order, with the precondition each rung actually needs

| Rung | Record                                                                                                      | Precondition — do not skip it                                                                                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | `p=none` + a _reachable_ `rua`                                                                              | DMARC reports only help if somebody reads them. `founder@securevoiceai.me` lands on Private Email (MX above), so confirm that mailbox exists and is checked; the third-party reporter address is fine alongside it |
| 1    | `"v=DMARC1; p=quarantine; sp=quarantine; rua=mailto:dmarc@securevoiceai.me; fo=1; adkim=s; aspf=s; pct=10"` | at least two weeks of reports showing **only** Resend as a source, and the answer to conclusion 2 above. `pct=10` bounds the blast radius of a mistake; raise it to 100 only after a clean month                   |
| 2    | `p=reject; sp=reject`, drop `pct`                                                                           | a full clean month at rung 1 with no legitimate sender in the reject bucket. `-all` on the SPF follows only when the domain genuinely never sends from anywhere else                                               |

`adkim=s` / `aspf=s` are strict alignment, and a hosted sender that keeps `Return-Path` on its
own domain will **fail strict `aspf`**. So set `adkim=s` (DKIM is aligned today) and leave
`aspf` relaxed unless the reports prove the envelope aligns. That is the one place this
document's earlier advice needs qualifying: it says to add strict alignment only if sending
from an unaligned subdomain — the truer rule is to let the reports decide, not the model of
how the provider is supposed to work.

### The part that is not about mail at all

`TWILIO_FROM_NUMBER` is a **+256 (Uganda)** number (measured from the deployment env; the
digits are not transcribed here). An AI voice agent that claims to be calling on behalf of a
Gulf bank, from a Ugandan line, to a person who never asked for a call, is the exact shape of
the vishing pattern this product exists to interrupt — and the caller ID is the only artifact
the recipient, their carrier, and any spam-labeler actually sees. `docs/TRUST-MODEL.md` builds
five layers around exactly this paradox, and layer 1 is _institutional caller ID, requiring
their authorisation_, which no pilot has supplied yet.

That is the most probable explanation for reports against the domain — well before the DNS
question, which measures clean. Closing it is a carrier/procurement action, not a code change:
port or purchase a UAE (or at least Gulf-region) DID, complete Twilio's number-hosting
verification for it, and register a caller name. Until then, no amount of DMARC tightening
changes what the called party sees when the phone lights up.
