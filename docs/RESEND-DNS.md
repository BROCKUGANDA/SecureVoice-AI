# Resend email — sending domain and DNS

Resend sends transactional auth mail (magic link, invite, password reset). This
file records the DNS records needed to send **from your own domain** instead of
the shared `onboarding@resend.dev` sandbox address.

## Why not just use support@securevoiceai.me

`support@securevoiceai.me` is an existing **mailbox**. Resend cannot send from
it. Sending requires a domain Resend can verify in DNS and attach SPF/DKIM to.

Two separate concepts, frequently confused:

| Concept | What it is | Where it lives |
|---------|-----------|----------------|
| **Sending domain** | The domain Resend is authorised to send *as* | Cloudflare DNS records below |
| **Reply-to address** | Where replies and bounces go | `resend_[REDACTED]` env var |

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
   Inbound makes Resend receive *everything* addressed to it.
4. Resend shows the exact record values. Copy them from there — the DKIM value
   is a public key unique to your account and cannot be derived.

## Cloudflare records

Resend shows 4 records. Add each under **Cloudflare → DNS → Records**. Cloudflare
proxies everything by default; **every one of these must be DNS Only (grey
cloud)** or verification silently fails (Cloudflare error 1004).

| Type | Name | Content / Target | Proxy | TTL |
|------|------|------------------|-------|-----|
| MX | `send` | `feedback-smtp.us-east-1.amazonses.com` | **DNS only** | Auto |
| TXT | `send` | `"v=spf1 include:amazonses.com ~all"` | **DNS only** | Auto |
| TXT | `resend._domainkey` | `p=<your DKIM public key from Resend>` | **DNS only** | Auto |
| TXT | `dmarc` (optional) | see below | **DNS only** | Auto |

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

| Symptom | Cause |
|---------|-------|
| Cloudflare error 1004 | Orange proxy cloud on — set DNS Only |
| Verification stuck pending | Values include your domain, or a second SPF record exists |
| Sending returns 403 domain mismatch | `resend_[REDACTED]` domain is not the verified one |
| Delivered but not received | Recipient's filter — check DMARC reports via the `rua=` address |
| Mail in spam | No DMARC, or SPF/DKIM not aligned with the visible From domain |
