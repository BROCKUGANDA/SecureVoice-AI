# SecureVoice AI — Voice-Agent Model Card

Covers the optional LLM reply layer (`src/lib/llm.ts`) and the deterministic
voice stack it plugs into. The card follows the standard model-card sections:
intended use, out of scope, training/provenance, evaluation, limitations, and
mitigations.

---

## 1. System overview

SecureVoice is a fraud-intervention voice agent for banks. One call pipeline,
three layers:

| Layer | Component | Provider | Deterministic? |
|---|---|---|---|
| Decide | Intent routing (`src/app/api/agent/route.ts`) | — | ✅ keyword/state machine, server-side |
| Decide | Compliance guardrails (`src/lib/compliance/policy.ts`) | — | ✅ server-enforced, no toggle |
| Phrase | Reply drafting (`src/lib/llm.ts`) | Groq (default) / Gemini (fallback) | ❌ generative, audited post-hoc |
| Speak | TTS | ElevenLabs (`multilingual_v2`, Swahili → `flash_v2_5`) | — |
| Listen | ASR | ElevenLabs Scribe → Deepgram nova-2 → dev fallback | — |

**The LLM never decides an action.** Intent classification (deny_fraud /
confirm_authorized / greeting / unclear) and the action mapping (freeze /
hold / clarify / handoff) are deterministic. The model only rephrases the
already-verified reply in the caller's language. If the model is unavailable,
slow, or hallucinates unusable text, the scripted reply serves — the product
behavior is identical without any LLM key.

## 2. Intended use

- Re-phrasing a bank fraud agent's verified reply in the caller's language
  during a live fraud-intervention call, across en / ar / hi / ur / fr / sw.
- Latency target: sub-second first audio (Groq LPU inference, streaming TTS).

## 3. Out of scope (hard refusals, enforced in code)

- Deciding whether to freeze a card, hold a transfer, or close a review.
- Asking for PINs, passwords, OTPs, CVVs, or full card numbers — the reply is
  scanned post-generation (`auditAgentReply`); a match is REPLACED with a
  scripted refusal and the audit log records the attempt.
- Off-topic conversation: the system prompt constrains the agent to the
  pending transaction ("I can only discuss the pending transaction. Was this
  charge yours?").

## 4. Models & provenance

| Field | Value |
|---|---|
| Default LLM | `qwen/qwen3.8-27b` served by Groq (LPUs) |
| Fallback LLM | `gemini-1.5-flash` via Gemini's OpenAI-compatible endpoint |
| Model selection rationale | ~400 ms round trips; clean spoken-style output. Llama-3.1 models were retired from Groq's lineup (verified 2026-09); `gpt-oss-120b` spends its token budget on reasoning and returns empty voice content at low `max_tokens`. |
| Training data | Not disclosed by the providers; base models used zero-shot with a system prompt — no fine-tuning on customer data |
| Voice models | ElevenLabs `eleven_multilingual_v2` (29 languages) + `eleven_flash_v2_5` (Swahili), preset voice per language |
| ASR models | ElevenLabs Scribe → Deepgram nova-2 (language hints; unsupported pins → `multi`) |

## 5. Prompt contract (the voice rules)

Every LLM draft is generated under, and audited against, these rules:

1. **≤ 50 words** — a phone call, not a chat window; the reply is truncated
   at 50 words post-generation.
2. **No markdown, asterisks, parentheses, or emojis** — TTS reads symbols
   literally ("asterisk asterisk…"). Output is scrubbed of `*_\`#>|` anyway.
3. **Strict guardrails** — automated fraud agent persona; never breaks
   character; never requests credentials; off-topic → scripted refusal.
4. **First turn must carry the recording disclosure** — injected verbatim by
   the compliance layer if the model omits it.

## 6. Evaluation

| Check | Method | Status |
|---|---|---|
| Language correctness (6 langs) | Live `/api/agent` runs per language; replies must be in the requested language | verified at demo freeze (fr/sw live; ar/hi/ur scripted + LLM spot checks) |
| Latency | Agent turn p95 incl. TTS start | LLM draft ~0.4–0.9 s; scripted path < 50 ms |
| Credential-asking resistance | Post-generation deny-pattern scan + prompt-injection scanner on user input | enforced server-side, cannot be disabled |
| Safety fallback | Kill the key → full behavior identical, scripted replies | verified |

## 7. Known limitations & mitigations

| Limitation | Mitigation |
|---|---|
| Base models may hallucinate phrasing | Compliance scan + word ceiling + scripted fallback on any failure |
| LLM availability/latency varies | 8 s hard timeout → scripted reply; nothing blocks on the model |
| Free-tier quota | Deterministic path is free; BYOK and daily meters on voice; the LLM only drafts ≤ 50-word replies (small token cost) |
| Language quality in ur/sw is provider-dependent | Gemini fallback documented; scripted replies are native-language and always available |
| PII leakage into logs | All text is redacted (`src/lib/redact.ts`) before audit/webhook persistence |

## 8. Runtime deployment

- The LLM key lives **server-side only** (`.env`, git-ignored; injected as a
  secret on hosting). It never reaches the browser, and no `NEXT_PUBLIC_`
  variable ever carries a key.
- Cloning this repo: create your own free Groq key (console.groq.com) and set
  `GROQ_API_KEY` in your local `.env`. The demo runs fully without it.
- `GROQ_MODEL` / `GEMINI_MODEL` override the defaults; both providers speak
  the OpenAI chat-completions wire format behind one 60-line abstraction.
