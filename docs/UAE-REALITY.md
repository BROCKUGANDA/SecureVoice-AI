# UAE reality check — things that can silently kill the demo

Four operational facts. Each one has silently killed a demo before, and none of
them is visible in the codebase.

---

## 1. Twilio may not terminate voice to +971 for your account

**The risk.** UAE has country-specific carrier rules, and a trial account can be
blocked from UAE termination without warning. The symptom is specific and
confusing: everything works, the call is accepted, and then silence.

**Check it on day one, not on stage day.** Place a real test call to a UAE number
and listen to it.

**If it is restricted, the browser demo is your demo** — and this is not a
downgrade. The browser widget (`LiveVoicePanel`) exercises the same pipeline
(mic → ASR → agent → streaming TTS) without touching a carrier, which means the
core claim survives even when PSTN does not.

**Say this on stage rather than hiding it:**

> "Twilio for the demo; a UAE-licensed carrier — Etisalat or du enterprise APIs,
> Unifonic, Cequens — for production."

That sentence is a compliance flex, not a caveat. A judge who knows UAE telecom
will be waiting to see whether you claim regulatory knowledge you do not have, and
naming the local carriers unprompted answers that question before it is asked.

---

## 2. Arabic TTS quality is a live risk

**The risk.** `eleven_multilingual_v2` is good at MSA and variable at Khaleeji.
The demo audience speaks Khaleeji. A line that sounds textbook in MSA can sound
stiff or mispronounced to the person in the room deciding whether you built
anything real.

**Test on day one with real phrases**, not "hello, this is a test". Use actual
product copy — the disclosure sentence and the hang-up-safe exit in
`src/lib/compliance/safety-exit.ts` are the right test material, because they are
the lines the product will actually speak.

**Rehearse the English fallback.** If Arabic is marginal, demo in Arabic **and**
have the English path one keystroke away. A demo that stumbles through marginal
Arabic loses more than it gains; a demo that delivers flawless English with an
honest "Khaleeji is being tuned" keeps the claim.

Note also the model pin: `resolveTtsModel` forces Urdu and Swahili to
`eleven_v4_turbo` because `eleven_multilingual_v2` cannot voice them at all.
Getting this wrong means the customer hears nothing at the exact moment a fraud
decision is read to them — which is the one moment silence is unacceptable.

---

## 3. PDPL: `me-central-2` is in the UAE, `me-central-1` is Bahrain

This one is worth getting exactly right in front of a local judge.

- **`me-central-1` is BAHRAIN.** It is the default Middle East region, it is not
  the UAE, and "our data is in Bahrain" is a worse sentence than you think when
  the audience is a UAE bank.
- **`me-central-2` is DUBAI.** It is the UAE region. Naming it — and only it —
  turns "we take compliance seriously" into "we know where our data is".

**The line to use:**

> "Data never leaves the country. Region is a tenant-declared field, set at
> onboarding, surfaced on the audit trail."

Which is exactly what the product does: `Organization.region` is collected in
step 1 of the wizard (`src/lib/setup.ts`), validated against a closed set
(`UAE | GCC | MENA | OTHER`), and read from the organization — never from a
request body.

**Also true and worth saying:** transcripts are redacted **before** indexing, audio
retention is bounded at 30 days and is zero for an organisation that disables
recording, and erasure deletes vectors before the row.

---

## 4. Do not invent fraud figures

Every fraud statistic in a pitch should be citable **live**. Pull current numbers
the morning of the pitch from:

- **CBUAE** (Central Bank of the UAE) — payment and fraud reporting.
- **UAE Cyber Security Council** — annual reports; these are strong, and they are
  free.

Then cite them with the year. _"CBUAE reported X in 2024"_ beats _"banks lose
billions"_ every time, because the second one tells a fraud expert you have not
done the reading.

**Where this repository already keeps an honest baseline:** the latency module
carries `INDUSTRY_BASELINE = 38 min` tagged `kind: "literature"`, with its
conflicting attributions recorded rather than hidden
(`src/lib/telemetry/spans.ts`). Follow that convention: if the number's provenance
is weak, say so, or leave it out.

---

## Pre-flight, the morning of the pitch

- [ ] Place a **real** UAE test call and confirm the customer hears audio.
- [ ] Play the disclosure sentence and the hang-up-safe exit **in Arabic**, on the
      stage speakers, in the stage room's acoustics.
- [ ] Confirm the region the demo database actually lives in, and be ready to name
      it precisely.
- [ ] Pull two current, citable fraud figures.
- [ ] Grant mic permission. Reload the tab. Warm the cache.
