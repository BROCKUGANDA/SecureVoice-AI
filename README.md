<div align="center">

<img src="public/logo.svg" alt="SecureVoice AI logo" width="110" />

# SecureVoice AI

**Real-time voice fraud intervention for banking & insurance.**
**Fraud detected. Customer called. Account frozen — in 60 seconds, not 38 minutes.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![Prisma + Postgres](https://img.shields.io/badge/Prisma-Postgres-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![ElevenLabs](https://img.shields.io/badge/Voice-ElevenLabs-000000)](https://elevenlabs.io)
[![Twilio](https://img.shields.io/badge/Telephony-Twilio-F22F46?logo=twilio&logoColor=white)](https://www.twilio.com)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](#run-with-docker)

[Quickstart](#quickstart) &middot; [Run with Docker](#run-with-docker) &middot; [Demo walkthrough](#demo-walkthrough) &middot; [API surface](#api-surface) &middot; [**Evidence bundle**](evidence/INDEX.md) &middot; [**Integration guide**](docs/INTEGRATION.md) &middot; [Submission](docs/SUBMISSION.md) &middot; [Releasing](docs/RELEASING.md)

<img src="scripts/shots/splash-new.png" alt="SecureVoice AI — fraud intervention call in progress" width="900" />

</div>

---

## What it does

Today, when a bank's fraud engine flags a transaction, the case lands in a Tier‑1 analyst's queue ~9 minutes later. The analyst dials the customer, the customer doesn't recognize the number, and while the phone rings the fraudster completes the second transaction. The average call-center agent takes **38 minutes** to work a single case — the fraudster moves in **seconds**.

**SecureVoice AI closes that gap.** The moment a risk signal arrives (`POST /v1/interventions`), the platform:

1. Places an **outbound voice call to the customer within seconds** — live over Twilio, in the customer's own language, for **banks and insurers** alike.
2. Runs a **guardrailed voice agent** (ElevenLabs Agents Platform) whose system prompt is selected by a **Dynamic Prompt Router** — the producer declares _why_ the institution is calling (`call_category`), and the agent's powers, prohibitions and backend preconditions follow that category.
3. On confirmation, **stages the protective action (always reversible), escalates to a human — live via warm transfer or the specialist queue — and streams every phase transition back to the institution** via signed webhooks — with a tamper-evident **audit chain** recording the entire interaction.

> **Compliance by construction:** every call opens with a disclosure, the agent _never_ requests PINs/OTPs/passwords (server-enforced, not prompt-enforced), all PII is redacted before persistence, and **irreversible account actions are decided by the institution's human team in every category and every environment**.

## Features

- 🎙️ **Streaming voice agent with barge-in** — sub-second turn-taking; the customer can interrupt the agent mid-sentence.
- 🧭 **The Dynamic Prompt Router — five call categories.** `fact_finding`, `sensitive_case`, `b2b`, `routine` and `time_critical_fraud` each carry their own system prompt, state-machine rules and backend preconditions: routine calls are refused outside the permitted calling window and for numbers on the do-not-call registry; a B2B call can only ever produce a recommendation for human sign-off; only fraud verification may stage a protective action. Absent a category, a producer gets `time_critical_fraud` — the audited baseline, so legacy integrations keep exactly today's call. See [src/lib/call-categories.ts](src/lib/call-categories.ts).
- 🏥 **Banks and insurers are both first-class** — one platform, two institution types: "your card" becomes "your policy", the protective action becomes a hold on the claim payout or policy change, the opening line and voicemail are institution-aware in all six languages, and the demo ships an insurer scenario.
- 🤝 **Live human handoff** — the `warm_transfer` tool bridges the customer to a human specialist's phone **inside the same call**: the customer is never asked to hang up and re-dial, and the caller ID they see stays the institution's own published number throughout. With no specialist number configured it degrades — audited — to the specialist queue rather than dropping the call.
- 🌍 **Multilingual, per path** — the ElevenLabs agent (the primary conversation plane) is configured for `en / ar / hi` ([`agent/securevoice.agent.yaml`](agent/securevoice.agent.yaml)); the built-in continuity pipeline additionally speaks `ur / fr / sw` ([`src/lib/config.ts`](src/lib/config.ts)). **Only English and Arabic have a recorded end-to-end conversation in the evidence bundle.** Voice identity per language.
- 🖥️ **Operator Command Center** — live intervention feed (SSE), case monitoring, sentiment-based escalation to human specialists.
- 🔗 **Tamper-evident audit chain** — every action hash-chained (sha256) with canonical serialization; exportable per case reference.
- 🏦 **Bank-grade ingest API** — signed risk-signal webhooks (`SV-Signature: t=…,v1=…`), idempotent case creation, producer key auth.
- 📞 **Real telephony** — live SMS + voice delivery via Twilio; runs in audit-only mode without credentials.
- 🔑 **BYOK & white-label** — institutions can bring their own ElevenLabs key; per-organization branding on Settings.
- 🧾 **Credits wallet** — per-organization budgeting of intervention usage.
- 🚀 **Push-to-deploy** — a GitHub Action SSHes into the production VPS on every push to `main`, rebuilds, rolls the app and workers, and smoke-tests the origin.

## Quickstart

> **Prerequisites:** [Bun](https://bun.sh) ≥ 1.3, Node ≥ 20 (for tooling).
> The datasource in `prisma/schema.prisma` is **PostgreSQL** — you need a Postgres
> server, or just use Docker below. There is **no SQLite mode** (Prisma rejects a
> `file:` URL against a `postgresql` provider).

```bash
# 1 — configure (the platform boots fine with empty keys: dry-run + audit-only).
#     This comes before `bun install` because Prisma ORM v7 resolves
#     DATABASE_URL through prisma.config.ts, and the install's postinstall runs
#     `prisma generate`.
cp .env.example .env
#    then set DATABASE_URL to your Postgres, e.g.
#    DATABASE_URL="postgresql://user:pass@localhost:5432/securevoice?schema=public"

# 2 — install dependencies (postinstall generates the Prisma client into
#     src/generated/prisma, which the app imports)
bun install

# 3 — apply the schema and seed a realistic case history
bun run db:push
bun run db:seed

# 4 — start the dev server
bun run dev
```

Open **[http://localhost:3000](http://localhost:3000)**. The site is a single-page app: the
landing page is at `/`, and everything else — Docs, Security, Use Cases, Pilot, the
Command Center, the live Demo — is reached by clicking through the nav (or via the
in-app view switcher). There are no separate `/docs`-style server routes.

> **Supabase users:** the direct DB host is often IPv6-only. If `prisma db push`
> fails with `P1001` on a project you know is healthy, your host has no IPv6 route —
> use the IPv4 pooler. See [docs/INTEGRATION.md §5](docs/INTEGRATION.md#5-run-it-yourself).

## Run with Docker

The reproducible, zero-setup path — Postgres, schema, seed data, realtime push, TLS, and server in one command:

```bash
docker compose up --build
```

- **Caddy is the only service that publishes a port.** It terminates TLS on :443 and routes `/realtime/*` to the realtime service, everything else to the app.
- **http://localhost:3000** is served by the Next.js standalone bundle inside a slim Bun image.
- A **Postgres 16** service comes up on the compose network, `db-setup` applies the Prisma schema and seeds demo cases, then `app` starts.
- Data persists in the `db-data` volume; `docker compose down -v` resets to a factory-fresh demo.
- A local `.env` is picked up automatically if present — without one the demo runs in dry-run/audit-only mode (nothing is dialled, no quota is burned). **Safe for judges.**

> **No SQLite mode.** `prisma/schema.prisma` declares `provider = "postgresql"`, and
> Prisma rejects a `file:` URL against it (`P1012: the URL must start with the protocol
postgresql://`). Verified empirically — don't be misled by older notes that mention
> `prisma/db/custom.db`; this schema has always been Postgres-only.

### Topology

```text
Internet ── :443 ──► Caddy (the only published port)
                     ├─ /realtime/*  ──► realtime:4000   Bun + Socket.IO
                     ├─ /healthz     ──► answered at the edge
                     └─ everything else ──► app:3000    Next.js standalone
```

`app` and `realtime` are reachable only on the compose network. That is what makes
the trust model in `src/proxy.ts` sound: it believes `X-Forwarded-For` only when the
request carries the marker Caddy sets, and a direct-to-origin caller can forge
anything else.

| Variable                   | Default                           | Purpose                                                                                                           |
| -------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SITE_ADDRESS`             | `localhost`                       | Domain Caddy issues a certificate for. Must resolve to the host.                                                  |
| `ACME_EMAIL`               | `admin@example.com`               | Let's Encrypt expiry notices.                                                                                     |
| `REALTIME_INGEST_SECRET`   | falls back to `AGENT_TOOL_SECRET` | HMAC key shared by app and realtime. Unset ⇒ realtime refuses every connection and the console silently uses SSE. |
| `REALTIME_URL`             | `http://realtime:4000`            | Internal service address. **Never `localhost`** — inside the app container that is the app container.             |
| `REALTIME_ALLOWED_ORIGIN`  | empty (any)                       | Comma-separated browser origins the socket accepts.                                                               |
| `EDGE_RATE_LIMIT_PER_HOUR` | `600`                             | Pre-auth edge budget per client IP. Separate from the expensive-call API limit.                                   |

### Feature flags

Every runtime switch is declared in `src/lib/flags.ts` — one file answers
"what is switchable in this deployment?", which is not otherwise greppable.

| Flag                                | Default | Effect                                                                                                                                                   |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FEATURE_REALTIME`                  | `false` | Signed push to the realtime service. Needs `REALTIME_INGEST_SECRET` too — both or neither, because the service rejects every handshake without a secret. |
| `FEATURE_CONSOLE_LIVE_FEED`         | `false` | Console live feed over the websocket. Off means SSE, which is what shipped first.                                                                        |
| `FEATURE_PII_REDACTION`             | `true`  | Redact PII in logs, audit rows, webhook payloads. Turning this off writes customer transcripts in the clear — local debugging only.                      |
| `FEATURE_COMPLIANCE_PII_REDACTION`  | `true`  | Second (outbound-wire) redaction switch; no legacy var backs it.                                                                                         |
| `FEATURE_ELEVEN_LABS_LIVE`          | `false` | Real neural voice. `ELEVENLABS_DRY_RUN` still wins when set, since the provider client reads it directly.                                                |
| `FEATURE_COMPLIANCE_DISCLOSURE`     | `true`  | The "this call is recorded" opening disclosure. Required by law; defaults ON.                                                                            |
| `FEATURE_COMPLIANCE_NO_SECRETS`     | `true`  | Never request PIN/password/OTP/CVV. Required by policy; defaults ON.                                                                                     |
| `FEATURE_WEBHOOK_STRICT_SIGNATURES` | `true`  | Refuse unsigned inbound signals. OFF is a local-debug affordance only.                                                                                   |
| `FEATURE_SEED_DEMO`                 | `false` | Seed demo case history on first boot. Defaults OFF for a clean production database.                                                                      |

Values are strictly `"true"` / `"false"`. Anything else throws at read time
rather than reading as "disabled" — a typo that silently disables realtime is
the exact failure this prevents. Defaults put the safe path first: money, PII,
and the audit chain are off unless you opt in.

Turn realtime on end to end (both switches, or it stays on SSE):

```bash
FEATURE_REALTIME=true \
FEATURE_CONSOLE_LIVE_FEED=true \
REALTIME_INGEST_SECRET="$(openssl rand -base64 32)" \
  docker compose up --build
```

Two ways to reach the app:

```bash
docker compose up --build                    # real topology, TLS via Caddy
docker compose --profile direct up --build   # publish :3000 directly, no TLS
```

The `direct` profile is for quick local work. It makes the origin reachable on
its own, which means every `X-Forwarded-For` becomes forgeable and the edge layer
falls back to one shared rate-limit bucket. Fine on a laptop; don't ship it.

<details>
<summary>Prefer plain Docker?</summary>

```bash
docker build -t securevoice-ai .

# the image needs a Postgres (there is no SQLite mode — see above)
docker run -p 3000:3000 \
  -e DATABASE_URL="postgresql://securevoice:securevoice@host.docker.internal:5432/securevoice?schema=public" \
  --env-file .env \
  securevoice-ai
```

</details>

## Demo walkthrough

1. **Land on the pitch page** — _"Fraud detected. Call placed. Frozen. In 60 seconds."_
2. **Launch the live demo** — a seeded intervention case appears in the **Command Center** (operator view) with live status transitions.
3. **Trigger an intervention** — the pilot flow places a real outbound call/SMS (Twilio trial: verified numbers only) or runs the simulated stream when keys are absent.
4. **Watch the voice agent work** — streaming TTS with barge-in, guardrail chips ("No PINs requested"), Arabic voice live on the call.
5. **Inspect the audit trail** — every step is hash-chained and verifiable against the canonical chain spec in `src/lib/audit-chain.ts`.
6. **Escalation** — sentiment analysis hands the customer to a human specialist ("Handoff ready — Sara H.").

## API surface

| Route                                                            | Purpose                                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/interventions` (`GET` = discovery doc)                 | Institution fraud engine ingests a risk signal (HMAC-signed) → case created, SLA clock starts. Optional `call_category` selects the agent's prompt and the backend preconditions |
| `POST /api/enroll` · `/v1/enroll`                                | Enroll a customer for real Twilio delivery (requires a `consentRecordId`)                                                                                                        |
| `POST /api/agent`                                                | Guardrailed conversation turn API used during a live call                                                                                                                        |
| `POST /api/tts` · `POST /api/tts/stream` · `POST /api/asr`       | Neural TTS / speech-to-text, language-routed voice IDs, rate-limited                                                                                                             |
| `POST /api/pilot`                                                | Guided pilot / lead capture                                                                                                                                                      |
| `POST /api/webhooks`                                             | Signed outbound phase-transition events back to the institution                                                                                                                  |
| `POST /api/elevenlabs/tools/verify-transaction`                  | Agent tool → record the verification outcome (`confirmed_fraud` / `confirmed_legitimate` / `uncertain`)                                                                          |
| `POST /api/elevenlabs/tools/card-freeze`                         | Agent tool → **stages** a reversible freeze (always `committed:false`)                                                                                                           |
| `POST /api/elevenlabs/tools/human-handoff`                       | Agent tool → queue a fraud specialist                                                                                                                                            |
| `POST /api/elevenlabs/tools/warm-transfer`                       | Agent tool → bridge the live call to a human specialist's phone (degrades to the queue)                                                                                          |
| `POST /api/elevenlabs/tools/switch-language`                     | Agent tool → switch the conversation language mid-call                                                                                                                           |
| `POST /api/elevenlabs/signed-url`                                | Mint a 15-min browser session credential; pins `ELEVENLABS_AGENT_ID`                                                                                                             |
| `GET /api/status` · `GET /api/health` · `GET /api/console/audit` | Status, liveness, audit chain export                                                                                                                                             |

Full request/response examples are on the in-app **Docs** page. For signing, enrolment,
tool authorisation, and self-serve onboarding see **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

## Branch & environment strategy

| Branch    | Purpose             | `APP_ENV`     | Outbound calls/SMS                             |
| --------- | ------------------- | ------------- | ---------------------------------------------- |
| `main`    | production          | `production`  | **allowed** — real customer contact            |
| `staging` | pre-production / RC | `staging`     | **refused (403)** — never reaches a real phone |
| `dev`     | development         | `development` | refused; dry-run voice                         |

`staging` runs the _same code and the same database_ as production — the difference is
blast radius, not behaviour. `APP_ENV` is explicit rather than inferred from `NODE_ENV`,
so a pre-production deploy can never silently inherit production's permissions. Set it in
the deployment environment; it defaults to `development` when unset.

The gate lives in `src/lib/twilio.ts` and is visible from outside via `GET /api/status`:

```json
{ "appEnv": "staging", "canContactRealNumbers": false }
```

Verified live against Supabase Postgres: a signed high-risk signal under `APP_ENV=staging`
returns `outbound_calls_disabled_staging` / `outbound_sms_disabled_staging` with **zero**
Twilio API calls in the server log. Evidence:
[`staging-gate-2026-10-01.json`](docs/evidence/staging-gate-2026-10-01.json).

> **Irreversible actions are environment-independent.** `card_freeze` only ever stages a
> reversible `pending_specialist` request in _any_ environment — a human fraud specialist
> finalises it. No environment can make the agent freeze a card on its own.

## The ElevenLabs conversation plane (primary)

The conversation runs on the **ElevenLabs Agents Platform** by default. The durable queue's
dial worker claims a case and calls `placeOutboundCall()`, which places the outbound call on
the platform agent — with the category-selected system prompt injected per call via
`conversation_config_override` (whitelisted in the agent's settings, see
[`agent/securevoice.agent.yaml`](agent/securevoice.agent.yaml)) — and the agent then owns the
conversation, calling our five server-side tools
(`verify_transaction`, `card_freeze`, `human_handoff`, `warm_transfer`, `switch_language`)
over signed webhooks as it verifies the customer. Set `ELEVENLABS_API_KEY`,
`ELEVENLABS_AGENT_ID` and `ELEVENLABS_PHONE_NUMBER_ID` in `.env` to place a real one.

The phone number id is the caller ID the customer sees. It is imported once from
the institution's own SIP trunk — `POST /v1/convai/phone-numbers` with
`provider: "sip_trunk"` and the trunk's INVITE address — and the platform
presents that DID to every customer it dials: the same number their fraud team
calls from. That is Layer 1 of [docs/TRUST-MODEL.md](docs/TRUST-MODEL.md): the
number must be genuinely the institution's, carrier-verified, never rented.

### Continuity path — when the platform is not on the call

The built-in voice pipeline is the **continuity** path, not an alternative to the agent. It is
what carries a conversation whenever the platform agent is not the thing speaking: an
**inbound Twilio call**, where `POST /api/twilio/turn` is a `<Gather>` loop over our own
keyword/state-machine intent router and Polly/Google voices; and the **browser demo**, which
posts each turn to `POST /api/agent` and the audio to `/api/tts`.

Be precise about what is _not_ a step-down: the dial worker never silently degrades to the
continuity path. `placeOutboundCall()` either dials the platform agent, or — in dry-run
(`ELEVENLABS_DRY_RUN=true`, mirrored by `FEATURE_ELEVEN_LABS_LIVE`, see
[`src/lib/flags.ts`](src/lib/flags.ts)) — returns a synthetic `conversation_id` and places no
call at all. If the agent credentials are missing it **throws**, and the job retries and then
dead-letters through the audited queue rather than dialling a customer nobody is verifying.

**What is lost on the continuity path:** the agent's autonomous tool calls. Nothing on this
path can invoke `verify_transaction`, `card_freeze`, `human_handoff` or `switch_language` —
the deterministic router _reports_ an intent (`deny_fraud` → `card_freeze`,
sentiment escalation → `human_handoff`) and the write action must be driven by the caller
against `/api/elevenlabs/tools/*` rather than by the conversation itself. Everything
load-bearing for the guardrail claim survives: disclosure, the no-credential rule, PII
redaction, sentiment escalation, and the hash-chained audit trail are server-enforced on both
paths.

**Agent configuration as code.** The full agent definition — system prompt, per-language
first messages and disclosure lines, LLM selection, TTS voice IDs, audio format, turn-taking,
max duration, tool IDs, knowledge-base locators, RAG settings, evaluation criteria and
data-collection fields — lives in [`agent/securevoice.agent.yaml`](agent/securevoice.agent.yaml).
It is applied and verified by:

```bash
bun run agent:apply     # PATCH the agent, GET it back, deep-diff — exits non-zero on divergence
bun run agent:snapshot  # write canonical config + sha256 to evidence/agent/
```

The applied version is recorded in `evidence/agent/version.txt` and the canonical config +
sha256 snapshot in `evidence/agent/` — reproducible: a second apply produces an identical
hash and an empty diff. All five webhook tools are defined on the platform account and
attached to the agent, with RAG and source attribution on.

Free-tier limits to be aware of: `eleven_v3` returns **402 `paid_plan_required`**
(enforced server-side, so no SDK or HTTP client can unlock it — the agent falls back to
`eleven_flash_v2`), voice cloning is disabled, and the monthly character quota is small
enough to run out mid-test-suite. See [docs/SUBMISSION.md](docs/SUBMISSION.md) for the
exact account state.

## Use it with your own systems

You do not need a SecureVoice plugin inside your core banking sandbox. Model it as a
**producer** and a **consumer**:

```
your fraud engine ──HMAC-signed POST──►  /api/interventions   (fires an intervention)
your CRM / SIEM   ◄──signed webhook────  /api/webhooks       (every phase transition)
```

Worked signing example, opt-out payload, producer-key auth, ElevenLabs tool
authorisation, Docker/VPC deployment, and the current state of self-serve multi-tenant
onboarding are all in **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

Already built and usable by any tenant: `orgId` scoping on the core tables, per-team
revocable producer keys, **BYOK** (bring your own ElevenLabs key, encrypted at rest),
per-org branding, and a credits wallet.

### Verifying our outbound webhooks

Case verdicts reach your system through a transactional outbox and arrive signed:

```
SV-Signature: t={unix_seconds},v1={hex_hmac}
v1 = HMAC_SHA256(shared_secret, f"{t}.{body}")
```

**Verify the raw body bytes exactly as received.** Re-serialising the JSON before
hashing changes the bytes and the digest will not match — this is the single most
common integration bug. Reject anything older than 5 minutes to blunt replay, and
deduplicate on `event_id`, which is stable across retries of the same verdict.

**TypeScript**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifySvSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing_signature" };
  const parts = Object.fromEntries(
    header
      .split(",")
      .map((p) => p.trim().split("="))
      .filter((p) => p.length === 2),
  ) as Record<string, string>;
  const { t, v1 } = parts;
  if (!t || !v1) return { ok: false, reason: "malformed_signature" };
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec)
    return { ok: false, reason: "stale_timestamp" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected, "hex"),
    b = Buffer.from(v1, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: "digest_mismatch" };
  return { ok: true };
}
```

**Python**

```python
import hashlib, hmac, time

def verify_sv_signature(raw_body: bytes, header: str, secret: str, tolerance: int = 300):
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    t, v1 = parts.get("t"), parts.get("v1")
    if not t or not v1:
        return False, "malformed_signature"
    if abs(time.time() - int(t)) > tolerance:
        return False, "stale_timestamp"
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, v1):
        return False, "digest_mismatch"
    return True, "ok"
```

Both implementations ship in-repo and are executed against a real delivery by the WP-5
gate — `scripts/verify_sv_signature.ts`, `scripts/verify_sv_signature.py` and the Java
reference `scripts/verify-signatures/SignatureVerifier.java` — so all three languages are
proven to agree rather than assumed to.

Our own receiver lives at `POST /api/webhooks/receiver` and the human-readable view at
**`/inspector`**: the raw payload, the signature header, and a green/red verdict recomputed
server-side. Deliveries retry with backoff and jitter (~1m, 5m, 30m, 2h, 3h, 12h) and
dead-letter after six attempts; an operator can replay a dead letter from
`POST /api/console/outbox/replay`.

## Configuration

Everything is opt-in: **no keys required to run the demo** (dry-run + audit-only mode).

| Variable                                                         | Purpose                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                   | **PostgreSQL** connection string (the Prisma datasource, `provider = "postgresql"`). There is no SQLite mode — see [Quickstart](#quickstart).                                                                                                                                                                           |
| `ELEVENLABS_AGENT_ID`                                            | The ElevenLabs agent the browser may connect to. `/api/elevenlabs/signed-url` rejects any other id (403).                                                                                                                                                                                                               |
| `AGENT_TOOL_SECRET`                                              | Shared secret the agent must present on webhook tool calls (`x-agent-tool-secret`).                                                                                                                                                                                                                                     |
| `AGENT_TOOL_ALLOWED`                                             | Comma-separated tool allow-list, e.g. `card_freeze,human_handoff`. **One global list, not per-tool scoping — see [Tool authorisation](#tool-authorisation).**                                                                                                                                                           |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_DRY_RUN`                      | Neural voice; `DRY_RUN=true` serves the dev backend without burning quota                                                                                                                                                                                                                                               |
| `ELEVENLABS_MODEL` / `ELEVENLABS_STT_MODEL`                      | Model overrides (`eleven_v3`, `scribe_v2`)                                                                                                                                                                                                                                                                              |
| `ELEVENLABS_VOICE_EN/AR/HI/UR`                                   | Per-language voice IDs                                                                                                                                                                                                                                                                                                  |
| `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_*` / `TWILIO_FROM_NUMBER` | Real call + SMS delivery                                                                                                                                                                                                                                                                                                |
| `WEBHOOK_SECRET`                                                 | Signs outbound events & verifies inbound risk signals                                                                                                                                                                                                                                                                   |
| `AUTH_SECRET`                                                    | Session cookie signing (384-bit)                                                                                                                                                                                                                                                                                        |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL`                         | Better Auth session signing (≥32 chars) and the deployment origin asserted at boot                                                                                                                                                                                                                                      |
| `HUMAN_AGENT_PHONE`                                              | Live warm-transfer destination (per-tenant override: `transferPhone` in the org's metadata JSON). Empty ⇒ `warm_transfer` degrades to the specialist queue. **Never the platform's own Twilio number — that would dial the platform.**                                                                                  |
| `GROQ_API_KEY` / `GROQ_MODEL`                                    | **Optional** live LLM reply layer — drafts the agent's spoken lines in the customer's language (default `qwen/qwen3.8-27b`, a Groq **preview-tier** model that Groq's own docs warn "should not be used in production environments as they may be discontinued at short notice"). Server-side only; never commit a key. |
| `GEMINI_API_KEY` / `GEMINI_MODEL`                                | Optional LLM fallback when no Groq key is present (`gemini-1.5-flash`)                                                                                                                                                                                                                                                  |
| `RATE_LIMIT_PER_HOUR`                                            | Per-caller TTS/ASR/agent budget                                                                                                                                                                                                                                                                                         |
| `COMPLIANCE_*`                                                   | Server-enforced compliance flags (disclosure, no credential requests, PII redaction)                                                                                                                                                                                                                                    |

See [.env.example](.env.example) for the annotated reference.

### Tool authorisation

There is **one** agent-tool credential. `authorizeToolCall`
(`src/lib/agent-tool-auth.ts`) compares the `x-agent-tool-secret` header against the
single global `process.env.AGENT_TOOL_SECRET`, then checks the requested tool name
against one flat, global list in `AGENT_TOOL_ALLOWED`.

**A leaked tool secret therefore authorises every tool on that list, not just the one
it was issued for.** There is no per-tool secret, so there is no per-tool scoping to
enforce: if `human_handoff` is in the list, the same secret reaches `card_freeze`.
`scripts/agent-apply.ts:382-417` writes that one value into every tool's
`request_headers`, which is how it works in practice.

What the allow-list _does_ buy is fail-closed narrowing of the whole surface at once:
an unset list gives `403 tool_scope_unconfigured` for **every** tool, so a deployment
that has not been scoped yet cannot reach any privileged action. The secret comparison
is also constant-time and length-safe (both sides SHA-256'd, then `timingSafeEqual`).
Neither of those is per-tool authorisation.

Per-tool secrets — so a read-only credential cannot reach `card_freeze` — is
follow-up work, tracked in [docs/POST-LAUNCH-TODO.md](docs/POST-LAUNCH-TODO.md).

## Guardrails — one in the UI, twelve in the audit chain

The ElevenLabs platform's Guardrails panel exposes exactly one toggle; the real
controls live where they **cannot be bypassed or prompted away** — in server code
that runs before, during and after every turn:

- `auditAgentReply` (`src/lib/compliance/policy.ts`) — replaces any credential-extraction
  reply with a safe refusal, injects the recording disclosure when the model omits it, and
  redacts PII before anything is persisted
- the tool guard (`src/lib/tool-guard.ts`) — authenticates every tool call, scopes it to
  the calling tenant, and enforces state preconditions before a privileged action
- the policy + abuse gates (`src/lib/policy-gate.ts`, `src/lib/abuse/*`) — consent, do-not-call,
  calling hours, country allowlists, cooldowns, concurrency and spend ceilings, decided
  before any carrier is contacted
- the call-category preconditions — a routine call that arrives at 23:00 is refused at
  ingest and parked by the dial worker until the window opens, without consuming an attempt
- the state machine (`src/lib/case-state-machine.ts`) — the single writer for case state;
  `card_freeze` only ever stages, in every category and every environment

The platform agent mirrors the same rules in its system prompt (absolute prohibitions,
per-category powers) and its evaluation criteria — but the enforcement is ours.

## Deployment

The production deployment is a **Hetzner VPS** running the compose stack, with **Caddy as
the only published port** (TLS, per-site blocks, log redaction) on a shared edge, and the
product hostname fronted by **Cloudflare proxied DNS**. Deploys are automated:

1. Push to `main` → the GitHub Action SSHes in, pulls, rebuilds the `app`, `dial-worker`
   and `retention-worker` images, rolls them, and smoke-tests `GET /api/health` on the
   running origin.
2. The VPS checkout keeps its own edge configuration (`Caddyfile` site blocks for the
   shared proxy) under `git update-index --skip-worktree`, so a deploy pull never trips
   over deployment-local state.
3. Migrations are versioned SQL applied by the `db-setup` one-shot on every stack bring-up
   (`prisma/migrations/` — additive by policy).

The platform agent's own configuration is **not** deployed by the Action — it is applied
declaratively by `bun run agent:apply` (deep-diffed against the YAML), so agent prompt and
tool changes are code-reviewed like everything else.

## The LLM reply layer (optional)

The agent's **intent routing and compliance guardrails are deterministic server-side code** — an LLM never decides to freeze a card, and a refusal cannot be prompted away. When `GROQ_API_KEY` (or `GEMINI_API_KEY`) is set, the model only _rephrases_ the verified reply in the customer's language under strict voice rules, then passes the same compliance scan as the scripted replies. It runs on the **continuity path only** — its language set is the pipeline's own, `en / ar / hi / ur / fr / sw` ([`src/lib/config.ts`](src/lib/config.ts)), not the ElevenLabs agent's `en / ar / hi`:

- ≤ 50 words — sized for a phone call, not a chat window
- no markdown, asterisks, or emojis — TTS reads punctuation literally
- never breaks character, never asks for PINs/OTPs/passwords

Without a key the platform runs identically on scripted replies. The default Groq model, `qwen/qwen3.8-27b`, is **preview-tier** — Groq's own documentation warns preview models "should not be used in production environments as they may be discontinued at short notice", so pin `GROQ_MODEL` to a production-tier slug before a pilot. Model provenance and refusal behavior: [MODEL_CARD.md](MODEL_CARD.md).

**Judges running a clone:** create a free key at console.groq.com → API Keys, put it in your local `.env` (`GROQ_API_KEY=…`) — never commit yours. **Hosted demo:** the deployment injects the key server-side, so judges get the live-LLM experience with zero setup while the key never reaches the browser.

## Measured latency

Two legs of the path are measured today. Everything else is a **target** and is marked as
not yet measured — a target printed next to a measurement is how a submission ends up
claiming performance it never observed. Sources: [docs/VERIFICATION.md](docs/VERIFICATION.md)
and the per-suite commands below.

| Leg                                                                | Target                      | Measured                                                             | Status                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Risk signal accepted → provider accepted (call placement)          | p95 < 1,500 ms              | **p95 551 ms** over 20 signals, co-located Postgres                  | ✅ MEASURED — `bun test tests/e2e/dial.test.ts`. The gate is topology-aware: against a remote database it asserts p95 under the measured DB floor plus the same budget, so a shared-hosting run (p95 6,715 ms against a 296 ms floor) passes without claiming 1,500 ms on hardware that cannot deliver it |
| Server tool round-trip (agent → `/api/elevenlabs/tools/*` → agent) | p95 < 300 ms                | **p95 9 ms** over 200 calls, co-located Postgres (db floor p95 3 ms) | ✅ MEASURED — `bun test tests/tools/guard.test.ts`                                                                                                                                                                                                                                                        |
| Signal accepted → first audio the customer hears                   | < 60 s (the headline claim) | —                                                                    | ⬜ **not yet measured** — needs a live PSTN call, which the evidence bundle does not contain                                                                                                                                                                                                              |
| Call end → post-call webhook ingested, case reconciled             | < 30 s                      | —                                                                    | ⬜ **not yet measured** — no end-to-end timing harness exists                                                                                                                                                                                                                                             |
| Verdict enqueued → first delivery attempt to the bank              | < 5 s                       | —                                                                    | ⬜ **not yet measured** — the outbox gate asserts retry/dead-letter _behaviour_, not delivery latency                                                                                                                                                                                                     |

The tool latency figure is only meaningful against a co-located database. The same suite
pointed at a remote Postgres measured p95 592 ms with a 294 ms database floor — 97 % of that
"regression" was network. The gate measures the database floor first and only enforces the
absolute 300 ms budget when the database is co-located, so a green run cannot be mistaken for
a measured one.

## Documentation

- 📦 [evidence/INDEX.md](evidence/INDEX.md) — what is in the evidence bundle, how each artifact was produced, and which claims are measured versus targeted.
- 📄 [docs/SUBMISSION.md](docs/SUBMISSION.md) — the full Stage‑1 submission: opportunity, measured baseline, architecture, and roadmap (Ignyte × ElevenLabs hackathon, Track 1 — Banking & Insurance, Use Case 1).
- 🖥️ In-app **Docs** page — live, runnable API reference served by the deployment itself.
- 🔐 In-app **Security** page — guardrails, compliance posture, and the audit-chain design.

## Branching model

| Branch    | Role                                                |
| --------- | --------------------------------------------------- |
| `main`    | Submission-ready, stable — the branch judges review |
| `staging` | Pre-release integration & verification screenshots  |
| `dev`     | Active development                                  |

---

<div align="center">

**SecureVoice** · built for the Ignyte × ElevenLabs hackathon (Banking & Insurance, Track 1)
Contact: [otemaach@gmail.com](mailto:otemaach@gmail.com)

</div>
