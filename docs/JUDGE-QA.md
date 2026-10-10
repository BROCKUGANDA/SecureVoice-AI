# Judge Q&A — pre-loaded answers

Every answer below names the **file that makes it true**. An answer a judge cannot
follow to code is worth less than an honest "not built" — and the honest ones are
marked, because volunteering a gap is far stronger than being caught in it.

---

## 1. "What stops a fraudster from signing up and using SecureVoice?"

The architecture, mostly — not the paperwork.

**The agent is a fixed state machine, not free-form chat.** There is no node in
the graph that can ask for an OTP. Every utterance passes
`prepareSpeech` (`src/lib/compliance/speech-gate.ts`), whose `SECRET_SOLICITATION`
rules refuse the utterance outright if solicitation context appears, and whose
vishing blocklist refuses urgency, threats and payment redirection. The prompt
asks for this; the gate enforces it. A prompt-only control is a preference; this
one refuses the audio.

Layered around it:

| Layer                 | Mechanism                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Onboarding            | Invite-only. No public sign-up; seats are created by a tenant admin (`src/views/Settings.tsx`, Team tab)                         |
| Per-tenant ceiling    | Plan tier + abuse config (`src/lib/abuse/*`); geo, concurrency, velocity and cooldown gates all fail **closed**                  |
| Webhooks              | HMAC-SHA256 signed with a per-tenant sealed key (`src/lib/vendor-endpoint.ts`), SSRF-validated on save **and again at delivery** |
| LLM access            | Optional BYOK; `resolveLlmCredentials` (`src/lib/llm.ts`) prefers the tenant's own gateway over the platform's                   |
| Every credit movement | Append-only, hash-chained audit (`src/lib/audit-chain.ts`)                                                                       |

The one-line answer: **the platform enforces what the model is allowed to say, so
a bad actor cannot talk it into being a vishing bot.**

**Not built, and said so:** KYB document verification (trade licence, bank
account) is a Tier-3 item — see `docs/SCOPE-TRIAGE.md`.

---

## 2. "Fraudsters already impersonate banks. What's the difference?"

**Out-of-band anchoring plus a blocklist the attacker cannot switch off.**

Full treatment in **`docs/VERIFICATION-PARADOX.md`** — the short version is that
the customer learns about the call on a channel the fraudster does not control (a
TDRA-registered sender ID SMS naming the case reference), and the agent says the
one sentence an impersonator can never afford to say: _"You may hang up now and
call your bank's official number. This verification stays valid for thirty
minutes."_

The demo-able half is `src/lib/compliance/vishing.ts` — hand the agent a vishing
opener and the console shows it refused, the rule that caught it, and the
scripted fallback spoken instead.

---

## 3. "Why won't the bank just build this internally?"

They can. In about eighteen months, after a compliance review, a carrier contract,
four languages of dialect tuning and a PDPL residency assessment — which is to say
they can, and they will start, and they will not finish.

What we package is the part that is **expensive and slow, not the part that is
clever**:

- **Khaleeji dialect TTS quality** — `en/ar/hi/ur/fr/sw` with per-language model
  pinning (`resolveTtsModel`), because `eleven_multilingual_v2` cannot voice Urdu
  and silently selecting the wrong model means the customer hears nothing at the
  exact moment a fraud decision is read to them.
- **Shariah language guardrails** — tenant-scoped terminology substitution in
  Arabic and Urdu (`src/lib/compliance/speech-gate.ts`), so a takaful customer is
  not told their "insurance premium".
- **Regional telecom routing and PDPL residency.**
- **The guardrail suite** — the blocklist, the disclosure injection, PII
  redaction, the vishing checks. Every one of these is a control a bank must
  re-derive and re-test for itself.

A bank buys weeks instead of two years, and gets the compliance artefacts — hash
chained audit, masked secrets, evidence log — that took the same eighteen months
to produce.

---

## 4. "What is the regulatory path?"

Named concretely, because "we're compliant" is not an answer:

- **CBUAE sandbox** for a supervised pilot; **DIFC FinTech Hive** or **ADGM
  RegLab** for a regulated one. The platform is already shaped for it: consent
  records are a first-class gate (`requireOutboundConsent`), not a checkbox.
- **PDPL**: region is a **tenant-declared field** set at onboarding
  (`Organization.region`) and surfaced on the audit trail, because "where does
  customer data live" is the first question a reviewer asks. Transcripts are
  redacted **before** indexing, audio retention is bounded (30 days, and zero for
  an organisation with recording disabled — `src/lib/privacy/retention.ts`), and
  erasure is a real path (`forgetDocument` deletes vectors before the row).
- **In-country hosting**: Supabase/Postgres in-region. See `docs/UAE-REALITY.md`
  for the `me-central-2` detail, which is the one that wins the local room.

---

## 5. "What about voice deepfakes?"

Flip it: **Phase 2 is inbound voice liveness** — detecting a cloned customer voice
calling a bank's own hotline, which is the symmetric threat and the one that will
actually hurt institutions.

What exists today on the inbound side: intent classification is **deterministic**
(a keyword router, `src/app/api/agent/route.ts`), so an LLM never decides to
freeze a card or close a review — it only rephrases an already-decided, vetted
line. Caller speech is treated as untrusted data, sanitised and audit-logged for
injection (`src/lib/llm-guard.ts`).

**Not built, and said so:** the liveness model itself. It is specced in
`docs/POST-LAUNCH-TODO.md` §2b as the browser/voice direction, not as an
inbound detector. Do not claim it.

---

## 6. "What if the customer authorized a scam payment themselves?"

Then the transaction is the thing we verify, not the customer's judgement.

- The agent asks about **one specific transaction** — merchant, amount, time —
  because "did you make this payment?" is answerable and "are you careful?" is
  not.
- A repeated "yes" on a **high-risk merchant category** is a signal in itself, and
  the escalation path exists: the state machine routes to a human specialist
  (`handoff`), and that handoff is audited.
- The protective step is always a **staged, human-confirmed** restriction. The
  agent never says a card is frozen, blocked or closed — those words are refused
  by the vishing blocklist and absent from the scripted copy, because a demo that
  tells a fraud victim their card is frozen is worse than no demo.

**Not built:** automatic repeat-yes escalation scoring. The path exists; the model
that scores it does not.

---

## 7. "How do you know the 2-second promise is real?"

Measured, not asserted — and the panel is finally mounted in the Command Center.

`src/lib/telemetry/spans.ts` declares eight spans with p95 budgets; `SloPanel`
renders measured p50/p95 against those targets, and `/api/status/spans` is
operator-scoped. A judge asking this gets a chart, not a claim.

**Honest caveat, stated first:** four of the eight declared spans had no producer
until this work. The panel reports `no_data` rather than a comfortable zero, and
`allTargetsMet()` returns `null` — not `true` — while any span is unmeasured. A
judge who notices that the platform refuses to claim success on incomplete data is
a judge who believes the numbers that are present.

Budget and the three latency tricks in `docs/LATENCY-BUDGET.md`.

---

## 8. "What happens if a judge asks something you haven't prepared for?"

Answer the question you have, honestly, and name the file. "Not built, and here is
where it would go" scores better than a confident sentence that dies under the
next question — because the next question is always better informed than the
first one.

If the honest answer is that the product does something the judge did not ask for,
that is a legitimate answer too: the strongest version of this product is that it
refuses to speak like a fraudster, which is the one capability nobody asked for
and everybody is worried about.
