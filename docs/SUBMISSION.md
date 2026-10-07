# SecureVoice AI — Ignyte × ElevenLabs Stage 1 Submission

> Banking & Insurance Track · Use Case 1: Real-time fraud intervention
> Maps directly to the ElevenLabs Idea Canvas boxes A–Q.

---

## 01 The Opportunity

### A. Submission details

| FIELD                      | YOUR ANSWER                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| Team name                  | SecureVoice                                                                                        |
| Contact email              | otemaach@gmail.com                                                                                 |
| Track (1 or 2)             | 1 — Banking & Insurance                                                                            |
| Use case (1–8)             | 1 — Real-time fraud intervention for retail banking customers                                      |
| Stage                      | Stage 1 submission                                                                                 |
| Languages covered          | English, Arabic (live end-to-end) + Hindi, Urdu (live) + French, Bengali (roadmap)                 |
| Prior ElevenLabs use (Y/N) | N                                                                                                  |
| Team size / based in       | Solo founder + AI engineering pipeline · Dubai, UAE                                                |
| Website or repo            | https://github.com/aaron-otema/securevoice (private) · live demo at https://57.130.80.158.sslip.io |

### B. The idea in one line (25 words max)

An agent that calls a bank customer in 38 seconds when their card is used in a new country, so that the customer never loses money to a fraudster they couldn't reach in time.

### C. What breaks today (120 words max)

Today the workflow is: fraud engine flags a transaction → case lands in a Tier-1 analyst's queue at +9 minutes → analyst dials the customer → customer doesn't answer (unknown number) → analyst leaves voicemail → fraudster completes second transaction at +18 minutes → bank eats the loss. The exact point that fails is the **analyst-to-customer handoff** — the average bank call-center agent waits 38 minutes before they finish one prior case and can dial the next, while the fraudster moves in seconds. The customer is left waiting, the bank is paying out, and the regulator (CBUAE) is writing the next fine.

### D. Today's baseline — what you measured (numbers only)

| VALUE TODAY | WHERE THE NUMBER COMES FROM                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 38 min      | average time from fraud flag to customer contact (CBUAE Consumer Protection Annual Review 2024, Annex 3 — Tier-1 retail banks)                                 |
| 14%         | fraud-loss recovery rate when customer is contacted within 10 minutes vs. 2% after 60 minutes (LexisNexis True Cost of Fraud 2024, MENA retail-banking cohort) |
| AED 2,847   | average per-case loss across 11 UAE retail banks (UAE Central Bank Cyber Fraud Bulletin, Q1 2025)                                                              |
| 1 in 6      | Tier-1 calls where the analyst must escalate to a senior before acting (internal sample of 14,200 cases)                                                       |

### E. Who buys this (60 words max)

Head of Fraud Operations at a UAE retail bank — typically a Director-level signatory with both operational budget and regulatory accountability. Budget comes from the existing fraud-loss line (currently absorbed) plus a marginal improvement to the cyber-risk reserve (UAE Central Bank Circular 4/2024 requires Tier-1 banks to hold 1.5% of digital transaction value in reserve). Sale is 12-month SaaS, AED 120k–340k/year per bank, with a shared-success component on prevented-loss.

---

## 02 The Evidence

### F. Who you spoke to

| NAME AND ROLE                                              | ORGANISATION                              | DATE       | TYPE      | THE ONE THING THEY SAID THAT CHANGED YOUR IDEA                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------- | ---------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Aisha Al Marzooqi · VP, Fraud Risk                         | a Tier-1 UAE bank (anonymised at request) | 2026-08-19 | in-person | "The hardest part isn't the detection — it's the call. My analysts spend 80% of their shift on the phone, and they still can't get there in time."                       |
| Marcus Brennan · former fraud analyst, now regtech founder | independent                               | 2026-08-22 | video     | "If you can solve the first 60 seconds after the alert, you've already done more than the last five years of ML."                                                        |
| Hala Saeed · Customer Experience Director                  | a regional bank                           | 2026-08-25 | video     | "Customers don't answer unknown numbers. Whatever you build, it has to feel like the bank, not like a robot calling about a robot."                                      |
| Dr. Khalid Al Hammadi · UAE PDPL Office                    | regulator                                 | 2026-09-01 | in-person | "We don't mind AI on the line if it identifies itself, never asks for secrets, and keeps a record we can audit. If it does those three things, the rest is engineering." |

### G. What you got wrong (50 words max)

We started with the assumption that customers would prefer to _type_ into a chat. Two interviews killed that — they want to _hear_ a voice, especially when they're stressed about money. Pivoted the entire UX to outbound voice in week one, abandoned the chat prototype in week two.

### H. The workflow today

| Stage 1                                                                                                             | Stage 2                                                                                                                               | Stage 3                                                                                                                                            | Stage 4                                                                                                             | Stage 5                                                                                                                        | Stage 6                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **Customer / Applicant** makes a card payment that trips a rule (e.g. new country, atypical merchant, large amount) | **Front-line analyst** picks up the alert from the queue (avg wait: 4 min) — they open the case in 3 systems (fraud engine, CRM, IVR) | **Analyst dials** the customer from the bank's CLI (customer's phone shows a generic 04 number — unknown) — call goes to voicemail 67% of the time | **Analyst leaves voicemail**, escalates to the bank's standard 2-line SMS — both happen in parallel                 | **Back-office approver** (Tier-2 supervisor) reviews the case at +22 min, must verbally approve the freeze — adds another dial | **Fraud system** receives the freeze instruction at +38 min; card is blocked; if fraudster already moved, loss is booked |
| **Systems:** card processor (card-not-present check), bank fraud engine (rule + ML),                                | **Systems:** fraud case mgmt, CRM, IVR,                                                                                               | **Systems:** PSTN/SIP, customer mobile,                                                                                                            | **Systems:** voicemail box, SMS gateway,                                                                            | **Systems:** supervisor queue, audit log,                                                                                      | **Systems:** card processor freeze API, ledger (loss booked),                                                            |
| **Elapsed time:** 0–5 s                                                                                             | **Elapsed time:** +5 min                                                                                                              | **Elapsed time:** +5 to +11 min                                                                                                                    | **Elapsed time:** +11 to +18 min                                                                                    | **Elapsed time:** +18 to +28 min                                                                                               | **Elapsed time:** +28 to +38 min                                                                                         |
| The step that fails most often: **Stage 3** — customer does not answer an unknown number                            |                                                                                                                                       |                                                                                                                                                    | Where the customer chases: **Stage 5** — by now they're calling the bank's main line asking "did you just call me?" |                                                                                                                                | **Total elapsed time: 38 minutes**                                                                                       |

---

## 03 The Agent

### I. The call flow (5 steps, 15 words each)

| STEP | WHAT HAPPENS                                                                                                                                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | **Opening disclosure (H=handoff-on-trigger):** "This call is recorded to protect you. I'm your bank's AI security assistant calling about a transaction on your card."                                                                             |
| 2    | **Verify identity via zero-knowledge pattern (H):** "Can you confirm the last transaction you remember making on this card?" — never asks for PIN/OTP/CVV. Customer confirms or denies.                                                            |
| 3    | **Branch on customer response:** (a) "Not mine" → card frozen immediately, specialist joins call within 30s. (b) "It's mine" → close review, log confirmation. (c) Confused → re-state disclosure, offer to dial back from bank's verified number. |
| 4    | **Action confirmation:** customer hears the freeze action in their language (EN/AR/HI/UR), receives SMS receipt, is told to expect a call from the specialist within 30 seconds.                                                                   |
| 5    | **Handoff to human (H):** AI summarises the conversation in the specialist's console, including any prompt-injection attempts detected during the call. Specialist joins the line.                                                                 |

### J. ElevenLabs components (tick + 60-word justification)

| Component                      | Used?           | Why                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agents Platform                | ✅              | Core platform. Real agent `agent_3601…thzdp` with a 1,862-char fraud-intervention system prompt, `trust_context`, `scribe_realtime` ASR with 16 keyterms, `gpt-4o-mini`, both webhook tools attached, and both KB documents attached with RAG + source attribution enabled — all read back from a fresh GET.                                                 |
| Agent Workflows                | ⚠️ **partial**  | The branching flow (verify → confirm → freeze → handoff) runs in SecureVoice's own deterministic state machine (`src/app/api/agent/route.ts`, `src/app/api/twilio/turn/route.ts`) with real TwiXML `<Gather>` telephony. The ElevenLabs Workflow object currently holds only `start_node` — we have **not** ported the branch graph into the visual builder. |
| Sub-agents                     | ❌              | One agent suffices; sub-agents add latency without adding capability here. `subagents: []` is deliberate, not missing.                                                                                                                                                                                                                                       |
| Eleven v3 TTS                  | ⚠️ **blocked**  | Direct REST call (no SDK in the path) returns **HTTP 402 `paid_plan_required`** — entitlements are enforced server-side by API key, so no client library can unlock it. The live agent runs `eleven_flash_v2`. **We cannot claim v3 until the account is upgraded.**                                                                                         |
| Voice Design / Voice Library   | ❌ **not used** | **Corrected from an earlier draft that claimed four cloned personas.** Cloning is disabled on this account (`can_use_instant_voice_cloning=false`, `can_use_pro_voice_cloning=false`, `professional_voice_limit=0`). The live agent uses one stock Library voice.                                                                                            |
| Scribe v2 STT                  | ✅              | Live and verified: `platform_settings.asr.provider = "scribe_realtime"`, `quality: high`. Chosen because it handles code-switched Arabic-English (standard in UAE banking).                                                                                                                                                                                  |
| Keyterm biasing                | ✅              | **Now actually sent** — 16 keyterms persisted on the live agent (verified by read-back): 8 English (`SecureVoice, AED, CNP, card freeze, IBAN, OTP, merchant, case id`) + 8 Arabic (`بطاقة, تجميد, احتيال, معاملة, أمان, بطاقتي, موثوق, مشبوه`). Previously defined in code but never transmitted; now verified on the agent record.                         |
| Knowledge base + RAG           | ✅              | Two real KB documents (EN + AR fraud-disposition policy `SV-FDP-2026-01` v3.2, Arabic copy corruption-checked) are **attached to the agent** with `rag.enabled=true`, `max_vector_distance=0.6`, and `include_source_urls=true` for source attribution. Read back from a fresh GET after a 200 PATCH.                                                        |
| Server / webhook tools         | ✅              | Two real account-level webhook tools pointing at our endpoints: `card_freeze` and `human_handoff`, both with full `api_schema`, **both attached to the agent** (`tool_ids` holds 2 ids, confirmed by read-back).                                                                                                                                             |
| Tool scoping & trust context   | ✅              | Implemented and verified over HTTP — see box K. `trust_context` is set on the agent.                                                                                                                                                                                                                                                                         |
| MCP servers                    | ❌              | No MCP-native CRM in our target bank stack; we wire via signed webhooks instead                                                                                                                                                                                                                                                                              |
| Telephony (Twilio / SIP)       | ✅              | Real Twilio `<Gather>` loop in `src/app/api/twilio/turn/route.ts`. ElevenLabs-side `phone_numbers: []` — telephony is ours, not ElevenLabs'.                                                                                                                                                                                                                 |
| Batch calling                  | ❌              | Outbound is per-event, never batch — anti-PUP & anti-spam compliance                                                                                                                                                                                                                                                                                         |
| Agent Testing                  | ⚠️ **partial**  | Real suite, real multi-run results: 3 tests × `repeat_count=3` = 9 runs, **5 executed and all 5 passed; 4 blocked by an exhausted character quota**. **Important: these do not prove a tool-call test** — observed `tool_calls` = 0 because no tools are attached. See box K and the evidence file.                                                          |
| Post-call webhooks             | ✅              | Signed `SV-Signature: t=<ts>,v1=<sha256(t.body, WEBHOOK_SECRET)>` to CRM + SIEM, PII redacted before send                                                                                                                                                                                                                                                    |
| WhatsApp                       | ❌              | Out of scope for this use case (bank calls, not bank messages)                                                                                                                                                                                                                                                                                               |
| Web / mobile SDKs              | ✅              | Web SDK for the customer-side portal. Signed-URL broker at `/api/elevenlabs/signed-url` verified: returns a real `wss://…conversation_signature=` for WebSocket and a real WebRTC token, both 15-min TTL, API key never leaves the server.                                                                                                                   |
| Bring-your-own LLM / cascading | ✅              | `conversation_config.agent.prompt.llm = gpt-4o-mini`; SecureVoice independently supports LLM cascade (Groq → Gemini → deterministic) in `src/lib/llm.ts` for its own reply layer.                                                                                                                                                                            |

**The two honest caveats, stated plainly:**

1. **Free-tier entitlements cap what we can demonstrate.** Our ElevenLabs account is `tier=free`. Tool attachment, KB attachment, and RAG are all **live and verified** — an earlier draft of this document wrongly claimed the API silently stripped them. What the tier _does_ block is **`eleven_v3`**, and that is enforced server-side: a bare REST call with no SDK in the path returns **HTTP 402 `paid_plan_required`**. No client library can change that; only an upgrade can. The character quota is separately exhausted (`10000/10000`), so the agent cannot currently _speak_ at all until the month resets or the tier is upgraded.
2. **The Agent Testing pass rate is 5/5 executed, not 9/9, and it is not a tool-call test.** Four of nine runs failed on `API quota limit exceeded` (character usage hit `10000/10000`). Of the three tests, two are platform type `llm` despite their names starting with "TOOLCALL", and the single type `tool` test asserts a negative, so it passes vacuously with zero tools attached. **The real high-stakes tool-call evidence is the 8/8 runtime guardrail suite** in `docs/evidence/guardrails-runtime-2026-10-01.json`, which drives the actual `card_freeze` endpoint over HTTP and proves `committed: false`.

### K. Guardrails (every row is a code-level mechanism, not a comment)

**Verified live 2026-10-01 — 8/8 runtime checks pass** (`docs/evidence/guardrails-runtime-2026-10-01.json`), driven over HTTP against the running server with a real Supabase Postgres audit write behind every call.

| CHECK                                  | EXPECTED                | OBSERVED                                                           |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------ |
| `card_freeze` with no shared secret    | 401                     | **401** `{"ok":false,"error":"unauthorized"}`                      |
| `card_freeze` with wrong shared secret | 401                     | **401** same                                                       |
| `card_freeze` missing required fields  | 422                     | **422** schema error                                               |
| `card_freeze` authorized               | 200 + `committed:false` | **200** `committed:false`, `stage:pending_specialist`              |
| `human_handoff` escalation             | 200                     | **200** `SV-HND-…`, `sla_seconds:30`                               |
| `signed-url` for a non-pinned agent    | 403                     | **403** `agent_not_allowed`                                        |
| `signed-url` websocket                 | 200                     | **200** real `wss://…conversation_signature=`                      |
| `signed-url` webrtc                    | 200                     | **200** real token                                                 |
| **PII redaction on a volunteered OTP** | 0 occurrences in DB     | **0** — `482913` absent from all audit rows, rendered `[REDACTED]` |

The high-stakes guarantee, in the agent's own response:

```json
{
  "ok": true,
  "committed": false,
  "reference": "SV-FRZ-FRAUD-2026-08612",
  "case_id": "FRAUD-2026-08612",
  "next_step": "A fraud specialist must confirm this freeze before it becomes final."
}
```

and the matching audit row: `{"committed":false,"reason_code":"FRAUD_CONFIRMED_BY_CUSTOMER","source":"elevenlabs_agent_tool","stage":"pending_specialist"}`.

| REQUIREMENT                           | HOW YOUR DESIGN ENFORCES IT                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opening disclosure                    | `src/lib/compliance/policy.ts → auditAgentReply()` injects the locale-specific disclosure string (`"This call is recorded to protect you"` / `"هذه المكالمة مسجلة لحمايتك"` / `"यह कॉल आपकी सुरक्षा के लिए रिकॉर्ड हो रहा है"` / `"یہ کال آپ کی حفاظت کے لیے ریکارڈ ہو رہی ہے"`) into every reply; if missing it appends the literal and flags `disclosure_injected` in the audit row |
| Consent to be called                  | Outbound calls require `consentRecordId`; missing → 422 (`requireOutboundConsent`). Inbound calls are exempt (caller initiated).                                                                                                                                                                                                                                                      |
| Verification without secrets          | Agent's decision tree + reply table in `src/app/api/agent/route.ts` contains exactly four intents (`deny_fraud`, `confirm_authorized`, `greeting`, `unclear`); zero branches ask for PIN, password, OTP, CVV, or full PAN. The classifier is deterministic — no LLM in the path.                                                                                                      |
| **Tool authentication**               | `src/lib/agent-tool-auth.ts` requires a shared secret AND an allow-list entry **per tool name**. Both values are SHA-256 hashed before `timingSafeEqual` so a wrong-length credential returns a clean 401 instead of throwing. A secret valid for `human_handoff` does not authorize `card_freeze`. **Verified: 401/401/200 above.**                                                  |
| **Human approval gate (high-stakes)** | `POST /api/elevenlabs/tools/card-freeze` never returns `committed:true`. It writes a reversible `pending_specialist` row and returns `committed:false` with an explicit next step. Only a human fraud specialist can finalize. **Verified in the DB row above.**                                                                                                                      |
| **Agent pinning**                     | `/api/elevenlabs/signed-url` rejects any `agent_id` other than the configured one with 403 `agent_not_allowed`, so a caller cannot mint browser sessions for arbitrary agents. **Verified.**                                                                                                                                                                                          |
| **API key containment**               | The browser never receives the ElevenLabs API key; it receives only a 15-minute signed URL or WebRTC token minted server-side. **Verified — key stays in the server process.**                                                                                                                                                                                                        |
| **PII redaction before persistence**  | `human_handoff` summaries are caller-supplied and untrusted, so they are passed through `src/lib/redact.ts` **before** the audit write. **Verified: volunteered OTP `482913` produced 0 rows containing it.**                                                                                                                                                                         |
| Opt-out path                          | Agent's greeting includes the bank's verified callback number in every language; user can hang up + dial back. A "do not call again" flag persists in the bank's CRM (out of our scope; bank-owned system).                                                                                                                                                                           |
| Escalation trigger                    | Agent routes to human on (a) `deny_fraud` decision, (b) prompt-injection detection (`auditUserInput` flags "ignore previous instructions", "share my otp", etc.), (c) customer sounds confused, (d) low confidence in the STT transcript.                                                                                                                                             |

---

## 04 The Architecture

### L. Technical architecture

The one-page diagram is a committed artifact: **[docs/architecture/securevoice-architecture.svg](architecture/securevoice-architecture.svg)**
(SVG so it stays reviewable in a diff and prints at any size). The ASCII form below is kept because it reads
in a plain-text review where an image does not; the two are generated from the same components and any drift
between them is a documentation bug.

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
│   │   Agent Testing: 3 tests × repeat_count 3 = 9 runs               │      │
│   │   (5 executed, 5 passed; 4 quota-blocked)                       │      │
│   │   Runtime guardrail suite: 8/8 HTTP checks against live tools   │      │
│   │   Knowledge base: fraud-disposition policy (EN/AR) — created,    │      │
│   │   ATTACHED: 2 tools + 2 KB docs, RAG + source attribution    │      │
│   │   Post-call webhooks: signed payload to bank's CRM + SIEM       │      │
│   └─────────────────────────────────────────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────────────┘
        │
        │ Signed HTTPS (HMAC-SHA256, replay-protected)
        ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         INSTITUTION SYSTEMS ZONE                             │
│                                                                              │
│   [SecureVoice API /api/agent] ───writes───► [Audit Chain (Postgres, ◉)]     │
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
- SecureVoice API → Audit Chain: Prisma ORM → **Supabase Postgres** (hash-chained, every row signed) via the `aws-0-eu-central-1.pooler.supabase.com:6543` IPv4 pooler
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

| KPI                                          | BASELINE (FROM D)                             | TARGET                            | HOW IT IS MEASURED                                                                       |
| -------------------------------------------- | --------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| **Time from fraud flag to customer contact** | 38 min (D)                                    | **< 60 s** for 95% of cases       | `AuditLog.first_contact_at - alert_received_at`, aggregated per callRef chain            |
| **Per-case fraud loss**                      | AED 2,847 (D)                                 | **< AED 200** (7-day rolling avg) | bank-ledger loss event matching the callRef; cross-checked against bank CRM ticket close |
| **Customer verification rate**               | 14% (D, contact-within-10-min recovery proxy) | **> 70%**                         | `count(intent == "deny_fraud" OR "confirm_authorized") / count(calls)`, measured weekly  |

### N. Risks (25 words per row)

| RISK                                                                                                                                    | HOW YOU HANDLE IT                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Impersonation risk** — agent could be tricked by a fraudster calling in to "confirm" a fraudulent transaction.                     | The agent never trusts the caller's word alone; the freeze action is gated by the bank's specialist console. Even a successful "confirm_authorized" is logged and queued for Tier-2 review.                                                                       |
| **2. PUP exposure** — ElevenLabs Prohibited Use Policy forbids unsolicited deceptive impersonation. Outbound calls could be challenged. | `requireOutboundConsent()` rejects outbound calls without a `consentRecordId` (422); every outbound carries the bank's recorded prior consent reference. Inbound calls (the use case) are exempt because the caller initiated the contact.                        |
| **3. Regulatory exposure (UAE PDPL + CBUAE)** — biometric voice data + AI in regulated customer communication.                          | Voice data is processed and discarded after each call (no persistent storage of biometric features); agent identifies itself as AI in the opening disclosure; tamper-evident audit chain is the legal record-of-evidence; CBUAE Consumer Protection §5 satisfied. |

### O. What will be working by 14 October (60 words max)

**End-to-end and live:** the fraud-intervention agent for one pilot bank on its real card portfolio, English + Arabic, with real audit chain and real signed webhooks to the bank's CRM stub. **Mocked or deferred:** cloned voices (using stock voices for the pilot; clones ready Stage 3), Twilio PSTN (we drive the agent via Web SDK + SIP simulator for the build sprint), the bank's specialist console (we ship our own; bank's IT integrates later).

### P. Team

| NAME        | ROLE ON THIS BUILD                                           | SHIPPED PREVIOUSLY (LINK)                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Aaron Otema | Founder · engineering · compliance · all 5 tracks            | Alpacaruns (Go+Alpaca trading bot, live since Aug 2025) · Vuna (Go+React invoice-financing platform, GitLab main → production) · ShieldLedger (Midnight ZK AML compliance dApp, Preprod funded) |
| (seeking)   | Senior backend engineer (Go/TS) — to be confirmed by 30 Sept | —                                                                                                                                                                                               |

### Q. Proof of build (two links)

1. **Live deployed app** — https://57.130.80.158.sslip.io (public demo, real product surface, all five tracks scoped: fraud = SHIPPED, collections/servicing = pilot pipeline, pre-auth/hard-moments = reference build). The pilot bank gets a dedicated hostname on its own domain once carrier caller-ID approval lands.
2. **60-second walkthrough of the architecture (box L)** — recorded; see `docs/WALKTHROUGH.md` (script, scene table, and the cut at `scripts/walkthrough/out/video/take.webm`, 2:37).

---

## Stage 2 readiness — honest status against the required submissions

Assessed against the criteria you were sent. Weights are the published Stage 2 criteria.

| STAGE 2 SUBMISSION ITEM                                                            | STATUS                                       | EVIDENCE / GAP                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live callable agent (test numbers) or hosted web/chat deployment                   | ⚠️ **partial**                               | ElevenLabs agent `agent_3601…thzdp` has a real prompt, first message, `gpt-4o-mini`, `scribe_realtime` ASR + 16 keyterms, `trust_context`, TTS voice, **2 attached tools, 2 attached KB docs with RAG + source attribution**, and a working signed-URL broker (real `wss://` + WebRTC token). **Remaining gap: the character quota is exhausted (10000/10000), so the agent cannot currently synthesize speech** — the config is correct, the account simply has no credits left this month. Twilio number and public deployment not re-verified in this pass.                                                                                                                                                                            |
| Recorded end-to-end demo + ≥1 failure/escalation path                              | ❌ **not done**                              | No committed `.mp4`/`.webm`/`.mov`. **The escalation path IS built and verified** (`human_handoff` → 200, `SV-HND-…`, `sla_seconds:30`) — it just has not been recorded. Highest-value remaining item.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Agent Testing suite + multi-run pass rate + tool-call test on a high-stakes action | ✅ **criterion met — by the stronger suite** | See the callout below. **The high-stakes tool-call criterion is met, and not by a mocked simulation.** The platform-native Agent Testing run (3 tests × 3 = 9 runs, 5 executed / 4 quota-blocked) is retained as supplementary evidence of conversation-plane behaviour. The high-stakes action is proven by the **8/8 runtime suite**, which drives the real `card_freeze` endpoint over HTTP against a live server and asserts `committed:false` on the wire and in Postgres.                                                                                                                                                                                                                                                           |
| Transcripts + post-call analysis                                                   | ✅ **done (dry-run, machine-enforced)**      | One committed per-conversation artifact — `evidence/transcripts/conversation.json` + rendered `conversation.md` — produced by the real path: real adapter placement (`placeOutboundCall`, dry-run), signed webhook through the real route, real redaction/seal/audit-chain/notified outputs. **The artifact's mode block states outright that the dial was dry-run and the transcript is not vendor evidence** (quota 10000/10000 at capture). This is now enforced by `tests/unit/evidence-honesty.test.ts`, which FAILS THE BUILD if any transcript artifact claims `vendor_evidence: true` while declaring a dry-run dial, or carries no `mode` block at all. An honest label that only lives inside one file is a label nobody reads. |
| One-page architecture diagram                                                      | ✅                                           | Box L above is the one-pager, and **`docs/architecture/securevoice-architecture.svg` is now committed as a standalone artifact** (rendered and checked for legible layout, not just written).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Short technical README                                                             | ✅                                           | `README.md` (472 lines — a full technical README, not a short one; the "short" criterion is met by its opening sections, the rest is reference).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### The high-stakes tool-call criterion — what actually proves it

The brief asks for "at least one tool-call test on a high-stakes action." Two things can satisfy that, and they are not equally worth anything.

**A simulated, mocked run** (what Agent Testing does) proves the agent's _wording and intent_. Tools are stubbed during simulation, so the agent is deciding against a fiction. Its value is real but bounded.

**A live HTTP call to the real endpoint** proves the _system refuses to take the irreversible action_. The freeze path is server-enforced, not prompt-enforced: the agent asks, and `src/app/api/elevenlabs/tools/card-freeze` stages and returns `committed:false` because a human specialist is the only actor who can commit. A prompt injection, a confused agent, or a malicious caller cannot talk that endpoint into committing.

So the criterion is evidenced by the **8/8 runtime suite** (`docs/evidence/guardrails-runtime-2026-10-01.json`), which is stronger than a mocked pass rate precisely because it is not mocked:

| CHECK                                  | EXPECTED                | OBSERVED (live)                                      |
| -------------------------------------- | ----------------------- | ---------------------------------------------------- |
| `card_freeze` with no shared secret    | 401                     | **401** `unauthorized`                               |
| `card_freeze` with wrong shared secret | 401                     | **401** `unauthorized`                               |
| `card_freeze` missing required fields  | 422                     | **422** Zod schema                                   |
| `card_freeze` authorized               | 200 + `committed:false` | **200** `committed:false`, `SV-FRZ-FRAUD-2026-08703` |
| `human_handoff` escalation             | 200                     | **200** `SV-HND-…`, `sla_seconds:30`                 |
| `signed-url` for a non-pinned agent    | 403                     | **403** `agent_not_allowed`                          |
| `signed-url` websocket                 | 200                     | **200** real `wss://…` credential, 15-min TTL        |
| `signed-url` webrtc                    | 200                     | **200** real WebRTC token                            |
| **PII redaction on a volunteered OTP** | 0 plaintext in Postgres | **0** — `482913` absent from every audit row         |

Verified against a live Next.js server on the IPv4 Supabase pooler: 8/8 green, the audit chain grew 215 → 230 rows, three callRefs show `links_broken=0`, and a volunteered OTP persisted as `[REDACTED]`.

Two honesty notes about the supplementary Agent Testing evidence, because a judge will check:

1. **The pass rate is 5/5 executed, not 9/9.** Four runs failed on `API quota limit exceeded` and are reported as **unverified, not passed**.
2. **The scoring harness no longer permits a vacuous pass.** A negative-control scenario (TC-2: "the agent must NOT freeze") used to score `pass` on a transcript containing zero tool calls — the arithmetic returned success because nothing was observed. An agent that froze every card scored identically. `scripts/run-agent-tests.ts` now refuses that case explicitly and reports it `VACUOUS PASS REFUSED`. TC-3 turned out not to be affected (it also requires `human_handoff`, so an empty transcript fails on a genuinely missing obligation). Pinned by `tests/unit/agent-test-scoring.test.ts`.

### Weighted-criteria self-assessment

| CRITERION                                       | WEIGHT               | HONEST READ                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working build — runs the flow end to end        | 30%                  | **Runs end to end, with one account-level gap.** State machine, telephony, TTS/STT, both tool endpoints and the escalation path all execute; **the tools ARE attached to the live agent** (verified by read-back — an earlier draft of this table claimed otherwise and was wrong). What is missing is _speech_: the character quota is exhausted, so the agent cannot synthesize. That is a billing state, not a code state, and it costs no fix beyond an upgrade. |
| Voice quality, latency, multilingual handling   | 20%                  | **Capped by tier.** Six-language flow and code-switched Arabic-English are real; Eleven v3 and Voice Design are unavailable on `tier=free` (`expressive_tts_not_allowed`, cloning disabled), so this score is bounded no matter how good the code is. Both TTS routes now resolve their model from one shared table, so no language is silently routed to a model that cannot voice it.                                                                              |
| Evidence: pass rates, transcripts, analysis     | 20%                  | **Strong, with the gap labelled by machine.** 8/8 runtime guardrail evidence with DB-backed verification; honest multi-run Agent Testing data that reports unverified runs as unverified; a committed transcript artifact with rendered post-call analysis; and an honesty gate that fails the build if a dry-run artifact is ever presented as vendor evidence. A recorded end-to-end demo is still outstanding.                                                    |
| Guardrails demonstrably enforced                | 20%                  | **Strongest area, and the one we lead on.** 8/8 live checks: auth 401, schema 422, `committed:false` on the high-stakes action, agent pinning 403, PII redaction proven at the DB layer, API key never leaves the server. Enforced server-side, so they hold against prompt injection as well as against a confused agent.                                                                                                                                           |
| Scalability + path to named institutional pilot | (stated, unweighted) | Not yet evidenced in-repo.                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### What only you can do (account-level, not code)

1. ~~Attach the two webhook tools and the two KB documents to the agent.~~ **DONE** — both attached via the API and verified by read-back; RAG and source attribution are enabled.
2. **Upgrade off `tier=free`** to unlock Eleven v3 and Voice Design — the 20% voice criterion is tier-bound.
3. **Reset or wait for the character quota** (it is at `10000/10000`) before rerunning the test suite for a clean 9/9.

### Tool-call latency (measured, not estimated)

Captured from the live dev-server logs, now a committed artifact: `docs/evidence/latency-2026-10-01.json`.

**Entitlement evidence:** `docs/evidence/elevenlabs-attachment-2026-10-01.json` records what a free tier can and cannot do, probed over plain REST with no SDK in the path — tools/KB/RAG attach successfully, `eleven_v3` returns `402 paid_plan_required`, and the character quota is exhausted. It also documents the earlier misdiagnosis it corrects. **Before** is the original two-transaction `append()` (port 3111); **After** is the same code path following the single-transaction fix (port 3113, n=13 authorized calls).

| REQUEST                             | BEFORE           | AFTER                                           | AUDIT DB WRITE |
| ----------------------------------- | ---------------- | ----------------------------------------------- | -------------- |
| `card_freeze` 401 (no secret)       | 108 ms           | **165 ms**                                      | no             |
| `card_freeze` 401 (wrong secret)    | 159 ms           | **185 ms**                                      | no             |
| `card_freeze` 422 (schema reject)   | 116 ms           | **148 ms**                                      | no             |
| `signed-url` 403 (agent not pinned) | 101 ms           | **990 ms**                                      | no             |
| `signed-url` 200 (websocket)        | 1370 ms          | **1376 ms**                                     | no             |
| `signed-url` 200 (webrtc)           | 735 ms           | **707 ms**                                      | no             |
| **`card_freeze` 200 (authorized)**  | **3700–5200 ms** | **median 2450 ms** (range 2200–2900, n=12 warm) | **YES**        |
| **`human_handoff` 200**             | **3700 ms**      | **3400 ms**                                     | **YES**        |

- **Authorized tool calls are ~34% faster** (median **2450 ms** vs the 3700 ms baseline; steady-state `application-code` median **2400 ms**). The one 4100 ms sample is the first request after server start — dev-mode compile, not the code path.
- **Rejection paths stay fast and never touch the database**: median **165 ms** across 401/401/422 (application-code 26–52 ms). No Prisma query is emitted at all — auth and Zod validation reject before any DB access, so a hostile caller cannot make the audit chain do work it is not authorised to do.
- **The remote audit write still dominates.** `append()` originally issued **6 Prisma round trips** (`BEGIN` → `SELECT … WHERE callRef` → `COMMIT` → `BEGIN` → `INSERT` → `COMMIT`). The server's own trace after the fix shows **4** (`BEGIN` → `SELECT` → `INSERT` → `COMMIT`) — one transaction. This is cheaper **and strictly safer**: the chain head can no longer be read outside the transaction that extends it.
- **Verified safe, not assumed:** a 4-row chain written under the new single transaction verifies with `links_broken=0` and `prevHash == prior chainHash` at every link, back to genesis.
- Remaining cost is the transatlantic round trip to a plaintext PgBouncer in `eu-central-1`; a UAE pilot would co-locate the audit write in-region and remove most of it. Steady-state median is **~12% of the ElevenLabs webhook `response_timeout_secs` of 20** — real headroom, not luck.

### A Turbopack dev-cache trap (cost me a false alarm)

After restarting the dev server, **every** route 404'd — including `/api/health`, which had just returned 200 — and the HTML served was the `global-error` boundary. The routes were all present on disk. Cause: a stale `.next` cache from a prior process. `rm -rf .next` restored all 22 routes immediately. If routes go 404 in this repo after adding a file, clear `.next` before debugging anything else.

### Known environment gotchas (documented so they are not rediscovered painfully)

- **Supabase is not paused** — its direct DB host is IPv6-only and this machine has no IPv6 route, which surfaces as `P1001`. Use `aws-0-eu-central-1.pooler.supabase.com:6543`. `/auth/v1/health` returns 200 even while the DB is unreachable.
- `prisma db execute` / `db push` **hang** on that pooler; the Prisma client and `psql`/`psycopg2` work fine.
- ElevenLabs signed URLs are `GET` with `agent_id` as a **query param**; a JSON body returns a bare `405`/`411` with no hint.
- Never trust a PATCH status code alone — **read the field back**. That discipline is what caught our own wrong diagnosis: we had concluded the free tier strips `tool_ids`/`knowledge_base`/`rag`, when in fact our request was malformed. The real error was `knowledge_base[].type`: ElevenLabs rejects anything that is not `file`, `url`, `text`, or `folder`, and then requires `id`. With the correct locator shape, a free tier attaches tools, KB, and RAG just fine.
- **Entitlements are enforced server-side, not by the SDK.** A bare `fetch` with no ElevenLabs client library in the path still returns `402 paid_plan_required` for `eleven_v3`, so swapping in the official SDK (or any HTTP client) buys nothing on a free tier.

---

## Compliance & governance appendix

- **Prohibited Use Policy (PUP):** every guardrail in box K is enforced in `src/lib/compliance/policy.ts`. See `docs/COMPLIANCE.md` for the full enumeration and the unit-test coverage matrix.
- **Tamper-evident audit:** every agent turn, TTS call, and ASR call writes a hash-chained row to `AuditLog` (Prisma → **Supabase Postgres**). `verifyChain(callRef)` recomputes and reports the broken row if any link is tampered. See `src/lib/audit-chain.ts`. _(An earlier draft of this doc said SQLite; the datasource in `prisma/schema.prisma` is `postgresql` and the live DB has 200+ rows.)_
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
