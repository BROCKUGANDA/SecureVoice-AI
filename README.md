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

[Quickstart](#quickstart) &middot; [Run with Docker](#run-with-docker) &middot; [Demo walkthrough](#demo-walkthrough) &middot; [API surface](#api-surface) &middot; [**Integration guide**](docs/INTEGRATION.md) &middot; [Submission](docs/SUBMISSION.md) &middot; [Releasing](docs/RELEASING.md)

<img src="scripts/shots/splash-new.png" alt="SecureVoice AI — fraud intervention call in progress" width="900" />

</div>

---

## What it does

Today, when a bank's fraud engine flags a transaction, the case lands in a Tier‑1 analyst's queue ~9 minutes later. The analyst dials the customer, the customer doesn't recognize the number, and while the phone rings the fraudster completes the second transaction. The average call-center agent takes **38 minutes** to work a single case — the fraudster moves in **seconds**.

**SecureVoice AI closes that gap.** The moment a risk signal arrives (`POST /api/interventions`), the platform:

1. Places an **outbound voice call to the customer within seconds** — live over Twilio, in the customer's own language.
2. Runs a **guardrailed, streaming voice agent** (ElevenLabs neural voices) that verifies the transaction — *"You did not authorize the AED 2,500 transaction — is that correct?"*
3. On confirmation, **freezes the account, escalates to a human specialist, and streams every phase transition back to the bank** via signed webhooks — with a tamper-evident **audit chain** recording the entire interaction.

> **Compliance by construction:** every call opens with a disclosure, the agent *never* requests PINs/OTPs/passwords (server-enforced, not prompt-enforced), and all PII is redacted before persistence.

## Features

- 🎙️ **Streaming voice agent with barge-in** — sub-second turn-taking; the customer can interrupt the agent mid-sentence.
- 🌍 **Multilingual** — English & Arabic live end-to-end, Hindi & Urdu live, French / Bengali / Swahili on the roadmap. Voice identity per language.
- 🖥️ **Operator Command Center** — live intervention feed (SSE), case monitoring, sentiment-based escalation to human specialists.
- 🔗 **Tamper-evident audit chain** — every action hash-chained (sha256) with canonical serialization; exportable per case reference.
- 🏦 **Bank-grade ingest API** — signed risk-signal webhooks (`SV-Signature: t=…,v1=…`), idempotent case creation, producer key auth.
- 📞 **Real telephony** — live SMS + voice delivery via Twilio; runs in audit-only mode without credentials.
- 🔑 **BYOK & white-label** — banks can bring their own ElevenLabs key; per-organization branding on Settings.
- 🧾 **Credits wallet** — per-organization budgeting of intervention usage.

## Quickstart

> **Prerequisites:** [Bun](https://bun.sh) ≥ 1.3, Node ≥ 20 (for tooling).
> The datasource in `prisma/schema.prisma` is **PostgreSQL** — you need a Postgres
> server, or just use Docker below. There is **no SQLite mode** (Prisma rejects a
> `file:` URL against a `postgresql` provider).

```bash
# 1 — install dependencies
bun install

# 2 — configure (the platform boots fine with empty keys: dry-run + audit-only)
cp .env.example .env
#    then set DATABASE_URL to your Postgres, e.g.
#    DATABASE_URL="postgresql://user:pass@localhost:5432/securevoice?schema=public"

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
> postgresql://`). Verified empirically — don't be misled by older notes that mention
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

| Variable | Default | Purpose |
| --- | --- | --- |
| `SITE_ADDRESS` | `localhost` | Domain Caddy issues a certificate for. Must resolve to the host. |
| `ACME_EMAIL` | `admin@example.com` | Let's Encrypt expiry notices. |
| `REALTIME_INGEST_SECRET` | falls back to `AGENT_TOOL_SECRET` | HMAC key shared by app and realtime. Unset ⇒ realtime refuses every connection and the console silently uses SSE. |
| `REALTIME_URL` | `http://realtime:4000` | Internal service address. **Never `localhost`** — inside the app container that is the app container. |
| `REALTIME_ALLOWED_ORIGIN` | empty (any) | Comma-separated browser origins the socket accepts. |
| `EDGE_RATE_LIMIT_PER_HOUR` | `600` | Pre-auth edge budget per client IP. Separate from the expensive-call API limit. |

### Feature flags

Every runtime switch is declared in `src/lib/flags.ts` — one file answers
"what is switchable in this deployment?", which is not otherwise greppable.

| Flag | Default | Effect |
| --- | --- | --- |
| `FEATURE_REALTIME` | `false` | Signed push to the realtime service. Needs `REALTIME_INGEST_SECRET` too — both or neither, because the service rejects every handshake without a secret. |
| `FEATURE_CONSOLE_LIVE_FEED` | `false` | Console live feed over the websocket. Off means SSE, which is what shipped first. |
| `FEATURE_PII_REDACTION` | `true` | Redact PII in logs, audit rows, webhook payloads. Turning this off writes customer transcripts in the clear — local debugging only. |
| `FEATURE_ELEVEN_LABS_LIVE` | `false` | Real neural voice. `ELEVENLABS_DRY_RUN` still wins when set, since the provider client reads it directly. |

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

1. **Land on the pitch page** — *"Fraud detected. Call placed. Frozen. In 60 seconds."*
2. **Launch the live demo** — a seeded intervention case appears in the **Command Center** (operator view) with live status transitions.
3. **Trigger an intervention** — the pilot flow places a real outbound call/SMS (Twilio trial: verified numbers only) or runs the simulated stream when keys are absent.
4. **Watch the voice agent work** — streaming TTS with barge-in, guardrail chips ("No PINs requested"), Arabic voice live on the call.
5. **Inspect the audit trail** — every step is hash-chained and verifiable against the canonical chain spec in `src/lib/audit-chain.ts`.
6. **Escalation** — sentiment analysis hands the customer to a human specialist ("Handoff ready — Sara H.").

## API surface

| Route | Purpose |
|---|---|
| `POST /api/interventions` · `/v1/interventions` | Bank fraud engine ingests a risk signal (HMAC-signed) → case created, SLA clock starts |
| `POST /api/enroll` · `/v1/enroll` | Enroll a customer for real Twilio delivery (requires a `consentRecordId`) |
| `POST /api/agent` | Guardrailed conversation turn API used during a live call |
| `POST /api/tts` · `POST /api/tts/stream` · `POST /api/asr` | Neural TTS / speech-to-text, language-routed voice IDs, rate-limited |
| `POST /api/pilot` | Guided pilot / lead capture |
| `POST /api/webhooks` | Signed outbound phase-transition events back to the bank |
| `POST /api/elevenlabs/tools/card-freeze` | ElevenLabs agent tool → **stages** a reversible freeze (always `committed:false`) |
| `POST /api/elevenlabs/tools/human-handoff` | ElevenLabs agent tool → queue a fraud specialist |
| `POST /api/elevenlabs/signed-url` | Mint a 15-min browser session credential; pins `ELEVENLABS_AGENT_ID` |
| `GET /api/status` · `GET /api/health` · `GET /api/console/audit` | Status, liveness, audit chain export |

Full request/response examples are on the in-app **Docs** page. For signing, enrolment,
tool authorisation, and self-serve onboarding see **[docs/INTEGRATION.md](docs/INTEGRATION.md)**.

## Run the ElevenLabs agent (optional, needs an account)

The platform works standalone with the built-in voice pipeline. To use the **ElevenLabs
conversational agent** instead, set `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` in `.env`.

**Agent configuration as code.** The full agent definition — system prompt, per-language
first messages and disclosure lines, LLM selection, TTS voice IDs, audio format, turn-taking,
max duration, tool IDs, knowledge-base locators, RAG settings, evaluation criteria and
data-collection fields — lives in [`agent/securevoice.agent.yaml`](agent/securevoice.agent.yaml).
It is applied and verified by:

```bash
bun run agent:apply     # PATCH the agent, GET it back, deep-diff — exits non-zero on divergence
bun run agent:snapshot  # write canonical config + sha256 to evidence/agent/
```

The current submission version is **`agtvrsn_0401m3xcsnyaeqbr5vkf4s6fffsp`**
(agent `agent_3601m3temww9e5eb43z3dtdthzdp`). The snapshot hash
`587112bd6949baa2002db99b17c76548214f63523498c7678339a876d5d9e3a7` is recorded in
[docs/VERIFICATION.md](docs/VERIFICATION.md) and is reproducible — a second apply produces
an identical hash and an empty diff.

The two webhook tools and both knowledge-base documents are already defined on the
account, and on our agent they are **attached**, with RAG and source attribution on.
If you set this up on a new agent, attach them via `PATCH /v1/convai/agents/{id}`:

```bash
# knowledge_base locators need type + name + id. `type` must be one of
# file | url | text | folder — anything else returns HTTP 400.
curl -X PATCH "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" \
  -H "xi-api-key: $ELEVENLABS_API_KEY" -H "content-type: application/json" \
  -d '{"conversation_config":{"agent":{"prompt":{
        "tool_ids":["tool_…","tool_…"],
        "knowledge_base":[{"type":"text","name":"<doc name>","id":"<doc id>"}],
        "rag":{"enabled":true,"include_source_urls":true}}}}}'
```

Always **read the fields back** with a GET — a 200 on PATCH does not prove anything saved.

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

## Configuration

Everything is opt-in: **no keys required to run the demo** (dry-run + audit-only mode).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | **PostgreSQL** connection string (the Prisma datasource). An absolute `file:` URL also works for SQLite. |
| `ELEVENLABS_AGENT_ID` | The ElevenLabs agent the browser may connect to. `/api/elevenlabs/signed-url` rejects any other id (403). |
| `AGENT_TOOL_SECRET` | Shared secret the agent must present on webhook tool calls (`x-agent-tool-secret`). |
| `AGENT_TOOL_ALLOWED` | Comma-separated tool allow-list, e.g. `card_freeze,human_handoff`. A secret valid for one tool does not authorise another. |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_DRY_RUN` | Neural voice; `DRY_RUN=true` serves the dev backend without burning quota |
| `ELEVENLABS_MODEL` / `ELEVENLABS_STT_MODEL` | Model overrides (`eleven_v3`, `scribe_v2`) |
| `ELEVENLABS_VOICE_EN/AR/HI/UR` | Per-language voice IDs |
| `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_*` / `TWILIO_FROM_NUMBER` | Real call + SMS delivery |
| `WEBHOOK_SECRET` | Signs outbound events & verifies inbound risk signals |
| `AUTH_SECRET` | Session cookie signing (384-bit) |
| `GROQ_API_KEY` / `GROQ_MODEL` | **Optional** live LLM reply layer — drafts the agent's spoken lines in the customer's language (default `qwen/qwen3.8-27b`). Server-side only; never commit a key. |
| `GEMINI_API_KEY` / `GEMINI_MODEL` | Optional LLM fallback when no Groq key is present (`gemini-1.5-flash`) |
| `RATE_LIMIT_PER_HOUR` | Per-caller TTS/ASR/agent budget |
| `COMPLIANCE_*` | Server-enforced compliance flags (disclosure, no credential requests, PII redaction) |

See [.env.example](.env.example) for the annotated reference.

## The LLM reply layer (optional)

The agent's **intent routing and compliance guardrails are deterministic server-side code** — an LLM never decides to freeze a card, and a refusal cannot be prompted away. When `GROQ_API_KEY` (or `GEMINI_API_KEY`) is set, the model only *rephrases* the verified reply in the customer's language (en/ar/hi/ur/fr/sw) under strict voice rules, then passes the same compliance scan as the scripted replies:

- ≤ 50 words — sized for a phone call, not a chat window
- no markdown, asterisks, or emojis — TTS reads punctuation literally
- never breaks character, never asks for PINs/OTPs/passwords

Without a key the platform runs identically on scripted replies. Model provenance and refusal behavior: [MODEL_CARD.md](MODEL_CARD.md).

**Judges running a clone:** create a free key at console.groq.com → API Keys, put it in your local `.env` (`GROQ_API_KEY=…`) — never commit yours. **Hosted demo:** the deployment injects the key server-side, so judges get the live-LLM experience with zero setup while the key never reaches the browser.

## Documentation

- 📄 [docs/SUBMISSION.md](docs/SUBMISSION.md) — the full Stage‑1 submission: opportunity, measured baseline, architecture, and roadmap (Ignyte × ElevenLabs hackathon, Track 1 — Banking & Insurance, Use Case 1).
- 🖥️ In-app **Docs** page — live, runnable API reference served by the deployment itself.
- 🔐 In-app **Security** page — guardrails, compliance posture, and the audit-chain design.

## Branching model

| Branch | Role |
|---|---|
| `main` | Submission-ready, stable — the branch judges review |
| `staging` | Pre-release integration & verification screenshots |
| `dev` | Active development |

---

<div align="center">

**SecureVoice** · built for the Ignyte × ElevenLabs hackathon (Banking & Insurance, Track 1)
Contact: [otemaach@gmail.com](mailto:otemaach@gmail.com)

</div>
