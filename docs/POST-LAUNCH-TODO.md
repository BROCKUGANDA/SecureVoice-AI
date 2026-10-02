# Post-launch to-do

## 1. Swap `sslip.io` → real domain (do this before the judges arrive)

The site is live at `https://139.162.166.83.sslip.io` with a valid ZeroSSL
certificate. That hostname is fine for a demo but must not be what you pitch,
because it ties you to an IP-shaped domain and looks temporary to a bank.

**Steps (~10 min):**

1. Buy the domain. Any registrar works (Cloudflare, Namecheap, Porkbun).
2. DNS: `A  voice.yourdomain.com  →  139.162.166.83` (TTL 300).
   Do **not** create an AAAA record — the box has no IPv6 route and ACME will
   try it first and fail.
3. On the server:

   ```bash
   cd /srv/securevoice
   sed -i 's/^SITE_ADDRESS=.*/SITE_ADDRESS=voice.yourdomain.com/' .env
   sed -i 's#^REALTIME_ALLOWED_ORIGIN=.*#REALTIME_ALLOWED_ORIGIN=https://voice.yourdomain.com#' .env
   docker compose up -d caddy
   docker logs -f securevoice-ai-caddy-1   # wait for "certificate obtained successfully"
   ```

4. Verify: `curl -s https://voice.yourdomain.com/healthz` → `ok`, and
   `docker compose ps` shows caddy healthy.
5. Update Clerk: add the new domain to the production instance's allowed
   origins (Applications → your app → Allowed origins), and set the
   sign-in/sign-up URLs to the new host.
6. ElevenLabs: update the agent's tool webhook + post-call webhook base URLs
   to the new domain, and re-run `bun run agent:apply && bun run agent:snapshot`.
7. Twilio: update the webhook/voice URL if one is configured (the inline-TwiML
   path needs no change — it embeds the origin per call).

**Do not run `docker compose down -v`** — that destroys the database volume and
the ACME account.

## 2. Operator account on the production Clerk instance

The dev-instance wallets were orphaned by the Clerk swap (expected).

1. Sign up at the site.
2. Clerk dashboard → Users → your user → Public metadata → `{"role":"operator"}`.
3. Sign out and back in (the profile syncs on login; operator wallets start at
   500 credits).

## 3. Housekeeping

- [ ] Delete the Northflank API token pasted in chat (app.northflank.com → API keys).
- [ ] Rotate any other credential pasted in chat.
- [ ] Review the 2 high Dependabot alerts on GitHub.
- [ ] Set up the nightly `pg_dump` cron (docs/HETZNER.md §8) — nothing is
      backed up yet, and the audit chain is the compliance artifact you will be
      asked to demonstrate.
- [ ] Confirm the legal entity named in the footer/privacy policy is actually
      registered before quoting it to a bank.
- [ ] `bun run preflight` on the server before any demo.

## 4. Before a real pilot

- [ ] Move `AGENT_TOOL_ALLOWED` to `card_freeze,human_handoff` (currently
      `human_handoff` only — deliberate).
- [ ] Carrier geo-lock in the Twilio console (disable every country you do not
      serve) — this is the control that stops toll fraud.
- [ ] Signed MSA + DPA; the public Terms are evaluation-only by design.
- [ ] Decide the invoicing entity and tax treatment with an accountant.