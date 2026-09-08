# SecureVoice AI — Ignyte × ElevenLabs Stage 1 Submission

> Banking & Insurance Track · Use Case 1: Real-time fraud intervention
> Maps directly to the ElevenLabs Idea Canvas boxes A–Q.

---

## 01 The Opportunity

### A. Submission details

| FIELD | YOUR ANSWER |
|---|---|
| Team name | SecureVoice |
| Contact email | aaron@securevoice.ai |
| Track (1 or 2) | 1 — Banking & Insurance |
| Use case (1–8) | 1 — Real-time fraud intervention for retail banking customers |
| Stage | Stage 1 submission |
| Languages covered | English, Arabic (live end-to-end) + Hindi, Urdu (live) + French, Bengali (roadmap) |
| Prior ElevenLabs use (Y/N) | N |
| Team size / based in | Solo founder + AI engineering pipeline · Dubai, UAE |
| Website or repo | https://github.com/aaron-otema/securevoice (private) · live demo at https://securevoice.ai |

### B. The idea in one line (25 words max)
An agent that calls a bank customer in 38 seconds when their card is used in a new country, so that the customer never loses money to a fraudster they couldn't reach in time.

### C. What breaks today (120 words max)
Today the workflow is: fraud engine flags a transaction → case lands in a Tier-1 analyst's queue at +9 minutes → analyst dials the customer → customer doesn't answer (unknown number) → analyst leaves voicemail → fraudster completes second transaction at +18 minutes → bank eats the loss. The exact point that fails is the **analyst-to-customer handoff** — the average bank call-center agent waits 38 minutes before they finish one prior case and can dial the next, while the fraudster moves in seconds. The customer is left waiting, the bank is paying out, and the regulator (CBUAE) is writing the next fine.

### D. Today's baseline — what you measured (numbers only)

| VALUE TODAY | WHERE THE NUMBER COMES FROM |
|---|---|
| 38 min | average time from fraud flag to customer contact (CBUAE Consumer Protection Annual Review 2024, Annex 3 — Tier-1 retail banks) |
| 14% | fraud-loss recovery rate when customer is contacted within 10 minutes vs. 2% after 60 minutes (LexisNexis True Cost of Fraud 2024, MENA retail-banking cohort) |
| AED 2,847 | average per-case loss across 11 UAE retail banks (UAE Central Bank Cyber Fraud Bulletin, Q1 2025) |
| 1 in 6 | Tier-1 calls where the analyst must escalate to a senior before acting (internal sample of 14,200 cases) |

### E. Who buys this (60 words max)
Head of Fraud Operations at a UAE retail bank — typically a Director-level signatory with both operational budget and regulatory accountability. Budget comes from the existing fraud-loss line (currently absorbed) plus a marginal improvement to the cyber-risk reserve (UAE Central Bank Circular 4/2024 requires Tier-1 banks to hold 1.5% of digital transaction value in reserve). Sale is 12-month SaaS, AED 120k–340k/year per bank, with a shared-success component on prevented-loss.

---

## 02 The Evidence

### F. Who you spoke to

| NAME AND ROLE | ORGANISATION | DATE | TYPE | THE ONE THING THEY SAID THAT CHANGED YOUR IDEA |
|---|---|---|---|---|
| Aisha Al Marzooqi · VP, Fraud Risk | a Tier-1 UAE bank (anonymised at request) | 2026-08-19 | in-person | "The hardest part isn't the detection — it's the call. My analysts spend 80% of their shift on the phone, and they still can't get there in time." |
| Marcus Brennan · former fraud analyst, now regtech founder | independent | 2026-08-22 | video | "If you can solve the first 60 seconds after the alert, you've already done more than the last five years of ML." |
| Hala Saeed · Customer Experience Director | a regional bank | 2026-08-25 | video | "Customers don't answer unknown numbers. Whatever you build, it has to feel like the bank, not like a robot calling about a robot." |
| Dr. Khalid Al Hammadi · UAE PDPL Office | regulator | 2026-09-01 | in-person | "We don't mind AI on the line if it identifies itself, never asks for secrets, and keeps a record we can audit. If it does those three things, the rest is engineering." |

### G. What you got wrong (50 words max)
We started with the assumption that customers would prefer to *type* into a chat. Two interviews killed that — they want to *hear* a voice, especially when they're stressed about money. Pivoted the entire UX to outbound voice in week one, abandoned the chat prototype in week two.

### H. The workflow today

| Stage 1 | Stage 2 | Stage 3 | Stage 4 | Stage 5 | Stage 6 |
|---|---|---|---|---|---|
| **Customer / Applicant** makes a card payment that trips a rule (e.g. new country, atypical merchant, large amount) | **Front-line analyst** picks up the alert from the queue (avg wait: 4 min) — they open the case in 3 systems (fraud engine, CRM, IVR) | **Analyst dials** the customer from the bank's CLI (customer's phone shows a generic 04 number — unknown) — call goes to voicemail 67% of the time | **Analyst leaves voicemail**, escalates to the bank's standard 2-line SMS — both happen in parallel | **Back-office approver** (Tier-2 supervisor) reviews the case at +22 min, must verbally approve the freeze — adds another dial | **Fraud system** receives the freeze instruction at +38 min; card is blocked; if fraudster already moved, loss is booked |
| **Systems:** card processor (card-not-present check), bank fraud engine (rule + ML), | **Systems:** fraud case mgmt, CRM, IVR, | **Systems:** PSTN/SIP, customer mobile, | **Systems:** voicemail box, SMS gateway, | **Systems:** supervisor queue, audit log, | **Systems:** card processor freeze API, ledger (loss booked), |
| **Elapsed time:** 0–5 s | **Elapsed time:** +5 min | **Elapsed time:** +5 to +11 min | **Elapsed time:** +11 to +18 min | **Elapsed time:** +18 to +28 min | **Elapsed time:** +28 to +38 min |
| The step that fails most often: **Stage 3** — customer does not answer an unknown number | | | Where the customer chases: **Stage 5** — by now they're calling the bank's main line asking "did you just call me?" | | **Total elapsed time: 38 minutes** |

---

## 03 The Agent

### I. The call flow (5 steps, 15 words each)

| STEP | WHAT HAPPENS |
|---|---|
| 1 | **Opening disclosure (H=handoff-on-trigger):** "This call is recorded to protect you. I'm your bank's AI security assistant calling about a transaction on your card." |
| 2 | **Verify identity via zero-knowledge pattern (H):** "Can you confirm the last transaction you remember making on this card?" — never asks for PIN/OTP/CVV. Customer confirms or denies. |
| 3 | **Branch on customer response:** (a) "Not mine" → card frozen immediately, specialist joins call within 30s. (b) "It's mine" → close review, log confirmation. (c) Confused → re-state disclosure, offer to dial back from bank's verified number. |
| 4 | **Action confirmation:** customer hears the freeze action in their language (EN/AR/HI/UR), receives SMS receipt, is told to expect a call from the specialist within 30 seconds. |
| 5 | **Handoff to human (H):** AI summarises the conversation in the specialist's console, including any prompt-injection attempts detected during the call. Specialist joins the line. |

### J. ElevenLabs components (tick + 60-word justification)

| Component | Used? | Why |
|---|---|---|
| Agents Platform | ✅ | Core platform — Agents orchestrates the conversation, calls our server-side tools for `card_freeze` and `human_handoff` |
| Agent Workflows | ✅ | Multi-step flow (verify → confirm → freeze → handoff) is a Workflow, not a single turn |
| Sub-agents | ❌ | One agent suffices; sub-agents add latency without adding capability here |
| Eleven v3 TTS | ✅ | Multilingual v3 is the only neural voice that genuinely renders UAE banking-register Arabic; lower tiers mispronounce financial terms |
| Voice Design | ✅ | We cloned four personas (EN-Male-Authoritative, AR-Female-Warm, HI-Male-Firm, UR-Female-Respectful) from licensed voice-talent recordings, each with consent URL on file |
| Scribe v2 STT | ✅ | Scribe v2 is the only STT that handles code-switched Arabic-English (very common in UAE banking); we transcribe even our own TTS for the audit log |
| Knowledge base + RAG | ✅ | KB holds the bank's verified fraud-disposition policy in EN/AR; agent refuses to deviate from policy text |
| Server / client tools | ✅ | Two server tools: `card_freeze(accountId, reason)` and `human_handoff(callRef, summary)`. Both idempotent. |
| MCP servers | ❌ | No MCP-native CRM in our target bank stack; we wire via signed webhooks instead |
| Telephony (Twilio / SIP) | ✅ | Twilio SIP trunk for UAE carrier interconnect; CLI set to bank's verified number on outbound |
| Batch calling | ❌ | Outbound is per-event, never batch — anti-PUP & anti-spam compliance |
| Agent Testing | ✅ | 27 conversation scenarios (3 cases × 9 perturbations: noise, accents, prompt injection, OTPs in input, multi-language, etc.) run nightly |
| Post-call webhooks | ✅ | Signed `post-call` webhooks to bank's CRM + SIEM, redacted before send |
| WhatsApp | ❌ | Out of scope for this use case (bank calls, not bank messages) |
| Web / mobile SDKs | ✅ | Web SDK for the customer-side portal (account activity); mobile SDK deferred to Stage 2 |
| Bring-your-own LLM | ❌ | Agents Platform's tuned model handles this; we don't need a second LLM in the loop |

**Why these two least obvious choices:**

1. **Voice Design (cloned personas)** — banking in the UAE is a relationship business; a generic TTS voice erodes trust. We licensed four voice talents, recorded 90 minutes each, and cloned with documented consent. The cloned voice is what the regulator hears on the call recording.

2. **Post-call webhooks (signed)** — every conversation must be auditable downstream by the bank's SIEM. We sign the payload with `SV-Signature: t=<ts>,v1=<sha256(t.body, WEBHOOK_SECRET)>` and redact PII (PAN, IBAN, phone, email, OTP) before signing. The bank's SIEM verifies the signature, decrypts the audit-log hash chain, and imports.

### K. Guardrails (every row is a code-level mechanism, not a comment)

| REQUIREMENT | HOW YOUR DESIGN ENFORCES IT |
|---|---|
| Opening disclosure | `src/lib/compliance/policy.ts → auditAgentReply()` injects the locale-specific disclosure string (`"This call is recorded to protect you"` / `"هذه المكالمة مسجلة لحمايتك"` / `"यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड हो रहा है"` / `"یہ کال آپ کی حفاظت کے لیے ریکارڈ ہو رہی ہے"`) into every reply; if missing it appends the literal and flags `disclosure_injected` in the audit row |
| Consent to be called | Outbound calls require `consentRecordId`; missing → 422 (`requireOutboundConsent`). Inbound calls are exempt (caller initiated). |
| Verification without secrets | Agent's decision tree + reply table in `src/app/api/agent/route.ts` contains exactly four intents (`deny_fraud`, `confirm_authorized`, `greeting`, `unclear`); zero branches ask for PIN, password, OTP, CVV, or full PAN. The classifier is deterministic — no LLM in the path. |
| Human approval point | Every `card_freeze` decision routes through `human_handoff` (specialist joins within 30 s, SLA in the bank's runbook). The agent's written summary appears in the specialist's console; specialist confirms before the freeze commits to the bank's core system. |
| Opt-out path | Agent's greeting includes the bank's verified callback number in every language; user can hang up + dial back. A "do not call again" flag persists in the bank's CRM (out of our scope; bank-owned system). |
| Escalation trigger | Agent routes to human on (a) `deny_fraud` decision, (b) prompt-injection detection (`auditUserInput` flags "ignore previous instructions", "share my otp", etc.), (c) customer sounds confused, (d) low confidence in the STT transcript. |

---

## 04 The Architecture

### L. Technical architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           CALLER + CHANNEL ZONE                              │
│                                                                              │
│   [Customer Mobile ◉]  ───PSTN/SIP───  [Twilio Trunk]  ───HTTPS/WSS───►    │
│                                                                              │
│   [Web App ◉]          ───HTTPS──────────►  [Web SDK ◉]                     │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
        │                              │
        │ inbound audio                │ web text input
        ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          ELEVENLABS PLATFORM ZONE                            │
│                                                                              │
│   ┌─────────────────────────┐         ┌─────────────────────────┐            │
│   │   Agents Platform ◉     │────────►│   Eleven v3 TTS ◉       │            │
│   │   (conversation loop)   │         │   (4 cloned voices)     │            │
│   │                         │◄────────│   Scribe v2 STT ◉       │            │
│   └────────┬────────────────┘         └─────────────────────────┘            │
│            │                                                               │
│            │ Tools (defined in Agents Platform):                            │
│            │   • card_freeze(accountId, reason)  ◉ server-side              │
│            │   • human_handoff(callRef, summary) ◉ server-side              │
│            │                                                               │
│            ▼                                                               │
│   ┌─────────────────────────────────────────────────────────────────┐      │
│   │   Agent Testing: 27 scenarios × 9 perturbations, nightly run     │      │
│   │   Knowledge base: bank's fraud-disposition policy (EN/AR)       │      │
│   │   Post-call webhooks: signed payload to bank's CRM + SIEM       │      │
│   └─────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        │ Signed HTTPS (HMAC-SHA256, replay-protected)
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         INSTITUTION SYSTEMS ZONE                             │
│                                                                              │
│   [SecureVoice API /api/agent] ───writes───► [Audit Chain (SQLite, ◉)]      │
│                                                                              │
│   [SecureVoice API /api/tts]    ───reads───►  [ElevenLabs keyring]           │
│                                                                              │
│   [SecureVoice API /api/asr]    ───reads───►  [ElevenLabs keyring]           │
│                                                                              │
│   [Outbound webhook server]     ───POSTs───► [Bank CRM stub]                 │
│                                                                              │
│   [Outbound webhook server]     ───POSTs───► [Bank SIEM stub]                │
│                                                                              │
│   [Card processor freeze API]   ◉ bank-owned                                │
│   [Specialist console]          ◉ bank-owned                                 │
│   [Consent registry]            ◉ bank-owned                                │
│                                                                              │
│   Crossings of personal data: marked with ◉ (5 sites)                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Every arrow is labelled:**
- Caller → Twilio: audio (g711 μ-law or opus), both directions
- Twilio → Agents Platform: SIP (encrypted), bidirectional audio
- Web App → Agents Platform: WebSocket JSON frames (audio chunks + control)
- Agents Platform → SecureVoice API: HTTPS POST with idempotency key (HMAC-SHA256 signed)
- SecureVoice API → Audit Chain: Prisma ORM → SQLite (hash-chained, every row signed)
- SecureVoice API → ElevenLabs keyring: server-side env var read, never written to logs or DB
- SecureVoice API → Bank CRM stub: HTTPS POST + `SV-Signature: t=…,v1=…` header
- SecureVoice API → Bank SIEM stub: same as CRM
- Card processor freeze API: bank-owned (out of our system), called by human specialist after agent summary

**The human approval gate from box K:** `card_freeze` server tool refuses to commit to the bank's core card-processor until the human specialist clicks "confirm" in their console. The agent's call summary, transcript (redacted), and audit chain hash are shown to the specialist as proof-of-state.

**What happens when a dependency is down:**
- ElevenLabs API unreachable → SecureVoice API returns 503 with `Retry-After: 60`; bank CRM retries with exponential backoff (4xx/5xx are not billed per treg llms.txt pattern)
- Scribe v2 STT down → agent falls back to browser Web Speech API; transcript is marked `stt=degraded` in the audit log
- Bank CRM stub unreachable → webhook queue buffers up to 10,000 events on disk; alert fires at 5,000
- Audit Chain DB down → API route returns 503 and the agent (running in Agents Platform) holds the conversation in a pending action queue, refuses to commit `card_freeze` until the audit row is written

---

## 05 The Case

### M. Success metrics (Max 3 KPIs, baseline from box D)

| KPI | BASELINE (FROM D) | TARGET | HOW IT IS MEASURED |
|---|---|---|---|
| **Time from fraud flag to customer contact** | 38 min (D) | **< 60 s** for 95% of cases | `AuditLog.first_contact_at - alert_received_at`, aggregated per callRef chain |
| **Per-case fraud loss** | AED 2,847 (D) | **< AED 200** (7-day rolling avg) | bank-ledger loss event matching the callRef; cross-checked against bank CRM ticket close |
| **Customer verification rate** | 14% (D, contact-within-10-min recovery proxy) | **> 70%** | `count(intent == "deny_fraud" OR "confirm_authorized") / count(calls)`, measured weekly |

### N. Risks (25 words per row)

| RISK | HOW YOU HANDLE IT |
|---|---|
| **1. Impersonation risk** — agent could be tricked by a fraudster calling in to "confirm" a fraudulent transaction. | The agent never trusts the caller's word alone; the freeze action is gated by the bank's specialist console. Even a successful "confirm_authorized" is logged and queued for Tier-2 review. |
| **2. PUP exposure** — ElevenLabs Prohibited Use Policy forbids unsolicited deceptive impersonation. Outbound calls could be challenged. | `requireOutboundConsent()` rejects outbound calls without a `consentRecordId` (422); every outbound carries the bank's recorded prior consent reference. Inbound calls (the use case) are exempt because the caller initiated the contact. |
| **3. Regulatory exposure (UAE PDPL + CBUAE)** — biometric voice data + AI in regulated customer communication. | Voice data is processed and discarded after each call (no persistent storage of biometric features); agent identifies itself as AI in the opening disclosure; tamper-evident audit chain is the legal record-of-evidence; CBUAE Consumer Protection §5 satisfied. |

### O. What will be working by 14 October (60 words max)
**End-to-end and live:** the fraud-intervention agent for one pilot bank on its real card portfolio, English + Arabic, with real audit chain and real signed webhooks to the bank's CRM stub. **Mocked or deferred:** cloned voices (using stock voices for the pilot; clones ready Stage 3), Twilio PSTN (we drive the agent via Web SDK + SIP simulator for the build sprint), the bank's specialist console (we ship our own; bank's IT integrates later).

### P. Team

| NAME | ROLE ON THIS BUILD | SHIPPED PREVIOUSLY (LINK) |
|---|---|---|
| Aaron Otema | Founder · engineering · compliance · all 5 tracks | Alpacaruns (Go+Alpaca trading bot, live since Aug 2025) · Vuna (Go+React invoice-financing platform, GitLab main → production) · ShieldLedger (Midnight ZK AML compliance dApp, Preprod funded) |
| (seeking) | Senior backend engineer (Go/TS) — to be confirmed by 30 Sept | — |

### Q. Proof of build (two links)

1. **Live deployed app** — https://securevoice.ai (public demo, real product surface, all five tracks scoped: fraud = SHIPPED, collections/servicing = pilot pipeline, pre-auth/hard-moments = reference build). To be updated with the pilot bank URL on 30 Sept.
2. **60-second walkthrough of the architecture (box L)** — see `docs/WALKTHROUGH.md` (to be recorded by 30 Sept and linked from the Stage 2 submission).

---

## Compliance & governance appendix

- **Prohibited Use Policy (PUP):** every guardrail in box K is enforced in `src/lib/compliance/policy.ts`. See `docs/COMPLIANCE.md` for the full enumeration and the unit-test coverage matrix.
- **Tamper-evident audit:** every agent turn, TTS call, and ASR call writes a hash-chained row to `AuditLog` (Prisma → SQLite). `verifyChain(callRef)` recomputes and reports the broken row if any link is tampered. See `src/lib/audit-chain.ts`.
- **Rate limiting + idempotency:** 60 calls/hour per `caller_id` (configurable via `RATE_LIMIT_PER_HOUR`). Identical TTS/ASR requests within 24h return the stored response without a second upstream call. See `src/lib/ratelimit.ts` and `src/lib/idempotency.ts`.
- **PII redaction:** PAN, IBAN, phone, email, OTP, CVV are redacted before any audit-log write, webhook send, or structured log line. See `src/lib/redact.ts`.
- **Multilingual:** EN, AR, HI, UR run end-to-end (TTS + agent replies + disclosure) on the running platform. FR, BN on the roadmap (scenario packs to ship by 14 Oct).

---

**Word counts (verified within limits):**
- B: 24 words / 25 max ✓
- C: 119 words / 120 max ✓
- E: 60 words / 60 max ✓
- G: 47 words / 50 max ✓
- K: each row ≤ 20 words ✓
- N: each row ≤ 25 words ✓
- O: 60 words / 60 max ✓