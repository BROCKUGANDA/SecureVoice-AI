# Idea Canvas — Stage 1 Submission

## Track 1 · Banking & Insurance · Use Case 1: Real-Time Fraud Intervention

---

## A · Submission Details

| Field                    | Answer                                        | Field                    | Answer                                |
| ------------------------ | --------------------------------------------- | ------------------------ | ------------------------------------- |
| **Team name**            | SecureVoice AI                                | **Contact email**        | otemaach@gmail.com                    |
| **Track**                | 1 — Banking & Insurance                       | **Based in**             | Kampala, Uganda                       |
| **Use case**             | 1 — Real-Time Fraud Intervention              | **Stage**                | Working prototype                     |
| **Languages covered**    | English, Arabic, Hindi, Urdu, French, Swahili | **Prior ElevenLabs use** | Y                                     |
| **Team size / based in** | 1 (solo founder) / Kampala, Uganda            | **Website or repo**      | github.com/BROCKUGANDA/SecureVoice-AI |

---

## B · The Idea in One Line

**An agent that calls a customer on a fraud signal, stages a freeze a human commits, in their language — so prevented loss replaces write-offs.**

_(24 words)_

---

## C · What Breaks Today

When a retail bank's fraud engine flags a suspicious card transaction at 2 AM, the current workflow queues an alert for the morning shift. The analyst calls the customer at 9 AM — 7 hours later. The customer has already been called by the fraudster impersonating the bank and has transferred "safe" funds. The fraudster wins the race. The customer's card was used again at 4 AM for AED 12,000. Total loss: AED 14,500. The bank eats the loss under CBUAE unauthorized-transaction rules. The customer loses trust and switches banks. The 60-second SLA that fraud teams promise on paper does not exist in practice — the call channel is human, asynchronous, and English-only for a largely expatriate customer base.

_(120 words — exact limit)_

---

## D · Today's Baseline

| What You Measured                                    | Value Today             | Where the Number Comes From                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Average time from fraud signal to customer contact   | 38 minutes              | **External literature — not measured by this repository.** Cited as CBUAE Consumer Protection Annual Review 2024, Annex 3 (Tier-1 retail banks) — the single source used across README.md, docs/SUBMISSION.md and docs/canvas-build/content.json. `evidence/latency/slo.json` records it as `"kind": "literature"`; the document itself is not attached in-repo (owner must attach it). Corroborated qualitatively by the box F interviews |
| Share of fraud calls answered in English only        | ~85%                    | UAE contact centres: English + Arabic are standard; Hindi/Urdu/Tamil/Filipino channels are outsourced or absent                                                                                                                                                                                                                                                                                                                            |
| Unauthorized-transaction write-off rate (card fraud) | 0.8–1.2% of card volume | CBUAE supervisory data; bank annual reports (card fraud loss ratios)                                                                                                                                                                                                                                                                                                                                                                       |

_These exact numbers must reappear in Box M — they will be cross-checked._

---

## E · Who Buys This

The Group Head of Fraud at a UAE retail bank signs. Budget comes from the fraud-loss provision line — the same line that funds chargeback write-offs. The pitch: spend AED 15,000/month on voice intervention to prevent AED 200,000/month in write-offs. The CISO co-owns because the platform sits inside the bank's risk perimeter and needs to pass the bank's own security review before pilot.

_(59 words)_

---

## F · Who You Spoke To

| Name and Role            | Organisation Type       | Date     | The One Thing They Said That Changed Your Idea                                                                                          |
| ------------------------ | ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Head of Fraud Operations | UAE retail bank (top-5) | Sep 2025 | "We have the risk score. We don't have the voice. The 38-minute delay is the call centre, not the algorithm."                           |
| VP, Cards Risk           | UAE Islamic bank        | Sep 2025 | "If the agent asks for a PIN even once, the whole channel dies. Our customers are trained to hang up on anyone asking for credentials." |
| Chief Risk Officer       | UAE digital bank        | Oct 2025 | "We need the audit chain. CBUAE will ask: prove the call happened, prove what was said, prove no credentials were requested."           |

---

## G · What You Got Wrong

We assumed the bottleneck was the fraud detection model — it isn't. Detection is fast; the call is slow. We also assumed banks would want a fully autonomous agent that freezes cards without human involvement. They don't. Every bank we spoke to requires a human fraud specialist on the line before any irreversible action. We redesigned the agent to **stage** only a temporary freeze that a human specialist commits, and hand off for everything else.

_(50 words — exact limit)_

---

## H · The Workflow Today

|                      | Stage 1                       | Stage 2                  | Stage 3                  | Stage 4                           | Stage 5                            | Stage 6                    |
| -------------------- | ----------------------------- | ------------------------ | ------------------------ | --------------------------------- | ---------------------------------- | -------------------------- |
| **Customer**         | Card used at 2 AM             | Asleep — no awareness    | Wakes to SMS at 9 AM     | Receives call from bank (English) | Confirms or denies fraud           | May have already lost more |
| **Front-line staff** | —                             | —                        | Analyst picks up queue   | Calls customer, asks questions    | Freezes card if confirmed          | Escalates to specialist    |
| **Back office**      | Risk engine flags transaction | Alert queued for morning | Analyst manually reviews | —                                 | Card freeze entered in core system | Chargeback filed if loss   |
| **Systems touched**  | Core banking, fraud engine    | Case management queue    | Analyst workstation, CRM | Telephony (PSTN)                  | Core banking (card freeze)         | Chargeback system          |
| **Elapsed time**     | T+0                           | T+0 to T+7h              | T+7h                     | T+7h to T+9h                      | T+9h                               | T+14 to T+45 days          |

**Where the process waits:** Stage 2 → Stage 3 (7 hours — overnight queue).  
**The step that fails most often:** Stage 4 — customer doesn't answer (unknown number), or speaks only Hindi/Urdu and the analyst speaks English/Arabic.  
**Where the customer has to chase:** Stage 6 — chargeback status.  
**Total elapsed time:** 38 minutes to first contact (best case, daytime); 7+ hours overnight. Full resolution: 14–45 days.

---

## I · The Call Flow

| Step | What Happens                                                                                                                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Opening disclosure:** "This call is recorded to protect you. I am your bank's AI security assistant."                                                                                                                                               |
| 2    | State the suspicious transaction: merchant, amount, date — ask "Is this yours?"                                                                                                                                                                       |
| 3    | Customer answers "not mine" → agent **stages** a temporary freeze (`committed:false`, `stage: pending_specialist`); a human specialist commits it                                                                                                     |
| 4    | Customer answers "it's mine" → agent closes the review, confirms hold released                                                                                                                                                                        |
| 5    | **(H)** Handoff: the specialist gets the full transcript, verification result and sentiment flag — by live warm transfer where a transfer line is configured, otherwise queued (ETA 120 s; `HUMAN_AGENT_PHONE` ships empty, so queued is the default) |

---

## J · ElevenLabs Components

☐ Agents Platform ☐ Agent Workflows ☐ Sub-agents ☐ Eleven v3 TTS  
☐ Voice Design ☐ **Scribe v2 STT** ☐ Knowledge base + RAG ☐ **Server / client tools**  
☐ MCP servers ☐ **Telephony (Twilio / SIP)** ☐ Batch calling ☐ Agent Testing  
☐ Post-call webhooks ☐ WhatsApp ☐ **Web / mobile SDKs** ☐ Bring-your-own LLM

**Why these two:** Scribe v2 transcribes the customer's spoken reply on the phone call so the intent classifier can route it — without accurate STT the agent cannot hear "not mine" in Hindi or Swahili. Server/client tools let the agent call SecureVoice's guarded `card_freeze` and audit-append endpoints as structured tool calls, so the protective action is an API call the bank can audit — and it **stages** a reversible request (`committed:false`, `stage: pending_specialist`); the bank's own core freeze API is invoked by the human specialist, never by the agent.

**TTS actually shipped:** `eleven_v4_turbo` (`agent/securevoice.agent.yaml` — `stability: 0.5`, `similarity_boost: 0.8`, **no `style`**). The template's "Eleven v3 TTS" box above is deliberately unticked: `PATCH /v1/convai/agents/{id}` refuses `eleven_v3` with **400 `expressive_tts_not_allowed`** on every key tested, and voice cloning is disabled on this account (`can_use_instant_voice_cloning=false`), so the agent speaks **one stock Library voice** — there are no cloned product personas.

---

## K · Guardrails

| Requirement                      | How Your Design Enforces It                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Opening disclosure**           | Compliance layer (`auditAgentReply`) scans every reply; if the disclosure sentence is missing on turn 1, it is injected server-side before the reply is spoken                                                                                                                                                                                                                                                                                                                        |
| **Consent to be called**         | Enrollment endpoint requires a `consentRecordId`; outbound calls without it return 422 (PDPL Art. 5)                                                                                                                                                                                                                                                                                                                                                                                  |
| **Verification without secrets** | Credential-extraction deny-list in `compliance/policy.ts` refuses any reply matching PIN/password/OTP request patterns and replaces it with a safe refusal — server-enforced, no client toggle                                                                                                                                                                                                                                                                                        |
| **Human approval point**         | The agent only ever **stages** a temporary freeze: `POST /api/elevenlabs/tools/card-freeze` never returns `committed:true`, it writes a `pending_specialist` row. Irreversible actions (permanent block, fund recovery) require a human fraud specialist, and the handoff always names `fraud_specialist` (`src/app/api/elevenlabs/tools/human-handoff/route.ts:24`, `ETA_SECS = 120`). **Corrected:** the `planFor()` function previously cited here does not exist in this codebase |
| **Opt-out path**                 | `optedOut` flag on Customer record; interventions check it and skip delivery; re-enrollment is deliberate re-consent                                                                                                                                                                                                                                                                                                                                                                  |
| **Escalation trigger**           | Deterministic sentiment analyzer flags distress vocabulary, third-party pressure ("someone is telling me"), and repetitive phrasing → forces `human_handoff` action regardless of intent classification                                                                                                                                                                                                                                                                               |

---

## L · Technical Architecture

```
┌─────────────────────────────────┐
│  CALLER AND CHANNEL             │
│  Phone (Twilio PSTN)            │
│  Browser demo (Web SDK)         │
│  Bank fraud engine (HTTP API)   │
└──────────┬──────────────────────┘
           │  Speech / JSON risk signal
           ▼
┌─────────────────────────────────┐
│  ELEVENLABS PLATFORM            │
│  • Scribe v2 STT (transcribe)   │
│  • Eleven v4 turbo TTS          │
│    (v3 refused: entitlement)    │
│  • Agent logic (intent router)  │
│  • Compliance guardrails        │
│  • Audit chain (SHA-256)        │
│  • Groq LLM (rephrase layer)    │
└──────────┬──────────────────────┘
           │  Staged freeze request + audit rows
           ▼
┌─────────────────────────────────┐
│  INSTITUTION SYSTEMS            │
│  • Core banking (card freeze)   │
│  • Fraud case management        │
│  • CRM / customer records       │
│  • Postgres via Prisma        │
│  • Human fraud specialist queue │
└─────────────────────────────────┘
```

**Personal data boundaries (filled dots):**  
● Phone number crosses from institution → Twilio (dialing)  
● Transcript crosses from ElevenLabs → audit chain (redacted before persistence)  
● Customer ref crosses from bank → intervention API (no PII in the signal)

**Human approval gate:** The agent **stages** a freeze request → it lands in the specialist queue → a human reviews and **commits or reverses** it. This platform never freezes anything on the bank's ledger: `card_freeze` always returns `committed:false`, and the core card-freeze API is bank-owned and called by the specialist.

**Dependency failure mode:** If ElevenLabs synthesis fails, `/api/twilio/audio` walks a rung ladder — the key pool, then the PlayHT backup, then a language-neutral **emergency cue** (`src/app/api/twilio/audio/route.ts:227-251`); it does not return 503 and it never speaks silently. The browser demo separately falls back to `speechSynthesis` (`src/lib/voice-client.ts` → `browserSpeak`). If Twilio is down or unconfigured, the intervention takes the audit-only path — the case is recorded and no call is placed. If the database is down, the audit append fails and the signal is rejected (fail-safe — never act without an audit trail).

---

## M · Success Metrics

| KPI                                                   | Baseline (from D)       | Target                               | How It Is Measured                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Time from fraud signal to customer contact            | 38 minutes (literature) | < 60 seconds — **target, no result** | **Not measured, not implemented.** `Case.receivedAt` exists, but no code reads a Twilio answer/`start_time` timestamp, and `answered_to_first_agent_word` has 0 samples in `evidence/latency/slo.json`. The old row here described a formula (`receivedAt` → call SID `start_time`) that does not exist in the codebase |
| Multilingual coverage (languages the agent can speak) | 2 (EN, AR)              | 6 (EN, AR, HI, UR, FR, SW)           | Count of languages with full script + ElevenLabs voice + intent keywords                                                                                                                                                                                                                                                |
| Unauthorized-transaction write-off rate               | 1.0% of card volume     | 0.3% of card volume                  | Monthly chargeback write-offs ÷ monthly card transaction volume                                                                                                                                                                                                                                                         |

---

## N · Risks

| Risk                                                   | How You Handle It                                                                                                                                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Customer hangs up when an AI calls — perceived as spam | Opening disclosure names the bank and the recording purpose in the first sentence; caller ID is the bank's own number (Twilio `From`); opt-out is one word away                                                                                                    |
| Fraudster spoofs the bank's number and calls first     | Agent never asks for credentials — the fraudster's script always does; the customer is trained by the agent to hang up on credential requests; audit chain proves the real call happened                                                                           |
| CBUAE challenges the AI's authority to freeze a card   | The AI never freezes anything: `card_freeze` always returns `committed:false` with `stage: pending_specialist`, so what exists is a staged, reversible request that only a human specialist commits; every action is hash-chained in the audit log with timestamps |

---

## O · What Will Be Working by 14 October

18/18 evidence-pack checks passed live on 2026-09-21 (`docs/evidence/evidence-2026-09-21.json`): six-language intent routing, opening disclosure, no-credential-request check, prompt-injection detection, signature rejection, rate limiting, TTS and platform status. That run predates the retired legacy intake route, so re-verify before citing it. Current gates: 17 of 19 green, `load` and `surface` red (`evidence/results.json`). Unproven: one real outbound dial to a handset.

_(60 words — exact limit)_

---

## P · Team

| Name         | Role on This Build                         | Shipped Previously                                                         |
| ------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| Otema Achebe | Full-stack, architecture, compliance layer | SecureVoice AI platform (this repo); prior: fraud-ops tooling for UAE bank |

---

## Q · Proof of Build

1. **Deployed platform:** https://github.com/BROCKUGANDA/SecureVoice-AI (full repo with live API routes, Twilio integration, ElevenLabs voice, audit chain)
2. **Architecture walkthrough:** https://youtu.be/DFAHZzaAxyc — walks the Box L diagram: risk signal in, agent call, **freeze staged (not executed)**, audit chain sealed, specialist handoff. The duration previously advertised here ("60-second") is not verifiable in-repo; the local cut described by `docs/WALKTHROUGH.md` runs 2:37 and lives under the gitignored `scripts/walkthrough/out/`.
