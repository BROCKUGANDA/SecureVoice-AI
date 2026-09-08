<div align="center">

<img src="public/logo.svg" alt="SecureVoice AI logo" width="110" />

# SecureVoice AI

**Real-time voice fraud intervention for banking & insurance.**
**Fraud detected. Customer called. Account frozen — in 60 seconds, not 38 minutes.**

[![Next.js 16](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Bun](https://img.shields.io/badge/Runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![Prisma + SQLite](https://img.shields.io/badge/Prisma-SQLite-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![ElevenLabs](https://img.shields.io/badge/Voice-ElevenLabs-000000)](https://elevenlabs.io)
[![Twilio](https://img.shields.io/badge/Telephony-Twilio-F22F46?logo=twilio&logoColor=white)](https://www.twilio.com)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED?logo=docker&logoColor=white)](#run-with-docker)

[Quickstart](#quickstart) &middot; [Run with Docker](#run-with-docker) &middot; [Demo walkthrough](#demo-walkthrough) &middot; [API surface](#api-surface) &middot; [Documentation](docs/SUBMISSION.md)

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

> **Prerequisites:** [Bun](https://bun.sh) ≥ 1.3, Node ≥ 20 (for tooling). No database server needed — SQLite.

```bash
# 1 — install dependencies
bun install

# 2 — configure (the platform boots fine with empty keys: dry-run + audit-only)
cp .env.example .env

# 3 — create the SQLite schema and seed a realistic case history
bun run db:push
bun run db:seed

# 4 — start the dev server
bun run dev
```

Open **[http://localhost:3000](http://localhost:3000)** — the landing page exposes the public pitch, the Docs, and the Security pages; the **Command Center** shows the live operator view.

## Run with Docker

The reproducible, zero-setup path — schema, seed data, and server in one command:

```bash
docker compose up --build
```

- **http://localhost:3000** is served by the Next.js standalone bundle inside a slim Bun image.
- `db-setup` provisions the SQLite schema (`prisma db push`) and seeds demo cases before `app` starts.
- The database persists in the `db-data` volume; `docker compose down -v` resets to a factory-fresh demo.
- A local `.env` is picked up automatically if present — without one the demo runs in dry-run mode.

<details>
<summary>Prefer plain Docker?</summary>

```bash
docker build -t securevoice-ai .
docker run -p 3000:3000 --env-file .env securevoice-ai
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
| `POST /api/interventions` | Bank fraud engine ingests a risk signal (signed payload) → case created, call placed |
| `POST /api/agent` | Guardrailed conversation turn API used during a live call |
| `POST /api/tts` · `POST /api/asr` | Neural TTS / speech-to-text, language-routed voice IDs, rate-limited |
| `POST /api/pilot` | End-to-end guided pilot (demo entry point) |
| `POST /api/enroll` | Enroll a customer for real Twilio delivery |
| `POST /api/webhooks` | Signed outbound phase-transition events back to the bank |
| `GET /api/status` · `GET /api/health` | Platform status & liveness |

Full request/response examples are on the in-app **Docs** page and in [docs/SUBMISSION.md](docs/SUBMISSION.md).

## Configuration

Everything is opt-in: **no keys required to run the demo** (dry-run + audit-only mode).

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite connection string (`file:…`) |
| `ELEVENLABS_API_KEY` / `ELEVENLABS_DRY_RUN` | Neural voice; `DRY_RUN=true` serves the dev backend without burning quota |
| `ELEVENLABS_MODEL` / `ELEVENLABS_STT_MODEL` | Model overrides (`eleven_v3`, `scribe_v2`) |
| `ELEVENLABS_VOICE_EN/AR/HI/UR` | Per-language voice IDs |
| `TWILIO_ACCOUNT_SID` / `TWILIO_API_KEY_*` / `TWILIO_FROM_NUMBER` | Real call + SMS delivery |
| `WEBHOOK_SECRET` | Signs outbound events & verifies inbound risk signals |
| `AUTH_SECRET` | Session cookie signing (384-bit) |
| `RATE_LIMIT_PER_HOUR` | Per-caller TTS/ASR/agent budget |
| `COMPLIANCE_*` | Server-enforced compliance flags (disclosure, no credential requests, PII redaction) |

See [.env.example](.env.example) for the annotated reference.

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
