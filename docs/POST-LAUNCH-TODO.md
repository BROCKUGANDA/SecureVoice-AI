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
5. Better Auth: `BETTER_AUTH_URL` (or `APP_URL`) must already point at the new
   host, and that origin must be in `trustedOrigins` (src/lib/better-auth.ts).
   Auth is same-origin, so there is no third-party console to update.
6. ElevenLabs: update the agent's tool webhook + post-call webhook base URLs
   to the new domain, and re-run `bun run agent:apply && bun run agent:snapshot`.
7. Twilio: update the webhook/voice URL if one is configured (the inline-TwiML
   path needs no change — it embeds the origin per call).

**Do not run `docker compose down -v`** — that destroys the database volume and
the ACME account.

## 2. Operator account in production

Sign-up is invite-only, so there is no self-serve account path any more.

1. Create the user (directly, or via the invite flow in Settings).
2. Better Auth: add the user to the tenant's `organization` and grant the
   operator/admin role THERE. Roles come from organization membership, not from
   a field on the user row, so a user with no organization has no role.
3. Top up credits if needed (operator wallets start at 500 credits). The wallet is
   ORG-scoped: once a session carries an active organization, `Organization.credits`
   is the balance that is spent and `UserProfile.credits` is only the org-less
   fallback. Top up the tenant's row, not the person's.

## 2b. Full-duplex browser voice — specced, deliberately not built

The landing widget (`src/components/demo/LiveVoicePanel.tsx`) is a **real** live
mic call into the real pipeline — `getUserMedia` → `/api/asr` → `/api/agent` →
streaming `/api/tts/stream`, with barge-in — but it is **half-duplex and
push-to-talk**: audio is only captured between recording start and stop, and the
agent is not reached until the customer has finished speaking. That is honest and
it works; it is just not a phone call.

The full-duplex path is deliberately a follow-up rather than a rushed addition,
because it is mostly **plumbing that already exists server-side and is currently
unreachable from a browser**:

- `src/lib/voice/deepgram-client.ts` — `DeepgramLiveClient`, streaming STT.
  `PINNABLE_LANGS` covers `en`/`ar`/`hi`; `ur`/`sw` fall back to `"multi"`.
- `src/lib/voice/elevenlabs-stream.ts` — `ElevenLabsStream`, async-iterates
  `audio/mpeg` chunks back.
- `src/app/api/voice-websocket/route.ts:153` — `createVoiceWebSocketServer()`
  wires mulaw frames → Deepgram → `routeAgentIntent` → `executeSoftFreeze` →
  ElevenLabs. **It has no callers**: the exported `GET` at `:131` returns
  `{ok:true, activeCalls}` rather than upgrading, because a Next.js route handler
  cannot reach the raw socket. That is the whole gap.
- `src/worker/voice-stream.ts:391` — the same wiring in the Bun worker, i.e. a
  process that CAN hold the socket already exists.

**Building it means:**

1. `src/worker/browser-voice.ts` — a Bun WebSocket server that is the only
   browser-facing half; the browser sends PCM16@16 kHz frames from an
   `AudioWorklet`, the server answers with `audio/mpeg` chunks.
2. A `NEXT_PUBLIC_VOICE_WS_URL` env and a compose service for it.
3. A client hook that drives the worklet, plays the returned chunks, and
   barge-ins on the **interim** transcript rather than on finished ASR.
4. Point `LiveVoicePanel` at it behind a capability check, keeping the existing
   half-duplex path as the fallback rather than replacing it.

**Preconditions before it can be demoed:** a live `DEEPGRAM_API_KEY` and a
non-dry-run `ELEVENLABS_API_KEY`. Until both exist, building the socket layer
would produce a path that cannot be heard — which is worse than the push-to-talk
one, because a judge would experience silence.

## 3. Housekeeping

- [ ] Delete the Northflank API token pasted in chat (app.northflank.com → API keys).
- [ ] Rotate any other credential pasted in chat.
- [ ] Review the 2 high Dependabot alerts on GitHub.
- [ ] Set up the nightly `pg_dump` cron (docs/DEPLOY.md §8) — nothing is
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

## 5. Per-tool agent secrets — not implemented, and the docs now say so

There is **one** agent-tool credential today. `authorizeToolCall`
(`src/lib/agent-tool-auth.ts`) compares `x-agent-tool-secret` against the single
global `AGENT_TOOL_SECRET`, then checks the tool name against one flat global
`AGENT_TOOL_ALLOWED`; `scripts/agent-apply.ts:382-417` writes that same one value
into every tool's `request_headers`. **So a leaked tool secret authorises every
tool on the list, not just the one it was issued for** — a leaked `human_handoff`
secret is a leaked `card_freeze` credential. `README.md` and
`docs/INTEGRATION.md` used to claim the opposite; they now state this instead.

The gap is scoping, not authentication: the secret is already compared in
constant time over length-safe buffers, and an unset allow-list already fails
closed with `403 tool_scope_unconfigured` for every tool.

**What closing it means:**

- Move from one global secret to a per-tool map, e.g. `AGENT_TOOL_SECRETS` as
  `card_freeze=…,human_handoff=…`, keeping the single-value name working as a
  wildcard for one release so deployments do not break on upgrade.
- `authorizeToolCall` selects the expected secret _by tool name_ before
  comparing, and returns 401 when the tool has no entry — a missing entry must be
  a refusal, never a fall-through to a shared value.
- Keep the allow-list as the second, independent condition. Scoping without it
  would still let a `card_freeze` secret name a tool that isn't allowed.
- `scripts/agent-apply.ts:configureToolSecrets` stops overwriting all headers
  with one value and writes each tool's own secret; a re-apply must not clobber a
  tool's secret with another tool's.
- Roll out by issuing a per-tool secret to one tool, rotating, then repeating —
  dual-accept during rotation, with the shared secret removed at the end.
- Gate it: `tests/tools/guard.test.ts` should carry two distinct secret fixtures
  and assert that tool A's secret is refused on tool B. It cannot today because
  there is no second secret to hold; that test is the acceptance criterion for
  this item.
